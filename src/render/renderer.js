/**
 * Renderer creation + configuration.
 * HDR scene -> the pipeline owns tone mapping when post is active (renderer.toneMapping stays at the value set here
 * only for the no-post path / materials rendered straight to the canvas).
 */
import * as THREE from 'three';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('../core/quality.js').resolveQuality>} quality
 */
export function createRenderer(canvas, quality) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !quality.msaa,          // MSAA lives in the post buffers when post is on; plain canvas AA as a fallback
    alpha: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(quality.dprStart);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  if (quality.shadowMap > 0) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  return renderer;
}
