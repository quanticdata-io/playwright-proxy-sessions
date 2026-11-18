import { BlockedError } from './blocks.js';
import { DEFAULT_ECHO_URL, geoMatch, parseExit, type ExitInfo } from './geo.js';
import { maskProxy, type ProxyEndpoint } from './proxy.js';

/** The parts of Puppeteer's types this module uses. */
export interface PuppeteerResponseLike {
  status(): number;
  json(): Promise<unknown>;
}
export interface PuppeteerCDPSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
export interface PuppeteerPageLike {
  authenticate(credentials: { username: string; password: string } | null): Promise<void>;
  goto(url: string, options?: { timeout?: number }): Promise<PuppeteerResponseLike | null>;
  emulateTimezone(timezoneId?: string): Promise<void>;
  setGeolocation(options: { latitude: number; longitude: number; accuracy?: number }): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  createCDPSession?(): Promise<PuppeteerCDPSessionLike>;
}
export interface PuppeteerContextLike<P extends PuppeteerPageLike> {
  newPage(): Promise<P>;
  overridePermissions(origin: string, permissions: string[]): Promise<void>;
  close(): Promise<void>;
}
export interface PuppeteerBrowserLike<X> {
  createBrowserContext(options?: { proxyServer?: string; proxyBypassList?: string[] }): Promise<X>;
}

export interface PuppeteerSessionOptions {
  echoUrl?: string;
  /** Match timezone, Accept-Language, locale (Chromium) and geolocation to the exit. Default true. */
  matchGeo?: boolean;
  locale?: string;
  /** Grant geolocation to this origin, e.g. `https://example.com`. */
  grantGeolocationTo?: string;
  probeTimeoutMs?: number;
}

export interface PuppeteerSession<P, X> {
  context: X;
  page: P;
  proxy: ProxyEndpoint;
  exit?: ExitInfo;
}

/**
 * An incognito browser context through `proxy` (Puppeteer 22+ supports a proxy
 * per context), one page with the proxy credentials set, and the page's
 * timezone, language and geolocation matched to the exit. The probe loads the
 * IP echo in that page, so the page has already navigated once.
 */
type PageOf<X extends PuppeteerContextLike<PuppeteerPageLike>> = Awaited<ReturnType<X['newPage']>>;

export async function newPuppeteerSession<X extends PuppeteerContextLike<PuppeteerPageLike>>(
  browser: PuppeteerBrowserLike<X>,
  proxy: ProxyEndpoint,
  options: PuppeteerSessionOptions = {},
): Promise<PuppeteerSession<PageOf<X>, X>> {
  const context = await browser.createBrowserContext({ proxyServer: proxy.server });
  try {
    const page = (await context.newPage()) as PageOf<X>;
    if (proxy.username) await page.authenticate({ username: proxy.username, password: proxy.password ?? '' });
    if (options.matchGeo === false) return { context, page, proxy };
    const res = await page.goto(options.echoUrl ?? DEFAULT_ECHO_URL, { timeout: options.probeTimeoutMs ?? 20_000 });
    if (!res) throw new Error('the IP echo did not answer');
    if (res.status() === 407) throw new Error(`proxy refused the credentials (HTTP 407): ${maskProxy(proxy)}`);
    if (res.status() !== 200) throw new BlockedError(`IP echo answered HTTP ${res.status()} through ${maskProxy(proxy)}`, res.status());
    const exit = parseExit(await res.json());
    const geo = geoMatch(exit, options.locale ? { locale: options.locale } : {});
    if (geo.timezoneId) await page.emulateTimezone(geo.timezoneId);
    if (geo.locale) {
      await page.setExtraHTTPHeaders({ 'Accept-Language': `${geo.locale},${geo.locale.split('-')[0]};q=0.9` });
      if (page.createCDPSession) {
        const cdp = await page.createCDPSession();
        await cdp.send('Emulation.setLocaleOverride', { locale: geo.locale });
      }
    }
    if (geo.geolocation) {
      if (options.grantGeolocationTo) await context.overridePermissions(options.grantGeolocationTo, ['geolocation']);
      await page.setGeolocation(geo.geolocation);
    }
    return { context, page, proxy, exit };
  } catch (err) {
    await context.close();
    throw err;
  }
}
