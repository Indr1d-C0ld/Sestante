import * as THREE from "three";
import type { CSM } from "three/addons/csm/CSM.js";

/** Uniforms shared by every material: one assignment moves the weather across the whole world. */
export const U = {
  uTime: { value: 0 },
  uWet: { value: 0 },
  uSnow: { value: 0 },
  uCloud: { value: 0 },
  uCloudOff: { value: new THREE.Vector2() },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uWindVec: { value: new THREE.Vector2(1, 0) },
  uWindAmp: { value: 0.1 },
  uNight: { value: 0 },
  uNoise: { value: null as THREE.Texture | null },
  uHalf: { value: new THREE.Vector2(500, 500) },
  uPlate: { value: null as THREE.Texture | null },
  uPlateB: { value: null as THREE.Texture | null },
  uPlateMix: { value: 0 },
  uGain: { value: null as THREE.Texture | null },
  uClass: { value: null as THREE.Texture | null },
  uDeshadow: { value: 1 },
  uDetail: { value: 0.8 },
  uGrid: { value: 0 },
  uCam: { value: new THREE.Vector3() },
  uFarPlate: { value: null as THREE.Texture | null },
  uFarHalf: { value: 12000 },
  uDrape: { value: null as THREE.Texture | null },
  uDrapeMix: { value: 0 },
  uProv: { value: 0 },
  uProjOn: { value: 0 },
  uProjTex: { value: null as THREE.Texture | null },
  uProjPos: { value: new THREE.Vector3() },
  uProjAz: { value: 0 },
  uProjFov: { value: 60 },
  uProjAspect: { value: 1.5 },
  uProjPano: { value: 0 },
  uProjMix: { value: 1 },
  uProjRange: { value: 45 },
};

export const COMMON_GLSL = /* glsl */ `
uniform float uTime, uWet, uSnow, uCloud, uNight;
uniform vec2 uCloudOff;
uniform vec3 uSunDir;
uniform sampler2D uNoise;
varying vec3 vW;
float cloudShade(vec3 p) {
  if (uCloud < .02) return 1.;
  vec2 q = (p.xz + uSunDir.xz / max(uSunDir.y, .12) * 2800.) * .000055 + uCloudOff;
  float n = texture2D(uNoise, q).r * .62 + texture2D(uNoise, q * 2.9).g * .38;
  float edge = 1. - uCloud * 1.02;
  float density = smoothstep(edge - .06, edge + .2, n);
  return mix(1., .12, density * smoothstep(.0, .25, uCloud));
}
`;

const VERTEX_WORLD = /* glsl */ `
  {
    vec4 wp = vec4(transformed, 1.);
    #ifdef USE_INSTANCING
      wp = instanceMatrix * wp;
    #endif
    vW = (modelMatrix * wp).xyz;
  }
`;

export type Patch = {
  key: string;
  uniforms?: Record<string, { value: unknown }>;
  vertexPars?: string;
  vertexBegin?: string;
  vertexEnd?: string;
  fragmentPars?: string;
  map?: string;
  afterRoughness?: string;
  afterNormal?: string;
  emissive?: string;
  beforeOutput?: string;
  noWeather?: boolean;
};

export function shade<T extends THREE.MeshStandardMaterial>(material: T, patch: Patch, csm: CSM | null) {
  if (csm) csm.setupMaterial(material);
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, U, patch.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vW;\nuniform float uTime;\nuniform vec2 uWindVec;\nuniform float uWindAmp;\n${patch.vertexPars ?? ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${patch.vertexBegin ?? ""}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERTEX_WORLD}\n${patch.vertexEnd ?? ""}`);
    const weather = patch.noWeather
      ? ""
      : /* glsl */ `
      {
        vec3 wN = inverseTransformDirection(normal, viewMatrix);
        float upF = smoothstep(.45, .92, wN.y);
        float wetAmt = uWet * mix(.35, 1., upF);
        float puddle = smoothstep(.56, .72, texture2D(uNoise, vW.xz * .017).g + uWet * .22 - .12) * upF * uWet;
        diffuseColor.rgb *= 1. - .42 * wetAmt;
        roughnessFactor = mix(roughnessFactor, .14, max(puddle * .95, wetAmt * .4));
        float snow = uSnow * smoothstep(.3, .72, wN.y + (texture2D(uNoise, vW.xz * .19).b - .5) * .5);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.86, .89, .94), snow);
        roughnessFactor = mix(roughnessFactor, .82, snow);
      }`;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${COMMON_GLSL}\n${patch.fragmentPars ?? ""}`)
      .replace("#include <map_fragment>", patch.map ?? "#include <map_fragment>")
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>\n${patch.afterRoughness ?? ""}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${patch.afterNormal ?? ""}\n${weather}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${patch.emissive ?? ""}`)
      .replace("#include <opaque_fragment>", `${patch.beforeOutput ?? ""}\n#include <opaque_fragment>`)
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>\n{ float cs = cloudShade(vW); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }`,
      );
  };
  material.customProgramCacheKey = () => `${patch.key}:${csm ? csm.cascades : 0}`;
  return material;
}

/** A plate-sampling block shared by the ground and by every roof, so that they read as the same photograph. */
export const PLATE_GLSL = /* glsl */ `
uniform vec2 uHalf;
uniform sampler2D uPlate, uPlateB, uGain, uClass, uFarPlate, uDrape;
uniform float uPlateMix, uDeshadow, uDetail, uGrid, uFarHalf, uDrapeMix;
uniform vec3 uCam;
vec3 plateAlbedo(vec2 p, out vec4 cls) {
  vec2 uv = vec2(p.x / uHalf.x, -p.y / uHalf.y) * .5 + .5;
  if (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) {
    // Past the plate, the coarse mosaic takes over at the seam rather than smearing the edge pixels.
    cls = vec4(0.);
    return texture2D(uFarPlate, vec2(p.x, -p.y) / uFarHalf * .5 + .5).rgb;
  }
  vec3 c = texture2D(uPlate, uv).rgb;
  if (uPlateMix > .001) c = mix(c, texture2D(uPlateB, uv).rgb, uPlateMix);
  cls = texture2D(uClass, uv);
  if (uDeshadow > .5) {
    vec4 fill = texture2D(uGain, uv);
    vec3 lit = pow(fill.rgb, vec3(2.2));
    // A trace of the dark plate survives, so curbs and manholes in shadow do not vanish altogether.
    c = mix(c, lit * (.82 + c * 2.4), fill.a * .97);
  }
  if (uDrapeMix > .001) {
    vec4 d = texture2D(uDrape, uv);
    c = mix(c, d.rgb, d.a * uDrapeMix);
  }
  return c;
}
`;

/** A photograph thrown onto the world from where it was taken: walls and ground pick it up as a slide projector would. */
export const PROJECT_GLSL = /* glsl */ `
uniform float uProjOn, uProjAz, uProjFov, uProjAspect, uProjPano, uProjMix, uProjRange;
uniform vec3 uProjPos;
uniform sampler2D uProjTex;
vec3 projectPhoto(vec3 base, vec3 p, vec3 n) {
  if (uProjOn < .5) return base;
  vec3 d = p - uProjPos;
  float r = length(d);
  float fade = (1. - smoothstep(uProjRange * .7, uProjRange, r)) * smoothstep(.02, .22, dot(n, -d / max(r, .001)));
  if (fade < .002) return base;
  vec2 uv;
  if (uProjPano > .5) {
    float az = atan(d.x, -d.z) - uProjAz;
    uv = vec2(fract(az / 6.2831853 + .5), asin(clamp(d.y / r, -1., 1.)) / 3.1415927 + .5);
  } else {
    vec3 f = vec3(sin(uProjAz), 0., -cos(uProjAz));
    vec3 s = vec3(cos(uProjAz), 0., sin(uProjAz));
    float z = dot(d, f);
    if (z < .2) return base;
    float t = tan(uProjFov * .00872665);
    uv = vec2(dot(d, s) / z / t, d.y / z / t * uProjAspect) * .5 + .5;
    if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) return base;
  }
  return mix(base, texture2D(uProjTex, uv).rgb, fade * uProjMix);
}
`;

/** Where a height comes from, in the three classes a map can carry safely: mapped, read from shadows, presumed. The last is also hatched, so colour never works alone. */
export const PROV_GLSL = /* glsl */ `
uniform float uProv;
vec3 provColor(float k, float conf, vec3 p) {
  if (k < 1.5) return vec3(.041, .242, .783) * (.55 + .45 * conf);
  if (k < 3.5 || k > 5.5) return vec3(.694, .1, .019) * (.55 + .45 * conf);
  float hatch = step(.5, fract((p.x + p.y + p.z) * .5));
  return vec3(.01, .342, .162) * (.45 + .55 * hatch);
}
`;

export const PROVENANCE_LEGEND = [
  { id: "mappata", label: "Mappata o misurata", note: "altezza o piani scritti in OSM, oppure laser GEDI", color: "#3987e5", sources: ["OSM height", "OSM piani", "laser GEDI"] },
  { id: "ombre", label: "Letta dalle ombre", note: "una o più riprese, oppure corpo dedotto", color: "#d95926", sources: ["ombre multi-data", "ombra", "ripresa"] },
  { id: "presunta", label: "Presunta", note: "mediana del quartiere o tipo edilizio, tratteggiata", color: "#199e70", sources: ["quartiere", "tipo edilizio"] },
];

function valueNoise(size: number, seed: number) {
  const lattice = new Float32Array(size * size);
  let s = seed;
  for (let i = 0; i < lattice.length; i++) {
    s = (s * 16807) % 2147483647;
    lattice[i] = s / 2147483647;
  }
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const at = (a: number, b: number) => lattice[(((b % size) + size) % size) * size + (((a % size) + size) % size)]!;
    return at(xi, yi) * (1 - u) * (1 - v) + at(xi + 1, yi) * u * (1 - v) + at(xi, yi + 1) * (1 - u) * v + at(xi + 1, yi + 1) * u * v;
  };
}

export function makeNoiseTexture(size = 512) {
  const data = new Uint8Array(size * size * 4);
  const layer = (seed: number, base: number, octaves: number, gain: number) => {
    const fns: { fn: ReturnType<typeof valueNoise>; period: number }[] = [];
    for (let o = 0; o < octaves; o++) {
      const period = base * 2 ** o;
      fns.push({ fn: valueNoise(period, seed + o * 131), period });
    }
    return (u: number, v: number) => {
      let sum = 0;
      let amp = 1;
      let total = 0;
      for (const { fn, period } of fns) {
        sum += fn(u * period, v * period) * amp;
        total += amp;
        amp *= gain;
      }
      return sum / total;
    };
  };
  const big = layer(11, 4, 6, 0.52);
  const mid = layer(29, 16, 5, 0.55);
  const fine = layer(47, 64, 3, 0.6);
  const speck = layer(83, 128, 2, 0.7);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const k = (y * size + x) * 4;
      // Stretch contrast around the mean: octave averages otherwise crowd near 0.5.
      const c = (value: number, gainC: number) => Math.max(0, Math.min(255, ((value - 0.5) * gainC + 0.5) * 255));
      data[k] = c(big(u, v), 1.9);
      data[k + 1] = c(mid(u, v), 1.8);
      data[k + 2] = c(fine(u, v), 1.6);
      data[k + 3] = c(speck(u, v), 1.5);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

export function canvasTexture(canvas: HTMLCanvasElement, anisotropy: number) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.flipY = true;
  return texture;
}

export function dataTexture(data: Uint8Array, width: number, height: number) {
  // The analysis raster runs north to south; flip rows so that the same uv addresses plate and masks.
  const flipped = new Uint8Array(data.length);
  const stride = width * 4;
  for (let y = 0; y < height; y++) flipped.set(data.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  const texture = new THREE.DataTexture(flipped, width, height, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
