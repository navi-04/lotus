/**
 * Camera rig - cinematic intro (low at the water beside the bud, rising and pulling back as it opens), seamless hand-over
 * to touch / mouse orbit (1-finger rotate, pinch zoom + twist), portrait/landscape auto-fit, camera kept above the water,
 * slow idle orbit after inactivity (respects prefers-reduced-motion).
 */
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MathUtils, Vector3, TOUCH, MOUSE } from 'three';
import { TIMELINE } from '../core/constants.js';
import { smoothstep, smootherstep, lerp, clamp01 } from '../core/timeline.js';

const DEG = Math.PI / 180;

/** vertical fov for an aspect ratio: tight telephoto-ish on landscape, wider on tall phones so the flower stays big */
export function fovFor(aspect) {
  return lerp(28, 46, 1 - smoothstep(0.55, 1.25, aspect));
}

/** distance at which a sphere of `radius` fits both axes */
export function fitDistance(aspect, fovDeg, radius) {
  const v = (fovDeg * DEG) / 2;
  const h = Math.atan(Math.tan(v) * aspect);
  return radius / Math.sin(Math.min(v, h));
}

/**
 * How far a page with lettering lowers the picture, as a fraction of the frame height. Wide frames have only a thin band of
 * sky above the flower, tall phone frames have plenty.
 */
export function lensShiftFor(aspect) {
  return lerp(0.035, 0.15, smoothstep(0.62, 1.45, aspect));
}

export function createCameraRig(ctx, canvas) {
  const { camera, frame, params } = ctx;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;
  controls.rotateSpeed = ctx.quality.isTouch ? 0.55 : 0.7;
  controls.zoomSpeed = 0.75;
  controls.minDistance = 1.5;
  controls.maxDistance = 26;
  controls.minPolarAngle = 0.12;
  controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };
  controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
  controls.autoRotateSpeed = 0.35;

  const cinematicAllowed = (!params.cam && !params.freeze) || params.raw.has('cine');   // ?cine=1 lets frozen stills use the cinematic path
  let mode = cinematicAllowed ? 'cine' : 'user';
  let lastInput = performance.now();
  let aspect = 1;
  const target = new Vector3();
  const tmp = new Vector3();

  controls.addEventListener('start', () => {
    mode = 'user';
    controls.autoRotate = false;
    lastInput = performance.now();
  });
  controls.addEventListener('end', () => { lastInput = performance.now(); });

  function setAspect(a) {
    aspect = a;
    camera.aspect = a;
    camera.fov = fovFor(a);
    camera.updateProjectionMatrix();
  }

  /**
   * Vertical lens shift (fraction of the frame height, + = picture moves down): a tilt-shift lens, so perspective and the
   * orbit are untouched and the flower just sits lower, leaving sky for lettering. Aspect independent; survives resizes
   * and still captures (they only rewrite aspect). The water reflection copies the main projection, so it follows.
   */
  let lensShift = 0;
  function setLensShift(s) {
    s = Number.isFinite(s) ? s : 0;
    if (Math.abs(s - lensShift) < 1e-4) return;
    lensShift = s;
    camera.view = Math.abs(s) < 1e-4 ? null : { enabled: true, fullWidth: 1, fullHeight: 1, offsetX: 0, offsetY: -s, width: 1, height: 1 };
    camera.updateProjectionMatrix();
  }

  function place(az, el, dist, tgt) {
    const a = az * DEG, e = el * DEG;
    camera.position.set(
      tgt.x + Math.sin(a) * Math.cos(e) * dist,
      tgt.y + Math.sin(e) * dist,
      tgt.z + Math.cos(a) * Math.cos(e) * dist,
    );
    controls.target.copy(tgt);
    camera.lookAt(tgt);
  }

  /** named views for ?cam= and the dev tools; distances are relative to what fits the open flower */
  function view(name) {
    const R = Math.max(1.0, frame.flowerRadius || 1.25);
    const fit = (r) => fitDistance(aspect, camera.fov, r);
    tmp.copy(frame.focus);
    tmp.y -= 0.1;
    switch (name) {
      case 'close': place(20, 12, fit(R * 0.95), tmp); break;
      case 'top': place(10, 78, fit(R * 1.2), tmp); break;
      case 'side': place(0, 2, fit(R * 1.35), tmp); break;
      case 'low': place(18, -14, fit(R * 1.3), tmp); break;
      case 'wide': place(24, 10, fit(R * 3.2), tmp); break;
      default: place(24, 9, fit(R * 1.22), tmp); break;
    }
    controls.update();
  }

  /** accepts 'default'|'close'|... or 'x,y,z,tx,ty,tz[,fov]' or an array */
  function setView(spec) {
    mode = 'user';
    if (typeof spec === 'string' && spec.includes(',')) spec = spec.split(',').map(Number);
    if (Array.isArray(spec) && spec.length >= 6) {
      camera.position.set(spec[0], spec[1], spec[2]);
      controls.target.set(spec[3], spec[4], spec[5]);
      if (spec[6]) { camera.fov = spec[6]; camera.updateProjectionMatrix(); }
      camera.lookAt(controls.target);
      controls.update();
      return;
    }
    view(typeof spec === 'string' ? spec : 'default');
  }

  function cinematic(dt) {
    const s = clamp01(frame.clock / TIMELINE.total);
    const e = smootherstep(0, 1, s);
    const az = lerp(54, 18, e);
    const el = lerp(-1.5, 11, smoothstep(0.0, 0.85, s));
    // frame the *current* flower: bud first (tall and narrow), then the opening bowl
    const R = Math.max(0.85, (frame.flowerRadius || 0.5) * 1.18);
    const dist = fitDistance(aspect, camera.fov, R * lerp(1.15, 1.32, e)) * lerp(0.92, 1.0, e);
    tmp.copy(frame.focus);
    tmp.y -= lerp(0.0, 0.18, e);
    tmp.y = Math.max(tmp.y, 0.9);                       // while the bud is still under water, look at the surface where it will appear
    target.lerp(tmp, 1 - Math.exp(-dt * 6));
    place(az, el, dist, target);
  }

  function update(dt) {
    if (mode === 'cine' && !reduced) {
      cinematic(dt);
      if (frame.clock >= TIMELINE.total - 0.01) mode = 'user';
    } else if (mode === 'cine' && reduced) {
      view('default');
      mode = 'user';
    } else {
      // follow the (swaying, rising) flower gently, keep the user's orbit
      tmp.copy(frame.focus); tmp.y -= 0.12;
      controls.target.lerp(tmp, 1 - Math.exp(-dt * 3));
      if (!reduced && !controls.autoRotate && performance.now() - lastInput > 14000 && mode === 'user') controls.autoRotate = true;
    }
    // never let the camera sink into the water
    const d = camera.position.distanceTo(controls.target);
    const lift = (controls.target.y - 0.55) / Math.max(d, 1e-3);
    controls.maxPolarAngle = Math.PI / 2 + Math.asin(MathUtils.clamp(lift, -1, 1));
    controls.update();
    if (camera.position.y < 0.5) { camera.position.y = 0.5; camera.lookAt(controls.target); }
  }

  function restart() {
    mode = cinematicAllowed ? 'cine' : 'user';
    controls.autoRotate = false;
    lastInput = performance.now();
  }

  return {
    controls, update, setAspect, setView, view, restart, setLensShift,
    get lensShift() { return lensShift; },
    get mode() { return mode; },
    get cinematic() { return mode === 'cine'; },
  };
}
