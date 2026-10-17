#!/usr/bin/env node
/**
 * Batch visual-QA runner: ONE browser, many frozen-state shots, contact sheets, JSON error report.
 *
 *   node tools/qa.mjs --list
 *   node tools/qa.mjs --preset bloom                 # bloom 0..1 (11 frames), default camera
 *   node tools/qa.mjs --preset bloom --cam close     # same from another camera
 *   node tools/qa.mjs --preset cams                  # 5 cameras at bloom 1 and 0.5
 *   node tools/qa.mjs --preset rise                  # stalk rising out of the water
 *   node tools/qa.mjs --preset quality               # low/medium/high/ultra at bloom 1
 *   node tools/qa.mjs --preset mobile                # phone portrait/landscape + tablet, bloom 0 / 0.5 / 1
 *   node tools/qa.mjs --preset birthday              # /nivashini reveal: whisper -> letters -> name -> wish (desktop, cinematic camera)
 *   node tools/qa.mjs --preset birthday-views        # /nivashini finished card on desktop, phone portrait + landscape, tablet, ultrawide
 *   node tools/qa.mjs --preset all
 *
 * Options
 *   --base <url>      app root (default http://localhost:5173/); use --page dev/petals.html to QA a dev page
 *   --page <path>     path under --base (default "" = the app)
 *   --dir <dir>       output directory (default shots/qa)
 *   --tag <name>      prefix for files (default = preset name)
 *   --quality <tier>  forced tier for every shot (default: high)  ('-' = do not force)
 *   --w/--h/--dpr     desktop viewport (default 1280x720 @1)
 *   --wait <ms>       settle time after ready (default 700)
 *   --extra <q>       extra query string appended to every URL, e.g. "hide=leaves,water&sun=200,10"
 *   --cam <name>      camera for presets that take one (default: default)
 *   --cols <n>        contact-sheet columns (default 4)
 *   --timeout <ms>    per-shot ready timeout (default 120000)
 *   --browser edge|chrome  --swiftshader
 *
 * Output: <dir>/<tag>_<label>.png per shot, <dir>/<tag>_sheet.png contact sheet, <dir>/<tag>_report.json
 * (console errors / warnings / page errors per shot) and a compact summary on stdout (last line = JSON).
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
  edge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
};
function findBrowser(pref) {
  for (const n of pref ? [pref] : ['edge', 'chrome']) for (const p of BROWSERS[n] || []) if (fs.existsSync(p)) return p;
  throw new Error('No Edge/Chrome found. Set CHROME_PATH.');
}

const BASE = (opt.base && opt.base !== true ? opt.base : 'http://localhost:5173/').replace(/\/?$/, '/');
const PAGE = opt.page && opt.page !== true ? opt.page.replace(/^\//, '') : '';
const DIR = opt.dir && opt.dir !== true ? opt.dir : 'shots/qa';
const W = parseInt(opt.w || 1280, 10), H = parseInt(opt.h || 720, 10), DPR = parseFloat(opt.dpr || 1);
const WAIT = parseInt(opt.wait ?? 700, 10);
const TIMEOUT = parseInt(opt.timeout || 120000, 10);
const COLS = parseInt(opt.cols || 4, 10);
const QUALITY = opt.quality === true ? 'high' : (opt.quality || 'high');
const CAM = opt.cam && opt.cam !== true ? opt.cam : 'default';
const EXTRA = opt.extra && opt.extra !== true ? String(opt.extra).replace(/^[?&]/, '') : '';

const DESKTOP = { w: W, h: H, dpr: DPR, mobile: false };
const PHONE_P = { w: 390, h: 844, dpr: 2, mobile: true };
const PHONE_L = { w: 844, h: 390, dpr: 2, mobile: true };
const TABLET = { w: 820, h: 1180, dpr: 2, mobile: true };
const ULTRAWIDE = { w: 2560, h: 1080, dpr: 1, mobile: false };

const f2 = (x) => x.toFixed(2);
const blooms = (n = 11) => Array.from({ length: n }, (_, i) => i / (n - 1));

const PRESETS = {
  bloom: () => blooms().map((b) => ({ label: `b${f2(b)}`, q: { bloom: f2(b), rise: 1, cam: CAM, still: 1 }, vp: DESKTOP })),
  rise: () => [0, 0.2, 0.4, 0.6, 0.8, 1].map((r) => ({ label: `r${f2(r)}`, q: { rise: f2(r), bloom: 0, cam: opt.cam || 'low', still: 1 }, vp: DESKTOP })),
  cams: () => ['default', 'close', 'top', 'side', 'low'].flatMap((c) => [1, 0.5].map((b) => ({ label: `${c}_b${f2(b)}`, q: { bloom: f2(b), rise: 1, cam: c, still: 1 }, vp: DESKTOP }))),
  quality: () => ['low', 'medium', 'high', 'ultra'].map((t) => ({ label: t, q: { bloom: 1, rise: 1, cam: CAM, still: 1, quality: t }, vp: DESKTOP, force: true })),
  mobile: () => [
    ...[0, 0.5, 1].map((b) => ({ label: `phoneP_b${f2(b)}`, q: { bloom: f2(b), rise: 1, cam: 'portrait', still: 1 }, vp: PHONE_P })),
    ...[0.5, 1].map((b) => ({ label: `phoneL_b${f2(b)}`, q: { bloom: f2(b), rise: 1, cam: CAM, still: 1 }, vp: PHONE_L })),
    ...[1].map((b) => ({ label: `tablet_b${f2(b)}`, q: { bloom: f2(b), rise: 1, cam: 'portrait', still: 1 }, vp: TABLET })),
  ],
  // the real timeline, no freezing: app UI + cinematic camera (needs the app agent's rig)
  timeline: () => [2, 6, 10, 16, 22, 30].map((t) => ({ label: `t${String(t).padStart(2, '0')}`, q: { t, cam: opt.cam || undefined, still: 1 }, vp: DESKTOP })),
  // the birthday page (src/app/routes.js): the lettering is a function of the timeline, so frozen `t` frames show every stage
  birthday: () => [3, 8, 16, 21, 23, 25, 28, 32, 37].map((t) => ({ label: `t${String(t).padStart(2, '0')}`, page: 'nivashini', q: { t, cine: 1, still: 1 }, vp: DESKTOP })),
  'birthday-views': () => [
    { label: 'desktop', vp: DESKTOP }, { label: 'phoneP', vp: PHONE_P }, { label: 'phoneL', vp: PHONE_L }, { label: 'tablet', vp: TABLET }, { label: 'ultrawide', vp: ULTRAWIDE },
  ].map((s) => ({ ...s, page: 'nivashini', q: { t: 37, cine: 1, still: 1 } })),
};
PRESETS.all = () => [...PRESETS.bloom(), ...PRESETS.cams(), ...PRESETS.rise(), ...PRESETS.mobile(), ...PRESETS.quality()];

if (opt.list || !opt.preset) {
  console.log('presets: ' + Object.keys(PRESETS).join(', '));
  process.exit(opt.list ? 0 : 1);
}
const presetName = String(opt.preset);
if (!PRESETS[presetName]) { console.error('unknown preset ' + presetName); process.exit(1); }
const TAG = opt.tag && opt.tag !== true ? opt.tag : presetName;
const shots = PRESETS[presetName]();

function buildUrl(q, force, page) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) p.set(k, String(v));
  if (QUALITY !== '-' && !force && !p.has('quality')) p.set('quality', QUALITY);
  const extra = EXTRA ? '&' + EXTRA : '';
  return `${BASE}${PAGE || page || ''}?${p.toString()}${extra}`;
}

const gpu = opt.swiftshader ? 'swiftshader' : 'd3d11';
const args = [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  `--use-angle=${gpu}`, `--window-size=${W},${H}`,
];

fs.mkdirSync(DIR, { recursive: true });
const report = { preset: presetName, base: BASE + PAGE, shots: [], startedAt: 0 };
const t0 = Date.now();
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || findBrowser(opt.browser && opt.browser !== true ? opt.browser : undefined),
    headless: true, args, defaultViewport: null, protocolTimeout: Math.max(TIMEOUT, 180000),
  });
  let page = null, curVp = null;
  for (const s of shots) {
    const key = JSON.stringify(s.vp);
    if (!page || key !== curVp) {
      if (page) await page.close().catch(() => {});
      page = await browser.newPage();
      await page.setViewport({ width: s.vp.w, height: s.vp.h, deviceScaleFactor: s.vp.dpr, isMobile: s.vp.mobile, hasTouch: s.vp.mobile });
      if (s.vp.mobile) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1');
      curVp = key;
    }
    const rec = { label: s.label, url: buildUrl(s.q, s.force, s.page), consoleErrors: [], warnings: [], pageErrors: [], ms: 0, ok: false };
    const onConsole = (msg) => {
      const type = msg.type(); const text = msg.text();
      if (type === 'error' && !/favicon|404 \(Not Found\)/.test(text)) rec.consoleErrors.push(text.slice(0, 1200));
      else if (type === 'warning' || type === 'warn') rec.warnings.push(text.slice(0, 500));
    };
    const onPageError = (err) => rec.pageErrors.push(String((err && err.stack) || err).slice(0, 2000));
    page.on('console', onConsole); page.on('pageerror', onPageError);
    const ts = Date.now();
    const file = path.join(DIR, `${TAG}_${s.label}.png`);
    try {
      await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForFunction('window.__LOTUS_READY__ === true', { timeout: TIMEOUT, polling: 250 });
      if (WAIT > 0) await new Promise((r) => setTimeout(r, WAIT));
      rec.stats = await page.evaluate(() => (window.__lotus && window.__lotus.stats ? window.__lotus.stats() : null)).catch(() => null);
      await page.screenshot({ path: file, type: 'png' });
      rec.ok = true; rec.file = file;
    } catch (e) {
      rec.error = String((e && e.message) || e);
    }
    rec.ms = Date.now() - ts;
    page.off('console', onConsole); page.off('pageerror', onPageError);
    report.shots.push(rec);
    console.error(`[qa] ${rec.ok ? 'ok ' : 'ERR'} ${s.label.padEnd(18)} ${String(rec.ms).padStart(6)} ms  errors:${rec.consoleErrors.length + rec.pageErrors.length} warn:${rec.warnings.length}`);
  }

  // contact sheet
  const okShots = report.shots.filter((r) => r.ok);
  if (okShots.length) {
    const sheetPage = await browser.newPage();
    const cell = Math.floor(1920 / COLS);
    const items = okShots.map((r) => `<figure><img src="data:image/png;base64,${fs.readFileSync(r.file).toString('base64')}"><figcaption>${r.label}</figcaption></figure>`).join('');
    await sheetPage.setViewport({ width: cell * COLS, height: 400, deviceScaleFactor: 1 });
    await sheetPage.setContent(`<!doctype html><meta charset=utf-8><style>
      body{margin:0;background:#101214;color:#cfd6dc;font:600 13px system-ui,sans-serif}
      .g{display:grid;grid-template-columns:repeat(${COLS},${cell}px)}
      figure{margin:0;padding:4px;box-sizing:border-box}
      img{display:block;width:100%;height:auto;background:#000}
      figcaption{padding:3px 2px 6px}
    </style><div class=g>${items}</div>`, { waitUntil: 'load' });
    const sheet = path.join(DIR, `${TAG}_sheet.png`);
    await sheetPage.screenshot({ path: sheet, fullPage: true, type: 'png' });
    await sheetPage.close();
    report.sheet = sheet;
  }
} catch (e) {
  report.fatal = String((e && e.message) || e);
} finally {
  report.totalMs = Date.now() - t0;
  if (browser) await browser.close().catch(() => {});
}
fs.writeFileSync(path.join(DIR, `${TAG}_report.json`), JSON.stringify(report, null, 1));
const bad = report.shots.filter((r) => !r.ok || r.consoleErrors.length || r.pageErrors.length);
console.log(JSON.stringify({
  preset: presetName, shots: report.shots.length, ok: report.shots.filter((r) => r.ok).length,
  withErrors: bad.map((r) => ({ label: r.label, error: r.error, consoleErrors: r.consoleErrors.slice(0, 2), pageErrors: r.pageErrors.slice(0, 1) })),
  warnings: [...new Set(report.shots.flatMap((r) => r.warnings))].slice(0, 6),
  sheet: report.sheet, report: path.join(DIR, `${TAG}_report.json`), totalMs: report.totalMs, fatal: report.fatal,
}));
process.exit(report.fatal ? 2 : 0);
