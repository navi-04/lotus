/**
 * Render pipeline - HDR post chain (pmndrs `postprocessing`) + adaptive resolution + still capture.
 *
 *   scene -> RenderPass (half-float, MSAA)
 *         -> EffectPass[ exposure, DOF (focus on the flower), bloom, tone mapping, grade (split tone / S-curve / grain+dither), vignette ]
 *         -> EffectPass[ SMAA ]   (only on tiers without MSAA)
 *
 * `?hide=post` bypasses everything (plain renderer.render with ACES) for A/B.  `?tm=agx|neutral|aces` picks the tone
 * mapper, `?exposure=1.0`, `?bloom=0.5` is taken by the timeline so bloom intensity uses `?glow=`.
 */
import { HalfFloatType, UnsignedByteType, NoToneMapping, ACESFilmicToneMapping, Uniform, Vector2, Vector3 } from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, DepthOfFieldEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect,
  SMAAEffect, SMAAPreset, Effect, BlendFunction,
} from 'postprocessing';
import { noteContextLoss } from '../core/quality.js';

const EXPOSURE_FRAG = /* glsl */ `
uniform float exposure;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb * exposure, inputColor.a);
}
`;

// display-referred grade: runs after tone mapping, still before the final sRGB encode
const GRADE_FRAG = /* glsl */ `
uniform float saturation;
uniform float contrast;
uniform float grain;
uniform float time;
uniform vec3 shadowTint;
uniform vec3 highlightTint;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  vec3 g = pow(c, vec3(1.0 / 2.2));
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  // split tone: cool/teal-ish shadows, warm highlights
  g = mix(g, g * shadowTint, (1.0 - smoothstep(0.0, 0.5, l)) * 0.5);
  g = mix(g, g * highlightTint, smoothstep(0.45, 1.0, l) * 0.5);
  // gentle S-curve
  g = mix(g, g * g * (3.0 - 2.0 * g), contrast);
  // saturation (luma preserving)
  float l2 = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l2), g, saturation);
  // film grain + triangular dither (about +-1 LSB) to kill banding in the sky gradient
  float n1 = ign(gl_FragCoord.xy + fract(time * 7.13) * 91.7);
  float n2 = ign(gl_FragCoord.xy * 1.37 + 17.0 + fract(time * 3.31) * 63.1);
  float tri = (n1 + n2 - 1.0);
  g += tri * (grain + 1.0 / 255.0) * (0.35 + 0.65 * (1.0 - l));
  outputColor = vec4(pow(max(g, 0.0), vec3(2.2)), inputColor.a);
}
`;

class ExposureEffect extends Effect {
  constructor(exposure = 1.0) {
    super('ExposureEffect', EXPOSURE_FRAG, { blendFunction: BlendFunction.NORMAL, uniforms: new Map([['exposure', new Uniform(exposure)]]) });
  }
  set exposure(v) { this.uniforms.get('exposure').value = v; }
  get exposure() { return this.uniforms.get('exposure').value; }
}

class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['saturation', new Uniform(1.06)],
        ['contrast', new Uniform(0.35)],
        ['grain', new Uniform(0.012)],
        ['time', new Uniform(0)],
        ['shadowTint', new Uniform(new Vector3(0.97, 1.0, 1.03))],
        ['highlightTint', new Uniform(new Vector3(1.04, 1.0, 0.95))],
      ]),
    });
  }
  set time(v) { this.uniforms.get('time').value = v; }
}

const TM = { agx: ToneMappingMode.AGX, neutral: ToneMappingMode.NEUTRAL, aces: ToneMappingMode.ACES_FILMIC };

/**
 * @param {import('../main.js').Ctx} ctx
 */
export function createPipeline(ctx) {
  const { renderer, scene, quality, params } = ctx;
  const canvas = renderer.domElement;
  const q = params.raw;
  const usePost = !params.hide.has('post');
  let dpr = quality.dprStart;
  let width = 1, height = 1;

  // ---- context loss ------------------------------------------------------------------------------------------------
  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; noteContextLoss(); location.reload(); });

  let composer = null, dof = null, bloom = null, exposureFx = null, grade = null, tone = null;
  const hdr = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  if (usePost) try {
    renderer.toneMapping = NoToneMapping;
    composer = new EffectComposer(renderer, { frameBufferType: hdr ? HalfFloatType : UnsignedByteType, multisampling: quality.msaa, depthBuffer: true });
    composer.addPass(new RenderPass(scene, ctx.camera));

    exposureFx = new ExposureEffect(parseFloat(q.get('exposure') || '1.0'));
    bloom = new BloomEffect({
      intensity: parseFloat(q.get('glow') || '0.30'),
      luminanceThreshold: 1.0, luminanceSmoothing: 0.35, mipmapBlur: true, radius: 0.62, levels: quality.tier === 'low' ? 4 : 6,
    });
    tone = new ToneMappingEffect({ mode: TM[(q.get('tm') || 'neutral').toLowerCase()] ?? ToneMappingMode.NEUTRAL });
    grade = new GradeEffect();
    const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.5 });

    const fx = [exposureFx];
    if (quality.dof || q.get('dof') === '1') {
      dof = new DepthOfFieldEffect(ctx.camera, { focusDistance: 8, focusRange: 2.2, bokehScale: 2.6, resolutionScale: quality.tier === 'ultra' ? 0.5 : 0.4 });
      dof.target = ctx.frame.focus;
      fx.push(dof);
    }
    fx.push(bloom, tone, grade, vignette);
    composer.addPass(new EffectPass(ctx.camera, ...fx));
    if (!quality.msaa) composer.addPass(new EffectPass(ctx.camera, new SMAAEffect({ preset: quality.tier === 'low' ? SMAAPreset.MEDIUM : SMAAPreset.HIGH })));
  } catch (err) {
    console.warn('Post-processing unavailable, rendering directly:', err);
    composer = null; dof = bloom = exposureFx = grade = tone = null;
  }
  if (!composer) renderer.toneMapping = ACESFilmicToneMapping;

  // ---- adaptive resolution ----------------------------------------------------------------------------------------
  // Max quality is the default, so a weak device begins far above what it can sustain (a phone starts at DPR 3). Frame time scales
  // roughly with pixel count, so the controller measures a short window, then jumps proportionally to the overload instead of
  // creeping down in small steps; it only creeps back up on displays faster than 60 Hz (vsync caps a 60 Hz frame at ~16.7 ms).
  let ema = 16.7, seen = 0, cooldown = 0, winT = 0, winN = 0, winMax = 0;
  function adapt(dt) {
    if (quality.fixedDpr || document.hidden) return;
    if (++seen <= 6) return;                                   // first frames: lazy uploads / program links
    const ms = Math.min(dt * 1000, 400);
    winT += ms; winN++; winMax = Math.max(winMax, ms);
    cooldown = Math.max(0, cooldown - dt);
    if (winT < 700 || winN < 5) return;                        // decide on ~0.7 s windows
    const avg = (winT - winMax) / (winN - 1);                  // drop the single worst frame (GC / compile hitch)
    winT = 0; winN = 0; winMax = 0;
    ema = seen <= 16 ? avg : ema + (avg - ema) * 0.5;
    if (cooldown > 0) return;
    const cap = Math.min(window.devicePixelRatio || 1, quality.dprMax);
    if (ema > 22 && dpr > quality.dprMin + 1e-3) {
      const over = ema / 16.7;
      const next = over > 2.7 ? dpr * 0.6 : over > 1.9 ? dpr * 0.78 : dpr - 0.15;
      setDpr(Math.max(quality.dprMin, next));
      cooldown = over > 1.9 ? 1.2 : 2.5;
    } else if (ema < 13.5 && dpr < cap - 1e-3) {
      setDpr(Math.min(cap, dpr + 0.1));
      cooldown = 4.0;
    }
  }

  function applySize() {
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    if (composer) composer.setSize(width, height, false);
  }
  function setSize(w, h, d) {
    width = w; height = h;
    if (d != null) dpr = d;
    applySize();
  }
  function setDpr(d) { dpr = d; applySize(); }
  function getDpr() { return dpr; }

  let lastT = performance.now();
  function render(frame) {
    if (lost) return;
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    lastT = now;
    adapt(dt);
    if (composer) {
      if (grade) grade.time = frame.time;
      composer.render(frame.dt || 0.016);
    } else {
      renderer.render(scene, ctx.camera);
    }
  }

  /** Render one still at up to width x height (long side clamped to the GPU limit) and return a PNG Blob. */
  async function capture({ width: W = 3840, height: H = 2160 } = {}) {
    const gl = renderer.getContext();
    const maxRB = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), quality.isMobile ? 3072 : 4096);
    const k = Math.min(1, maxRB / Math.max(W, H));
    const cw = Math.max(2, Math.floor(W * k)), ch = Math.max(2, Math.floor(H * k));
    const prevDpr = dpr, prevW = width, prevH = height;
    const prevAspect = ctx.camera.aspect;
    try {
      renderer.setPixelRatio(1);
      renderer.setSize(cw, ch, false);
      if (composer) composer.setSize(cw, ch, false);
      ctx.camera.aspect = cw / ch;
      ctx.camera.updateProjectionMatrix();
      render(ctx.frame);
      render(ctx.frame);
      return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
    } finally {
      ctx.camera.aspect = prevAspect;
      ctx.camera.updateProjectionMatrix();
      width = prevW; height = prevH; dpr = prevDpr;
      applySize();
    }
  }

  function info() { return { dpr, frameMs: ema, post: !!composer, dof: !!dof, msaa: quality.msaa, hdr }; }
  function dispose() { if (composer) composer.dispose(); }

  return { render, setSize, setDpr, getDpr, capture, info, dispose, composer };
}
