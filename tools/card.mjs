#!/usr/bin/env node
/**
 * Press the app's own "save picture" button in headless Edge/Chrome and keep the PNG it produces (the finished card on
 * birthday routes: render + lettering). Handy to inspect exactly what a visitor would download.
 *
 *   node tools/card.mjs --url "http://localhost:5173/nivashini" --out shots/card.png [--t 38] [--w 1280 --h 720] [--mobile]
 *
 * --t   jump the timeline to that second first (default 38 = the end)
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[argv[i].slice(2)] = true;
  else { opt[argv[i].slice(2)] = next; i++; }
}
const url = opt.url && opt.url !== true ? opt.url : 'http://localhost:5173/nivashini';
const out = opt.out && opt.out !== true ? opt.out : 'shots/card.png';
const mobile = !!opt.mobile;
const W = parseInt(opt.w || (mobile ? 390 : 1280), 10), H = parseInt(opt.h || (mobile ? 844 : 720), 10);
const t = opt.t === true ? NaN : parseFloat(opt.t ?? 38);        // a bare --t used to become NaN and render a blank frame
if (!Number.isFinite(t)) { console.log(JSON.stringify({ ok: false, error: '--t needs a number of seconds, e.g. --t 22' })); process.exit(2); }
const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || exe, headless: true, defaultViewport: null, protocolTimeout: 300000,
  args: ['--headless=new', '--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--mute-audio', `--window-size=${W},${H}`],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__LOTUS_READY__ === true', { timeout: 120000, polling: 250 });
  await page.evaluate((tt) => {
    window.__lotus.setTime(tt);
    window.__dl = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push({ name: this.download, href: this.href }); return; } return click.call(this); };
    // a still frame: hold the clock and let the wind/ripples carry on
  }, t);
  await new Promise((r) => setTimeout(r, 900));
  await page.click('#btn-capture');
  await page.waitForFunction('window.__dl && window.__dl.length > 0', { timeout: 120000, polling: 300 });
  const b64 = await page.evaluate(async () => {
    const d = window.__dl[0];
    const buf = new Uint8Array(await (await (await fetch(d.href)).blob()).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { name: d.name, data: btoa(s) };
  });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(b64.data, 'base64'));
  console.log(JSON.stringify({ ok: true, out, name: b64.name, kb: Math.round(fs.statSync(out).size / 1024) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exitCode = 2;
} finally {
  await browser.close();
}
