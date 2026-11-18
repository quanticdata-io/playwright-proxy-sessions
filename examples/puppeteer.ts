/**
 * A Puppeteer page through a proxy, matched to its exit.
 *
 *   PROXY_URL=http://user:pass@gw.example.net:8080 CHROME_PATH=/path/to/chrome npx tsx examples/puppeteer.ts
 *
 * With the full `puppeteer` package, import it instead and drop executablePath.
 */
import puppeteer from 'puppeteer-core';
import { newPuppeteerSession, parseProxy } from '../src/index.js';

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH });
const { context, page, exit } = await newPuppeteerSession(browser, parseProxy(process.env.PROXY_URL ?? ''));
await page.goto('https://example.com/');
console.log(exit?.country, exit?.timezone, await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone));
await context.close();
await browser.close();
