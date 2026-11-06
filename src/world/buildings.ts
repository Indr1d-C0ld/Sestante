import * as THREE from "three";
import type { CSM } from "three/addons/csm/CSM.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Building } from "../field/load.ts";
import { PLATE_GLSL, PROJECT_GLSL, PROV_GLSL, shade } from "./shading.ts";

const NAMED: Record<string, number> = {
  white: 0xece7dc, black: 0x2c2c2c, grey: 0x8f8f8c, gray: 0x8f8f8c, red: 0xa0463a, brown: 0x7a5a42, beige: 0xcbb99a, yellow: 0xd7bd6c,
  orange: 0xcf8a4c, pink: 0xd4a39a, sand: 0xc8ae80, cream: 0xe2d6b8, tan: 0xb89a70, green: 0x6d8a5c, blue: 0x6a84a0, ivory: 0xe8e1cd, maroon: 0x7a3b32,
};

function hashString(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

const PLASTER = [0xd8c9a7, 0xcdb793, 0xc9a982, 0xdfd5be, 0xbf9d7a, 0xd3b9a0, 0xb8a58a, 0xe2d9c6, 0xc4a78f, 0xc2836a];

function wallColor(building: Building) {
  const tags = building.tags;
  const colour = tags["building:colour"] ?? tags["building:color"];
  const material = tags["building:material"] ?? "";
  if (colour) {
    if (colour.startsWith("#")) return new THREE.Color(colour);
    const named = NAMED[colour.toLowerCase()];
    if (named) return new THREE.Color(named);
  }
  if (material === "brick") return new THREE.Color(0x9c5b45);
  if (material === "stone" || material === "limestone" || material === "marble") return new THREE.Color(0xc2b59a);
  if (material === "glass") return new THREE.Color(0x9fb2b8);
  if (material === "concrete") return new THREE.Color(0xa9a59b);
  if (material === "metal") return new THREE.Color(0x98a0a4);
  if (material === "wood") return new THREE.Color(0x8e6c4a);
  if (tags.historic || tags["building:architecture"] === "antique" || tags.ruins === "yes") return new THREE.Color(0xbfae8e);
  const kind = tags.building ?? "";
  if (kind === "industrial" || kind === "warehouse") return new THREE.Color(0xa6a59c);
  if (kind === "office" || kind === "commercial") return new THREE.Color(0xb6b8b2);
  return new THREE.Color(PLASTER[Math.floor(hashString(building.id) * PLASTER.length)]!);
}

/** 0 plaster with windows, 1 glazed curtain wall, 2 industrial panels, 3 arcaded stone, 4 plain ancient wall. */
function wallStyle(building: Building) {
  const tags = building.tags;
  const kind = tags.building ?? "";
  const levels = building.levels;
  if (building.source === "ripresa") return 4;
  const antique = tags["building:architecture"] === "antique" || tags["historic:civilization"] === "ancient_roman" || tags.ruins === "yes" || kind === "ruins";
  if (kind === "amphitheatre" || tags.historic === "amphitheatre" || (antique && building.height > 14)) return 3;
  if (antique || tags.historic === "ruins" || tags.historic === "archaeological_site" || tags.historic === "tomb" || tags.historic === "castle" || tags.historic === "fort") return 4;
  if (["pyramid", "tomb", "temple", "ruins", "castle", "fort", "tower", "bunker", "wall", "tumulus", "mausoleum"].includes(kind)) return 4;
  if (kind === "church" || kind === "cathedral" || kind === "basilica" || kind === "chapel") return 4;
  if (kind === "industrial" || kind === "warehouse" || kind === "shed" || kind === "garage" || kind === "garages" || kind === "barn" || kind === "service") return 2;
  if ((kind === "office" || kind === "commercial") && levels >= 5) return 1;
  if (levels >= 16) return 1;
  if (tags["building:material"] === "glass") return 1;
  return 0;
}

class Sink {
  pos: number[] = [];
  norm: number[] = [];
  uv: number[] = [];
  color: number[] = [];
  info: number[] = [];
  prov: number[] = [];
  index: number[] = [];
  /** Source of the height and how sure it is, stamped on every vertex of the current building. */
  stamp: [number, number] = [0, 1];

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: THREE.Color, floorH: number, style: number, seed: number) {
    this.pos.push(x, y, z);
    this.norm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.color.push(c.r, c.g, c.b);
    this.info.push(floorH, style, seed);
    this.prov.push(this.stamp[0], this.stamp[1]);
    return this.pos.length / 3 - 1;
  }

  build() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute("aM", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("aColor", new THREE.Float32BufferAttribute(this.color, 3));
    g.setAttribute("aInfo", new THREE.Float32BufferAttribute(this.info, 3));
    g.setAttribute("aProv", new THREE.Float32BufferAttribute(this.prov, 2));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    return g;
  }
}

function ensureCCW(ring: number[]) {
  let area = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!;
  // x east, z south, seen from above: positive shoelace is clockwise on screen.
  return area >= 0 ? ring : reverseRing(ring);
}

function reverseRing(ring: number[]) {
  const out: number[] = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i]!, ring[i + 1]!);
  return out;
}

function addWalls(sink: Sink, ring: number[], yBase: number, yTop: number, color: THREE.Color, floorH: number, style: number, seed: number, flip: boolean, groundRef: number) {
  const n = ring.length / 2;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2]!;
    const az = ring[i * 2 + 1]!;
    const bx = ring[j * 2]!;
    const bz = ring[j * 2 + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.01) continue;
    // Clockwise-from-above rings: outward normal is on the left of travel.
    let nx = (bz - az) / len;
    let nz = -(bx - ax) / len;
    if (flip) {
      nx = -nx;
      nz = -nz;
    }
    const v0 = yBase - groundRef;
    const v1 = yTop - groundRef;
    const a = sink.vert(ax, yBase, az, nx, 0, nz, u, v0, color, floorH, style, seed);
    const b = sink.vert(bx, yBase, bz, nx, 0, nz, u + len, v0, color, floorH, style, seed);
    const c = sink.vert(bx, yTop, bz, nx, 0, nz, u + len, v1, color, floorH, style, seed);
    const d = sink.vert(ax, yTop, az, nx, 0, nz, u, v1, color, floorH, style, seed);
    if (flip) sink.index.push(a, c, b, a, d, c);
    else sink.index.push(a, b, c, a, c, d);
    u += len;
  }
}

function triNormal(a: number[], b: number[], c: number[]) {
  const ux = b[0]! - a[0]!;
  const uy = b[1]! - a[1]!;
  const uz = b[2]! - a[2]!;
  const vx = c[0]! - a[0]!;
  const vy = c[1]! - a[1]!;
  const vz = c[2]! - a[2]!;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return ny >= 0 ? [nx / len, ny / len, nz / len] : [-nx / len, -ny / len, -nz / len];
}

function addRoofTri(sink: Sink, a: number[], b: number[], c: number[], color: THREE.Color, seed: number) {
  const n = triNormal(a, b, c);
  const add = (p: number[]) => sink.vert(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, 0, 0, color, 1, 0, seed);
  // Facing up from above matters more than winding consistency here: materials are double sided on roofs.
  const ia = add(a);
  const ib = add(b);
  const ic = add(c);
  sink.index.push(ia, ib, ic);
}

function addFlatRoof(sink: Sink, rings: number[][], y: number, color: THREE.Color, seed: number) {
  const contour = [] as THREE.Vector2[];
  const outer = rings[0]!;
  for (let i = 0; i < outer.length; i += 2) contour.push(new THREE.Vector2(outer[i], outer[i + 1]));
  const holes = rings.slice(1).map((ring) => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < ring.length; i += 2) pts.push(new THREE.Vector2(ring[i], ring[i + 1]));
    return pts;
  });
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  const all = [contour, ...holes].flat();
  const offset = sink.pos.length / 3;
  for (const p of all) sink.vert(p.x, y, p.y, 0, 1, 0, 0, 0, color, 1, 0, seed);
  for (const f of faces) sink.index.push(offset + f[0]!, offset + f[2]!, offset + f[1]!);
}

function centroid(ring: number[]) {
  let x = 0;
  let z = 0;
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i]!;
    z += ring[i + 1]!;
  }
  const n = ring.length / 2;
  return { x: x / n, z: z / n };
}

function principalAxis(ring: number[]) {
  const c = centroid(ring);
  let xx = 0;
  let zz = 0;
  let xz = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // Weighted by edge length so that dense curves do not skew a rectangular plan.
    const len = Math.hypot(ring[j * 2]! - ring[i * 2]!, ring[j * 2 + 1]! - ring[i * 2 + 1]!);
    const dx = ring[i * 2]! - c.x;
    const dz = ring[i * 2 + 1]! - c.z;
    xx += dx * dx * len;
    zz += dz * dz * len;
    xz += dx * dz * len;
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  return { ax: Math.cos(angle), az: Math.sin(angle), c };
}

/** Pitched roofs: every eave edge is lofted to a ridge segment, which covers gables and hips for any star-like plan. */
function addLoftRoof(sink: Sink, ring: number[], eave: number, rise: number, shape: string, color: THREE.Color, seed: number) {
  const { ax, az, c } = principalAxis(ring);
  const n = ring.length / 2;
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = ring[i * 2]! - c.x;
    const dz = ring[i * 2 + 1]! - c.z;
    const a = dx * ax + dz * az;
    const b = -dx * az + dz * ax;
    minA = Math.min(minA, a);
    maxA = Math.max(maxA, a);
    minB = Math.min(minB, b);
    maxB = Math.max(maxB, b);
  }
  const midA = (minA + maxA) / 2;
  const midB = (minB + maxB) / 2;
  const halfLen = (maxA - minA) / 2;
  const halfWid = (maxB - minB) / 2;
  const ridgeHalf = shape === "gabled" ? halfLen : Math.max(0, halfLen - halfWid);
  const ridgePoint = (t: number) => {
    const a = midA + Math.max(-ridgeHalf, Math.min(ridgeHalf, t - midA));
    return [c.x + a * ax - midB * az, eave + rise, c.z + a * az + midB * ax];
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = [ring[i * 2]!, eave, ring[i * 2 + 1]!];
    const q = [ring[j * 2]!, eave, ring[j * 2 + 1]!];
    const along = (v: number[]) => (v[0]! - c.x) * ax + (v[2]! - c.z) * az;
    const rp = ridgePoint(along(p));
    const rq = ridgePoint(along(q));
    addRoofTri(sink, p, q, rq, color, seed);
    if (Math.hypot(rp[0]! - rq[0]!, rp[2]! - rq[2]!) > 0.01) addRoofTri(sink, p, rq, rp, color, seed);
  }
}

function addSkillion(sink: Sink, ring: number[], eave: number, rise: number, color: THREE.Color, seed: number) {
  const { ax, az, c } = principalAxis(ring);
  const n = ring.length / 2;
  let minB = Infinity;
  let maxB = -Infinity;
  for (let i = 0; i < n; i++) {
    const b = -(ring[i * 2]! - c.x) * az + (ring[i * 2 + 1]! - c.z) * ax;
    minB = Math.min(minB, b);
    maxB = Math.max(maxB, b);
  }
  const yAt = (x: number, z: number) => eave + rise * ((-(x - c.x) * az + (z - c.z) * ax - minB) / Math.max(0.1, maxB - minB));
  const contour: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(ring[i * 2], ring[i * 2 + 1]));
  for (const f of THREE.ShapeUtils.triangulateShape(contour, [])) {
    const pts = f.map((k) => [contour[k]!.x, yAt(contour[k]!.x, contour[k]!.y), contour[k]!.y]);
    addRoofTri(sink, pts[0]!, pts[2]!, pts[1]!, color, seed);
  }
  addWallsSkirt(sink, ring, eave, yAt, color, seed);
}

function addWallsSkirt(sink: Sink, ring: number[], eave: number, yAt: (x: number, z: number) => number, color: THREE.Color, seed: number) {
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2]!;
    const az = ring[i * 2 + 1]!;
    const bx = ring[j * 2]!;
    const bz = ring[j * 2 + 1]!;
    addRoofTri(sink, [ax, eave, az], [bx, eave, bz], [bx, yAt(bx, bz), bz], color, seed);
    addRoofTri(sink, [ax, eave, az], [bx, yAt(bx, bz), bz], [ax, yAt(ax, az), az], color, seed);
  }
}

function addRevolvedRoof(sink: Sink, ring: number[], eave: number, rise: number, shape: string, color: THREE.Color, seed: number) {
  const c = centroid(ring);
  const n = ring.length / 2;
  const steps = shape === "cone" || shape === "pyramidal" ? 1 : 8;
  const profile = (t: number) => {
    if (shape === "cone" || shape === "pyramidal") return { r: 1 - t, y: t };
    if (shape === "onion") {
      const r = t < 0.45 ? 1 + 0.22 * Math.sin((t / 0.45) * Math.PI) : Math.pow(1 - (t - 0.45) / 0.55, 1.6);
      return { r, y: t };
    }
    const a = t * Math.PI * 0.5;
    return { r: Math.cos(a), y: Math.sin(a) };
  };
  for (let s = 0; s < steps; s++) {
    const p0 = profile(s / steps);
    const p1 = profile((s + 1) / steps);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ring0 = (k: number, p: { r: number; y: number }) => [c.x + (ring[k * 2]! - c.x) * p.r, eave + rise * p.y, c.z + (ring[k * 2 + 1]! - c.z) * p.r];
      const a = ring0(i, p0);
      const b = ring0(j, p0);
      const d = ring0(i, p1);
      const e = ring0(j, p1);
      addRoofTri(sink, a, b, e, color, seed);
      if (p1.r > 0.001) addRoofTri(sink, a, e, d, color, seed);
    }
  }
}

function compact(ring: number[]) {
  const n = ring.length / 2;
  let area = 0;
  let perim = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!;
    perim += Math.hypot(ring[i * 2]! - ring[j * 2]!, ring[i * 2 + 1]! - ring[j * 2 + 1]!);
  }
  return (4 * Math.PI * Math.abs(area / 2)) / (perim * perim);
}

const WALL_PARS = /* glsl */ `
  attribute vec2 aM;
  attribute vec3 aColor;
  attribute vec3 aInfo;
  attribute vec2 aProv;
  varying vec2 vM;
  varying vec3 vWall;
  varying vec3 vInfo;
  varying vec2 vProv;
`;

const WALL_FRAG_PARS = /* glsl */ `
  varying vec2 vM;
  varying vec3 vWall;
  varying vec3 vInfo;
  varying vec2 vProv;
  ${PROJECT_GLSL}
  ${PROV_GLSL}
  float wallGlass, wallLit, wallRecess;
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`;

const WALL_MAP = /* glsl */ `
  float floorH = max(vInfo.x, 2.6);
  float style = vInfo.y;
  float seed = vInfo.z;
  vec3 wall = vWall;
  vec3 c = wall;
  wallGlass = 0.; wallLit = 0.; wallRecess = 0.;
  float grain = texture2D(uNoise, vM * vec2(.13, .19)).g;
  float fine = texture2D(uNoise, vM * .9).a;
  float weather = smoothstep(1.2, -.6, fract(vM.y / floorH) * 2. - 1.);
  if (style < .5) {
    float bay = 3.5 + seed * 1.7;
    vec2 q = vec2(vM.x / bay, vM.y / floorH);
    vec2 id = floor(q);
    vec2 f = fract(q);
    float ground = step(id.y, 0.);
    float w = smoothstep(.34, .36, f.x) * smoothstep(.66, .64, f.x) * smoothstep(.26, .29, f.y) * smoothstep(.8, .77, f.y);
    float frame = smoothstep(.315, .33, f.x) * smoothstep(.685, .67, f.x) * smoothstep(.22, .24, f.y) * smoothstep(.84, .82, f.y);
    float shutterSide = (hash21(id + seed) > .5 ? 1. : 0.);
    float shut = shutterSide * smoothstep(.23, .245, f.x) * smoothstep(.77, .755, f.x) * smoothstep(.26, .29, f.y) * smoothstep(.8, .77, f.y) * (1. - frame);
    c = wall * (.82 + .3 * grain) * (.92 + .12 * fine);
    c = mix(c, c * .86 + vec3(.04), frame * (1. - w) * .8);
    c = mix(c, vec3(.27, .32, .24) * (.7 + .5 * hash21(vec2(seed, 3.))), shut * .85);
    c *= mix(1., .86, step(.97, f.y));
    if (ground > .5) {
      c = mix(c, wall * .6, .5);
      w *= 1.;
    }
    if (w > .5) {
      wallGlass = 1.;
      c = vec3(.1, .11, .12);
      wallLit = step(.62 + uTime * 0., hash21(id * 1.7 + seed * 9.));
    }
    wallRecess = 0.;
  } else if (style < 1.5) {
    vec2 q = vec2(vM.x / 2.8, vM.y / floorH);
    vec2 id = floor(q);
    vec2 f = fract(q);
    float mull = smoothstep(.03, .05, f.x) * smoothstep(.97, .95, f.x) * smoothstep(.05, .08, f.y) * smoothstep(.93, .9, f.y);
    c = mix(wall * .5, vec3(.18, .22, .26), mull);
    wallGlass = mull;
    wallLit = mull * step(.66, hash21(id + seed * 7.));
  } else if (style < 2.5) {
    float rib = smoothstep(.45, .55, abs(fract(vM.x / .9) - .5) * 2.);
    c = wall * (.72 + .22 * rib) * (.82 + .3 * grain);
    float band = smoothstep(.02, .05, abs(fract(vM.y / 5.) - .5));
    c *= .9 + .1 * band;
  } else if (style < 3.5) {
    float tiers = max(1., floor(vM.y / 11.5));
    vec2 q = vec2(vM.x / 6.6, vM.y / 11.5);
    vec2 id = floor(q);
    vec2 f = fract(q);
    vec2 a = (f - vec2(.5, .3)) * vec2(6.6, 11.5);
    float rx = 2.15;
    float arch = max(step(abs(a.x), rx) * step(a.y, 0.) * step(-3.2, a.y), step(length(a), rx) * step(0., a.y));
    float top = step(3.5, id.y);
    arch *= 1. - top;
    float blocks = smoothstep(.0, .05, abs(fract(vM.y / .75) - .5)) * smoothstep(.0, .03, abs(fract(vM.x / 1.5 + floor(vM.y / .75) * .5) - .5));
    c = wall * (.66 + .4 * grain) * (.82 + .2 * blocks) * (.9 + .15 * fine);
    float cornice = smoothstep(.04, .0, abs(f.y - .97));
    c *= 1. - cornice * .38;
    float deep = smoothstep(-3.2, rx, a.y);
    c = mix(c, mix(vec3(.13, .105, .08), vec3(.035, .03, .025), deep), arch);
    wallRecess = arch;
    tiers *= 1.;
  } else {
    float blocks = smoothstep(.0, .06, abs(fract(vM.y / .55) - .5)) * smoothstep(.0, .03, abs(fract(vM.x / 1.1 + floor(vM.y / .55) * .5) - .5));
    c = wall * (.62 + .46 * grain) * (.8 + .22 * blocks) * (.86 + .22 * fine);
  }
  // Weather stains grow from the ground and from under eaves.
  c *= mix(.68, 1., smoothstep(.0, 2.8, vM.y));
  diffuseColor.rgb = c;
`;

const LAYERS_NORMAL = /* glsl */ `
  diffuseColor.rgb = projectPhoto(diffuseColor.rgb, vW, inverseTransformDirection(normal, viewMatrix));
  if (uProv > .5) diffuseColor.rgb = provColor(vProv.x, vProv.y, vW);
`;

const WALL_ROUGH = /* glsl */ `
  if (wallGlass > .5) { roughnessFactor = .1; metalnessFactor = .55; }
  else { roughnessFactor = .86; metalnessFactor = 0.; }
`;

const WALL_EMISSIVE = /* glsl */ `
  if (wallLit > .5) totalEmissiveRadiance += vec3(1.7, 1.15, .66) * uNight * (.5 + .8 * hash21(floor(vM / vec2(3., floorH)) + seed));
`;

// Openings hold no sky: the blue sheen of the environment would flatten them into paint.
const WALL_OUT = /* glsl */ `
  if (wallGlass < .5) outgoingLight *= mix(1., .42, wallRecess);
  else outgoingLight = outgoingLight * .42 + totalEmissiveRadiance * .58;
`;

const ROOF_MAP = /* glsl */ `
  vec4 cls;
  vec3 albedo = plateAlbedo(vW.xz, cls);
  float dRoof = length(uCam - vW);
  float nR = texture2D(uNoise, vW.xz * .47).a;
  albedo *= mix(1., .85 + .3 * nR, (1. - smoothstep(15., 120., dRoof)) * uDetail);
  diffuseColor.rgb = albedo;
`;

const SOURCE_INDEX: Record<Building["source"], number> = { "OSM height": 0, "OSM piani": 1, "laser GEDI": 1, "ombre multi-data": 2, ombra: 3, quartiere: 4, "tipo edilizio": 5, ripresa: 6, LiDAR: 1 };

export type BuildingGroup = { group: THREE.Group; walls: THREE.Mesh[]; roofs: THREE.Mesh[] };

export function buildBuildings(buildings: Building[], csm: CSM | null, cell = 260): BuildingGroup {
  const buckets = new Map<string, { walls: Sink; roofs: Sink }>();
  const bucketOf = (x: number, z: number) => {
    const key = `${Math.floor(x / cell)}:${Math.floor(z / cell)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { walls: new Sink(), roofs: new Sink() };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const building of buildings) {
    if (building.hidden) continue;
    const seed = hashString(building.id);
    const color = wallColor(building);
    color.multiplyScalar(0.88 + seed * 0.2);
    const style = wallStyle(building);
    const rings = building.rings.map((ring, index) => (index === 0 ? ensureCCW(ring) : ring));
    const outer = rings[0]!;
    const c = centroid(outer);
    const bucket = bucketOf(c.x, c.z);
    bucket.walls.stamp = bucket.roofs.stamp = [SOURCE_INDEX[building.source], Math.max(0.15, Math.min(1, building.confidence))];
    const yTop = building.top;
    const eave = yTop - building.roofHeight;
    const groundRef = yTop - building.height;
    const floor = building.minHeight > 0 ? groundRef + building.minHeight : building.base - 2.5;
    const floorH = Math.max(2.8, Math.min(style === 3 ? 12 : 4.6, (building.height - building.roofHeight) / Math.max(1, building.levels)));
    addWalls(bucket.walls, outer, floor, eave, color, floorH, style, seed, false, groundRef);
    for (let h = 1; h < rings.length; h++) {
      const hole = ensureCCW(rings[h]!);
      addWalls(bucket.walls, hole, floor, eave, color, floorH, style, seed, true, groundRef);
    }
    const shape = building.roofShape;
    const round = compact(outer) > 0.72;
    if (shape === "gabled" || shape === "hipped" || shape === "half-hipped" || shape === "saltbox" || shape === "gambrel" || shape === "mansard") {
      addLoftRoof(bucket.roofs, outer, eave, building.roofHeight, shape === "gabled" ? "gabled" : "hipped", color, seed);
    } else if (shape === "dome" || shape === "onion" || shape === "round") {
      addRevolvedRoof(bucket.roofs, outer, eave, building.roofHeight, shape === "onion" ? "onion" : "dome", color, seed);
    } else if (shape === "cone" || shape === "pyramidal") {
      addRevolvedRoof(bucket.roofs, outer, eave, building.roofHeight, shape, color, seed);
    } else if (shape === "skillion" || shape === "lean_to") {
      addSkillion(bucket.roofs, outer, eave, building.roofHeight, color, seed);
    } else {
      void round;
      addFlatRoof(bucket.roofs, rings, eave, color, seed);
    }
    // Flat roofs read as flat slabs without a parapet.
    if ((shape === "flat" || !shape) && building.height > 5 && style !== 3 && outer.length / 2 <= 48) {
      addWalls(bucket.walls, outer, eave, eave + 0.55, color, floorH, 4, seed, false, eave - 3);
    }
  }

  const wallMaterial = shade(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0, envMapIntensity: 0.65 }),
    {
      key: "walls",
      vertexPars: WALL_PARS,
      vertexBegin: "vM = aM; vWall = aColor; vInfo = aInfo; vProv = aProv;",
      fragmentPars: WALL_FRAG_PARS,
      map: WALL_MAP,
      afterRoughness: WALL_ROUGH,
      afterNormal: LAYERS_NORMAL,
      emissive: WALL_EMISSIVE,
      beforeOutput: WALL_OUT,
    },
    csm,
  );
  const roofMaterial = shade(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, envMapIntensity: 0.5, side: THREE.DoubleSide }),
    {
      key: "roofs",
      vertexPars: "attribute vec2 aProv; varying vec2 vProv;",
      vertexBegin: "vProv = aProv;",
      fragmentPars: `${PLATE_GLSL}\n${PROJECT_GLSL}\n${PROV_GLSL}\nvarying vec2 vProv;`,
      map: ROOF_MAP,
      afterNormal: LAYERS_NORMAL,
    },
    csm,
  );

  const group = new THREE.Group();
  const walls: THREE.Mesh[] = [];
  const roofs: THREE.Mesh[] = [];
  for (const bucket of buckets.values()) {
    const wg = bucket.walls.build();
    const rg = bucket.roofs.build();
    if (wg) {
      const mesh = new THREE.Mesh(wg, wallMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      walls.push(mesh);
      group.add(mesh);
    }
    if (rg) {
      const mesh = new THREE.Mesh(rg, roofMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      roofs.push(mesh);
      group.add(mesh);
    }
  }
  void mergeGeometries;
  return { group, walls, roofs };
}
