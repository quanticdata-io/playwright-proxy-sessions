import { describe, expect, it, vi } from 'vitest';
import {
  assertNotBlocked,
  BlockedError,
  contextOptionsFor,
  generateProxies,
  geoMatch,
  isBlocked,
  maskProxy,
  newProxyContext,
  newPuppeteerSession,
  NoProxyAvailableError,
  parseExit,
  parseProxy,
  PlaywrightSessions,
  ProxyParseError,
  QuanticDataError,
  redact,
  SessionPool,
  type PlaywrightAPIResponseLike,
} from '../src/index.js';

const BERLIN = { type: 'response', payload: { ip: '203.0.113.7', countryCode: 'DE', city: 'Berlin', timezone: 'Europe/Berlin', latitude: 52.52, longitude: 13.405 } };

describe('parseProxy', () => {
  it.each([
    ['203.0.113.7:3128', 'http://203.0.113.7:3128', undefined, undefined],
    ['user:pass@gw.example.net:8080', 'http://gw.example.net:8080', 'user', 'pass'],
    ['gw.example.net:8080:user-country-us:pa:ss', 'http://gw.example.net:8080', 'user-country-us', 'pa:ss'],
    ['socks5h://u:p%40x@198.51.100.4:1080', 'socks5://198.51.100.4:1080', 'u', 'p@x'],
    ['http://[2001:db8::1]:8080', 'http://[2001:db8::1]:8080', undefined, undefined],
  ])('%s', (input, server, username, password) => {
    const p = parseProxy(input);
    expect(p.server).toBe(server);
    expect(p.username).toBe(username);
    expect(p.password).toBe(password);
  });

  it('rejects bad input without leaking the password', () => {
    for (const bad of ['', 'ftp://h:1', 'nohost', 'h:70000']) expect(() => parseProxy(bad)).toThrow(ProxyParseError);
    expect(() => parseProxy('user:topsecret@host:x')).toThrow(/user:\*\*\*\*\*@host:x/);
    expect(redact('http://u:secret@h:1')).toBe('http://u:*****@h:1');
    expect(maskProxy(parseProxy('u:secret@h:1'))).toBe('http://u:*****@h:1');
  });
});

describe('SessionPool', () => {
  const make = (n: number, opts: ConstructorParameters<typeof SessionPool>[1] = {}) => {
    let now = 1_000_000;
    const pool = new SessionPool(
      Array.from({ length: n }, (_, i) => `u${i}:p@gw.example.net:${8000 + i}`),
      { now: () => now, ...opts },
    );
    return { pool, advance: (ms: number) => (now += ms) };
  };

  it('gives each key its own proxy and keeps it', () => {
    const { pool } = make(3);
    const a = pool.acquire('a');
    const b = pool.acquire('b');
    expect(a.port).not.toBe(b.port);
    expect(pool.acquire('a')).toBe(a);
    expect(pool.bound('a')).toBe(a);
  });

  it('expires bindings after the TTL', () => {
    const { pool, advance } = make(3, { stickyTtlMs: 1000 });
    pool.acquire('a');
    advance(1001);
    expect(pool.bound('a')).toBeUndefined();
  });

  it('retires a proxy with backoff and moves its keys', () => {
    const { pool, advance } = make(2, { cooldownMs: 100, maxStrikes: 3 });
    const first = pool.acquire('a');
    pool.retire(first);
    const second = pool.acquire('a');
    expect(second).not.toBe(first);
    pool.retire(second);
    expect(() => pool.acquire()).toThrow(NoProxyAvailableError);
    advance(100);
    expect(pool.acquire().port).toBe(first.port);
    pool.retire(first);
    advance(150);
    expect(() => pool.acquire('x')).not.toThrow(); // second is back after 100 ms
    expect(pool.summary().resting).toBe(1); // first rests 200 ms after its second strike
  });

  it('marks proxies dead after maxStrikes', () => {
    const { pool, advance } = make(1, { cooldownMs: 1, maxStrikes: 2 });
    const p = pool.acquire();
    pool.retire(p);
    advance(10);
    pool.retire(p);
    advance(10_000);
    try {
      pool.acquire();
      throw new Error('expected an error');
    } catch (err) {
      expect(err).toBeInstanceOf(NoProxyAvailableError);
      expect((err as NoProxyAvailableError).retryAfterMs).toBeNull();
    }
    expect(pool.summary().dead).toBe(1);
  });

  it('succeeded clears strikes; duplicates are ignored', () => {
    const { pool } = make(1, { cooldownMs: 10, maxStrikes: 2 });
    const p = pool.acquire();
    pool.retire(p);
    pool.succeeded(p);
    expect(pool.acquire()).toBe(p);
    expect(pool.add(['u0:p@gw.example.net:8000'])).toBe(0);
    expect(pool.size).toBe(1);
  });
});

describe('geo', () => {
  it('parses echo shapes', () => {
    expect(parseExit(BERLIN)).toEqual({ ip: '203.0.113.7', country: 'DE', city: 'Berlin', timezone: 'Europe/Berlin', latitude: 52.52, longitude: 13.405 });
    expect(parseExit({ ip: '198.51.100.1', country: 'us', loc: '40.71,-74.00', timezone: 'America/New_York' })).toMatchObject({ country: 'US', latitude: 40.71, longitude: -74 });
    expect(parseExit('{"origin":"198.51.100.2, 192.0.2.1"}').ip).toBe('198.51.100.2');
    expect(() => parseExit({ status: 'ok' })).toThrow(/no IP/);
  });

  it('maps an exit to context settings', () => {
    expect(geoMatch(parseExit(BERLIN))).toEqual({ timezoneId: 'Europe/Berlin', locale: 'de-DE', geolocation: { latitude: 52.52, longitude: 13.405, accuracy: 5000 } });
    expect(geoMatch({ ip: '1', country: 'XX' })).toEqual({});
    expect(geoMatch({ ip: '1', country: 'CH' }, { locale: 'fr-CH' }).locale).toBe('fr-CH');
  });
});

describe('blocks', () => {
  it('detects block statuses', () => {
    const res = (status: number) => ({ status: () => status, url: () => 'https://shop.example/' });
    expect(isBlocked(res(403))).toBe(true);
    expect(isBlocked(res(200))).toBe(false);
    expect(isBlocked(null)).toBe(false);
    expect(isBlocked(res(503), [503])).toBe(true);
    expect(() => assertNotBlocked(res(429))).toThrow(BlockedError);
    expect(() => assertNotBlocked(res(429))).toThrow('blocked with HTTP 429 on https://shop.example/');
  });
});

// A fake Playwright browser: records context options, answers the echo per proxy port.
function fakeBrowser(echo: (port: number) => { status: number; body?: unknown }) {
  const created: Record<string, unknown>[] = [];
  let closed = 0;
  const browser = {
    async newContext(options: Record<string, unknown> = {}) {
      created.push(options);
      const server = (options.proxy as { server: string } | undefined)?.server ?? '';
      const port = Number(server.split(':').pop());
      return {
        options,
        request: {
          async get(): Promise<PlaywrightAPIResponseLike> {
            const r = echo(port);
            return { status: () => r.status, json: async () => r.body };
          },
        },
        async close() {
          closed++;
        },
      };
    },
  };
  return { browser, created, closed: () => closed };
}

describe('Playwright', () => {
  it('builds context options from device, geo and overrides', () => {
    const proxy = parseProxy('u:p@gw.example.net:8080');
    const device = { userAgent: 'Mobile UA', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, defaultBrowserType: 'chromium' };
    const options = contextOptionsFor(proxy, parseExit(BERLIN), { device, grantGeolocation: true, contextOptions: { locale: 'en-GB' } });
    expect(options).toEqual({
      userAgent: 'Mobile UA',
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      timezoneId: 'Europe/Berlin',
      locale: 'en-GB',
      geolocation: { latitude: 52.52, longitude: 13.405, accuracy: 5000 },
      permissions: ['geolocation'],
      proxy: { server: 'http://gw.example.net:8080', username: 'u', password: 'p' },
    });
    expect(contextOptionsFor(proxy, undefined, { locale: 'it-IT' })).toEqual({ locale: 'it-IT', proxy: { server: 'http://gw.example.net:8080', username: 'u', password: 'p' } });
  });

  it('probes the exit then opens a matched context', async () => {
    const fake = fakeBrowser(() => ({ status: 200, body: BERLIN }));
    const session = await newProxyContext(fake.browser, parseProxy('u:p@gw.example.net:8080'));
    expect(session.exit?.timezone).toBe('Europe/Berlin');
    expect(fake.created).toHaveLength(2);
    expect(fake.created[0]).toEqual({ proxy: { server: 'http://gw.example.net:8080', username: 'u', password: 'p' } });
    expect(fake.created[1]).toMatchObject({ timezoneId: 'Europe/Berlin', locale: 'de-DE' });
    expect(fake.closed()).toBe(1); // only the probe context
    const plain = await newProxyContext(fake.browser, parseProxy('gw.example.net:8080'), { matchGeo: false });
    expect(plain.exit).toBeUndefined();
  });

  it('reports a 407 from the probe clearly', async () => {
    const fake = fakeBrowser(() => ({ status: 407 }));
    await expect(newProxyContext(fake.browser, parseProxy('u:secret@gw.example.net:8080'))).rejects.toThrow('proxy refused the credentials (HTTP 407): http://u:*****@gw.example.net:8080');
  });

  it('run() retires blocked proxies and retries in a fresh context', async () => {
    const fake = fakeBrowser(() => ({ status: 200, body: BERLIN }));
    const pool = new SessionPool(['a:p@gw.example.net:8001', 'b:p@gw.example.net:8002', 'c:p@gw.example.net:8003']);
    const sessions = new PlaywrightSessions(fake.browser, pool);
    const ports: number[] = [];
    const result = await sessions.run('account-1', async (_context, session) => {
      ports.push(session.proxy.port);
      if (ports.length < 3) throw new BlockedError('captcha', 403);
      return 'done';
    });
    expect(result).toBe('done');
    expect(new Set(ports).size).toBe(3);
    expect(pool.bound('account-1')?.port).toBe(ports[2]);
    expect(pool.summary().resting).toBe(2);
  });

  it('run() gives up after the attempts and rethrows other errors at once', async () => {
    const fake = fakeBrowser(() => ({ status: 200, body: BERLIN }));
    const pool = new SessionPool(['a:p@gw.example.net:8001', 'b:p@gw.example.net:8002'], { cooldownMs: 0 });
    const sessions = new PlaywrightSessions(fake.browser, pool, { matchGeo: false });
    await expect(sessions.run(undefined, async () => { throw new BlockedError('no'); }, { attempts: 2 })).rejects.toThrow(BlockedError);
    const fn = vi.fn(async () => { throw new TypeError('bug'); });
    await expect(sessions.run('k', fn)).rejects.toThrow(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('run() caches the exit per proxy and keeps the context open on request', async () => {
    let probes = 0;
    const fake = fakeBrowser(() => {
      probes++;
      return { status: 200, body: BERLIN };
    });
    const sessions = new PlaywrightSessions(fake.browser, new SessionPool(['a:p@gw.example.net:8001']));
    await sessions.run('k', async () => 1);
    const kept = await sessions.run('k', async (context) => context, { keepOpen: true });
    expect(probes).toBe(1);
    expect((kept as unknown as { options: Record<string, unknown> }).options.timezoneId).toBe('Europe/Berlin');
  });

  it('a failing probe retires the proxy and the next one is tried', async () => {
    const fake = fakeBrowser((port) => (port === 8001 ? { status: 403 } : { status: 200, body: BERLIN }));
    const pool = new SessionPool(['a:p@gw.example.net:8001', 'b:p@gw.example.net:8002']);
    const port = await new PlaywrightSessions(fake.browser, pool).run('k', async (_c, s) => s.proxy.port);
    expect(port).toBe(8002);
  });
});

describe('Puppeteer', () => {
  function fakePuppeteer(status = 200) {
    const calls: string[] = [];
    const page = {
      authenticate: async (c: { username: string; password: string } | null) => void calls.push(`auth ${c?.username}`),
      goto: async (url: string) => (calls.push(`goto ${url}`), { status: () => status, json: async () => BERLIN }),
      emulateTimezone: async (tz?: string) => void calls.push(`tz ${tz}`),
      setGeolocation: async (g: { latitude: number }) => void calls.push(`geo ${g.latitude}`),
      setExtraHTTPHeaders: async (h: Record<string, string>) => void calls.push(`lang ${h['Accept-Language']}`),
      createCDPSession: async () => ({ send: async (m: string, p?: Record<string, unknown>) => void calls.push(`${m} ${String(p?.locale)}`) }),
    };
    const context = {
      newPage: async () => page,
      overridePermissions: async (origin: string) => void calls.push(`grant ${origin}`),
      close: async () => void calls.push('close'),
    };
    const browser = { createBrowserContext: async (o?: { proxyServer?: string }) => (calls.push(`context ${o?.proxyServer}`), context) };
    return { browser, calls };
  }

  it('opens a proxied context and matches the page to the exit', async () => {
    const { browser, calls } = fakePuppeteer();
    const s = await newPuppeteerSession(browser, parseProxy('u:p@gw.example.net:8080'), { echoUrl: 'http://echo.test/', grantGeolocationTo: 'https://maps.example' });
    expect(s.exit?.country).toBe('DE');
    expect(calls).toEqual([
      'context http://gw.example.net:8080',
      'auth u',
      'goto http://echo.test/',
      'tz Europe/Berlin',
      'lang de-DE,de;q=0.9',
      'Emulation.setLocaleOverride de-DE',
      'grant https://maps.example',
      'geo 52.52',
    ]);
  });

  it('closes the context when the probe is blocked', async () => {
    const { browser, calls } = fakePuppeteer(403);
    await expect(newPuppeteerSession(browser, parseProxy('gw.example.net:8080'))).rejects.toThrow(BlockedError);
    expect(calls.at(-1)).toBe('close');
  });
});

describe('generateProxies', () => {
  it('posts the documented body and parses the strings', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ orderId: 'ord_1', quantity: 2, protocol: 'http', format: 'http://user:pass@host:port', country: 'us', isp: 't_mobile_usa', rotation: 'sticky', sessionTime: 30 });
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer qd_test_key');
      return new Response(JSON.stringify({ type: 'response', payload: { proxies: ['http://user-sid-1:pw@gw.example.net:8080', 'http://user-sid-2:pw@gw.example.net:8080'] } }), { status: 200 });
    });
    const proxies = await generateProxies({ orderId: 'ord_1', quantity: 2, country: 'us', isp: 't_mobile_usa', rotation: 'sticky', sessionTime: 30, superSticky: false, apiKey: 'qd_test_key', baseUrl: 'http://api.test/v1', fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/v1/public/proxies/generate');
    expect(proxies.map((p) => p.username)).toEqual(['user-sid-1', 'user-sid-2']);
  });

  it('surfaces API errors and validates input', async () => {
    const fetchMock = (async () => new Response(JSON.stringify({ type: 'error', message: 'Proxy has expired' }), { status: 400 })) as unknown as typeof fetch;
    await expect(generateProxies({ orderId: 'o', apiKey: 'k', fetch: fetchMock })).rejects.toThrow(QuanticDataError);
    await expect(generateProxies({ orderId: 'o', apiKey: 'k', quantity: 0 })).rejects.toThrow(/quantity/);
    await expect(generateProxies({ orderId: ' ', apiKey: 'k' })).rejects.toThrow(/orderId/);
    const saved = process.env.QUANTICDATA_API_KEY;
    delete process.env.QUANTICDATA_API_KEY;
    await expect(generateProxies({ orderId: 'o' })).rejects.toThrow(/QUANTICDATA_API_KEY/);
    if (saved !== undefined) process.env.QUANTICDATA_API_KEY = saved;
  });
});
