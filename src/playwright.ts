import { BlockedError } from './blocks.js';
import { DEFAULT_ECHO_URL, geoMatch, parseExit, type ExitInfo } from './geo.js';
import { NoProxyAvailableError, type SessionPool } from './pool.js';
import { maskProxy, proxyKey, type ProxyEndpoint } from './proxy.js';

/** The parts of Playwright's types this module uses (so Playwright stays a peer, not a dependency). */
export interface PlaywrightAPIResponseLike {
  status(): number;
  json(): Promise<unknown>;
}
export interface PlaywrightContextLike {
  request: { get(url: string, options?: { timeout?: number; failOnStatusCode?: boolean }): Promise<PlaywrightAPIResponseLike> };
  close(): Promise<void>;
}
export interface PlaywrightBrowserLike<C extends PlaywrightContextLike> {
  newContext(options?: Record<string, unknown>): Promise<C>;
}

/** Playwright's `proxy` option for a parsed proxy. */
export function toPlaywrightProxy(p: ProxyEndpoint): { server: string; username?: string; password?: string } {
  const out: { server: string; username?: string; password?: string } = { server: p.server };
  if (p.username) out.username = p.username;
  if (p.password !== undefined) out.password = p.password;
  return out;
}

export interface ContextOptions {
  /** IP echo requested through the proxy. Default: the free QuanticData echo. */
  echoUrl?: string;
  /** Set `timezoneId`, `locale` and `geolocation` from the exit. Default true. */
  matchGeo?: boolean;
  /** Locale to use instead of the country default. */
  locale?: string;
  /** Also grant the geolocation permission, so pages can read the coordinates. Default false. */
  grantGeolocation?: boolean;
  /** A device descriptor, e.g. `devices['Pixel 7']` from Playwright: user agent, viewport, touch, mobile. */
  device?: Record<string, unknown>;
  /** Any other `newContext` options; they win over everything above. */
  contextOptions?: Record<string, unknown>;
  /** Timeout of the echo request. Default 20 s. */
  probeTimeoutMs?: number;
}

export interface ProxyContext<C> {
  context: C;
  proxy: ProxyEndpoint;
  /** Where the proxy exited when it was probed; absent with `matchGeo: false`. */
  exit?: ExitInfo;
}

/**
 * Ask the IP echo, through `proxy`, where it exits. Uses a short-lived context
 * of `browser` (its API request client, no page), so the request takes the
 * same network path as the browser.
 */
export async function probeExit<C extends PlaywrightContextLike>(
  browser: PlaywrightBrowserLike<C>,
  proxy: ProxyEndpoint,
  options: Pick<ContextOptions, 'echoUrl' | 'probeTimeoutMs'> = {},
): Promise<ExitInfo> {
  const ctx = await browser.newContext({ proxy: toPlaywrightProxy(proxy) });
  try {
    const res = await ctx.request.get(options.echoUrl ?? DEFAULT_ECHO_URL, {
      timeout: options.probeTimeoutMs ?? 20_000,
      failOnStatusCode: false,
    });
    if (res.status() === 407) throw new Error(`proxy refused the credentials (HTTP 407): ${maskProxy(proxy)}`);
    if (res.status() !== 200) throw new BlockedError(`IP echo answered HTTP ${res.status()} through ${maskProxy(proxy)}`, res.status());
    return parseExit(await res.json());
  } finally {
    await ctx.close();
  }
}

/** The `newContext` options for a proxy and an exit. */
export function contextOptionsFor(proxy: ProxyEndpoint, exit: ExitInfo | undefined, options: ContextOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(options.device ?? {}) };
  delete out.defaultBrowserType;
  if (exit && options.matchGeo !== false) {
    const geo = geoMatch(exit, options.locale ? { locale: options.locale } : {});
    Object.assign(out, geo);
    if (geo.geolocation && options.grantGeolocation) out.permissions = ['geolocation'];
  } else if (options.locale) {
    out.locale = options.locale;
  }
  Object.assign(out, options.contextOptions ?? {});
  out.proxy = toPlaywrightProxy(proxy);
  return out;
}

/** A browser context that goes through `proxy`, with timezone, locale and geolocation matched to its exit. */
export async function newProxyContext<C extends PlaywrightContextLike>(
  browser: PlaywrightBrowserLike<C>,
  proxy: ProxyEndpoint,
  options: ContextOptions = {},
): Promise<ProxyContext<C>> {
  const exit = options.matchGeo === false ? undefined : await probeExit(browser, proxy, options);
  const context = await browser.newContext(contextOptionsFor(proxy, exit, options));
  return exit ? { context, proxy, exit } : { context, proxy };
}

export interface RunOptions {
  /** Contexts to try before giving up. Default 3. */
  attempts?: number;
  /** Keep the context open after `fn` succeeds (you close it). Default false. */
  keepOpen?: boolean;
}

/**
 * Sticky proxy sessions for Playwright contexts, on top of a {@link SessionPool}.
 * Exits are probed once per proxy and cached for `exitCacheMs` (default 10 minutes).
 */
export class PlaywrightSessions<C extends PlaywrightContextLike> {
  private readonly exits = new Map<string, { exit: ExitInfo; at: number }>();

  constructor(
    private readonly browser: PlaywrightBrowserLike<C>,
    readonly pool: SessionPool,
    private readonly options: ContextOptions & { exitCacheMs?: number } = {},
  ) {}

  private async exitFor(proxy: ProxyEndpoint): Promise<ExitInfo | undefined> {
    if (this.options.matchGeo === false) return undefined;
    const key = proxyKey(proxy);
    const cached = this.exits.get(key);
    const ttl = this.options.exitCacheMs ?? 10 * 60_000;
    if (cached && Date.now() - cached.at < ttl) return cached.exit;
    const exit = await probeExit(this.browser, proxy, this.options);
    this.exits.set(key, { exit, at: Date.now() });
    return exit;
  }

  /** A context on the proxy of `key` (a new proxy when the key has none). */
  async open(key?: string): Promise<ProxyContext<C>> {
    const proxy = this.pool.acquire(key);
    let exit: ExitInfo | undefined;
    try {
      exit = await this.exitFor(proxy);
    } catch (err) {
      this.pool.retire(proxy);
      throw err;
    }
    const context = await this.browser.newContext(contextOptionsFor(proxy, exit, this.options));
    return exit ? { context, proxy, exit } : { context, proxy };
  }

  /**
   * Run `fn` in a context of `key`'s session. When `fn` throws a
   * {@link BlockedError} (see `assertNotBlocked`) or the probe fails, the
   * proxy is retired, the key moves to another proxy, and `fn` runs again in
   * a fresh context, up to `attempts` times. Other errors are rethrown at once.
   */
  async run<T>(key: string | undefined, fn: (context: C, session: ProxyContext<C>) => Promise<T>, options: RunOptions = {}): Promise<T> {
    const attempts = options.attempts ?? 3;
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let session: ProxyContext<C>;
      try {
        session = await this.open(key);
      } catch (err) {
        if (err instanceof NoProxyAvailableError) throw err;
        last = err;
        continue;
      }
      let ok = false;
      try {
        const value = await fn(session.context, session);
        this.pool.succeeded(session.proxy);
        ok = true;
        return value;
      } catch (err) {
        if (!(err instanceof BlockedError)) throw err;
        this.pool.retire(session.proxy);
        this.exits.delete(proxyKey(session.proxy));
        last = err;
      } finally {
        if (!(ok && options.keepOpen)) await session.context.close();
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}
