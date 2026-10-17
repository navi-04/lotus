/**
 * Quality tiers + device detection.
 *
 * DEFAULT = ULTRA, everywhere. "Auto" (match the device) is opt-in via the Quality menu / ?quality=auto. What keeps max-by-default
 * safe on weak hardware: the adaptive pixel ratio (render/pipeline) and two silent safety nets - software renderers start on
 * 'low', and a context loss / a boot that never reached its first frames steps the *default* down one tier on the next load
 * (see core/crashGuard.js). An explicit ?quality= in the URL is always honoured as-is.
 *
 * The tier is chosen ONCE at boot (changing it = reload with ?quality=). Modules read `ctx.quality`:
 *   quality.tier        'low' | 'medium' | 'high' | 'ultra'   (pick your own per-module LOD tables from this)
 *   quality.lod         geometry density multiplier (0.5 / 0.7 / 1 / 1.4) - scale segment counts with it
 *   quality.shadowMap   shadow map size in px (0 = shadows off)
 *   quality.reflection  planar water reflection scale relative to the drawing buffer (0 = off, use env-map only)
 *   quality.dof         depth-of-field on/off
 *   quality.msaa        MSAA samples for the post-processing buffers
 *   quality.bloomScale  bloom resolution scale
 *   quality.particles   multiplier for particle counts (pollen, fireflies, bokeh)
 *   quality.dprMax / dprMin   pixel-ratio ceiling / floor for the adaptive-resolution controller
 *   quality.isMobile / isTouch / gpu / caps
 *
 * Adaptive resolution (render/pipeline or app) moves the pixel ratio between dprMin..min(devicePixelRatio, dprMax)
 * to hold ~50-60 fps. Tier itself never changes at runtime.
 */
import { getParams } from './params.js';
import { local } from './storage.js';
import { readSafe, clearSafe } from './crashGuard.js';

export const TIER_ORDER = ['low', 'medium', 'high', 'ultra'];

export const TIERS = {
  low:    { dprMax: 1.0, dprMin: 0.6,  msaa: 0, shadowMap: 0,    reflection: 0,    dof: false, bloomScale: 0.25, particles: 0.3,  lod: 0.5 },
  medium: { dprMax: 1.5, dprMin: 0.60, msaa: 0, shadowMap: 1024, reflection: 0.3,  dof: false, bloomScale: 0.35, particles: 0.5,  lod: 0.7 },
  high:   { dprMax: 2.0, dprMin: 0.70, msaa: 2, shadowMap: 2048, reflection: 0.5,  dof: true,  bloomScale: 0.5,  particles: 0.8, lod: 1.0 },
  ultra:  { dprMax: 3.0, dprMin: 0.75, msaa: 4, shadowMap: 4096, reflection: 0.75, dof: true,  bloomScale: 0.5,  particles: 1.0, lod: 1.4 },
};

export const DEFAULT_TIER = 'ultra';

const STORE_KEY = 'lotus.quality';     // the user's explicit pick from the Quality menu: a tier or 'auto'

function readGpuFromContext(gl) {
  const info = { renderer: '', vendor: '', webgl2: false, maxTexture: 0, maxSamples: 0 };
  try {
    info.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    info.renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    info.vendor = String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
    info.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;
    info.maxSamples = info.webgl2 ? gl.getParameter(gl.MAX_SAMPLES) | 0 : 0;
  } catch (e) { /* ignore */ }
  return info;
}

/** Probe the GPU without touching the real renderer. */
export function sniffGpu() {
  try {
    const c = document.createElement('canvas');
    const attrs = { powerPreference: 'high-performance' };         // judge the same GPU the renderer will use (hybrid laptops)
    const gl = c.getContext('webgl2', attrs) || c.getContext('webgl', attrs);
    if (!gl) return { renderer: '', vendor: '', webgl2: false, maxTexture: 0, maxSamples: 0 };
    const info = readGpuFromContext(gl);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return info;
  } catch (e) {
    return { renderer: '', vendor: '', webgl2: false, maxTexture: 0, maxSamples: 0 };
  }
}

export function detectDevice() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const win = typeof window !== 'undefined' ? window : {};
  const coarse = !!(win.matchMedia && win.matchMedia('(pointer: coarse)').matches);
  const isTouch = coarse || (nav.maxTouchPoints || 0) > 1;
  const shortSide = Math.min(win.screen ? win.screen.width : 1024, win.screen ? win.screen.height : 768);
  const isMobile = isTouch && shortSide < 900;
  return {
    isTouch,
    isMobile,
    cores: nav.hardwareConcurrency || 4,
    memoryGB: nav.deviceMemory || 0,
    devicePixelRatio: win.devicePixelRatio || 1,
    ua: nav.userAgent || '',
  };
}

/** Heuristic starting tier. The adaptive pixel ratio does the fine tuning afterwards. */
export function guessTier(gpu, dev) {
  const r = (gpu.renderer || '').toLowerCase();
  if (!gpu.webgl2) return 'low';
  if (/swiftshader|llvmpipe|software|basic render/.test(r)) return 'low';
  if (dev.isMobile) {
    if (/apple/.test(r)) return dev.cores >= 6 && dev.devicePixelRatio >= 3 ? 'high' : 'medium';
    const adreno = /adreno[^0-9]*([0-9]{3})/.exec(r);
    if (adreno) return parseInt(adreno[1], 10) >= 650 ? 'high' : 'medium';
    const mali = /mali-g([0-9]{2,3})/.exec(r);
    if (mali) return parseInt(mali[1], 10) >= 77 ? 'high' : 'medium';
    return 'medium';
  }
  if (/nvidia|geforce|rtx|gtx|radeon rx|radeon pro|apple m[0-9]|apple gpu/.test(r)) return 'ultra';
  if (/intel/.test(r)) return /arc/.test(r) ? 'ultra' : 'high';
  return 'high';
}

const isChoice = (v) => v === 'auto' || (typeof v === 'string' && Object.prototype.hasOwnProperty.call(TIERS, v));

/**
 * @param {{gl?: WebGLRenderingContext|WebGL2RenderingContext, params?: ReturnType<typeof getParams>}} [opts]
 */
export function resolveQuality({ gl, params = getParams() } = {}) {
  const gpu = gl ? readGpuFromContext(gl) : sniffGpu();
  const dev = detectDevice();

  // who decides: the URL (absolute) > the user's saved pick > the default (max)
  const fromUrl = isChoice(params.quality) ? params.quality : null;
  const saved = local.get(STORE_KEY);
  const fromStore = !fromUrl && isChoice(saved) ? saved : null;
  const choice = fromUrl || fromStore || DEFAULT_TIER;
  const source = fromUrl ? 'url' : fromStore ? 'stored' : 'default';

  const auto = choice === 'auto';
  let tier = auto ? guessTier(gpu, dev) : choice;

  // Safety nets. Neither overrides an explicit ?quality=. A software renderer lowers the DEFAULT only: a pick made in the Quality menu
  // (stored) is honoured exactly like the URL, otherwise "Quality > Ultra" could never undo it.
  let demoted = 0, reason = null;
  if (!fromUrl) {
    const software = /swiftshader|llvmpipe|software|basic render/i.test(gpu.renderer || '');
    if (software && source === 'default' && TIER_ORDER.indexOf(tier) > 0) { tier = 'low'; demoted = 1; reason = 'software'; }
    const at = TIER_ORDER.indexOf(tier);
    const to = Math.max(0, at - readSafe());
    if (to < at) { demoted += at - to; tier = TIER_ORDER[to]; reason = reason || 'crash'; }
  }
  const base = TIERS[tier];

  const dprCap = Math.min(dev.devicePixelRatio, base.dprMax);
  const fixedDpr = params.dpr != null;
  // Phones start at 2x even when the screen is 3x: the render targets are allocated at the start pixel ratio, and a 3x start is the
  // biggest memory spike of the whole boot. The adaptive controller climbs to the full ratio when the device has headroom.
  const dprStart = fixedDpr ? params.dpr : (dev.isMobile ? Math.min(dprCap, 2) : dprCap);

  return {
    tier,
    auto,
    choice,                // what was asked for: 'auto' or a tier name (before the safety nets)
    source,                // 'url' | 'stored' | 'default'
    demoted,               // tiers stepped down by a safety net (0 = running exactly what was asked for)
    reason,                // why: 'software' (no real GPU) | 'crash' (a lost context / a boot that died) | null
    ...base,
    dprMax: fixedDpr ? params.dpr : base.dprMax,
    dprMin: fixedDpr ? params.dpr : Math.min(base.dprMin, dprCap),
    msaa: dev.isMobile ? 0 : base.msaa,        // multisampled half-float targets are the riskiest feature on phones; SMAA is used instead
    dprStart,
    fixedDpr,
    isMobile: dev.isMobile,
    isTouch: dev.isTouch,
    gpu,
    caps: { maxTexture: gpu.maxTexture, maxSamples: gpu.maxSamples },
    device: dev,
  };
}

/**
 * Persist the user's explicit choice (a tier or 'auto') and clear any automatic step-down. Caller reloads the page afterwards.
 * Returns false when the pick could not be stored (blocked storage): the caller then keeps it in the URL instead.
 */
export function storeQuality(value) {
  const ok = local.set(STORE_KEY, isChoice(value) ? value : null);
  clearSafe();
  return ok;
}
