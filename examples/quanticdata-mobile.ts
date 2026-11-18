/**
 * QuanticData mobile sessions in a mobile browser profile.
 *
 *   export QUANTICDATA_API_KEY=qd_live_...   QUANTICDATA_ORDER_ID=ord_...
 *   npx tsx examples/quanticdata-mobile.ts
 */
import { chromium, devices } from 'playwright';
import { generateProxies, PlaywrightSessions, SessionPool } from '../src/index.js';

const proxies = await generateProxies({
  orderId: process.env.QUANTICDATA_ORDER_ID ?? '',
  quantity: 3,
  country: 'de',
  rotation: 'sticky',
  sessionTime: 30,
});

const browser = await chromium.launch();
const sessions = new PlaywrightSessions(browser, new SessionPool(proxies, { stickyTtlMs: 25 * 60_000 }), {
  device: devices['Pixel 7'],
});
const { context, exit } = await sessions.open('profile-1');
const page = await context.newPage();
await page.goto('https://example.com/');
console.log(exit, await page.evaluate(() => [navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone]));
await context.close();
await browser.close();
