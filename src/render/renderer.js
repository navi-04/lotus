/**
 * Renderer creation + configuration.
 * HDR scene -> the pipeline owns tone mapping when post is active (renderer.toneMapping stays at the value set here
 * only for the no-post path / materials rendered straight to the canvas).
 */
import * as THREE from 'three';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('../core/quality.js').resolveQuality>} quality
 * @param {{post?: boolean}} [opts]  post = the post-processing chain draws into the canvas (MSAA buffers or SMAA happen there)
 */
export function createRenderer(canvas, quality, { post = true } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    // Anti-aliasing lives in the post chain. A multisampled backbuffer on top of it is pure waste (about 95 MB on a 3x phone);
    // it is only the fallback when post-processing is switched off.
    antialias: !quality.msaa && !post,
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
