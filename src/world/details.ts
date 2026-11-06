import * as THREE from "three";
import type { CSM } from "three/addons/csm/CSM.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { AreaFeature, LineFeature, PointFeature } from "../field/load.ts";
import { PLATE_GLSL, shade, U } from "./shading.ts";

function colored(geometry: THREE.BufferGeometry, hex: number) {
  const c = new THREE.Color(hex);
  const p = geometry.getAttribute("position") as THREE.BufferAttribute;
  const data = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    data[i * 3] = c.r;
    data[i * 3 + 1] = c.g;
    data[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(data, 3));
  return geometry.index ? geometry.toNonIndexed() : geometry;
}

const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
const merge = (parts: THREE.BufferGeometry[]) => {
  const clean = parts.map((part) => {
    const g = part.index ? part.toNonIndexed() : part;
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "color"].includes(name)) g.deleteAttribute(name);
    return g;
  });
  return mergeGeometries(clean)!;
};

const METAL = 0x34383a;
const STONE = 0xa9a292;
const WOOD = 0x6a4a2e;

function propGeometry(kind: string): THREE.BufferGeometry {
  switch (kind) {
    case "lamp":
      return merge([
        colored(at(cyl(0.05, 0.08, 6), 0, 3, 0), METAL),
        colored(at(box(0.9, 0.06, 0.08), 0.42, 6, 0), METAL),
        colored(at(box(0.4, 0.09, 0.2), 0.8, 5.96, 0), 0xfff5cf),
      ]);
    case "bench":
      return merge([
        colored(at(box(1.7, 0.06, 0.42), 0, 0.44, 0), WOOD),
        colored(at(box(1.7, 0.4, 0.05), 0, 0.68, -0.2), WOOD),
        colored(at(box(0.06, 0.44, 0.4), -0.72, 0.22, 0), METAL),
        colored(at(box(0.06, 0.44, 0.4), 0.72, 0.22, 0), METAL),
      ]);
    case "bin":
      return merge([colored(at(cyl(0.26, 0.22, 0.9, 10), 0, 0.45, 0), 0x3b4a3e)]);
    case "bollard":
      return merge([colored(at(cyl(0.07, 0.09, 0.95), 0, 0.47, 0), 0x2c2f30)]);
    case "signal":
      return merge([colored(at(cyl(0.05, 0.06, 3.4), 0, 1.7, 0), METAL), colored(at(box(0.26, 0.8, 0.2), 0, 3.5, 0), 0x1d1f1e)]);
    case "busstop":
      return merge([colored(at(cyl(0.04, 0.05, 2.9), 0, 1.45, 0), METAL), colored(at(box(0.5, 0.42, 0.04), 0, 2.8, 0), 0x2e5b8f)]);
    case "fountain":
      return merge([colored(at(cyl(0.18, 0.24, 1.1), 0, 0.55, 0), STONE), colored(at(cyl(0.34, 0.26, 0.1), 0, 1.1, 0), STONE)]);
    case "monument":
      return merge([colored(at(box(1.8, 0.7, 1.8), 0, 0.35, 0), STONE), colored(at(box(1.05, 2.4, 1.05), 0, 1.9, 0), 0xb4ad9c), colored(at(new THREE.SphereGeometry(0.46, 10, 8), 0, 3.5, 0), 0x6f7b6b)]);
    case "column":
      return merge([colored(at(box(1, 0.5, 1), 0, 0.25, 0), STONE), colored(at(cyl(0.34, 0.42, 6.8, 12), 0, 3.9, 0), 0xbdb5a0), colored(at(box(0.95, 0.42, 0.95), 0, 7.5, 0), STONE)]);
    case "mast":
      return merge([colored(at(cyl(0.1, 0.32, 26), 0, 13, 0), 0x777c7c)]);
    case "chimney":
      return merge([colored(at(cyl(0.9, 1.5, 34, 12), 0, 17, 0), 0x8d7e70)]);
    case "cross":
      return merge([colored(at(box(0.12, 2.8, 0.12), 0, 1.4, 0), STONE), colored(at(box(1, 0.12, 0.12), 0, 2.1, 0), STONE)]);
    case "pole":
      return merge([colored(at(cyl(0.09, 0.14, 8.5), 0, 4.2, 0), 0x5a4a38), colored(at(box(1.4, 0.07, 0.07), 0, 8, 0), 0x5a4a38)]);
    case "pylon":
      return merge([
        colored(at(cyl(0.2, 1.6, 30, 4), 0, 15, 0), 0x6e7274),
        colored(at(box(8, 0.2, 0.2), 0, 25, 0), 0x6e7274),
        colored(at(box(6, 0.2, 0.2), 0, 20, 0), 0x6e7274),
      ]);
    case "rock":
      return merge([colored(at(new THREE.DodecahedronGeometry(0.8, 0), 0, 0.35, 0), 0x777366)]);
    case "info":
      return merge([colored(at(cyl(0.04, 0.05, 1.6), -0.4, 0.8, 0), METAL), colored(at(cyl(0.04, 0.05, 1.6), 0.4, 0.8, 0), METAL), colored(at(box(1, 0.7, 0.04), 0, 1.35, 0), 0x35513c)]);
    default:
      return merge([colored(at(box(0.3, 0.8, 0.3), 0, 0.4, 0), STONE)]);
  }
}

function classifyProp(tags: Record<string, string>) {
  if (tags.highway === "street_lamp") return "lamp";
  if (tags.amenity === "bench") return "bench";
  if (tags.amenity === "waste_basket") return "bin";
  if (tags.barrier === "bollard") return "bollard";
  if (tags.highway === "traffic_signals") return "signal";
  if (tags.highway === "bus_stop") return "busstop";
  if (tags.amenity === "fountain" || tags.amenity === "drinking_water") return "fountain";
  if (tags.historic === "memorial" || tags.historic === "monument" || tags.tourism === "artwork" || tags.historic === "tomb") return "monument";
  if (tags.historic === "column" || tags.historic === "boundary_stone" || tags.historic === "milestone") return "column";
  if (tags.man_made === "mast" || tags.man_made === "flagpole" || tags.man_made === "surveillance") return "mast";
  if (tags.man_made === "chimney") return "chimney";
  if (tags.man_made === "cross" || tags.historic === "wayside_cross" || tags.historic === "wayside_shrine") return "cross";
  if (tags.power === "pole") return "pole";
  if (tags.power === "tower") return "pylon";
  if (tags.natural === "rock" || tags.natural === "stone") return "rock";
  if (tags.tourism === "information") return "info";
  return null;
}

export type PlacedProp = { x: number; z: number; r: number; h: number; feature: PointFeature; kind: string };

export function buildProps(props: PointFeature[], heightAt: (x: number, z: number) => number, csm: CSM | null) {
  const group = new THREE.Group();
  const byKind = new Map<string, PointFeature[]>();
  for (const prop of props) {
    const kind = classifyProp(prop.tags);
    if (!kind) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(prop);
  }
  const material = shade(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0.12, envMapIntensity: 0.6 }), { key: "props" }, csm);
  const dummy = new THREE.Object3D();
  const placed: PlacedProp[] = [];
  const lamps: { x: number; y: number; z: number }[] = [];
  for (const [kind, items] of byKind) {
    const geometry = propGeometry(kind);
    geometry.computeBoundingBox();
    const size = geometry.boundingBox!.max;
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    items.forEach((item, index) => {
      const y = heightAt(item.x, item.z);
      const heading = Number.parseFloat(item.tags.direction ?? "");
      dummy.position.set(item.x, y, item.z);
      dummy.rotation.set(0, Number.isFinite(heading) ? (-heading * Math.PI) / 180 : (index * 2.399) % 6.283, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      placed.push({ x: item.x, z: item.z, r: Math.max(size.x, size.z) * 0.5, h: size.y, feature: item, kind });
      if (kind === "lamp") lamps.push({ x: item.x + Math.cos(-dummy.rotation.y) * 0.8, y: y + 0.08, z: item.z + Math.sin(-dummy.rotation.y) * 0.8 });
    });
    mesh.castShadow = kind !== "bollard";
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (lamps.length) group.add(lampPools(lamps));
  return { group, placed };
}

/** Night-time pools of light: additive decals cost nothing, a hundred real lights would cost everything. */
function lampPools(lamps: { x: number; y: number; z: number }[]) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,225,170,1)");
  gradient.addColorStop(0.4, "rgba(255,205,140,.42)");
  gradient.addColorStop(1, "rgba(255,190,120,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { map: { value: texture }, uNight: U.uNight },
    polygonOffset: true,
    polygonOffsetFactor: -2,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D map;
      uniform float uNight;
      void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb * uNight * 1.3, 1.); }`,
  });
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geometry, material, lamps.length);
  const dummy = new THREE.Object3D();
  lamps.forEach((lamp, index) => {
    dummy.position.set(lamp.x, lamp.y + 0.05, lamp.z);
    dummy.scale.set(18, 1, 18);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  });
  mesh.frustumCulled = false;
  return mesh;
}

export function buildFences(lines: LineFeature[], heightAt: (x: number, z: number) => number, csm: CSM | null) {
  const solid = { pos: [] as number[], nor: [] as number[], col: [] as number[], uv: [] as number[], index: [] as number[] };
  const bars = { pos: [] as number[], nor: [] as number[], col: [] as number[], uv: [] as number[], index: [] as number[] };
  const segments: { ax: number; az: number; bx: number; bz: number; h: number; solid: boolean }[] = [];
  const palette = (tags: Record<string, string>) => {
    if (tags.barrier === "hedge") return { hex: 0x3e5a2e, h: 1.5, t: 0.5, solid: true, bars: false };
    if (tags.barrier === "wall" || tags.barrier === "city_wall" || tags.barrier === "retaining_wall") return { hex: tags.barrier === "city_wall" ? 0xa4876a : 0xa49c8a, h: tags.barrier === "city_wall" ? 7 : 1.7, t: tags.barrier === "city_wall" ? 1.2 : 0.3, solid: true, bars: false };
    if (tags.barrier === "fence" || tags.barrier === "guard_rail" || tags.barrier === "handrail" || tags.barrier === "gate") return { hex: 0x3b4042, h: 1.25, t: 0.03, solid: true, bars: true };
    return null;
  };
  let run = 0;
  const addQuad = (sink: typeof solid, a: number[], b: number[], c: number[], d: number[], n: number[], color: THREE.Color, u0 = 0, u1 = 0, h = 0) => {
    const base = sink.pos.length / 3;
    [a, b, c, d].forEach((p, i) => {
      sink.pos.push(p[0]!, p[1]!, p[2]!);
      sink.nor.push(n[0]!, n[1]!, n[2]!);
      sink.col.push(color.r, color.g, color.b);
      sink.uv.push(i === 0 || i === 3 ? u0 : u1, i < 2 ? -0.3 : h);
    });
    sink.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const line of lines) {
    const style = palette(line.tags);
    if (!style) continue;
    const tagged = Number.parseFloat(line.tags.height ?? "");
    const h = Number.isFinite(tagged) && tagged > 0.2 ? tagged : style.h;
    const color = new THREE.Color(style.hex);
    for (let i = 0; i + 3 < line.pts.length; i += 2) {
      const ax = line.pts[i]!;
      const az = line.pts[i + 1]!;
      const bx = line.pts[i + 2]!;
      const bz = line.pts[i + 3]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      const pieces = Math.max(1, Math.ceil(len / 6));
      for (let s = 0; s < pieces; s++) {
        const t0 = s / pieces;
        const t1 = (s + 1) / pieces;
        const x0 = ax + (bx - ax) * t0;
        const z0 = az + (bz - az) * t0;
        const x1 = ax + (bx - ax) * t1;
        const z1 = az + (bz - az) * t1;
        const y0 = heightAt(x0, z0);
        const y1 = heightAt(x1, z1);
        const nx = (bz - az) / len;
        const nz = -(bx - ax) / len;
        const ox = nx * style.t * 0.5;
        const oz = nz * style.t * 0.5;
        const piece = Math.hypot(x1 - x0, z1 - z0);
        if (style.bars) {
          addQuad(bars, [x0, y0 - 0.1, z0], [x1, y1 - 0.1, z1], [x1, y1 + h, z1], [x0, y0 + h, z0], [nx, 0, nz], color, run, run + piece, h);
        } else {
          addQuad(solid, [x0 + ox, y0 - 0.3, z0 + oz], [x1 + ox, y1 - 0.3, z1 + oz], [x1 + ox, y1 + h, z1 + oz], [x0 + ox, y0 + h, z0 + oz], [nx, 0, nz], color, run, run + piece, h);
          addQuad(solid, [x1 - ox, y1 - 0.3, z1 - oz], [x0 - ox, y0 - 0.3, z0 - oz], [x0 - ox, y0 + h, z0 - oz], [x1 - ox, y1 + h, z1 - oz], [-nx, 0, -nz], color, run, run + piece, h);
          addQuad(solid, [x0 + ox, y0 + h, z0 + oz], [x1 + ox, y1 + h, z1 + oz], [x1 - ox, y1 + h, z1 - oz], [x0 - ox, y0 + h, z0 - oz], [0, 1, 0], color, run, run + piece, h);
        }
        run += piece;
        segments.push({ ax: x0, az: z0, bx: x1, bz: z1, h, solid: style.solid });
      }
    }
  }
  const geometryOf = (sink: typeof solid) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(sink.pos, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(sink.nor, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(sink.col, 3));
    geometry.setAttribute("aM", new THREE.Float32BufferAttribute(sink.uv, 2));
    geometry.setIndex(sink.index);
    return geometry;
  };
  const vert = { vertexPars: "attribute vec2 aM; varying vec2 vM;", vertexBegin: "vM = aM;" };
  const wallMaterial = shade(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }),
    {
      key: "walls-low",
      ...vert,
      fragmentPars: "varying vec2 vM;",
      afterRoughness: /* glsl */ `
        {
          float rows = smoothstep(.0, .04, abs(fract(vM.y / .42) - .5)) * smoothstep(.0, .025, abs(fract(vM.x / .9 + floor(vM.y / .42) * .5) - .5));
          diffuseColor.rgb *= (.66 + .52 * texture2D(uNoise, vM * vec2(.21, .3)).g) * (.84 + .2 * rows) * mix(.62, 1., smoothstep(0., .9, vM.y));
        }`,
    },
    csm,
  );
  const barMaterial = shade(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide }),
    {
      key: "fence-bars",
      ...vert,
      fragmentPars: "varying vec2 vM;",
      map: /* glsl */ `
        {
          float upright = step(fract(vM.x / .14), .2);
          float rail = step(fract(vM.y / 1.05 + .05), .07);
          if (upright + rail < .5 || vM.y < 0.) discard;
        }`,
    },
    csm,
  );
  const mesh = new THREE.Group();
  const wallMesh = new THREE.Mesh(geometryOf(solid), wallMaterial);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  const barMesh = new THREE.Mesh(geometryOf(bars), barMaterial);
  barMesh.receiveShadow = true;
  mesh.add(wallMesh, barMesh);
  return { mesh, segments };
}

const WATER_MATERIAL = (csm: CSM | null) =>
  shade(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.07, metalness: 0, envMapIntensity: 1.1 }),
    {
      key: "water",
      noWeather: true,
      fragmentPars: PLATE_GLSL,
      // Water takes its colour from the photograph, so it never disagrees with the lagoon around it.
      map: /* glsl */ `
        vec4 clsW;
        diffuseColor.rgb = plateAlbedo(vW.xz, clsW) * .62;`,
      afterNormal: /* glsl */ `
        {
          float t = uTime * .35;
          vec2 p = vW.xz;
          vec2 a = vec2(texture2D(uNoise, p * .07 + vec2(t * .08, t * .05)).a, texture2D(uNoise, p * .07 + vec2(-t * .06, t * .09)).a) - .5;
          vec2 b = vec2(texture2D(uNoise, p * .31 + vec2(t * .2, -t * .1)).b, texture2D(uNoise, p * .31 - vec2(t * .15, t * .19)).b) - .5;
          vec2 w = a * .28 + b * .13;
          normal = normalize(normal + (viewMatrix * vec4(w.x, 0., w.y, 0.)).xyz);
        }`,
    },
    csm,
  );

export function buildWater(areas: AreaFeature[], lines: LineFeature[], heightAt: (x: number, z: number) => number, csm: CSM | null) {
  const positions: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  const levels: { ring: number[]; level: number }[] = [];
  for (const area of areas) {
    const ring = area.rings[0];
    if (!ring || ring.length < 6) continue;
    let level = Infinity;
    for (let i = 0; i < ring.length; i += 2) level = Math.min(level, heightAt(ring[i]!, ring[i + 1]!));
    level += area.tags.leisure === "swimming_pool" ? 0.15 : 0;
    const contour: THREE.Vector2[] = [];
    for (let i = 0; i < ring.length; i += 2) contour.push(new THREE.Vector2(ring[i], ring[i + 1]));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = positions.length / 3;
    for (const p of contour) {
      positions.push(p.x, level, p.y);
      normals.push(0, 1, 0);
    }
    for (const f of faces) index.push(base + f[0]!, base + f[2]!, base + f[1]!);
    levels.push({ ring, level });
  }
  for (const line of lines) {
    if (line.tags.tunnel === "yes" || line.tags.tunnel === "culvert") continue;
    const half = line.width / 2;
    for (let i = 0; i + 3 < line.pts.length; i += 2) {
      const ax = line.pts[i]!;
      const az = line.pts[i + 1]!;
      const bx = line.pts[i + 2]!;
      const bz = line.pts[i + 3]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      const nx = (-(bz - az) / len) * half;
      const nz = ((bx - ax) / len) * half;
      const ya = heightAt(ax, az) + 0.05;
      const yb = heightAt(bx, bz) + 0.05;
      const base = positions.length / 3;
      positions.push(ax + nx, ya, az + nz, ax - nx, ya, az - nz, bx - nx, yb, bz - nz, bx + nx, yb, bz + nz);
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      index.push(base, base + 3, base + 2, base, base + 2, base + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, WATER_MATERIAL(csm));
  mesh.material.side = THREE.DoubleSide;
  mesh.receiveShadow = true;
  return { mesh, levels };
}

/** Rails and bridge decks: ribbons laid on the ground or flown over it. */
export function buildRibbons(highways: LineFeature[], railways: LineFeature[], heightAt: (x: number, z: number) => number, csm: CSM | null) {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const index: number[] = [];
  const decks: { pts: number[]; width: number; y: number[] }[] = [];
  const rail = new THREE.Color(0x3a3c3c);
  const ribbon = (ax: number, az: number, bx: number, bz: number, half: number, ya: number, yb: number, color: THREE.Color, side: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.02) return;
    const nx = (-(bz - az) / len) * half;
    const nz = ((bx - ax) / len) * half;
    const offX = (-(bz - az) / len) * side;
    const offZ = ((bx - ax) / len) * side;
    const base = pos.length / 3;
    pos.push(ax + nx + offX, ya, az + nz + offZ, ax - nx + offX, ya, az - nz + offZ, bx - nx + offX, yb, bz - nz + offZ, bx + nx + offX, yb, bz + nz + offZ);
    nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    col.push(color.r, color.g, color.b, color.r, color.g, color.b, color.r, color.g, color.b, color.r, color.g, color.b);
    index.push(base, base + 3, base + 2, base, base + 2, base + 1);
  };
  for (const line of railways) {
    const kind = line.tags.railway;
    if (kind !== "rail" && kind !== "tram" && kind !== "light_rail" && kind !== "subway" && kind !== "narrow_gauge") continue;
    if (line.tags.tunnel === "yes" || kind === "subway") continue;
    for (let i = 0; i + 3 < line.pts.length; i += 2) {
      const ax = line.pts[i]!;
      const az = line.pts[i + 1]!;
      const bx = line.pts[i + 2]!;
      const bz = line.pts[i + 3]!;
      const ya = heightAt(ax, az) + 0.12;
      const yb = heightAt(bx, bz) + 0.12;
      ribbon(ax, az, bx, bz, 0.045, ya, yb, rail, 0.72);
      ribbon(ax, az, bx, bz, 0.045, ya, yb, rail, -0.72);
    }
  }
  const deck = new THREE.Color(0x6a6660);
  for (const line of highways) {
    if (line.tags.bridge !== "yes" && line.tags.bridge !== "viaduct") continue;
    const n = line.pts.length / 2;
    const ends = [heightAt(line.pts[0]!, line.pts[1]!), heightAt(line.pts[n * 2 - 2]!, line.pts[n * 2 - 1]!)];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      const ground = heightAt(line.pts[i * 2]!, line.pts[i * 2 + 1]!);
      ys.push(Math.max(ground + 0.6, ends[0]! + (ends[1]! - ends[0]!) * t + 0.4));
    }
    decks.push({ pts: line.pts, width: line.width, y: ys });
    for (let i = 0; i + 1 < n; i++) ribbon(line.pts[i * 2]!, line.pts[i * 2 + 1]!, line.pts[i * 2 + 2]!, line.pts[i * 2 + 3]!, line.width / 2, ys[i]!, ys[i + 1]!, deck, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, shade(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1, side: THREE.DoubleSide }), { key: "ribbons" }, csm));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, decks };
}

/** Rain streaks or snowflakes in a box that travels with the camera. */
export class Precipitation {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor(count = 9000) {
    const stretch = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 4 * 3);
    const seed = new Float32Array(count * 4 * 3);
    const corner = new Float32Array(count * 4 * 2);
    const index = new Uint32Array(count * 6);
    for (let i = 0; i < count; i++) {
      const sx = Math.random();
      const sy = Math.random();
      const sz = Math.random();
      for (let c = 0; c < 4; c++) {
        const k = i * 4 + c;
        seed.set([sx, sy, sz], k * 3);
        corner.set([c === 0 || c === 3 ? -1 : 1, c < 2 ? -1 : 1], k * 2);
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    stretch.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    stretch.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
    stretch.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
    stretch.setIndex(new THREE.BufferAttribute(index, 1));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: U.uTime,
        uCamPos: { value: new THREE.Vector3() },
        uWindXZ: { value: new THREE.Vector2() },
        uAmount: { value: 0 },
        uSnowMix: { value: 0 },
        uLight: { value: new THREE.Color(1, 1, 1) },
        uCount: { value: count },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        attribute vec2 aCorner;
        uniform float uTime, uAmount, uSnowMix;
        uniform vec3 uCamPos;
        uniform vec2 uWindXZ;
        varying vec2 vC;
        varying float vA;
        void main() {
          const float SIZE = 36.;
          float speed = mix(9.5, 1.15, uSnowMix);
          vec3 vel = vec3(uWindXZ.x * mix(.55, .85, uSnowMix), -speed, uWindXZ.y * mix(.55, .85, uSnowMix));
          vec3 p = aSeed * SIZE + vel * uTime * (.8 + aSeed.y * .4);
          if (uSnowMix > .5) p.xz += vec2(sin(uTime * .9 + aSeed.x * 30.), cos(uTime * .7 + aSeed.z * 30.)) * .5;
          p = mod(p - uCamPos, SIZE) - SIZE * .5;
          vec3 view = (viewMatrix * vec4(0., 0., 0., 1.)).xyz;
          vec3 vv = (viewMatrix * vec4(p + uCamPos, 1.)).xyz;
          vec3 dirV = normalize((viewMatrix * vec4(normalize(vel), 0.)).xyz);
          float visible = step(fract(aSeed.x * 91.7 + aSeed.z * 13.1), uAmount);
          vec3 side = normalize(cross(dirV, normalize(vv)));
          vec3 pos = vv;
          if (uSnowMix > .5) {
            pos.xy += aCorner * .032;
          } else {
            pos += side * aCorner.x * (.011 + length(vv) * .0016) + dirV * aCorner.y * .42;
          }
          vC = aCorner;
          vA = visible * smoothstep(.3, 1.5, length(vv)) * smoothstep(18., 10., length(p));
          gl_Position = projectionMatrix * vec4(pos * step(.5, visible) + view * 0., 1.);
          if (visible < .5) gl_Position = vec4(2., 2., 2., 1.);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vC;
        varying float vA;
        uniform float uSnowMix;
        uniform vec3 uLight;
        void main() {
          float a = uSnowMix > .5 ? smoothstep(1., .35, length(vC)) * .95 : (1. - abs(vC.x)) * (1. - vC.y * vC.y) * .55;
          gl_FragColor = vec4(uLight, a * vA);
        }`,
    });
    this.mesh = new THREE.Mesh(stretch, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  update(camera: THREE.Camera, rain: number, snow: number, windVec: THREE.Vector2, light: THREE.Color) {
    const amount = snow > rain * 0.4 ? Math.min(1, snow * 0.5) : Math.min(1, Math.pow(rain / 12, 0.55));
    this.mesh.visible = amount > 0.01;
    if (!this.mesh.visible) return;
    const u = this.material.uniforms;
    u.uCamPos!.value.copy(camera.position);
    u.uWindXZ!.value.copy(windVec);
    u.uAmount!.value = amount;
    u.uSnowMix!.value = snow > rain * 0.4 ? 1 : 0;
    u.uLight!.value.copy(light).multiplyScalar(snow > rain * 0.4 ? 1 : 2.1);
  }
}
