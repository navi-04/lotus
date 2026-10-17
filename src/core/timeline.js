/**
 * Master clock -> per-frame state shared by every module (`frame`).
 *
 * frame fields (all modules may READ everything; only the owner WRITES):
 *   time        scene time in seconds (wind, sway, ripples, shimmer). Advances only while playing.
 *   dt          seconds since the previous frame (clamped to 0.1)
 *   clock       timeline clock in seconds since (re)play: 0..TIMELINE.total, then stays at total
 *   rise        0..1   stalk lifts the bud out of the water
 *   bloom       0..1   0 = tight bud, 1 = fully open (hold at 1 afterwards)
 *   wind        THREE.Vector3  horizontal wind (x,z) magnitude 0..~1  (shared sway driver)
 *   gust        0..1   occasional stronger puffs
 *   focus       THREE.Vector3  world position of the flower's visual centre   (WRITTEN BY stem)
 *   headAxis    THREE.Vector3  unit up-axis of the flower head in world space   (WRITTEN BY stem)
 *   flowerRadius  approx. current outer radius of the flower in world units    (WRITTEN BY petals)
 *   camera      the active THREE.Camera
 *   frameIndex  integer frame counter
 */
import { Vector3 } from 'three';
import { TIMELINE } from './constants.js';

export const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
export const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };

/** 0..1 stalk rise at timeline clock t (seconds). */
export function riseAt(t) {
  const x = clamp01((t - TIMELINE.riseStart) / TIMELINE.riseDuration);
  return 1 - Math.pow(1 - x, 1.9);          // unhurried start, long ease-out as the stalk settles
}

/** 0..1 bloom progress at timeline clock t (seconds): slow swell, brisk unfurl, long settle. */
export function bloomAt(t) {
  const x = clamp01((t - TIMELINE.bloomStart) / TIMELINE.bloomDuration);
  return smootherstep(0, 1, Math.pow(x, 0.92));
}

/** Smooth, never-repeating-looking wind. Writes into `out` (Vector3: x,z). Returns gust 0..1. */
export function windAt(time, out) {
  const a =
    0.34 +
    0.22 * Math.sin(time * 0.31) +
    0.13 * Math.sin(time * 0.83 + 1.3) +
    0.06 * Math.sin(time * 1.91 + 0.4);
  const dir = 0.9 + 0.7 * Math.sin(time * 0.07) + 0.25 * Math.sin(time * 0.23 + 2.0);
  out.set(Math.cos(dir) * a, 0, Math.sin(dir) * a);
  return clamp01(Math.max(0, Math.sin(time * 0.9) * Math.sin(time * 0.37 + 0.8)) * 1.4);
}

export function createFrame() {
  return {
    time: 0,
    dt: 0,
    clock: 0,
    rise: 0,
    bloom: 0,
    wind: new Vector3(),
    gust: 0,
    focus: new Vector3(0, 3.9, 0),
    headAxis: new Vector3(0, 1, 0),
    flowerRadius: 0.5,
    camera: null,
    frameIndex: 0,
    playing: true,
  };
}

/**
 * Advance the frame. `frozen` = {bloom?, rise?, t?} from URL params pins the timeline (still shots).
 * Call once per rendered frame, BEFORE module updates.
 */
export function stepFrame(frame, dt, { playing = true, frozen = null, stillTime = false } = {}) {
  dt = Math.min(Math.max(dt, 0), 0.1);
  frame.dt = playing ? dt : 0;
  if (playing && !stillTime) frame.time += dt;
  if (playing && !frozen) frame.clock = Math.min(frame.clock + dt, TIMELINE.total);

  if (frozen && frozen.t != null) frame.clock = frozen.t;
  frame.rise = frozen && frozen.rise != null ? frozen.rise : riseAt(frame.clock);
  frame.bloom = frozen && frozen.bloom != null ? frozen.bloom : bloomAt(frame.clock);
  if (frozen && frozen.t == null && frozen.bloom != null && frozen.rise == null) frame.rise = 1;

  frame.gust = windAt(frame.time, frame.wind);
  frame.frameIndex++;
  return frame;
}
