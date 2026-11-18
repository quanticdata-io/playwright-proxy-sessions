# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-18

### Added

- `SessionPool`: one proxy per key with a TTL, retirement with exponential rest, proxies retired for good after N strikes.
- Playwright: `newProxyContext`, `probeExit`, `contextOptionsFor` and `PlaywrightSessions` (`open`, `run` with retry on `BlockedError`); timezone, locale and geolocation matched to the exit; device descriptors.
- Puppeteer: `newPuppeteerSession` with a proxy per browser context, authentication and timezone, language, locale and geolocation matched to the exit.
- Block helpers (`isBlocked`, `assertNotBlocked`, `BlockedError`), proxy parsing and masking.
- `generateProxies` for QuanticData plans.

[Unreleased]: https://github.com/quanticdata-io/playwright-proxy-sessions/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/quanticdata-io/playwright-proxy-sessions/releases/tag/v0.1.0
