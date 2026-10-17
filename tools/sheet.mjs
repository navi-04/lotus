#!/usr/bin/env node
/**
 * Contact sheet: node tools/sheet.mjs --out shots/sheet.png --cols 3 --label "a,b,c" img1.png img2.png img3.png
 * Options: --out --cols (default 3) --label "l1,l2,.." --width <px per column> (default 640)
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = {}; const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const next = argv[i + 1]; if (next === undefined || next.startsWith('--')) opt[a.slice(2)] = true; else { opt[a.slice(2)] = next; i++; } }
  else files.push(a);
}
const COLS = parseInt(opt.cols || 3, 10), CW = parseInt(opt.width || 640, 10);
const labels = String(opt.label || '').split(',');
const out = opt.out && opt.out !== true ? opt.out : 'shots/sheet.png';
const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const items = files.map((f, i) => `<figure><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}"><figcaption>${labels[i] || f}</figcaption></figure>`).join('');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || exe, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: CW * COLS, height: 400 });
await page.setContent(`<!doctype html><meta charset=utf-8><style>body{margin:0;background:#101214;color:#cfd6dc;font:600 13px system-ui}.g{display:grid;grid-template-columns:repeat(${COLS},${CW}px)}figure{margin:0;padding:4px;box-sizing:border-box}img{display:block;width:100%;height:auto}figcaption{padding:3px 2px 6px}</style><div class=g>${items}</div>`, { waitUntil: 'load' });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(JSON.stringify({ ok: true, out, n: files.length }));
