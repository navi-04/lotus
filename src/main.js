/**
 * App entry. Boots the scene in small yielding steps behind a loading screen, then runs the frame loop:
 *   stepFrame -> environment -> stem -> petals -> pod -> stamens -> leaves -> water -> camera rig -> pipeline.render
 * QA hooks kept for tools/shot.mjs & tools/qa.mjs: URL params (src/core/params.js), window.__lotus, window.__LOTUS_READY__.
 */
import * as THREE from 'three';
import { getParams } from './core/params.js';
import { resolveQuality, storeQuality } from './core/quality.js';
import { armCrashGuard } from './core/crashGuard.js';
import { SCENE, SUN, TIMELINE } from './core/constants.js';
import { makeRng } from './core/rng.js';
import { createFrame, stepFrame, smoothstep } from './core/timeline.js';
import { resolveRoute } from './app/routes.js';
import { createRenderer } from './render/renderer.js';
import { createPipeline } from './render/pipeline.js';
import { createEnvironment } from './world/environment.js';
import { createWater } from './world/water.js';
import { createStem } from './lotus/stem.js';
import { createPetals } from './lotus/petals.js';
import { createPod } from './lotus/pod.js';
import { createStamens } from './lotus/stamens.js';
import { createLeaves } from './lotus/leaves.js';
import { createSparkles } from './world/sparkles.js';
import { createCameraRig, lensShiftFor } from './app/cameraRig.js';
import { createUI } from './ui/controls.js';
import { createGreeting } from './ui/greeting.js';

/**
 * @typedef {object} Ctx  Shared context handed to every module factory: createX(ctx).
 * @property {THREE.WebGLRenderer} renderer
 * @property {THREE.Scene} scene
 * @property {THREE.PerspectiveCamera} camera
 * @property {ReturnType<typeof resolveQuality>} quality
 * @property {ReturnType<typeof getParams>} params
 * @property {ReturnType<typeof makeRng>} rng         root RNG - always `ctx.rng.fork('mymodule')`
 * @property {{direction: THREE.Vector3, color: THREE.Color, intensity: number}} sun   mutate in place, never replace
 * @property {ReturnType<typeof createFrame>} frame   the shared per-frame state (same object every frame)
 * @property {(x:number, z:number, strength?:number) => void} ripple   water ripple event (water module installs it)
 * @property {{leafDisks: Array<{x:number, z:number, r:number}>}} pondLayout   leaves push their floating discs here; water reads it lazily
 * @property {(...args:any[]) => void} log            debug logger (silent unless ?debug=1)
 */

const $ = (id) => document.getElementById(id);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const params = getParams();

// which page is this (/, /home, /nivashini ...)? See src/app/routes.js
const route = resolveRoute();
document.documentElement.dataset.route = route.id;
document.documentElement.dataset.kind = route.kind;
document.title = route.title;

function setProgress(p, text) {
  const fill = $('loader-fill');
  if (fill) fill.style.width = `${Math.round(p * 100)}%`;
  if (text && $('loader-text')) $('loader-text').textContent = text;
}

function showFatal(err) {
  console.error(err);
  const loader = $('loader');
  if (!loader) return;
  loader.classList.remove('done');
  // Built from nodes, not markup: error and shader-log text can contain "<".
  const p = document.createElement('p');
  p.style.cssText = 'max-width:34ch;text-align:center;line-height:1.6;text-transform:none;letter-spacing:0';
  const small = document.createElement('small');
  small.style.opacity = '.7';
  small.textContent = String((err && err.message) || err).slice(0, 160);
  const retry = document.createElement('a');
  retry.style.color = '#f08cb4';
  retry.textContent = 'Try low quality';
  const u = new URL(location.href);               // keeps the page (?route=) and every other parameter
  u.searchParams.set('quality', 'low');
  retry.href = u.toString();
  p.append("The lotus couldn't start on this device.", document.createElement('br'), small, document.createElement('br'), document.createElement('br'), retry);
  loader.replaceChildren(p);
}

async function boot() {
  setProgress(0.04, route.loaderText || 'Preparing the pond…');
  await nextFrame();

  const guard = await armCrashGuard();    // a boot that dies before rendering steps the default quality down next time
  const canvas = $('scene');
  const quality = resolveQuality({ params });
  if (!quality.gpu.webgl2) throw new Error('WebGL2 is not available in this browser.');
  const renderer = createRenderer(canvas, quality, { post: !params.hide.has('post') });
  renderer.info.autoReset = false;      // we reset once per frame so stats cover every pass (shadow, reflection, post)
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(SCENE.camera.fov, 1, SCENE.camera.near, SCENE.camera.far);
  const frame = createFrame();
  frame.camera = camera;

  const sunDir = new THREE.Vector3();
  {
    const az = THREE.MathUtils.degToRad(SUN.azimuthDeg);
    const el = THREE.MathUtils.degToRad(SUN.elevationDeg);
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
  }

  /** @type {Ctx} */
  const ctx = {
    renderer, scene, camera, quality, params, frame,
    rng: makeRng(params.seed ?? SCENE.seed),
    sun: { direction: sunDir, color: new THREE.Color(SUN.color), intensity: SUN.intensity },
    ripple: () => {},
    pondLayout: { leafDisks: [] },
    log: params.debug ? (...a) => console.log('[lotus]', ...a) : () => {},
  };

  // ---- build the world in yielding steps --------------------------------------------------------------------------
  const steps = [
    ['env', createEnvironment, 'Painting the dawn sky…'],
    ['water', createWater, 'Stilling the water…'],
    ['stem', createStem, 'Raising the stalk…'],
    ['petals', createPetals, 'Folding the petals…'],
    ['pod', createPod, 'Setting the seeds…'],
    ['stamens', createStamens, 'Dusting the stamens…'],
    ['leaves', createLeaves, 'Floating the leaves…'],
  ];
  if (route.kind === 'birthday') steps.push(['sparkles', createSparkles, 'Gathering the pollen-light…']);
  const mods = {};
  let n = 0;
  for (const [name, factory, label] of steps) {
    setProgress(0.08 + 0.6 * (n / steps.length), label);
    await nextFrame();
    n++;
    if (params.hide.has(name)) continue;
    mods[name] = factory(ctx);
  }
  const stem = mods.stem;
  for (const [name, m] of Object.entries(mods)) {
    const head = stem && (name === 'petals' || name === 'pod' || name === 'stamens');
    (head ? stem.headAnchor : scene).add(m.group);
  }
  if (!stem) for (const k of ['petals', 'pod', 'stamens']) if (mods[k]) scene.add(mods[k].group);

  setProgress(0.74, 'Gathering the light…');
  await nextFrame();
  const pipeline = createPipeline(ctx);
  const rig = createCameraRig(ctx, canvas);

  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // birthday pages: the lettering that writes itself over the sky (fonts are loaded before the loader lifts)
  let greeting = null;
  if (route.kind === 'birthday' && route.greeting && !params.hide.has('greeting')) {
    setProgress(0.78, 'Lettering the sky…');
    try {
      greeting = await createGreeting(route.greeting, { reduced: reducedMotion });
      await greeting.ready;
    } catch (e) { console.warn('Greeting unavailable:', e); greeting = null; }
  }

  // ---- timeline state ----------------------------------------------------------------------------------------------
  const state = { playing: true, scrub: null };
  const frozenFromUrl = params.freeze ? { bloom: params.bloom, rise: params.rise, t: params.t } : null;
  const order = ['env', 'stem', 'petals', 'pod', 'stamens', 'leaves', 'sparkles', 'water'];

  function resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    rig.setAspect(w / h);
    pipeline.setSize(w, h, sizedOnce ? undefined : quality.dprStart);
    sizedOnce = true;
  }
  let sizedOnce = false;
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));
  resize();

  /** route-specific layers that follow the timeline: the lettering and the lens shift that makes room for it */
  function applyRouteState() {
    if (greeting) greeting.update(frame);
    if (route.kind === 'birthday') {
      // The picture slides down over the bloom to make room for the lettering. With reduced motion it simply starts there.
      const shift = lensShiftFor(camera.aspect);
      rig.setLensShift(reducedMotion ? shift : shift * smoothstep(0.30, 0.72, frame.bloom));
    }
  }

  // prime one frame so focus/flowerRadius are valid before the first camera placement
  stepFrame(frame, 0, { playing: false, frozen: frozenFromUrl, stillTime: true });
  for (const k of order) mods[k]?.update(frame);
  applyRouteState();
  if (rig.cinematic) rig.update(0.016);
  else rig.setView(params.cam || 'default');

  setProgress(0.82, 'Compiling shaders…');
  await nextFrame();
  try { if (renderer.compileAsync) await renderer.compileAsync(scene, camera); } catch (e) { ctx.log('compileAsync failed', e); }

  /** draw the greeting (as it was when the button was pressed: `snap`) onto the captured picture */
  async function withGreeting(blob, snap) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    greeting.paintOnto(g, c.width, c.height, snap);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
  }

  // ---- app api (UI) --------------------------------------------------------------------------------------------------
  const ui = createUI({
    getProgress: () => Math.min(1, frame.clock / TIMELINE.total),
    isPlaying: () => state.playing,
    setPlaying: (b) => { state.playing = !!b; state.scrub = null; },
    replay: () => { frame.clock = 0; state.playing = true; state.scrub = null; rig.restart(); },
    seek: (f) => { state.scrub = f * TIMELINE.total; frame.clock = state.scrub; },   // also commit the clock so a quick tap sticks
    qualityName: quality.auto ? 'auto' : quality.tier,
    setQuality(q) {
      const stored = storeQuality(q);
      const u = new URL(location.href);
      // With storage blocked (cookies off, some in-app browsers) the pick travels in the URL instead of silently coming back as Ultra.
      if (stored) u.searchParams.delete('quality'); else u.searchParams.set('quality', q);
      location.href = u.toString();
    },
    canFullscreen: !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen),
    toggleFullscreen() {
      const el = document.documentElement;
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    },
    async capture() {
      // Measure the lettering NOW, before the 4K render and the asynchronous encode: the picture is of this exact frame, and a
      // rotation, a resize or seconds of timeline passing while it is saved cannot move or advance the text (see greeting.snapshot).
      const snap = greeting ? greeting.snapshot() : null;
      const a = camera.aspect;
      const W = a >= 1 ? 3840 : Math.round(3840 * a);
      const H = a >= 1 ? Math.round(3840 / a) : 3840;
      ui.toast('Rendering a high-resolution picture…', 2500);
      let blob = await pipeline.capture({ width: W, height: H });
      let filename = 'lotus-bloom.png';
      if (greeting) {
        // the lettering is DOM text over the canvas, so paint it onto the picture too: the saved image is the finished card
        try { blob = await withGreeting(blob, snap); filename = `happy-birthday-${route.id}.png`; } catch (e) { ctx.log('greeting not added to the picture', e); }
      }
      const file = new File([blob], filename, { type: 'image/png' });
      if (quality.isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: route.title }); return; } catch (e) { /* cancelled -> fall through to download */ }
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      ui.toast(`Saved ${filename}`);
    },
  });

  // the GPU keeps resetting and the loop breaker stopped reloading: say so instead of leaving a frozen canvas unexplained
  window.addEventListener('lotus:context-stuck', () => ui.toast('The graphics driver keeps resetting — try Quality › Low', 9000));

  // ---- frame loop ------------------------------------------------------------------------------------------------------
  const hud = $('hud');
  if (params.debug && hud) hud.hidden = false;
  let last = performance.now();
  let rendered = 0;
  let slowFor = 0, warnedSlow = false;
  let hudT = 0;

  function tick(dt) {
    const frozen = frozenFromUrl || (state.scrub != null ? { t: state.scrub } : null);
    stepFrame(frame, dt, { playing: state.playing, frozen, stillTime: params.still });
    for (const k of order) mods[k]?.update(frame);
    applyRouteState();
    rig.update(Math.max(dt, 1e-3));
    ui.update();
    renderer.info.reset();
    pipeline.render(frame);

    // gentle hint when even the lowest resolution can't hold frame rate
    const inf = pipeline.info();
    if (!warnedSlow && !quality.fixedDpr && quality.tier !== 'low' && inf.dpr <= quality.dprMin + 0.01 && inf.frameMs > 38) {
      slowFor += dt;
      if (slowFor > 6) { warnedSlow = true; ui.toast(`Running slowly — try Quality › ${quality.tier === 'medium' ? 'Low' : 'Medium'}`, 6000); }
    } else slowFor = Math.max(0, slowFor - dt);

    if (hud && !hud.hidden) {
      hudT += dt;
      if (hudT > 0.4) {
        hudT = 0;
        const i = renderer.info.render;
        hud.textContent = `${quality.tier}${quality.auto ? ' (auto)' : ''}  dpr ${inf.dpr.toFixed(2)}  ${inf.frameMs.toFixed(1)} ms\ncalls ${i.calls}  tris ${(i.triangles / 1000).toFixed(0)}k\nbloom ${frame.bloom.toFixed(2)}  rise ${frame.rise.toFixed(2)}  t ${frame.clock.toFixed(1)}`;
      }
    }
  }

  function loop(now) {
    const dt = (now - last) / 1000;
    last = now;
    tick(dt);
    if (++rendered === 4) {
      window.__LOTUS_READY__ = true;
      $('loader').classList.add('done');
      if (!frozenFromUrl && route.kind === 'bloom') setTimeout(() => ui.showTitle(), 700);
      // told the user once if a safety net (not their choice) is running a lower tier than requested
      if (quality.demoted && quality.source !== 'url') {
        const why = quality.reason === 'software'
          ? 'No graphics card found, so this runs on Low — Quality › Ultra overrides it'
          : 'Quality was lowered after a problem on this device — Quality › Ultra restores it';
        setTimeout(() => ui.toast(why, 7000), 1200);
      }
    }
    if (rendered === 20) guard.disarm();                   // frames are flowing: this boot did not crash
    requestAnimationFrame(loop);
  }
  setProgress(1, 'Opening…');
  requestAnimationFrame(loop);

  window.__lotus = {
    ctx, mods, scene, camera, renderer, frame, controls: rig.controls, pipeline, rig, route, greeting, quality,
    setCamera: rig.setView,
    setBloom(b) { if (frozenFromUrl) frozenFromUrl.bloom = b; },
    setTime(t) { state.scrub = t; },
    glInfo: quality.gpu,
    stats() {
      const i = renderer.info;
      return {
        drawCalls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures,
        programs: i.programs ? i.programs.length : 0, tier: quality.tier, dpr: pipeline.getDpr(), frameMs: pipeline.info().frameMs,
      };
    },
  };
}

boot().catch(showFatal);
