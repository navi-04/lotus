/**
 * Environment - dawn sky dome, image-based lighting baked from the same sky, the shadow-casting sun, fill and haze.
 * Owns scene.environment / scene.fog and the lights; keeps ctx.sun (shared, mutated in place) in sync.
 */
import {
  Group, Mesh, SphereGeometry, ShaderMaterial, BackSide, Scene, Color, FogExp2, DirectionalLight, HemisphereLight,
  PMREMGenerator, Vector3,
} from 'three';
import { SCENE, SUN, PALETTE } from '../core/constants.js';
import { SKY_FUNCS_GLSL } from './envSky.js';
import { createBackdrop } from './envBackdrop.js';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;   // always on the far plane
}
`;

const SKY_FRAG = /* glsl */ `
${SKY_FUNCS_GLSL}
varying vec3 vDir;
void main() {
  gl_FragColor = vec4(skyRadiance(normalize(vDir)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function makeSkyMesh(ctx, { disc, clouds, radius }) {
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      uSunDir: { value: ctx.sun.direction },
      uSunCol: { value: new Color(8.0, 6.2, 4.2) },
      uSunDisc: { value: disc },
      uTime: { value: 0 },
      uClouds: { value: clouds },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
  const mesh = new Mesh(new SphereGeometry(radius, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/** PMREM image-based light from the sky (sun disc kept tiny: the DirectionalLight owns the sun) */
function bakeEnvironment(ctx, size) {
  const sc = new Scene();
  const sky = makeSkyMesh(ctx, { disc: 1.0, clouds: 0.0, radius: 50 });
  sky.material.depthTest = true;
  sky.material.uniforms.uSunCol.value.set(8.0, 6.2, 4.2);
  sc.add(sky);
  const pm = new PMREMGenerator(ctx.renderer);
  const rt = pm.fromScene(sc, 0, 0.1, 100, { size });
  pm.dispose();
  sky.geometry.dispose();
  sky.material.dispose();
  return rt;
}

/**
 * @param {import('../main.js').Ctx} ctx
 */
export function createEnvironment(ctx) {
  const { scene, quality } = ctx;
  const group = new Group();
  group.name = 'environment';

  // ---- fog / haze ----------------------------------------------------------------------------------------
  scene.fog = new FogExp2(SCENE.fog.color, SCENE.fog.density);
  scene.background = new Color(PALETTE.skyHorizon);

  // ---- sky dome + IBL ------------------------------------------------------------------------------------
  const dome = makeSkyMesh(ctx, { disc: 5.0, clouds: 1.0, radius: 400 });
  dome.name = 'sky';
  group.add(dome);

  const envSize = { low: 128, medium: 256, high: 256, ultra: 512 }[quality.tier] || 256;
  const envRT = bakeEnvironment(ctx, envSize);
  scene.environment = envRT.texture;
  scene.environmentIntensity = SUN.envIntensity;

  // ---- lights --------------------------------------------------------------------------------------------
  const sun = new DirectionalLight(ctx.sun.color, ctx.sun.intensity);
  sun.name = 'sun';
  const shadowsOn = quality.shadowMap > 0;
  sun.castShadow = shadowsOn;
  if (shadowsOn) {
    sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.012;
    sun.shadow.radius = 3.5;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 90;
  }
  const hemi = new HemisphereLight(SUN.skyFill, SUN.groundFill, 0.45);
  hemi.name = 'fill';
  group.add(sun, sun.target, hemi);

  // light-space basis for texel snapping
  const L = ctx.sun.direction;
  const right = new Vector3();
  const up = new Vector3();
  const center = new Vector3();
  let curExtent = 0;
  function fitShadow(focus, extent) {
    right.crossVectors(new Vector3(0, 1, 0), L).normalize();
    up.crossVectors(L, right).normalize();
    const texel = (2 * extent) / (quality.shadowMap || 1024);
    const sx = Math.round(focus.dot(right) / texel) * texel;
    const sy = Math.round(focus.dot(up) / texel) * texel;
    const sz = focus.dot(L);
    center.set(0, 0, 0).addScaledVector(right, sx).addScaledVector(up, sy).addScaledVector(L, sz);
    sun.position.copy(center).addScaledVector(L, 40);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    if (Math.abs(extent - curExtent) > 0.02 * extent) {
      const c = sun.shadow.camera;
      c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent;
      c.updateProjectionMatrix();
      curExtent = extent;
    }
  }
  sun.position.copy(L).multiplyScalar(40);
  fitShadow(ctx.frame.focus, 2.6);

  // ---- distant scenery, mist, bokeh, motes ---------------------------------------------------------------
  const backdrop = createBackdrop(ctx);
  group.add(backdrop.group);

  function update(frame) {
    const cam = frame.camera;
    if (cam) dome.position.copy(cam.position);
    dome.material.uniforms.uTime.value = frame.time;
    sun.color.copy(ctx.sun.color);
    sun.intensity = ctx.sun.intensity;
    if (shadowsOn) fitShadow(frame.focus, Math.max(2.4, frame.flowerRadius * 2.5));
    backdrop.update(frame);
  }

  function dispose() {
    dome.geometry.dispose();
    dome.material.dispose();
    envRT.dispose();
    sun.shadow.map && sun.shadow.map.dispose();
    backdrop.dispose();
    scene.environment = null;
  }

  return { group, update, dispose, sun, hemi };
}
