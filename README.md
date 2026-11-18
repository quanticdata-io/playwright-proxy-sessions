# playwright-proxy-sessions

[![CI](https://github.com/quanticdata-io/playwright-proxy-sessions/actions/workflows/ci.yml/badge.svg)](https://github.com/quanticdata-io/playwright-proxy-sessions/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Sticky proxy sessions for **Playwright** and **Puppeteer**. Each browser context gets its own proxy and keeps it, a proxy that gets blocked is rested and its session moves to a fresh one, and every context's **timezone, language and geolocation are set to match where its proxy exits**, so a German mobile IP does not come with a browser that says `America/Los_Angeles` and `en-US`.

```ts
import { chromium, devices } from 'playwright';
import { assertNotBlocked, PlaywrightSessions, SessionPool } from 'playwright-proxy-sessions';

const browser = await chromium.launch();
const sessions = new PlaywrightSessions(browser, new SessionPool(process.env.PROXIES!.split('\n')), {
  device: devices['Pixel 7'],               // optional: mobile user agent, viewport, touch
});

const title = await sessions.run('account-42', async (context) => {
  const page = await context.newPage();
  assertNotBlocked(await page.goto('https://example.com/'));   // 403/429: retire this proxy, retry on another
  return page.title();
});
```

It works with any HTTP or HTTPS proxy from any provider: a list of sticky session strings (one exit IP each) or a single rotating gateway. QuanticData plans are supported directly.

## Install

Not on npm yet: install from GitHub (the `prepare` script builds it).

```bash
npm install github:quanticdata-io/playwright-proxy-sessions
npm install playwright        # or puppeteer (22 or later); both are optional peers
```

Node 18.17 or later. ESM and CommonJS builds, with types.

## What it does for each context

1. **Picks a proxy** for the session key from a `SessionPool` (a key is whatever must keep one IP: an account, a profile, a cart, a task).
2. **Probes the exit**: one request to an IP echo through that proxy, using a short-lived context's request client (no page), so it takes the browser's network path. The default echo is `https://api.quanticdata.io/v1/public/ip-echo`: free, no account, never cached, and it reports the location the way Cloudflare, and most sites behind it, see the visitor. Any echo with `ip`, `countryCode`/`country`, `timezone` and `latitude`/`longitude` (or ipinfo-style `loc`) works with `echoUrl`.
3. **Opens the context** with `proxy`, and from the exit: `timezoneId`, `locale` (the country's main language, see [`COUNTRY_LOCALES`](src/geo.ts)) and `geolocation` (with the permission only if you set `grantGeolocation`). A `device` descriptor and your own `contextOptions` are merged in; yours win.
4. With `run()`, **retires the proxy** when your code throws `BlockedError` (for example through `assertNotBlocked(response)`), closes the context and runs your function again on a fresh proxy, up to `attempts`.

Exits are probed once per proxy and cached for `exitCacheMs` (10 minutes).

## API

### `SessionPool(proxies, options?)`

| Option | Default | Meaning |
|---|---|---|
| `stickyTtlMs` | `600000` | how long a key keeps its proxy; `0` = until the proxy is retired |
| `cooldownMs` | `60000` | rest after a retirement, doubled per retirement in a row |
| `maxCooldownMs` | `1800000` | longest rest |
| `maxStrikes` | `3` | retirements in a row before a proxy is never used again; `0` = never |

`acquire(key?)`, `bound(key)`, `release(key)`, `retire(proxy)`, `succeeded(proxy)`, `add(proxies)`, `summary()`. Keys prefer proxies no other live key uses. When every proxy rests, `acquire` throws `NoProxyAvailableError` with `retryAfterMs` (`null` when all are retired for good).

Proxy strings: `host:port`, `user:pass@host:port`, `host:port:user:pass`, `scheme://[user:pass@]host:port` (`http`, `https`, `socks4`, `socks5`); credentials may be percent-encoded.

### Playwright

```ts
newProxyContext(browser, proxy, options?)  // -> { context, proxy, exit }
new PlaywrightSessions(browser, pool, options?)
  .open(key?)                               // -> { context, proxy, exit }; you close it
  .run(key, fn, { attempts: 3, keepOpen: false })
probeExit(browser, proxy, options?)         // -> { ip, country, city, timezone, latitude, longitude }
contextOptionsFor(proxy, exit, options?)    // the newContext options, if you create contexts yourself
```

| Option | Default | Meaning |
|---|---|---|
| `echoUrl` | QuanticData IP echo | echo requested through the proxy |
| `matchGeo` | `true` | set timezone, locale and geolocation from the exit; `false` skips the probe |
| `locale` | country default | force a locale (for countries with several languages) |
| `grantGeolocation` | `false` | also grant the geolocation permission |
| `device` | none | a Playwright device descriptor, e.g. `devices['iPhone 15']` |
| `contextOptions` | none | any other `newContext` options; they override the rest |
| `probeTimeoutMs` | `20000` | timeout of the echo request |
| `exitCacheMs` | `600000` | `PlaywrightSessions` only: reuse a probed exit per proxy |

### Puppeteer

```ts
import puppeteer from 'puppeteer';
import { newPuppeteerSession, parseProxy } from 'playwright-proxy-sessions';

const browser = await puppeteer.launch();
const { context, page, exit } = await newPuppeteerSession(browser, parseProxy(process.env.PROXY_URL!), {
  grantGeolocationTo: 'https://example.com',   // optional
});
await page.goto('https://example.com/');
await context.close();
```

It creates a browser context with `proxyServer` (a proxy per context needs Puppeteer 22 or later), authenticates the page, loads the echo in it, then calls `emulateTimezone`, sets `Accept-Language`, the Chromium locale override and the geolocation. The page has navigated once (to the echo) when you get it. Options: `echoUrl`, `matchGeo`, `locale`, `grantGeolocationTo`, `probeTimeoutMs`.

### Blocks

`isBlocked(response, statuses = [403, 429])`, `assertNotBlocked(response, statuses?)` (throws `BlockedError`), or throw `new BlockedError('captcha')` yourself when a page shows a challenge.

## QuanticData proxies

`generateProxies()` fills a pool from a QuanticData residential, mobile, ISP or datacenter plan through the documented, free [`POST /public/proxies/generate`](https://quanticdata.io/docs/) endpoint. The strings come back with country, city, carrier and session applied; they are used as returned. Traffic through them is billed by the plan as usual.

```ts
import { generateProxies, PlaywrightSessions, SessionPool } from 'playwright-proxy-sessions';

// 20 sticky mobile sessions on one US carrier, each keeping its IP for as long as the device is online
const proxies = await generateProxies({
  orderId: process.env.QUANTICDATA_ORDER_ID!,     // QUANTICDATA_API_KEY is read from the environment
  quantity: 20,
  country: 'us',
  isp: 't_mobile_usa',                            // carrier codes: GET /public/generator/mobile/targeting-options
  superSticky: true,
});
const sessions = new PlaywrightSessions(browser, new SessionPool(proxies, { stickyTtlMs: 0 }));
```

Options: `orderId`, `quantity` (1 to 10000), `protocol` (default `http`), `country`, `state`, `city`, `isp`, `rotation` (`rotating`, `sticky`, `static`), `sessionTime` (minutes), `superSticky`, `gateway`, `apiKey`, `baseUrl`. Which ones apply depends on the plan type, as listed in the [API reference](https://quanticdata.io/docs/). Plans: [quanticdata.io/pricing](https://quanticdata.io/pricing/).

## Limits

- **SOCKS5 with a password does not work in Chromium**: Chromium cannot authenticate to SOCKS5 proxies. Use HTTP strings (`protocol: 'http'` above), or put [rotating-proxy-gateway](https://github.com/quanticdata-io/rotating-proxy-gateway) in front to hold the credentials.
- The timezone and coordinates are those of the echo's IP database. Databases disagree, mostly for mobile IPs; the country is the most reliable part.
- With a **rotating** gateway, the probe sees one exit and the page may leave from another. The country stays if you target it, but a timezone inside a large country can differ. Use sticky strings when geo consistency matters.
- The locale table covers one main language per country. Pass `locale` where that is not what you want.
- Matching timezone and language removes two obvious mismatches. It does not make a browser undetectable, and it is not meant to: follow the terms of the sites you automate.
- Older Playwright versions needed `chromium.launch({ proxy: { server: 'per-context' } })` for per-context proxies on some platforms; current versions do not.

## Examples

[`examples/`](examples/): a Playwright crawl with sticky sessions per account, a mobile device profile on QuanticData mobile strings, and a Puppeteer session.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test
npx playwright install chromium && npm run test:e2e   # real Chromium through in-process proxies
```

Unit tests use fake browsers; the end-to-end tests drive real Chromium through test proxies on 127.0.0.1 that answer made-up `.test` hosts themselves, so no test reaches the network. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
