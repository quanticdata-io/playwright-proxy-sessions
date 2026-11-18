import { chromium, devices, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNotBlocked, newProxyContext, parseProxy, PlaywrightSessions, SessionPool } from '../src/index.js';
import { startProxy, type TestProxy } from './proxy-server.js';

// Real Chromium through in-process proxies on 127.0.0.1. Pages use made-up
// .test hosts, which only the test proxies answer, so nothing leaves the machine.

let browser: Browser;
let berlin: TestProxy;
let tokyo: TestProxy;

beforeAll(async () => {
  browser = await chromium.launch();
  berlin = await startProxy({ ip: '203.0.113.7', countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 52.52, longitude: 13.4 });
  tokyo = await startProxy({ ip: '198.51.100.9', countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 35.68, longitude: 139.69 });
});

afterAll(async () => {
  await browser?.close();
  await berlin?.close();
  await tokyo?.close();
});

async function report(page: Page): Promise<{ timeZone: string; language: string }> {
  return JSON.parse((await page.textContent('#out')) ?? '{}') as { timeZone: string; language: string };
}

describe('Chromium through a proxy', () => {
  it('matches timezone and language to the exit, with a mobile device profile', async () => {
    const { context, exit } = await newProxyContext(browser, parseProxy(berlin.url), {
      echoUrl: 'http://echo.test/ip',
      device: devices['Pixel 7'],
    });
    const page = await context.newPage();
    await page.goto('http://site.test/');
    expect(exit?.ip).toBe('203.0.113.7');
    expect(await report(page)).toEqual({ timeZone: 'Europe/Berlin', language: 'de-DE' });
    expect(await page.evaluate(() => navigator.maxTouchPoints > 0)).toBe(true);
    await context.close();
  });

  it('moves a blocked session to the next proxy', async () => {
    berlin.block = true;
    const pool = new SessionPool([berlin.url, tokyo.url]);
    const sessions = new PlaywrightSessions(browser, pool, { echoUrl: 'http://echo.test/ip' });
    const seen = await sessions.run('account-1', async (context) => {
      const page = await context.newPage();
      assertNotBlocked(await page.goto('http://site.test/'));
      return report(page);
    });
    expect(seen.timeZone).toBe('Asia/Tokyo');
    expect(pool.bound('account-1')?.port).toBe(tokyo.port);
    berlin.block = false;
  });
});
