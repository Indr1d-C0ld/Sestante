import * as THREE from "three";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import {
  abs,
  asin,
  cameraProjectionMatrix,
  cross,
  materialRoughness,
  uniform,
  varying,
  atan,
  attribute,
  clamp,
  cos,
  normalWorld,
  select,
  tan,
  cameraPosition,
  cameraViewMatrix,
  dot,
  float,
  floor,
  Fn,
  fract,
  instanceIndex,
  positionLocal,
  sin,
  length,
  materialColor,
  max,
  mix,
  normalize,
  normalView,
  positionWorld,
  pow,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { GpuView } from "./gpu.ts";

/**
 * TSL ports of the shade() patches, by material key. Each one follows its GLSL original in buildings.ts, nature.ts,
 * terrain.ts and details.ts; what is left out is said next to it.
 */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- TSL nodes are untyped chains
type Port = (view: GpuView, source: THREE.Material) => THREE.Material;

/**
 * PROJECT_GLSL of shading.ts: a photograph thrown onto the world from where it was taken, as a slide projector would, faded
 * with distance and on surfaces seen edge-on from the camera's position. `n` is the world normal.
 */
export function projectPhoto(view: GpuView, base: Any, p: Any, n: Any): Any {
  const b = view.bridge;
  const az = b.value("uProjAz");
  const range = b.value("uProjRange");
  const d = p.sub(b.value("uProjPos"));
  const r = d.length().max(0.001);
  const fade = float(1).sub(smoothstep(range.mul(0.7), range, r)).mul(smoothstep(0.02, 0.22, dot(n, d.negate().div(r))));
  const pano = b.value("uProjPano").greaterThan(0.5);
  const turn = atan(d.x, d.z.negate()).sub(az);
  const uvPano = vec2(fract(turn.div(6.2831853).add(0.5)), asin(clamp(d.y.div(r), -1, 1)).div(3.1415927).add(0.5));
  const ahead = dot(d, vec3(sin(az), 0, cos(az).negate()));
  const side = dot(d, vec3(cos(az), 0, sin(az)));
  const t = tan(b.value("uProjFov").mul(0.00872665));
  const z = ahead.max(0.2);
  const uvFlat = vec2(side.div(z).div(t), d.y.div(z).div(t).mul(b.value("uProjAspect"))).mul(0.5).add(0.5);
  const inFrame = step(0.2, ahead).mul(step(0, uvFlat.x)).mul(step(uvFlat.x, 1)).mul(step(0, uvFlat.y)).mul(step(uvFlat.y, 1));
  const photo = b.sample("uProjTex", select(pano, uvPano, uvFlat)).rgb;
  const weight = fade.mul(b.value("uProjMix")).mul(select(pano, float(1), inFrame)).mul(step(0.5, b.value("uProjOn")));
  return mix(base, photo, weight);
}

/**
 * cloudShade of COMMON_GLSL: the clouds' shadow at a point, read from the same noise as the cloud layer, 2,800 m up along
 * the sun's direction. 1 in the clear, down to 0.12 under thick cloud.
 */
export function cloudShade(view: GpuView, p: Any): Any {
  const b = view.bridge;
  const sun = b.value("uSunDir");
  const cover = b.value("uCloud");
  const q = p.xz.add(sun.xz.div(sun.y.max(0.12)).mul(2800)).mul(0.000055).add(b.value("uCloudOff"));
  return mix(float(1), float(0.12), cloudDensity(view, q).mul(smoothstep(0, 0.25, cover))).mul(step(0.02, cover)).add(step(cover, 0.02));
}

/** How thick the cloud is at a point of the cloud layer's noise field, before the cover's own fade-in. */
export function cloudDensity(view: GpuView, q: Any): Any {
  const b = view.bridge;
  const n = b.sample("uNoise", q).r.mul(0.62).add(b.sample("uNoise", q.mul(2.9)).g.mul(0.38));
  const edge = float(1).sub(b.value("uCloud").mul(1.02));
  return smoothstep(edge.sub(0.06), edge.add(0.2), n);
}

/**
 * The weather block of shade() in shading.ts: rain darkens and slicks what faces up, puddles gather where the noise is
 * low, snow settles on what is flat enough; and the clouds' shadows dim the sun on every surface that takes them.
 */
export function weatherize(view: GpuView, m: Any) {
  const b = view.bridge;
  const n = normalWorld;
  const xz = positionWorld.xz;
  const wet = b.value("uWet");
  const upF = smoothstep(0.45, 0.92, n.y);
  const wetAmt = wet.mul(mix(float(0.35), float(1), upF));
  const puddle = smoothstep(0.56, 0.72, b.sample("uNoise", xz.mul(0.017)).g.add(wet.mul(0.22)).sub(0.12)).mul(upF).mul(wet);
  const snow = b.value("uSnow").mul(smoothstep(0.3, 0.72, n.y.add(b.sample("uNoise", xz.mul(0.19)).b.sub(0.5).mul(0.5))));
  const color = m.colorNode ?? vec3(1);
  m.colorNode = mix(color.mul(float(1).sub(wetAmt.mul(0.42))), vec3(0.86, 0.89, 0.94), snow);
  const rough = m.roughnessNode ?? materialRoughness;
  m.roughnessNode = mix(mix(rough, float(0.14), max(puddle.mul(0.95), wetAmt.mul(0.4))), float(0.82), snow);
  m.receivedShadowNode = Fn(([shadow]: Any[]) => shadow.mul(cloudShade(view, positionWorld)));
  return m;
}

/**
 * Precipitation of details.ts: rain streaks or snowflakes in a 36 m box that travels with the camera, the same quads,
 * placed in view space by the vertex stage. The source's uniforms are read every frame, so Precipitation.update drives both.
 */
function precipitation(view: GpuView, source: THREE.Material) {
  const u = (source as THREE.ShaderMaterial).uniforms;
  const live = (name: string, init: unknown): Any => uniform(init as Any).onRenderUpdate(() => u[name]!.value);
  // The camera's own position: the box travels with the eye that draws it.
  const camPos = cameraPosition;
  const wind = live("uWindXZ", new THREE.Vector2());
  const amount = live("uAmount", 0);
  const snowMix = live("uSnowMix", 0);
  const light = live("uLight", new THREE.Color(1, 1, 1));
  const t = view.bridge.value("uTime");
  const seed = attribute("aSeed", "vec3");
  const corner = attribute("aCorner", "vec2");
  const SIZE = 36;
  const snowy = snowMix.greaterThan(0.5);
  const drift = mix(float(0.55), float(0.85), snowMix);
  const vel = vec3(wind.x.mul(drift), mix(float(9.5), float(1.15), snowMix).negate(), wind.y.mul(drift));
  // Every drop falls at the same speed here. The GLSL original gives each its own (0.8 to 1.2 times): in TSL any per-drop
  // factor on the time, from the seed or from an attribute, threw the drops out of the box, and the cause was not found.
  let p: Any = seed.mul(SIZE).add(vel.mul(t));
  p = p.add(vec3(sin(t.mul(0.9).add(seed.x.mul(30))), 0, cos(t.mul(0.7).add(seed.z.mul(30)))).mul(0.5).mul(step(0.5, snowMix)));
  // GLSL's mod floors; WGSL's % truncates, which would fold the box the wrong way below zero.
  const rel = p.sub(camPos);
  p = rel.sub(floor(rel.div(SIZE)).mul(SIZE)).sub(SIZE / 2);
  const vv = cameraViewMatrix.mul(vec4(p.add(camPos), 1)).xyz;
  const dirV = normalize(cameraViewMatrix.mul(vec4(normalize(vel), 0)).xyz);
  const visible = step(fract(seed.x.mul(91.7).add(seed.z.mul(13.1))), amount);
  const side = normalize(cross(dirV, normalize(vv)));
  const rain = vv.add(side.mul(corner.x).mul(vv.length().mul(0.0016).add(0.011))).add(dirV.mul(corner.y).mul(0.42));
  const flake = vv.add(vec3(corner.mul(0.032), 0));
  const clip = cameraProjectionMatrix.mul(vec4(select(snowy, flake, rain), 1));
  const fade = varying(visible.mul(smoothstep(0.3, 1.5, vv.length())).mul(smoothstep(18, 10, p.length())));
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.vertexNode = select(visible.greaterThan(0.5), clip, vec4(2, 2, 2, 1)) as Any;
  const shape = select(snowy, smoothstep(1, 0.35, corner.length()).mul(0.95), float(1).sub(abs(corner.x)).mul(float(1).sub(corner.y.mul(corner.y))).mul(0.55));
  m.colorNode = light as Any;
  m.opacityNode = shape.mul(fade) as Any;
  m.fog = false;
  return m;
}

/** PROV_GLSL: mapped or measured in blue, read from shadows in orange, presumed in green and hatched, so colour never works alone. */
export function provColor(k: Any, conf: Any, p: Any): Any {
  const sure = conf.mul(0.45).add(0.55);
  const hatch = step(0.5, fract(p.x.add(p.y).add(p.z).mul(0.5)));
  const presumed = vec3(0.01, 0.342, 0.162).mul(hatch.mul(0.55).add(0.45));
  return select(k.lessThan(1.5), vec3(0.041, 0.242, 0.783).mul(sure), select(k.lessThan(3.5).or(k.greaterThan(5.5)), vec3(0.694, 0.1, 0.019).mul(sure), presumed));
}

/** LAYERS_NORMAL of buildings.ts: the projected photograph, then the provenance colours when they are switched on. */
export function buildingLayers(view: GpuView, base: Any): Any {
  const projected = projectPhoto(view, base, positionWorld, normalWorld);
  const prov = attribute("aProv", "vec2");
  return select(view.bridge.value("uProv").greaterThan(0.5), provColor(prov.x, prov.y, positionWorld), projected);
}

const hash21 = Fn(([p]: Any[]) => {
  const q: Any = fract(p.mul(vec2(123.34, 456.21)));
  const r = q.add(dot(q, q.add(45.32)));
  return fract(r.x.mul(r.y));
});

/**
 * Facades of buildings.ts WALL_MAP: five styles, windows lit at night, recesses darker. Every style is worked out and the
 * right one picked, so glass and recess can feed roughness, metalness and emission too; then projection and provenance.
 */
function walls(view: GpuView, source: THREE.Material) {
  const b = view.bridge;
  const m = new MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0, side: source.side });
  const aM = attribute("aM", "vec2");
  const wall = attribute("aColor", "vec3");
  const info = attribute("aInfo", "vec3");
  const floorH = max(info.x, 2.6);
  const style = info.y;
  const seed = info.z;
  const grain = b.sample("uNoise", aM.mul(vec2(0.13, 0.19))).g;
  const fine = b.sample("uNoise", aM.mul(0.9)).a;

  // 0: rendered walls with bays, frames and shutters.
  const q0 = vec2(aM.x.div(seed.mul(1.7).add(3.5)), aM.y.div(floorH));
  const id0 = floor(q0);
  const f0 = fract(q0);
  const w0 = smoothstep(0.34, 0.36, f0.x).mul(smoothstep(0.66, 0.64, f0.x)).mul(smoothstep(0.26, 0.29, f0.y)).mul(smoothstep(0.8, 0.77, f0.y));
  const frame = smoothstep(0.315, 0.33, f0.x).mul(smoothstep(0.685, 0.67, f0.x)).mul(smoothstep(0.22, 0.24, f0.y)).mul(smoothstep(0.84, 0.82, f0.y));
  const shut = step(0.5, hash21(id0.add(seed))).mul(smoothstep(0.23, 0.245, f0.x)).mul(smoothstep(0.77, 0.755, f0.x)).mul(smoothstep(0.26, 0.29, f0.y)).mul(smoothstep(0.8, 0.77, f0.y)).mul(frame.oneMinus());
  let c0: Any = wall.mul(grain.mul(0.3).add(0.82)).mul(fine.mul(0.12).add(0.92));
  c0 = mix(c0, c0.mul(0.86).add(0.04), frame.mul(w0.oneMinus()).mul(0.8));
  c0 = mix(c0, vec3(0.27, 0.32, 0.24).mul(hash21(vec2(seed, 3)).mul(0.5).add(0.7)), shut.mul(0.85));
  c0 = c0.mul(mix(float(1), float(0.86), step(0.97, f0.y)));
  c0 = mix(c0, mix(c0, wall.mul(0.6), 0.5), step(id0.y, 0));
  const glass0 = step(0.5, w0);
  c0 = mix(c0, vec3(0.1, 0.11, 0.12), glass0);
  const lit0 = glass0.mul(step(0.62, hash21(id0.mul(1.7).add(seed.mul(9)))));

  // 1: curtain wall of glass in mullions.
  const q1 = vec2(aM.x.div(2.8), aM.y.div(floorH));
  const f1 = fract(q1);
  const mull = smoothstep(0.03, 0.05, f1.x).mul(smoothstep(0.97, 0.95, f1.x)).mul(smoothstep(0.05, 0.08, f1.y)).mul(smoothstep(0.93, 0.9, f1.y));
  const c1 = mix(wall.mul(0.5), vec3(0.18, 0.22, 0.26), mull);
  const lit1 = mull.mul(step(0.66, hash21(floor(q1).add(seed.mul(7)))));

  // 2: ribbed sheds.
  const rib = smoothstep(0.45, 0.55, abs(fract(aM.x.div(0.9)).sub(0.5)).mul(2));
  const c2 = wall.mul(rib.mul(0.22).add(0.72)).mul(grain.mul(0.3).add(0.82)).mul(smoothstep(0.02, 0.05, abs(fract(aM.y.div(5)).sub(0.5))).mul(0.1).add(0.9));

  // 3: monuments in arcades of ashlar.
  const q3 = vec2(aM.x.div(6.6), aM.y.div(11.5));
  const f3 = fract(q3);
  const a3 = f3.sub(vec2(0.5, 0.3)).mul(vec2(6.6, 11.5));
  const arch = max(step(abs(a3.x), 2.15).mul(step(a3.y, 0)).mul(step(-3.2, a3.y)), step(length(a3), 2.15).mul(step(0, a3.y))).mul(step(3.5, floor(q3).y).oneMinus());
  const blocks3 = smoothstep(0, 0.05, abs(fract(aM.y.div(0.75)).sub(0.5))).mul(smoothstep(0, 0.03, abs(fract(aM.x.div(1.5).add(floor(aM.y.div(0.75)).mul(0.5))).sub(0.5))));
  let c3: Any = wall.mul(grain.mul(0.4).add(0.66)).mul(blocks3.mul(0.2).add(0.82)).mul(fine.mul(0.15).add(0.9));
  c3 = c3.mul(smoothstep(0.04, 0, abs(f3.y.sub(0.97))).mul(0.38).oneMinus());
  c3 = mix(c3, mix(vec3(0.13, 0.105, 0.08), vec3(0.035, 0.03, 0.025), smoothstep(-3.2, 2.15, a3.y)), arch);

  // 4: rough stone.
  const blocks4 = smoothstep(0, 0.06, abs(fract(aM.y.div(0.55)).sub(0.5))).mul(smoothstep(0, 0.03, abs(fract(aM.x.div(1.1).add(floor(aM.y.div(0.55)).mul(0.5))).sub(0.5))));
  const c4 = wall.mul(grain.mul(0.46).add(0.62)).mul(blocks4.mul(0.22).add(0.8)).mul(fine.mul(0.22).add(0.86));

  const pick = (v0: Any, v1: Any, v2: Any, v3: Any, v4: Any) =>
    style.lessThan(0.5).select(v0, style.lessThan(1.5).select(v1, style.lessThan(2.5).select(v2, style.lessThan(3.5).select(v3, v4))));
  const glass: Any = pick(glass0, mull, float(0), float(0), float(0));
  const lit: Any = pick(lit0, lit1, float(0), float(0), float(0));
  const recess: Any = pick(float(0), float(0), float(0), arch, float(0));
  let c: Any = pick(c0, c1, c2, c3, c4);
  // Weather stains grow from the ground; openings hold no sky, so recesses stay dark.
  c = c.mul(mix(float(0.68), float(1), smoothstep(0, 2.8, aM.y))).mul(mix(float(1), float(0.42), recess));
  m.colorNode = buildingLayers(view, c);
  // The GLSL original dims the glass's whole reflection; a standard material cannot, so the glass reflects less instead.
  // With the provenance colours on, the facade is one flat colour: no glass, no lit windows.
  const plain = step(0.5, b.value("uProv")).oneMinus();
  m.roughnessNode = mix(float(0.86), float(0.22), step(0.5, glass).mul(plain)) as Any;
  m.metalnessNode = mix(float(0), float(0.25), step(0.5, glass).mul(plain)) as Any;
  m.emissiveNode = vec3(1.7, 1.15, 0.66)
    .mul(b.value("uNight"))
    .mul(step(0.5, lit).mul(plain))
    .mul(hash21(floor(aM.div(vec2(3, floorH))).add(seed)).mul(0.8).add(0.5)) as Any;
  return m;
}

/** Each instance's own phase, so neighbouring trees do not sway in step. The GLSL original drew it from the instance position. */
const phaseOf = () => fract(sin(instanceIndex.toFloat().mul(12.9898)).mul(43758.5453)).mul(40);

/**
 * SWAY of nature.ts: crowns bend with the square of their height, in three overlapping rhythms, along the wind. Here the
 * position arrives already placed by the instance, so the bend reads the vertex's own height in the model, and the
 * offset, added after the instance's scaling, is scaled by a typical crown of six metres.
 */
function sway(view: GpuView) {
  const b = view.bridge;
  const t = b.value("uTime");
  const phase = phaseOf();
  const bend = max(attribute("position", "vec3").y, 0).mul(6);
  const swing = sin(t.mul(1.1).add(phase)).mul(0.6).add(sin(t.mul(2.7).add(phase.mul(1.7))).mul(0.25)).add(sin(t.mul(5.3).add(phase.mul(3))).mul(0.08));
  const wind = b.value("uWindVec");
  return positionLocal.add(vec3(wind.x, 0, wind.y).mul(bend.mul(bend).mul(swing).mul(b.value("uWindAmp")).mul(0.022 / 6)));
}

/** Leaf cards: the leaf texture with its cut-out, tinted by each tree's colour, swaying. */
function leaves(view: GpuView, source: THREE.Material) {
  const s = source as THREE.MeshStandardMaterial;
  const m = new MeshStandardNodeMaterial({ map: s.map, alphaTest: s.alphaTest, side: THREE.DoubleSide, roughness: s.roughness, metalness: 0, vertexColors: s.vertexColors });
  m.positionNode = sway(view) as Any;
  return m;
}

/** Solid far crowns get their leafiness from world-space noise, so they do not read as polygons. */
function crowns(view: GpuView, source: THREE.Material) {
  const b = view.bridge;
  const s = source as THREE.MeshStandardMaterial;
  const m = new MeshStandardNodeMaterial({ roughness: s.roughness, metalness: 0, color: s.color.clone() });
  const p = positionWorld;
  const leafy = b.sample("uNoise", p.xz.mul(0.23).add(p.y.mul(0.19))).b.mul(0.6).add(b.sample("uNoise", p.zx.mul(0.9).add(p.y.mul(0.7))).a.mul(0.4));
  m.colorNode = materialColor.mul(leafy.mul(1.1).add(0.46)) as Any;
  m.positionNode = sway(view) as Any;
  return m;
}

function trunks(view: GpuView, source: THREE.Material) {
  const b = view.bridge;
  const s = source as THREE.MeshStandardMaterial;
  const m = new MeshStandardNodeMaterial({ roughness: s.roughness, metalness: 0, color: s.color.clone() });
  const p = positionWorld;
  const bark = b.sample("uNoise", vec2(p.x.atan(p.z).mul(3), p.y.mul(0.35))).b;
  m.colorNode = materialColor.mul(bark.mul(0.95).add(0.55)) as Any;
  return m;
}

/** Grass tufts take the colour of the lawn under them on the plate, greened and graded from root to tip, and bend in the wind. */
function grass(view: GpuView, source: THREE.Material) {
  const b = view.bridge;
  const s = source as THREE.MeshStandardMaterial;
  const m = new MeshStandardNodeMaterial({ map: s.map, alphaTest: s.alphaTest, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
  const half = b.value("uHalf");
  const plateUv = vec2(positionWorld.x.div(half.x), positionWorld.z.negate().div(half.y)).mul(0.5).add(0.5);
  const tex = texture(s.map!, uv());
  const fill = b.sample("uGain", plateUv);
  const ground = mix(b.sample("uPlate", plateUv).rgb, pow(fill.rgb, vec3(2.2)), fill.a.mul(b.value("uDeshadow")));
  const g = dot(ground, vec3(0.3, 0.6, 0.1));
  const height = attribute("position", "vec3").y;
  const t = b.value("uTime");
  const phase = phaseOf();
  const wind = b.value("uWindVec");
  const swing = sin(t.mul(2.3).add(phase)).add(sin(t.mul(4.1).add(phase.mul(1.3))).mul(0.6));
  m.positionNode = positionLocal.add(vec3(wind.x, 0, wind.y).mul(height.mul(height)).mul(swing).mul(b.value("uWindAmp")).mul(0.22)) as Any;
  m.colorNode = vec4(mix(ground, vec3(g.mul(0.8), g.mul(1.25), g.mul(0.42)), 0.4).mul(mix(float(0.75), float(1.5), height.mul(2))).mul(tex.rgb), tex.a) as Any;
  return m;
}

/** Water takes its colour from the photograph and moves with two drifting ripple layers in its normal. */
function water(view: GpuView) {
  const b = view.bridge;
  const m = new MeshStandardNodeMaterial({ roughness: 0.07, metalness: 0 });
  const { albedo } = view.plateAlbedo(positionWorld.xz, float(0));
  m.colorNode = albedo.mul(0.62) as Any;
  const t = b.value("uTime").mul(0.35);
  const p = positionWorld.xz;
  const a = vec2(b.sample("uNoise", p.mul(0.07).add(vec2(t.mul(0.08), t.mul(0.05)))).a, b.sample("uNoise", p.mul(0.07).add(vec2(t.mul(-0.06), t.mul(0.09)))).a).sub(0.5);
  const c = vec2(b.sample("uNoise", p.mul(0.31).add(vec2(t.mul(0.2), t.mul(-0.1)))).b, b.sample("uNoise", p.mul(0.31).sub(vec2(t.mul(0.15), t.mul(0.19)))).b).sub(0.5);
  const w = a.mul(0.28).add(c.mul(0.13));
  m.normalNode = normalize(normalView.add(cameraViewMatrix.mul(vec4(w.x, 0, w.y, 0)).xyz)) as Any;
  return m;
}

/** Low walls in courses of stone, darker at the foot. */
function lowWalls(view: GpuView) {
  const b = view.bridge;
  const m = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const aM = attribute("aM", "vec2");
  const rows = smoothstep(0, 0.04, abs(fract(aM.y.div(0.42)).sub(0.5))).mul(smoothstep(0, 0.025, abs(fract(aM.x.div(0.9).add(floor(aM.y.div(0.42)).mul(0.5))).sub(0.5))));
  m.colorNode = materialColor.mul(b.sample("uNoise", aM.mul(vec2(0.21, 0.3))).g.mul(0.52).add(0.66)).mul(rows.mul(0.2).add(0.84)).mul(mix(float(0.62), float(1), smoothstep(0, 0.9, aM.y))) as Any;
  return m;
}

/** Railings: uprights and rails cut out of a flat strip. */
function bars() {
  const m = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide, alphaTest: 0.5 });
  const aM = attribute("aM", "vec2");
  const upright = step(fract(aM.x.div(0.14)), 0.2);
  const rail = step(fract(aM.y.div(1.05).add(0.05)), 0.07);
  m.opacityNode = upright.add(rail).min(1).mul(step(0, aM.y)) as Any;
  return m;
}

/** The flood tool's sheet of water: translucent, with drifting ripples in its normal, as in engine.ts setFlood. */
function flood(view: GpuView) {
  const b = view.bridge;
  const m = new MeshStandardNodeMaterial({ color: 0x2f5560, roughness: 0.09, metalness: 0.05, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
  const t = b.value("uTime");
  const p = positionWorld.xz.mul(0.05);
  const w = vec2(b.sample("uNoise", p.add(t.mul(vec2(0.006, 0.004)))).a, b.sample("uNoise", p.sub(t.mul(vec2(0.004, 0.007)))).a).sub(0.5);
  m.normalNode = normalize(normalView.add(cameraViewMatrix.mul(vec4(w.x.mul(0.16), 0, w.y.mul(0.16), 0)).xyz)) as Any;
  return m;
}

export const PORTED: Record<string, Port> = {
  flood,
  precip: precipitation,
  ground: (view) => view.groundMaterial(),
  roofs: (view, source) => view.roofMaterial(source),
  far: (view, source) => view.standIn(source),
  // Marked so that GpuView gives walls their own share of the sky's light (wallLight in gpu.ts).
  walls: (view, source) => {
    const m = weatherize(view, walls(view, source));
    m.userData.wall = true;
    return m;
  },
  leaves,
  crowns,
  trunks,
  grass,
  water,
  "walls-low": (view) => weatherize(view, lowWalls(view)),
  "fence-bars": bars,
  ribbons: (view, source) => view.standIn(source),
  props: (view, source) => view.standIn(source),
  avatar: (view, source) => view.standIn(source),
};

void cameraPosition;
