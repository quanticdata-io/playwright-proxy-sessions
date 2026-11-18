# Contributing

Thanks for helping improve playwright-proxy-sessions.

## Setup

```bash
git clone https://github.com/quanticdata-io/playwright-proxy-sessions
cd playwright-proxy-sessions
npm install
npx playwright install chromium     # for the end-to-end tests
```

## Checks

```bash
npm run lint
npm run typecheck
npm test            # unit tests with fake browsers
npm run test:e2e    # real Chromium through test proxies on 127.0.0.1
```

CI runs the unit tests on Node 18 and 22 (Ubuntu and Windows) and the end-to-end tests on Ubuntu.

## Ground rules

- No test reaches the network. The test proxy in `test/proxy-server.ts` answers made-up `.test` hosts itself, over plain requests and CONNECT tunnels.
- Playwright and Puppeteer stay optional peers: `src/` uses only the structural types declared in `src/playwright.ts` and `src/puppeteer.ts`, and `npm run typecheck` checks them against the real packages through the examples and tests.
- Never put a password in an error message: use `maskProxy` or `redact`.
- Changes to `COUNTRY_LOCALES` need the country's main language as its tag (`ll-CC`).
- User-facing changes need a CHANGELOG entry under "Unreleased".
