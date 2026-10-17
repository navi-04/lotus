/**
 * Single source of truth for numbers that more than one module depends on.
 *
 * Units: 1 unit = 10 cm.  Y is up.  Water surface is y = 0.  Right-handed.
 * Colours are sRGB hex strings - pass them to THREE.Color (colour management converts to linear).
 */

export const UNIT_CM = 10;

/** Scene layout & camera. The hero lotus stands at x=0,z=0. */
export const SCENE = {
  seed: 20260214,
  water: { y: 0, radius: 220 },
  stem: {
    x: 0, z: 0,
    baseY: -2.6,        // where the stalk disappears under the mud/water
    headY: 3.4,         // world Y of the receptacle base (head origin) once fully risen
    topRadius: 0.085,   // stalk radius just under the flower
    baseRadius: 0.125,  // stalk radius at the water line
  },
  camera: {
    fov: 28,            // vertical degrees (desktop landscape). Rig widens/pulls back for portrait
    near: 0.05,
    far: 900,
    // spherical "home" pose around the flower focus point (azimuth 0 = camera on +Z looking toward -Z)
    home: { azimuthDeg: 24, elevationDeg: 9, distance: 8.6 },
  },
  // fog / haze (pond mist). Modules that write their own fragment shaders should honour scene.fog.
  fog: { color: '#d9c7b4', density: 0.0125 },
};

/** Key light. direction = unit vector pointing FROM the origin TOWARD the sun. */
export const SUN = {
  azimuthDeg: 238,      // back-left of the flower (~40 deg off the home view axis): rim light + back-lit translucency
  elevationDeg: 17,
  color: '#ffd6a6',
  intensity: 3.6,       // DirectionalLight intensity (physical-ish, with ACES/AgX tone mapping)
  skyFill: '#d6c4c4',   // hemisphere / ambient sky tint
  groundFill: '#3a4636',
  envIntensity: 1.0,
};

/** Starting palette (sRGB hex). Modules may refine their own shades but should stay close for overall harmony. */
export const PALETTE = {
  // petals - white/cream-green base -> blush -> saturated pink tip (Nelumbo nucifera "pink")
  petalBase: '#eef0c2',
  petalMid: '#fbe4e9',
  petalTip: '#e65c94',
  petalTipDeep: '#c92f71',
  petalOuterBack: '#c8d79c',   // outer face of outer petals near the base is greenish
  // receptacle / carpels
  podTop: '#c6d45c',
  podSide: '#a9c44c',
  seed: '#86a63c',
  stigma: '#ecdc72',
  // stamens
  filament: '#f6e9a8',
  anther: '#f7c42c',
  antherTip: '#fff2b6',
  // stalk
  stem: '#76934b',
  stemDark: '#4d6a33',
  prickle: '#8b5b3b',
  // leaves
  leafTop: '#5b9873',
  leafBloom: '#a9cebf',     // glaucous waxy bloom
  leafVein: '#9ac79a',
  leafUnder: '#8cb686',
  // water & sky
  water: '#0d2622',
  waterDeep: '#050f0e',
  skyZenith: '#7b98be',
  skyHorizon: '#f7d6b2',
  skyGlow: '#ffe4bc',
};

/** The flower head. Local frame: origin = centre of the receptacle BASE (where petals/stamens/sepals attach), +Y = flower axis. */
export const FLOWER = {
  receptacle: {
    baseR: 0.12,        // radius at y = 0
    topR: 0.33,         // radius of the flat top
    height: 0.42,       // y of the top surface (rim). Centre of the top is domeH higher
    domeH: 0.03,
    carpelCount: 19,    // 1 centre + 6 inner ring + 12 outer ring
    carpelRingR: [0.0, 0.115, 0.225],
    carpelRingCount: [1, 6, 12],
    carpelHoleR: 0.042,
  },
  /** Reference numbers; the exact per-whorl parameters live in src/lotus/petals.js (WHORLS). */
  petals: {
    total: 22,
    layers: 4,
    lengthRange: [0.88, 1.36],     // 8.8 - 13.6 cm
    widthRange: [0.44, 0.70],
    openRadius: 1.25,              // approx. outer radius of the fully open flower
    budHeight: 1.45,               // approx. height of the closed bud above head origin
    budRadius: 0.52,               // approx. max radius of the closed bud
  },
  sepals: { count: 4 },
  stamens: {
    count: { low: 110, medium: 170, high: 250, ultra: 340 },
    length: [0.38, 0.58],
  },
};

/** Radius of the receptacle cone at height y (0..height). Petals/stamens must stay outside this. */
export function coneRadius(y) {
  const r = FLOWER.receptacle;
  const t = Math.min(Math.max(y / r.height, 0), 1);
  // slightly convex flank (obconical, fuller toward the top)
  return r.baseR + (r.topR - r.baseR) * (0.75 * t + 0.25 * t * t);
}

/** Bloom timeline (seconds). rise = stalk lifts the bud out of the water. bloom = petals unfurl. */
export const TIMELINE = {
  riseStart: 0.0,
  riseDuration: 9.0,
  bloomStart: 5.5,
  bloomDuration: 30.0,
  total: 38.0,
};
