#!/usr/bin/env node
/**
 * Headless screenshot tool (puppeteer-core + installed Edge/Chrome).
 *
 *   node tools/shot.mjs --url "http://localhost:5173/?bloom=0.6" --out shots/a.png
 *
 * Options
 *   --url <url>        page to load (default http://localhost:5173/)
 *   --out <file>       PNG output (default shots/shot.png)
 *   --w <px> --h <px>  CSS viewport size (default 1280x720)
 *   --dpr <n>          device pixel ratio (default 1)
 *   --mobile           emulate a phone (touch + mobile UA); implies --w 390 --h 844 --dpr 3 unless given
 *   --wait <ms>        extra settle time after the ready flag (default 800)
 *   --timeout <ms>     max time to wait for the ready flag (default 120000)
 *   --ready <expr>     JS expression that becomes truthy when ready (default window.__LOTUS_READY__)
 *   --eval <js>        JS run in the page after ready, before the screenshot (result printed)
 *   --frames <n>       frames sequence: take n screenshots, `--out` must contain {i}; use with --eval-each
 *   --eval-each <js>   JS template run before each frame, {i} replaced by frame index
 *   --browser <b>      edge | chrome (default: whichever exists, edge first)
 *   --swiftshader      force software WebGL (slow, but works with no GPU)
 *   --gpu <name>       pass-through ANGLE backend: d3d11 (default) | d3d9 | gl | vulkan | swiftshader
 *   --clip x,y,w,h     screenshot only that CSS-px region
 *   --canvas           screenshot only the first <canvas> element's pixels via toDataURL (needs preserveDrawingBuffer)
 *   --quiet            only print the JSON summary
 *
 * Prints one JSON object on the last stdout line: { ok, out, ms, consoleErrors, warnings, pageErrors, failedRequests, gl, evalResult }
 * Exit code 0 on success (even with console errors - read them!), 2 on timeout / crash.
 */
import fs from 'node:fs';
import path from 'node:path';
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
  edge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
};
function findBrowser(pref) {
  const order = pref ? [pref] : ['edge', 'chrome'];
  for (const name of order) for (const p of BROWSERS[name] || []) if (fs.existsSync(p)) return p;
  throw new Error('No Edge/Chrome found. Set CHROME_PATH env var.');
}

const url = opt.url || 'http://localhost:5173/';
const out = opt.out && opt.out !== true ? opt.out : 'shots/shot.png';
const mobile = !!opt.mobile;
const W = parseInt(opt.w || (mobile ? 390 : 1280), 10);
const H = parseInt(opt.h || (mobile ? 844 : 720), 10);
const DPR = parseFloat(opt.dpr || (mobile ? 3 : 1));
const waitMs = parseInt(opt.wait ?? 800, 10);
const timeout = parseInt(opt.timeout || 120000, 10);
const readyExpr = opt.ready && opt.ready !== true ? opt.ready : 'window.__LOTUS_READY__ === true';
const quiet = !!opt.quiet;
const log = (...a) => { if (!quiet) console.error(...a); };

const gpu = opt.swiftshader ? 'swiftshader' : (opt.gpu && opt.gpu !== true ? opt.gpu : 'd3d11');
const args = [
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-unsafe-swiftshader',
  '--allow-file-access-from-files',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--use-angle=${gpu}`,
  `--window-size=${W},${H}`,
];
if (opt['browser-arg']) args.push(...String(opt['browser-arg']).split(' '));

const t0 = Date.now();
const result = { ok: false, out, ms: 0, consoleErrors: [], warnings: [], pageErrors: [], failedRequests: [], gl: null, evalResult: null };

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || findBrowser(opt.browser && opt.browser !== true ? opt.browser : undefined),
    headless: true,
    args,
    defaultViewport: null,
    protocolTimeout: Math.max(timeout, 180000),
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR, isMobile: mobile, hasTouch: mobile });
  if (mobile) {
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1');
  }
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') result.consoleErrors.push(text.slice(0, 1500));
    else if (type === 'warning' || type === 'warn') result.warnings.push(text.slice(0, 600));
    else if (!quiet && opt.verbose) console.error('[page]', text);
  });
  page.on('pageerror', (err) => result.pageErrors.push(String(err && err.stack || err).slice(0, 2500)));
  page.on('requestfailed', (req) => result.failedRequests.push(`${req.url()} ${req.failure()?.errorText || ''}`.slice(0, 300)));

  log(`[shot] ${url}  ${W}x${H}@${DPR}${mobile ? ' mobile' : ''}  gpu=${gpu}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(readyExpr, { timeout, polling: 250 });
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

  result.gl = await page.evaluate(() => window.__GL_INFO__ || (window.__lotus && window.__lotus.glInfo) || null).catch(() => null);

  if (opt.eval && opt.eval !== true && !opt.frames) {
    result.evalResult = await page.evaluate(`(async()=>{ return await (${opt.eval}); })()`).catch((e) => `EVAL ERROR: ${e.message}`);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs, 1500)));
  }

  fs.mkdirSync(path.dirname(path.resolve(out.replace('{i}', '0'))), { recursive: true });
  const clip = opt.clip && opt.clip !== true ? (() => { const [x, y, w, h] = String(opt.clip).split(',').map(Number); return { x, y, width: w, height: h }; })() : undefined;

  if (opt.frames) {
    const n = parseInt(opt.frames, 10);
    const outs = [];
    for (let i = 0; i < n; i++) {
      if (opt['eval-each']) {
        await page.evaluate(`(async()=>{ ${String(opt['eval-each']).replaceAll('{i}', String(i)).replaceAll('{n}', String(n))} })()`).catch((e) => result.pageErrors.push('eval-each: ' + e.message));
        await new Promise((r) => setTimeout(r, Math.max(300, waitMs)));
      }
      const f = out.replaceAll('{i}', String(i).padStart(2, '0'));
      await page.screenshot({ path: f, type: 'png', clip });
      outs.push(f);
    }
    result.out = outs;
  } else if (opt.canvas) {
    const dataUrl = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } else {
    await page.screenshot({ path: out, type: 'png', clip });
  }
  result.ok = true;
} catch (e) {
  result.error = String(e && e.message || e);
  result.ok = false;
} finally {
  result.ms = Date.now() - t0;
  if (browser) await browser.close().catch(() => {});
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 2);
