#!/usr/bin/env node
/**
 * Smoothness probe: how evenly are frames delivered? (puppeteer-core + installed Edge/Chrome, normal vsync)
 *
 *   node tools/smooth.mjs --url "http://localhost:5173/nivashini" --mobile --seconds 24
 *   node tools/smooth.mjs --url "http://localhost:5173/nivashini?shadow=4096&refl=0.75&lod=1.4" --mobile --w 640 --h 1100 --dsf 3 --seconds 40   # a heavy load on a weak GPU's behalf
 *
 * It counts RENDERED frames (the governor skips display refreshes on purpose, so counting every refresh would hide its work) and prints one
 * JSON line: fps, the median / 95th / 99th percentile interval, how many frames were late (> 1.5x the median rhythm after the first 6 s - the
 * judder you can see), how many resizes (each re-allocates the render targets) and pace changes happened, and where the governor ended up.
 *
 * Options: --url --seconds (12) --mobile --w --h --dsf (phone view: 390 x 844 @ 2) --uncapped (removes vsync: only for raw throughput, the
 * numbers then include multi-second queue stalls that no real display shows) --slowest (also print the 12 slowest frames)
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2), next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[k] = true; else { opt[k] = next; i++; }
}
const exe = process.env.CHROME_PATH || ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const url = opt.url && opt.url !== true ? opt.url : 'http://localhost:5173/';
const secs = parseFloat(opt.seconds || 12);
const mobile = !!opt.mobile;
const view = mobile
  ? { width: +(opt.w || 390), height: +(opt.h || 844), deviceScaleFactor: +(opt.dsf || 2), isMobile: true, hasTouch: true }
  : { width: +(opt.w || 700), height: +(opt.h || 760), deviceScaleFactor: +(opt.dsf || 1) };

const browser = await puppeteer.launch({
  executablePath: exe, headless: true, defaultViewport: null,
  args: ['--headless=new', '--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ...(opt.uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [])],
});
try {
  const page = await browser.newPage();
  await page.setViewport(view);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__LOTUS_READY__ === true', { timeout: 120000, polling: 250 });
  await new Promise((r) => setTimeout(r, 1500));
  const frames = await page.evaluate((secs) => new Promise((resolve) => {
    const L = window.__lotus;
    let renders = 0, seen = 0;
    const origRender = L.pipeline.render;
    L.pipeline.render = function (...a) { renders++; return origRender.apply(this, a); };
    const t0 = performance.now(); let last = t0; const out = [];
    function f(now) {
      if (renders !== seen) {                                              // a frame was rendered since the previous callback
        seen = renders;
        const i = L.pipeline.info();
        out.push({ t: +(now - t0).toFixed(0), dt: +(now - last).toFixed(1), dpr: +L.pipeline.getDpr().toFixed(2), pace: i.pacing.pace, hz: +i.pacing.hz.toFixed(0), shed: L.shedder.level });
        last = now;
      }
      if (now - t0 < secs * 1000) requestAnimationFrame(f); else resolve(out);
    }
    requestAnimationFrame(f);
  }), secs);

  const dts = frames.map((x) => x.dt).sort((a, b) => a - b);
  const pick = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
  const late = frames.filter((x) => x.t > 6000);
  const median = late.map((x) => x.dt).sort((a, b) => a - b)[Math.floor(late.length / 2)];
  const end = frames[frames.length - 1];
  const result = {
    url, view: `${view.width}x${view.height}@${view.deviceScaleFactor}`, seconds: secs,
    fps: +(frames.length / secs).toFixed(1), p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: dts[dts.length - 1],
    over50ms: frames.filter((x) => x.dt > 50).length,
    medianAfter6s: median, lateFramesAfter6s: late.filter((x) => x.dt > 1.5 * median).length, framesAfter6s: late.length,
    resizes: frames.filter((x, i) => i && x.dpr !== frames[i - 1].dpr).length,
    paceChanges: frames.filter((x, i) => i && x.pace !== frames[i - 1].pace).length,
    end: { dpr: end.dpr, pace: end.pace, hz: end.hz, eased: end.shed },
  };
  console.log(JSON.stringify(result));
  if (opt.slowest) console.log('slowest:', JSON.stringify(frames.slice().sort((a, b) => b.dt - a.dt).slice(0, 12)));
} finally {
  await browser.close();
}
