#!/usr/bin/env node
/**
 * Frame-time probe: loads a page, lets it warm up, records requestAnimationFrame deltas for N seconds and prints
 * fps / median / p95 / p99 frame time + renderer stats. Use --uncapped to remove the 60 Hz limit so that the median
 * frame time reflects the true GPU+CPU cost (headless Edge on this laptop = Intel Iris Xe: a decent proxy for a
 * mid-range phone GPU at similar pixel counts).
 *
 *   node tools/perf.mjs --url "http://localhost:5173/?quality=high&bloom=1" --seconds 8 --w 1280 --h 720 --dpr 1 --uncapped
 *   node tools/perf.mjs --url "http://localhost:5173/?quality=medium&cam=portrait" --mobile --seconds 8 --uncapped
 *   node tools/perf.mjs --url ... --sweep dpr=0.75,1,1.5,2        # re-run for several device pixel ratios (one JSON line each)
 *
 * Options: --url --seconds (8) --warmup (3, seconds) --w --h --dpr --mobile --uncapped --timeout --browser --swiftshader --sweep k=v1,v2
 * Last stdout line(s): JSON per run.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[k] = true;
  else { opt[k] = next; i++; }
}
const BROWSERS = {
  edge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
};
const findBrowser = (pref) => {
  for (const n of pref ? [pref] : ['edge', 'chrome']) for (const p of BROWSERS[n] || []) if (fs.existsSync(p)) return p;
  throw new Error('No Edge/Chrome found. Set CHROME_PATH.');
};

const url = opt.url && opt.url !== true ? opt.url : 'http://localhost:5173/';
const seconds = parseFloat(opt.seconds || 8);
const warmup = parseFloat(opt.warmup || 3);
const mobile = !!opt.mobile;
const W = parseInt(opt.w || (mobile ? 390 : 1280), 10);
const H = parseInt(opt.h || (mobile ? 844 : 720), 10);
const baseDpr = parseFloat(opt.dpr || (mobile ? 2 : 1));
const timeout = parseInt(opt.timeout || 120000, 10);

const sweeps = [];
if (opt.sweep && opt.sweep !== true) {
  const [k, vs] = String(opt.sweep).split('=');
  for (const v of vs.split(',')) sweeps.push({ k, v });
} else sweeps.push(null);

const args = [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
  '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  `--use-angle=${opt.swiftshader ? 'swiftshader' : 'd3d11'}`, `--window-size=${W},${H}`,
];
if (opt.uncapped) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || findBrowser(opt.browser && opt.browser !== true ? opt.browser : undefined),
  headless: true, args, defaultViewport: null, protocolTimeout: Math.max(timeout, 180000),
});
let exitCode = 0;
try {
  for (const sw of sweeps) {
    let u = url, dpr = baseDpr;
    if (sw) {
      if (sw.k === 'dpr') dpr = parseFloat(sw.v);
      else { const uo = new URL(url); uo.searchParams.set(sw.k, sw.v); u = uo.toString(); }
    }
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text().slice(0, 300)); });
    const res = { url: u, w: W, h: H, dpr, mobile, uncapped: !!opt.uncapped };
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForFunction('window.__LOTUS_READY__ === true', { timeout, polling: 250 });
      await new Promise((r) => setTimeout(r, warmup * 1000));
      const t = await page.evaluate((secs) => new Promise((resolve) => {
        const times = [];
        const t0 = performance.now();
        function f(now) {
          times.push(now);
          if (now - t0 < secs * 1000) requestAnimationFrame(f);
          else resolve(times);
        }
        requestAnimationFrame(f);
      }), seconds);
      const d = [];
      for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
      d.sort((a, b) => a - b);
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      res.frames = d.length;
      res.fps = +(1000 / mean).toFixed(1);
      res.medianMs = +pct(d, 0.5).toFixed(2);
      res.p95Ms = +pct(d, 0.95).toFixed(2);
      res.p99Ms = +pct(d, 0.99).toFixed(2);
      res.maxMs = +d[d.length - 1].toFixed(1);
      res.stats = await page.evaluate(() => (window.__lotus && window.__lotus.stats ? window.__lotus.stats() : null)).catch(() => null);
      res.gl = await page.evaluate(() => (window.__GL_INFO__ ? { renderer: window.__GL_INFO__.renderer } : null)).catch(() => null);
      res.errors = errors.slice(0, 3);
      res.ok = true;
    } catch (e) {
      res.ok = false; res.error = String((e && e.message) || e); exitCode = 2;
    }
    await page.close().catch(() => {});
    console.log(JSON.stringify(res));
  }
} finally {
  await browser.close().catch(() => {});
}
process.exit(exitCode);
