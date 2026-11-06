import * as THREE from "three";
import type { CSM } from "three/addons/csm/CSM.js";
import type { FarField, TerrainData } from "../field/load.ts";
import { PLATE_GLSL, PROJECT_GLSL, PROV_GLSL, shade, U } from "./shading.ts";

const GROUND_FRAG = /* glsl */ `
  vec4 cls;
  vec3 albedo = plateAlbedo(vW.xz, cls);
  float dist = length(uCam - vW);
  float near = (1. - smoothstep(25., 240., dist)) * uDetail;
  vec2 xz = vW.xz;
  float nA = texture2D(uNoise, xz * .021).b;
  float nB = texture2D(uNoise, xz * .083).b;
  float nC = texture2D(uNoise, xz * .4).b;
  float veg = max(cls.r, cls.g);
  float paved = cls.a;
  // The plate supplies colour, the procedural layer supplies what no satellite can see from orbit.
  float grit = texture2D(uNoise, xz * 1.9).a;
  float fine = texture2D(uNoise, xz * 5.3).a;
  vec3 grassTone = albedo * (.9 + .2 * nB) * (.8 + .4 * nC) * (.84 + .32 * grit);
  grassTone *= mix(vec3(1.), vec3(.9, 1.03, .82), nA * .5);
  vec3 stoneTone = albedo * (.96 + .08 * nB) * (.93 + .14 * nC) * (.9 + .2 * fine);
  vec3 bareTone = albedo * (.94 + .12 * nB) * (.88 + .24 * nC) * (.82 + .36 * grit);
  float s = smoothstep(.0, .6, paved);
  vec3 near3 = mix(mix(bareTone, grassTone, veg), stoneTone, s * (1. - veg));
  diffuseColor.rgb = mix(albedo, near3, near);
  if (uGrid > .5) {
    vec2 g = abs(fract(vW.xz / 100. + .5) - .5) * 100.;
    float l = 1. - smoothstep(.0, .9, min(g.x, g.y));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.95, .55, .2), l * .75);
  }
  if (cls.b > .5) diffuseColor.rgb = albedo * .62;
  groundCls = cls;
  groundNear = near;
`;

const GROUND_ROUGH = /* glsl */ `
  roughnessFactor = mix(mix(.92, .78, groundCls.a), .98, max(groundCls.r, groundCls.g));
  if (groundCls.b > .5) roughnessFactor = .07;
`;

const GROUND_NORMAL = /* glsl */ `
  if (groundCls.b > .5) {
    float tw = uTime * .35;
    vec2 pw = vW.xz;
    vec2 wa = vec2(texture2D(uNoise, pw * .07 + vec2(tw * .08, tw * .05)).a, texture2D(uNoise, pw * .07 + vec2(-tw * .06, tw * .09)).a) - .5;
    vec2 wb = vec2(texture2D(uNoise, pw * .31 + vec2(tw * .2, -tw * .1)).b, texture2D(uNoise, pw * .31 - vec2(tw * .15, tw * .19)).b) - .5;
    vec2 ww = wa * .22 + wb * .1;
    normal = normalize(normal + (viewMatrix * vec4(ww.x, 0., ww.y, 0.)).xyz);
  } else if (groundNear > .01) {
    vec2 uvN = vW.xz;
    float e = .9;
    float h0 = texture2D(uNoise, uvN * .083).b + texture2D(uNoise, uvN * .4).b * .5;
    float hx = texture2D(uNoise, (uvN + vec2(e * .25, 0.)) * .083).b + texture2D(uNoise, (uvN + vec2(e * .25, 0.)) * .4).b * .5;
    float hz = texture2D(uNoise, (uvN + vec2(0., e * .25)) * .083).b + texture2D(uNoise, (uvN + vec2(0., e * .25)) * .4).b * .5;
    float amp = mix(.5, .1, smoothstep(.0, .6, groundCls.a)) * groundNear;
    vec3 wPert = vec3(hx - h0, 0., hz - h0) * amp * 4.;
    normal = normalize(normal - (viewMatrix * vec4(wPert, 0.)).xyz);
  }
  diffuseColor.rgb = projectPhoto(diffuseColor.rgb, vW, inverseTransformDirection(normal, viewMatrix));
  if (uProv > .5) diffuseColor.rgb = vec3(dot(diffuseColor.rgb, vec3(.3, .55, .15))) * .8;
`;

export function buildTerrain(terrain: TerrainData, csm: CSM | null) {
  const { size, spacing, heights } = terrain;
  const half = ((size - 1) * spacing) / 2;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(size * size * 3);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = (j * size + i) * 3;
      positions[k] = -half + i * spacing;
      positions[k + 1] = heights[j * size + i]!;
      positions[k + 2] = -half + j * spacing;
    }
  }
  const indices = new Uint32Array((size - 1) * (size - 1) * 6);
  let n = 0;
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const a = j * size + i;
      const b = a + 1;
      const c = a + size;
      const d = c + 1;
      indices[n++] = a;
      indices[n++] = c;
      indices[n++] = b;
      indices[n++] = b;
      indices[n++] = c;
      indices[n++] = d;
    }
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  const material = shade(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, envMapIntensity: 0.55 }),
    {
      key: "ground",
      fragmentPars: `${PLATE_GLSL}\n${PROJECT_GLSL}\n${PROV_GLSL}\nvec4 groundCls; float groundNear;`,
      map: GROUND_FRAG,
      afterRoughness: GROUND_ROUGH,
      afterNormal: GROUND_NORMAL,
    },
    csm,
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/** The land around the plate: it keeps the horizon true without pretending to be high resolution. */
export function buildFarField(far: FarField, near: TerrainData, halfX: number, halfZ: number, csm: CSM | null) {
  const { size, span, heights } = far;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(size * size * 3);
  const uvs = new Float32Array(size * size * 2);
  const nearHalf = ((near.size - 1) * near.spacing) / 2;
  const nearAt = (x: number, z: number) => {
    const gx = Math.max(0, Math.min(near.size - 1, (x + nearHalf) / near.spacing));
    const gz = Math.max(0, Math.min(near.size - 1, (z + nearHalf) / near.spacing));
    return near.heights[Math.round(gz) * near.size + Math.round(gx)]!;
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = -span / 2 + (i / (size - 1)) * span;
      const z = -span / 2 + (j / (size - 1)) * span;
      let h = heights[j * size + i]!;
      // Sits under the detailed terrain and rises to meet its rim, so the two never fight for the same pixels.
      const inside = Math.abs(x) <= nearHalf + span / (size - 1) && Math.abs(z) <= nearHalf + span / (size - 1);
      if (inside) h = nearAt(x, z) - 12;
      const k = (j * size + i) * 3;
      positions[k] = x;
      positions[k + 1] = h;
      positions[k + 2] = z;
      uvs[(j * size + i) * 2] = i / (size - 1);
      uvs[(j * size + i) * 2 + 1] = 1 - j / (size - 1);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const a = j * size + i;
      const b = a + 1;
      const c = a + size;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const texture = new THREE.CanvasTexture(far.plate);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const material = shade(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0, envMapIntensity: 0.4 }), { key: "far" }, csm);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = false;
  void halfX;
  void halfZ;
  void U;
  return mesh;
}
