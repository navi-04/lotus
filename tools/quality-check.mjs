#!/usr/bin/env node
/**
 * Unit checks for quality resolution (no browser): node tools/quality-check.mjs
 * A fake GPU, device and storage stand in for the browser, so priority (URL > saved > default), the safety nets, phone defaults and
 * blocked storage are all checked deterministically - including the software-renderer-vs-saved-pick bug found in the audit.
 */
import { getParams } from '../src/core/params.js';
import { resolveQuality, storeQuality, TIERS, DEFAULT_TIER, TIER_ORDER } from '../src/core/quality.js';

let failed = 0, total = 0;
const check = (name, ok, info = '') => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };

const NOW = 1_700_000_000_000;
Date.now = () => NOW;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
class FakeWebGL2 {}
define('WebGL2RenderingContext', FakeWebGL2);

const NVIDIA = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)';
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const ADRENO = 'Adreno (TM) 740';

/** a browser-ish world: storage, screen, touch; returns the helpers */
function world({ renderer = NVIDIA, mobile = false, dpr = 1, store = {}, blocked = false } = {}) {
  const data = new Map(Object.entries(store));
  if (blocked) {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  } else {
    define('localStorage', { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); }, removeItem: (k) => { data.delete(k); } });
  }
  define('window', { matchMedia: () => ({ matches: mobile }), screen: { width: mobile ? 390 : 1920, height: mobile ? 844 : 1080 }, devicePixelRatio: dpr });
  define('navigator', { maxTouchPoints: mobile ? 5 : 0, hardwareConcurrency: 8, deviceMemory: 8, userAgent: '' });
  const gl = new FakeWebGL2();
  Object.assign(gl, { RENDERER: 1, VENDOR: 2, MAX_TEXTURE_SIZE: 3, MAX_SAMPLES: 4 });
  gl.getExtension = (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 11, UNMASKED_VENDOR_WEBGL: 12 } : null);
  gl.getParameter = (p) => ({ 11: renderer, 12: 'vendor', 1: renderer, 2: 'vendor', 3: 16384, 4: 8 })[p];
  return { data, gl };
}
const q = (search = '', opts = {}) => { const w = world(opts); return { ...resolveQuality({ gl: w.gl, params: getParams(search) }), _data: w.data }; };
const safe = (n, ageDays = 0) => ({ 'lotus.safe': `${n}@${NOW - ageDays * 864e5}` });

// ---- defaults and priority -------------------------------------------------------------------------------------------------
check('the default tier is ultra', DEFAULT_TIER === 'ultra' && TIER_ORDER[TIER_ORDER.length - 1] === 'ultra');
{
  const r = q();
  check('nothing set -> ultra, source default, not auto, nothing demoted', r.tier === 'ultra' && r.source === 'default' && !r.auto && r.demoted === 0 && r.reason === null, `${r.tier} ${r.source}`);
}
check('URL ?quality=low wins', q('?quality=low').tier === 'low' && q('?quality=low').source === 'url');
check('URL value is trimmed and case-insensitive', q('?quality=%20HIGH%20').tier === 'high');
check('URL beats a saved pick', q('?quality=high', { store: { 'lotus.quality': 'medium' } }).tier === 'high');
check('a saved Medium is honoured', (() => { const r = q('', { store: { 'lotus.quality': 'medium' } }); return r.tier === 'medium' && r.source === 'stored'; })());
check('a saved Auto matches the device (RTX -> ultra) and says auto', (() => { const r = q('', { store: { 'lotus.quality': 'auto' } }); return r.auto && r.tier === 'ultra' && r.source === 'stored'; })());
check('?quality=auto on a phone GPU picks a phone tier, not ultra', (() => { const r = q('?quality=auto', { renderer: ADRENO, mobile: true, dpr: 3 }); return r.auto && r.tier === 'high'; })());
for (const junk of ['turbo', '__proto__', 'constructor', 'hasOwnProperty', '', '0']) {
  check(`junk ?quality=${junk} is ignored`, q(`?quality=${junk}`).tier === 'ultra' && q(`?quality=${junk}`).source === 'default');
}
check('junk in storage is ignored', q('', { store: { 'lotus.quality': 'turbo' } }).source === 'default');

// ---- software renderer ----------------------------------------------------------------------------------------------------
{
  const r = q('', { renderer: SWIFTSHADER });
  check('software renderer: the DEFAULT is lowered to low, reason software', r.tier === 'low' && r.demoted === 1 && r.reason === 'software', `${r.tier} ${r.reason}`);
}
{
  const r = q('', { renderer: SWIFTSHADER, store: { 'lotus.quality': 'ultra' } });
  check('software renderer: a saved Ultra pick is honoured (the audit bug: it used to force Low again)', r.tier === 'ultra' && r.demoted === 0 && r.reason === null && r.source === 'stored', `${r.tier} demoted=${r.demoted}`);
}
check('software renderer: ?quality=ultra is honoured', q('?quality=ultra', { renderer: SWIFTSHADER }).tier === 'ultra');
check('software renderer: saved Auto -> low (the device guess)', q('', { renderer: SWIFTSHADER, store: { 'lotus.quality': 'auto' } }).tier === 'low');
check('software renderer already on low is not "demoted" twice', (() => { const r = q('?quality=low', { renderer: SWIFTSHADER }); return r.tier === 'low' && r.demoted === 0; })());

// ---- the crash step-down ---------------------------------------------------------------------------------------------------
for (const [n, want] of [[1, 'high'], [2, 'medium'], [3, 'low'], [9, 'low']]) {
  const r = q('', { store: safe(n) });
  check(`step-down of ${n} -> ${want}`, r.tier === want && r.reason === 'crash' && r.demoted === Math.min(n, 3), `${r.tier} demoted=${r.demoted}`);
}
check('an explicit URL tier ignores the step-down', (() => { const r = q('?quality=ultra', { store: safe(3) }); return r.tier === 'ultra' && r.demoted === 0; })());
check('a saved pick is lowered by a later crash too', (() => { const r = q('', { store: { 'lotus.quality': 'ultra', ...safe(1) } }); return r.tier === 'high' && r.source === 'stored' && r.demoted === 1; })());
check('a step-down older than a week has expired', (() => { const r = q('', { store: safe(3, 8) }); return r.tier === 'ultra' && r.demoted === 0; })());
check('a step-down just under a week old still applies', q('', { store: safe(1, 6.9) }).tier === 'high');
check('a software renderer plus a step-down cannot go below low', (() => { const r = q('', { renderer: SWIFTSHADER, store: safe(2) }); return r.tier === 'low' && r.demoted === 1; })());
check('a garbage step-down value is ignored', q('', { store: { 'lotus.safe': 'lots' } }).tier === 'ultra');

// ---- resolution numbers ---------------------------------------------------------------------------------------------------
{
  const d = q('', { dpr: 1 });
  check('desktop at 1x: the ultra floor is 0.75 so a 1x display can adapt, start 1, ceiling 3', d.dprMin === 0.75 && d.dprStart === 1 && d.dprMax === 3 && !d.isMobile, JSON.stringify({ min: d.dprMin, start: d.dprStart }));
  const d3 = q('', { dpr: 3 });
  check('desktop at 3x starts at 3x', d3.dprStart === 3 && d3.msaa === 4);
  const m = q('', { renderer: ADRENO, mobile: true, dpr: 3 });
  check('phone at 3x: starts at 2x (smaller boot allocations), ceiling still 3, no MSAA (SMAA instead)', m.dprStart === 2 && m.dprMax === 3 && m.msaa === 0 && m.isMobile && m.tier === 'ultra', JSON.stringify({ start: m.dprStart, msaa: m.msaa, tier: m.tier }));
  const m15 = q('', { renderer: ADRENO, mobile: true, dpr: 1.5 });
  check('phone at 1.5x starts at 1.5x', m15.dprStart === 1.5);
  const fixed = q('?dpr=1.25');
  check('?dpr pins the pixel ratio and switches adaptation off', fixed.fixedDpr && fixed.dprStart === 1.25 && fixed.dprMin === 1.25 && fixed.dprMax === 1.25);
  check('every tier keeps a sane floor below its ceiling', Object.values(TIERS).every((t) => t.dprMin < t.dprMax && t.dprMin > 0));
}

// ---- storing a pick ---------------------------------------------------------------------------------------------------------
{
  const w = world({ store: { 'lotus.quality': 'low', ...safe(2) } });
  const ok = storeQuality('high');
  check('storeQuality saves the pick, reports success and clears any step-down', ok === true && w.data.get('lotus.quality') === 'high' && !w.data.has('lotus.safe'));
  check('storeQuality("auto") is stored explicitly', (() => { world(); const w2 = world(); storeQuality('auto'); return w2.data.get('lotus.quality') === 'auto'; })());
  const w3 = world({ store: { 'lotus.quality': 'low' } });
  storeQuality('nonsense');
  check('storeQuality ignores nonsense by clearing the pick', !w3.data.has('lotus.quality'));
  world({ blocked: true });
  let result = null, threw = false;
  try { result = storeQuality('low'); } catch (e) { threw = true; }
  check('blocked storage: storeQuality returns false and never throws', result === false && !threw);
  const r = q('', { blocked: true });
  check('blocked storage: resolution still works and falls back to the default', r.tier === 'ultra' && r.source === 'default');
}

console.log(JSON.stringify({ total, failed }));
process.exit(failed ? 1 : 0);
