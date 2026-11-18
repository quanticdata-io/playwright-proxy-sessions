import { parseProxy, proxyKey, type ProxyEndpoint } from './proxy.js';

export interface SessionPoolOptions {
  /** Milliseconds a key keeps its proxy. `0` keeps it until the proxy is retired. Default 10 minutes. */
  stickyTtlMs?: number;
  /** Rest after a proxy is retired; doubled per retirement in a row. Default 60 s. */
  cooldownMs?: number;
  /** Upper bound of the rest. Default 30 minutes. */
  maxCooldownMs?: number;
  /** Retirements in a row after which a proxy is never handed out again. `0` = never. Default 3. */
  maxStrikes?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export class NoProxyAvailableError extends Error {
  override name = 'NoProxyAvailableError';
  constructor(
    message: string,
    /** Milliseconds until a proxy is free again, or `null` when every proxy is dead. */
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

interface Entry {
  proxy: ProxyEndpoint;
  key: string;
  uses: number;
  strikes: number;
  restUntil: number;
  dead: boolean;
}

/**
 * Sticky sessions for browser contexts: each key (an account, a profile, a
 * task) gets its own proxy and keeps it; a proxy that gets blocked is retired
 * for a while and its keys move to fresh proxies.
 *
 * Fill it with **sticky** proxy strings (one exit IP per string) to get one IP
 * per key, or with a single **rotating** string to get a new IP per context.
 */
export class SessionPool {
  private readonly entries: Entry[] = [];
  private readonly bindings = new Map<string, { entry: Entry; expires: number }>();
  private cursor = 0;
  private readonly ttl: number;
  private readonly cooldown: number;
  private readonly maxCooldown: number;
  private readonly maxStrikes: number;
  private readonly now: () => number;

  constructor(proxies: Iterable<string | ProxyEndpoint>, options: SessionPoolOptions = {}) {
    this.ttl = options.stickyTtlMs ?? 10 * 60_000;
    this.cooldown = options.cooldownMs ?? 60_000;
    this.maxCooldown = Math.max(options.maxCooldownMs ?? 30 * 60_000, this.cooldown);
    this.maxStrikes = options.maxStrikes ?? 3;
    this.now = options.now ?? Date.now;
    this.add(proxies);
  }

  /** Add proxies; returns how many were new. */
  add(proxies: Iterable<string | ProxyEndpoint>): number {
    let added = 0;
    for (const item of proxies) {
      const proxy = typeof item === 'string' ? parseProxy(item) : item;
      const key = proxyKey(proxy);
      if (this.entries.some((e) => e.key === key)) continue;
      this.entries.push({ proxy, key, uses: 0, strikes: 0, restUntil: 0, dead: false });
      added++;
    }
    return added;
  }

  get size(): number {
    return this.entries.length;
  }

  private usable(e: Entry, now: number): boolean {
    return !e.dead && e.restUntil <= now;
  }

  /** The proxy for `key` (or the next free one without a key). */
  acquire(key?: string): ProxyEndpoint {
    const now = this.now();
    if (key !== undefined) {
      const b = this.bindings.get(key);
      if (b && (b.expires === 0 || now < b.expires) && this.usable(b.entry, now)) {
        b.entry.uses++;
        return b.entry.proxy;
      }
      this.bindings.delete(key);
    }
    const n = this.entries.length;
    // Prefer proxies no live key is bound to, so keys do not share an exit.
    const bound = new Set([...this.bindings.values()].filter((b) => b.expires === 0 || now < b.expires).map((b) => b.entry));
    let chosen: Entry | undefined;
    for (const preferUnbound of [true, false]) {
      for (let step = 0; step < n && !chosen; step++) {
        const e = this.entries[(this.cursor + step) % n]!;
        if (this.usable(e, now) && (!preferUnbound || !bound.has(e))) {
          chosen = e;
          this.cursor = (this.cursor + step + 1) % n;
        }
      }
      if (chosen) break;
    }
    if (!chosen) {
      const alive = this.entries.filter((e) => !e.dead);
      if (alive.length === 0) throw new NoProxyAvailableError('every proxy in the pool is retired for good', null);
      const wait = Math.max(0, Math.min(...alive.map((e) => e.restUntil)) - now);
      throw new NoProxyAvailableError(`every proxy is resting; next one in ${Math.ceil(wait / 1000)}s`, wait);
    }
    chosen.uses++;
    if (key !== undefined) this.bindings.set(key, { entry: chosen, expires: this.ttl > 0 ? now + this.ttl : 0 });
    return chosen.proxy;
  }

  /** The proxy bound to `key`, if the binding is still valid. */
  bound(key: string): ProxyEndpoint | undefined {
    const b = this.bindings.get(key);
    if (!b || (b.expires !== 0 && this.now() >= b.expires)) return undefined;
    return b.entry.proxy;
  }

  /** Forget the binding of `key`. */
  release(key: string): void {
    this.bindings.delete(key);
  }

  /** The proxy worked: clear its strikes. */
  succeeded(proxy: ProxyEndpoint): void {
    const e = this.find(proxy);
    if (e) {
      e.strikes = 0;
      e.restUntil = 0;
    }
  }

  /** The proxy was blocked or failed: rest it and move every key bound to it. */
  retire(proxy: ProxyEndpoint): void {
    const e = this.find(proxy);
    if (!e) return;
    e.strikes++;
    for (const [k, b] of this.bindings) if (b.entry === e) this.bindings.delete(k);
    if (this.maxStrikes > 0 && e.strikes >= this.maxStrikes) {
      e.dead = true;
      return;
    }
    e.restUntil = this.now() + Math.min(this.cooldown * 2 ** (e.strikes - 1), this.maxCooldown);
  }

  /** Counts by state. */
  summary(): { total: number; available: number; resting: number; dead: number; keys: number } {
    const now = this.now();
    const dead = this.entries.filter((e) => e.dead).length;
    const available = this.entries.filter((e) => this.usable(e, now)).length;
    return { total: this.entries.length, available, resting: this.entries.length - available - dead, dead, keys: this.bindings.size };
  }

  private find(proxy: ProxyEndpoint): Entry | undefined {
    const key = proxyKey(proxy);
    return this.entries.find((e) => e.key === key);
  }
}
