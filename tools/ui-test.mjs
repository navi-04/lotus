#!/usr/bin/env node
/**
 * End-to-end UI smoke test in headless Edge/Chrome: play/pause, replay, scrubber, quality menu, mouse + touch orbit,
 * keyboard shortcuts, 2K capture, console errors.   node tools/ui-test.mjs [--url http://localhost:5173/] [--quality medium]
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1];
const base = opt.url || 'http://localhost:5173/';
const quality = opt.quality || 'medium';
const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok, info: String(info) }); console.error(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); };

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || exe, headless: true, defaultViewport: null,
  args: ['--headless=new', '--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--mute-audio', '--window-size=1100,700'],
});

async function session(label, viewport, mobile, fn) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.setViewport({ ...viewport, isMobile: mobile, hasTouch: mobile });
  await page.goto(`${base}?quality=${quality}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__LOTUS_READY__ === true', { timeout: 120000, polling: 250 });
  await new Promise((r) => setTimeout(r, 800));
  try { await fn(page); } catch (e) { check(`${label}: no exception`, false, e.message); }
  check(`${label}: no console/page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

await session('desktop', { width: 1100, height: 700, deviceScaleFactor: 1 }, false, async (page) => {
  const ev = (f) => page.evaluate(f);
  check('loader dismissed', await ev(() => document.getElementById('loader').classList.contains('done')));
  const lab0 = await ev(() => document.getElementById('btn-play').getAttribute('aria-label'));
  await page.click('#btn-play');
  const lab1 = await ev(() => document.getElementById('btn-play').getAttribute('aria-label'));
  check('play/pause toggles', lab0 === 'Pause' && lab1 === 'Play', `${lab0} -> ${lab1}`);
  const c1 = await ev(() => window.__lotus.frame.clock);
  await new Promise((r) => setTimeout(r, 700));
  const c2 = await ev(() => window.__lotus.frame.clock);
  check('paused clock holds', Math.abs(c2 - c1) < 0.02, `${c1.toFixed(2)} -> ${c2.toFixed(2)}`);
  await page.click('#btn-play');
  await new Promise((r) => setTimeout(r, 700));
  const c3 = await ev(() => window.__lotus.frame.clock);
  check('resumed clock advances', c3 > c2 + 0.3, `${c2.toFixed(2)} -> ${c3.toFixed(2)}`);

  // scrubber: click at 60% of the track
  const box = await (await page.$('#scrub')).boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 500));
  const clk = await ev(() => window.__lotus.frame.clock);
  check('scrubber seeks the timeline', clk > 14 && clk < 28, `clock=${clk.toFixed(1)}s (36s total)`);
  const bl = await ev(() => window.__lotus.frame.bloom);
  check('bloom follows the scrubber', bl > 0.2 && bl < 0.95, `bloom=${bl.toFixed(2)}`);

  await page.click('#btn-replay');
  await new Promise((r) => setTimeout(r, 400));
  const cr = await ev(() => window.__lotus.frame.clock);
  check('replay restarts the clock', cr < 2.0, `clock=${cr.toFixed(2)}`);

  // quality menu
  await page.click('#btn-quality');
  check('quality menu opens', await ev(() => !document.getElementById('menu').hidden));
  await page.keyboard.press('Escape');
  check('Escape closes the menu', await ev(() => document.getElementById('menu').hidden));

  // mouse orbit hands over from the cinematic camera
  const p0 = await ev(() => window.__lotus.camera.position.toArray());
  await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.move(700, 280, { steps: 8 }); await page.mouse.up();
  await new Promise((r) => setTimeout(r, 400));
  const p1 = await ev(() => window.__lotus.camera.position.toArray());
  const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  check('mouse drag orbits the camera', moved > 0.3, `moved ${moved.toFixed(2)}`);
  check('rig switched to user mode', (await ev(() => window.__lotus.rig.mode)) === 'user');
  const camY = await ev(() => window.__lotus.camera.position.y);
  check('camera stays above the water', camY > 0.4, `y=${camY.toFixed(2)}`);

  await page.keyboard.press('Space');
  check('Space pauses', (await ev(() => document.getElementById('btn-play').getAttribute('aria-label'))) === 'Play');
  await page.keyboard.press('Space');

  // 2K capture through the pipeline
  const cap = await ev(async () => { const b = await window.__lotus.pipeline.capture({ width: 1920, height: 1080 }); return { size: b.size, type: b.type }; });
  check('capture returns a PNG', cap.type === 'image/png' && cap.size > 80000, `${cap.type} ${Math.round(cap.size / 1024)} KB`);
  const after = await ev(() => ({ w: window.__lotus.renderer.domElement.width, h: window.__lotus.renderer.domElement.height, a: window.__lotus.camera.aspect }));
  check('canvas restored after capture', Math.abs(after.w / after.h - after.a) < 0.02, `${after.w}x${after.h}`);

  // bar auto-hides
  await new Promise((r) => setTimeout(r, 4800));
  check('control bar auto-hides', await ev(() => document.getElementById('bar').classList.contains('hidden')));
  await page.mouse.move(520, 320);
  check('control bar returns on activity', await ev(() => !document.getElementById('bar').classList.contains('hidden')));
});

await session('phone portrait + touch', { width: 390, height: 844, deviceScaleFactor: 2 }, true, async (page) => {
  const ev = (f) => page.evaluate(f);
  check('no horizontal scroll', await ev(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const bar = await (await page.$('#bar')).boundingBox();
  check('control bar fits the viewport', bar.x >= 0 && bar.x + bar.width <= 391 && bar.y + bar.height <= 844, `${Math.round(bar.x)},${Math.round(bar.y)} ${Math.round(bar.width)}x${Math.round(bar.height)}`);
  const btn = await (await page.$('#btn-play')).boundingBox();
  check('touch targets >= 42px', btn.width >= 42 && btn.height >= 42, `${btn.width}x${btn.height}`);
  const asp = await ev(() => window.__lotus.camera.aspect);
  const fov = await ev(() => window.__lotus.camera.fov);
  check('portrait widens the fov', fov > 36, `aspect ${asp.toFixed(2)} fov ${fov.toFixed(1)}`);
  const p0 = await ev(() => window.__lotus.camera.position.toArray());
  await page.touchscreen.touchStart(120, 300);
  await page.touchscreen.touchMove(260, 300);
  await page.touchscreen.touchMove(300, 290);
  await page.touchscreen.touchEnd();
  await new Promise((r) => setTimeout(r, 400));
  const p1 = await ev(() => window.__lotus.camera.position.toArray());
  check('one-finger touch orbits', Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) > 0.2);
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 600));
  const a2 = await ev(() => window.__lotus.camera.aspect);
  check('rotation to landscape updates aspect', a2 > 1.8, `aspect ${a2.toFixed(2)}`);
  const c = await ev(() => { const r = window.__lotus.renderer.domElement; return [r.width, r.height]; });
  check('canvas follows the viewport', Math.abs(c[0] / c[1] - 844 / 390) < 0.08, `${c[0]}x${c[1]}`);
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed }));
process.exit(failed.length ? 1 : 0);
