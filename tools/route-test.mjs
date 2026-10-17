#!/usr/bin/env node
/**
 * Routes + defaults test (headless Edge/Chrome, real WebGL).
 *
 *   node tools/route-test.mjs                                   # dev server  http://localhost:5173
 *   node tools/route-test.mjs --base http://localhost:4173      # `npm run preview` (the built dist/, behaves like a static host)
 *   node tools/route-test.mjs --single dist-single              # also test the double-clickable file:// copies
 *
 * Checks, per page: the right route / title / data-kind, greeting + fonts only on the birthday page, no errors, ultra by default.
 * Then: quality overrides + safety nets, the greeting reveal states along the timeline, the quality menu, and "save picture".
 * Exit code 1 if anything fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[argv[i].slice(2)] = true;
  else { opt[argv[i].slice(2)] = next; i++; }
}
const base = String(opt.base && opt.base !== true ? opt.base : 'http://localhost:5173').replace(/\/$/, '');
const singleDir = opt.single && opt.single !== true ? opt.single : null;
const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const ARGS = ['--headless=new', '--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--mute-audio', '--window-size=1100,700'];

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok, info: String(info) }); console.error(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || exe, headless: true, defaultViewport: null, args: [...ARGS, '--use-angle=d3d11'] });

/** open a page, wait for the first frames, return {page, errors} */
async function open(url, { viewport = { width: 1100, height: 700, deviceScaleFactor: 1 }, preload = null, mobile = false, br = browser } = {}) {
  const page = await br.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.setViewport({ ...viewport, isMobile: mobile, hasTouch: mobile });
  // every page starts from a clean profile (pages share one browser), then gets its own preset, then the app boots
  await page.evaluateOnNewDocument(`try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}`);
  if (preload) await page.evaluateOnNewDocument(preload);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__LOTUS_READY__ === true', { timeout: 120000, polling: 250 });
  await sleep(500);
  return { page, errors };
}

const probe = (page) => page.evaluate(() => {
  const L = window.__lotus;
  const g = document.getElementById('greeting');
  return {
    route: L.route.id, kind: L.route.kind, title: document.title, dataRoute: document.documentElement.dataset.route, dataKind: document.documentElement.dataset.kind,
    tier: L.quality.tier, source: L.quality.source, auto: L.quality.auto, demoted: L.quality.demoted,
    greeting: !!L.greeting, greetingHidden: g.hidden, greetingText: g.textContent.trim().slice(0, 80), srHeading: (g.querySelector('.g-sr') || {}).textContent || '',
    sparkles: !!(L.mods && L.mods.sparkles), titleCard: !!document.getElementById('title'),
    fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/"/g, '')} ${f.weight} ${f.style}`),
    hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    loaderDone: document.getElementById('loader').classList.contains('done'),
  };
});

// ---- 1. every route variant resolves to the right page ----------------------------------------------------------------
const PAGES = [
  ['/', 'home'], ['/home', 'home'], ['/home/', 'home'], ['/nivashini', 'nivashini'], ['/nivashini/', 'nivashini'],
  ['/Nivashini', 'nivashini'], ['/NIVASHINI/', 'nivashini'], ['/nivashini/index.html', 'nivashini'], ['/unknown-page', 'home'], ['/?route=nivashini', 'nivashini'],
];
const TITLE = { home: 'Lotus — a blooming', nivashini: 'Happy Birthday Nivashini' };

for (const [p, want] of PAGES) {
  const { page, errors } = await open(`${base}${p}`);
  const s = await probe(page);
  const birthday = want === 'nivashini';
  check(`${p}  ->  route ${want}`, s.route === want && s.dataRoute === want, `got ${s.route}`);
  check(`${p}  title`, s.title === TITLE[want], s.title);
  check(`${p}  kind / greeting / sparkles only on the birthday page`, s.dataKind === (birthday ? 'birthday' : 'bloom') && s.greeting === birthday && s.sparkles === birthday && s.greetingHidden === !birthday, JSON.stringify({ kind: s.dataKind, g: s.greeting, sp: s.sparkles, hidden: s.greetingHidden }));
  if (birthday) {
    check(`${p}  screen-reader heading`, /Happy Birthday\s+Nivashini/.test(s.srHeading), s.srHeading);
    check(`${p}  bundled fonts loaded (Allura + Cormorant)`, s.fontsLoaded.some((f) => /^Allura/.test(f)) && s.fontsLoaded.some((f) => /^Cormorant Garamond/.test(f)), s.fontsLoaded.join(', '));
  } else {
    check(`${p}  plain page downloads no greeting fonts and has no greeting markup`, s.fontsLoaded.length === 0 && s.greetingText === '', `loaded: ${s.fontsLoaded.join(', ') || 'none'}`);
  }
  check(`${p}  default quality is ULTRA (nothing in the URL / storage)`, s.tier === 'ultra' && s.source === 'default' && !s.auto && s.demoted === 0, `${s.tier} (${s.source})`);
  check(`${p}  loader dismissed, no horizontal scroll, no console errors`, s.loaderDone && !s.hscroll && errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ---- 2. quality choices and safety nets --------------------------------------------------------------------------------
const store = (o) => `try { ${Object.entries(o).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`).join(';')} } catch (e) {}`;
const QCASES = [
  ['URL ?quality=low wins', '/?quality=low', null, { tier: 'low', source: 'url' }],
  ['URL ?quality=high wins over a saved pick', '/?quality=high', store({ 'lotus.quality': 'medium' }), { tier: 'high', source: 'url' }],
  ['saved Medium is honoured', '/', store({ 'lotus.quality': 'medium' }), { tier: 'medium', source: 'stored' }],
  ['saved Auto = match the device (not forced to ultra)', '/', store({ 'lotus.quality': 'auto' }), { auto: true, source: 'stored' }],
  ['garbage in storage falls back to ultra', '/', store({ 'lotus.quality': 'turbo' }), { tier: 'ultra', source: 'default' }],
  ['one automatic step-down after a context loss / crash', '/', store({ 'lotus.safe': '1' }), { tier: 'high', source: 'default', demoted: 1 }],
  ['two steps down', '/', store({ 'lotus.safe': '2' }), { tier: 'medium', demoted: 2 }],
  ['an explicit URL tier ignores the step-down', '/?quality=ultra', store({ 'lotus.safe': '2' }), { tier: 'ultra', demoted: 0 }],
  ['a boot that never rendered (left-over flag) steps down once', '/', store({ 'lotus.booting': '1' }), { tier: 'high', demoted: 1 }],
];
for (const [name, p, preload, want] of QCASES) {
  const { page } = await open(`${base}${p}`, { preload });
  const s = await probe(page);
  const ok = Object.entries(want).every(([k, v]) => s[k] === v);
  check(`quality: ${name}`, ok, `${s.tier} source=${s.source} auto=${s.auto} demoted=${s.demoted}`);
  await page.close();
}
{
  // the flag set by a healthy boot must be cleared once frames flow
  const { page } = await open(`${base}/`);
  await sleep(1500);
  const left = await page.evaluate(() => { try { return localStorage.getItem('lotus.booting'); } catch (e) { return 'n/a'; } });
  check('quality: crash flag is cleared after a healthy boot', left === null, String(left));
  await page.close();
}

// ---- 3. the quality menu -----------------------------------------------------------------------------------------------
{
  const { page } = await open(`${base}/`);
  const items = await page.evaluate(() => [...document.querySelectorAll('#menu button')].map((b) => ({ q: b.dataset.q, checked: b.getAttribute('aria-checked') })));
  check('menu lists Ultra, High, Medium, Low, Auto in that order', items.map((i) => i.q).join() === 'ultra,high,medium,low,auto', items.map((i) => i.q).join());
  check('menu shows Ultra as the current choice by default', items.filter((i) => i.checked === 'true').map((i) => i.q).join() === 'ultra', JSON.stringify(items.filter((i) => i.checked === 'true')));
  await page.close();
}

// ---- 4. the greeting reveal follows the timeline ------------------------------------------------------------------------
{
  const { page, errors } = await open(`${base}/nivashini`);
  const st = async (t) => { await page.evaluate((tt) => window.__lotus.setTime(tt), t); await sleep(450); return page.evaluate(() => window.__lotus.greeting.state()); };
  const at2 = await st(3.5), at12 = await st(14), at22 = await st(22), at26 = await st(24.5), at30 = await st(30.5), at38 = await st(38);
  check('reveal: whisper appears while the stalk rises (t=3.5 s)', at2.whisper > 0.5 && at2.title === 0 && at2.stage === 'whisper', JSON.stringify(at2));
  check('reveal: nothing on screen while the petals first open (t=14 s)', at12.whisper < 0.05 && at12.title === 0 && at12.stage === 'none', JSON.stringify(at12));
  check('reveal: headline is mid-way at t=22 s, name not started', at22.title > 0.05 && at22.title < 0.95 && at22.name < 0.2, JSON.stringify(at22));
  check('reveal: headline done, name being written at t=24.5 s', at26.title > 0.99 && at26.name > 0.2 && at26.name < 0.95 && at26.stage === 'name', JSON.stringify(at26));
  check('reveal: wish fading in at t=30.5 s', at30.name > 0.99 && at30.wish > 0.05 && at30.wish < 1, JSON.stringify(at30));
  check('reveal: complete at the end of the timeline', at38.stage === 'done' && at38.wish > 0.995, JSON.stringify(at38));
  const back = await st(5);
  check('reveal: scrubbing back hides the lettering again (no stale state)', back.title === 0 && back.name === 0 && back.wish === 0, JSON.stringify(back));
  // the lens shift (room for the text) follows the same timeline
  const lens = await page.evaluate(async () => { const r = window.__lotus.rig; window.__lotus.setTime(38); await new Promise((x) => setTimeout(x, 400)); const a = r.lensShift; window.__lotus.setTime(2); await new Promise((x) => setTimeout(x, 400)); return { end: a, start: r.lensShift }; });
  check('lens shift: 0 at the start, lowers the picture by the end', lens.start === 0 && lens.end > 0.03, JSON.stringify(lens));
  check('reveal: no console errors while scrubbing', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ---- 5. "save picture" on the birthday page produces the finished card ---------------------------------------------------
{
  const { page, errors } = await open(`${base}/nivashini`, { viewport: { width: 960, height: 600, deviceScaleFactor: 1 } });
  await page.evaluate(() => { window.__lotus.setTime(38); window.__dl = []; const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push({ name: this.download, href: this.href }); return; } return c.call(this); }; });
  await sleep(600);
  await page.click('#btn-capture');
  await page.waitForFunction('window.__dl && window.__dl.length > 0', { timeout: 60000, polling: 300 });
  const dl = await page.evaluate(async () => {
    const d = window.__dl[0];
    const blob = await (await fetch(d.href)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    // golden lettering: count warm, bright, saturated-gold pixels in the top 30 % (the plain render has almost none there)
    const band = g.getImageData(0, 0, c.width, Math.floor(c.height * 0.3)).data;
    let gold = 0;
    for (let i = 0; i < band.length; i += 16) { const r = band[i], gr = band[i + 1], b = band[i + 2]; if (r > 235 && gr > 190 && b > 120 && b < 215 && r - b > 40) gold++; }
    return { name: d.name, type: blob.type, size: blob.size, w: bmp.width, h: bmp.height, gold };
  });
  check('save picture: named happy-birthday-nivashini.png, PNG, 3-4K wide', dl.name === 'happy-birthday-nivashini.png' && dl.type === 'image/png' && dl.w >= 3000 && dl.size > 200000, JSON.stringify({ n: dl.name, t: dl.type, kb: Math.round(dl.size / 1024), w: dl.w, h: dl.h }));
  check('save picture: the lettering is painted into the image (gold pixels in the top band)', dl.gold > 400, `gold px: ${dl.gold}`);
  check('save picture: no errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ---- 6. phone portrait: layout --------------------------------------------------------------------------------------------
{
  const { page, errors } = await open(`${base}/nivashini`, { viewport: { width: 390, height: 844, deviceScaleFactor: 2 }, mobile: true });
  await page.evaluate(() => window.__lotus.setTime(38));
  await sleep(700);
  const m = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s).getBoundingClientRect(); return { l: e.left, r: e.right, t: e.top, b: e.bottom, w: e.width }; };
    return { name: r('.g-name'), title: r('.g-title'), wish: r('.g-wish'), vw: innerWidth, vh: innerHeight, nameFont: parseFloat(getComputedStyle(document.querySelector('.g-name')).fontSize) };
  });
  check('phone: name, headline and wish sit inside the screen with margins', [m.name, m.title, m.wish].every((e) => e.l >= 8 && e.r <= m.vw - 8), JSON.stringify({ name: [m.name.l, m.name.r], title: [m.title.l, m.title.r], wish: [m.wish.l, m.wish.r], vw: m.vw }));
  check('phone: lettering stays in the upper half of the screen', m.wish.b < m.vh * 0.5, `wish bottom ${Math.round(m.wish.b)} of ${m.vh}`);
  check('phone: name is large enough to read (>= 64 px)', m.nameFont >= 64, `${m.nameFont}px`);
  check('phone: no errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ---- 7. the single-file copies (double-click / file://) ------------------------------------------------------------------
if (singleDir) {
  const dir = path.resolve(singleDir);
  const cases = [['index.html', 'home'], ['nivashini.html', 'nivashini']];
  for (const [file, want] of cases) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) { check(`single: ${file} exists`, false, full); continue; }
    const { page, errors } = await open(pathToFileURL(full).href);
    const s = await probe(page);
    check(`single: ${file} (file://) -> ${want}`, s.route === want && s.title === TITLE[want] && s.tier === 'ultra', `${s.route} / ${s.title} / ${s.tier}`);
    if (want === 'nivashini') check(`single: ${file} has the inlined fonts`, s.fontsLoaded.some((f) => /^Allura/.test(f)), s.fontsLoaded.join(', '));
    check(`single: ${file} no errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }
  const { page } = await open(pathToFileURL(path.join(dir, 'index.html')).href + '?route=nivashini');
  const s = await probe(page);
  check('single: index.html?route=nivashini switches the page', s.route === 'nivashini' && s.greeting, s.route);
  await page.close();
}

await browser.close();

// ---- 8. software renderer starts on Low (separate browser: SwiftShader) --------------------------------------------------
{
  const sw = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || exe, headless: true, defaultViewport: null, args: [...ARGS, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const { page } = await open(`${base}/`, { br: sw, viewport: { width: 480, height: 320, deviceScaleFactor: 1 } });
    const s = await probe(page);
    check('software WebGL (SwiftShader) starts on Low instead of Ultra', s.tier === 'low' && s.demoted >= 1, `${s.tier} demoted=${s.demoted}`);
    await page.close();
  } catch (e) { check('software WebGL (SwiftShader) starts on Low instead of Ultra', false, String(e.message).slice(0, 160)); }
  await sw.close();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed }));
process.exit(failed.length ? 1 : 0);
