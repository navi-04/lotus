/**
 * Composable onBeforeCompile patching for three's built-in materials.
 *
 *   inject(src, 'begin_vertex', 'transformed = foo();')       -> code lands right AFTER <begin_vertex>
 *   inject(src, 'common', decls, 'before')                    -> or right BEFORE a chunk
 *   addPatch(material, { key, uniforms?, vertex?(src)=>src, fragment?(src)=>src })
 *
 * Markers let several patches target the same chunk without knowing about each other (emitted in call order).
 * Throws when a chunk is missing so a three upgrade fails loudly instead of silently rendering wrong.
 * `key` MUST change whenever the produced GLSL changes (flags, loop counts, tier ...).
 */
export function inject(src, chunk, code, where = 'after') {
  const inc = `#include <${chunk}>`;
  const mB = `//@@before:${chunk}`;
  const mA = `//@@after:${chunk}`;
  if (!src.includes(mB)) {
    if (!src.includes(inc)) throw new Error(`shaderPatch.inject: chunk <${chunk}> not found in shader`);
    src = src.replace(inc, `${mB}\n${inc}\n${mA}`);
  }
  return where === 'before' ? src.replace(mB, () => `${code}\n${mB}`) : src.replace(mA, () => `${code}\n${mA}`);
}

/** Replace a literal anchor string (first occurrence). Throws if absent. */
export function replaceOnce(src, anchor, replacement) {
  if (!src.includes(anchor)) throw new Error(`shaderPatch.replaceOnce: anchor not found: ${anchor.slice(0, 60)}`);
  return src.replace(anchor, () => replacement);
}

export function addPatch(material, patch) {
  const prevCompile = material.onBeforeCompile;
  const prevKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey') ? material.customProgramCacheKey : null;
  material.onBeforeCompile = function (shader, renderer) {
    prevCompile.call(this, shader, renderer);
    if (patch.uniforms) Object.assign(shader.uniforms, patch.uniforms);
    if (patch.vertex) shader.vertexShader = patch.vertex(shader.vertexShader);
    if (patch.fragment) shader.fragmentShader = patch.fragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = function () {
    return (prevKey ? prevKey.call(this) + '|' : '') + patch.key;
  };
  material.needsUpdate = true;
  return material;
}
