/**
 * One sticky proxy per account; a blocked account moves to a fresh proxy.
 *
 *   PROXY_FILE=sessions.txt npx tsx examples/sticky-accounts.ts
 *
 * sessions.txt holds sticky proxy strings, one per line (any provider).
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { assertNotBlocked, PlaywrightSessions, SessionPool } from '../src/index.js';

const lines = readFileSync(process.env.PROXY_FILE ?? 'sessions.txt', 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const browser = await chromium.launch();
const sessions = new PlaywrightSessions(browser, new SessionPool(lines, { stickyTtlMs: 30 * 60_000 }));

for (const account of ['account-a', 'account-b', 'account-a']) {
  const where = await sessions.run(account, async (context, session) => {
    const page = await context.newPage();
    assertNotBlocked(await page.goto('https://example.com/'));
    return `${session.exit?.ip} ${session.exit?.country} ${await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
  });
  console.log(account, where); // account-a shows the same exit both times
}
console.log(sessions.pool.summary());
await browser.close();
