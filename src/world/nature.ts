import * as THREE from "three";
import type { CSM } from "three/addons/csm/CSM.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { TreeInstance } from "../field/load.ts";
import { PLATE_GLSL, shade, U } from "./shading.ts";

function leafTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 256, 256);
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 620; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.pow(rand(), 0.6) * 118;
    const x = 128 + Math.cos(a) * r;
    const y = 128 + Math.sin(a) * r;
    const size = 2.6 + rand() * 4.4;
    const light = 0.45 + rand() * 0.55;
    ctx.fillStyle = `rgb(${255 * light} ${255 * light} ${255 * light})`;
    ctx.beginPath();
    ctx.ellipse(x, y, size, size * 0.52, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  return texture;
}

function noise3(x: number, y: number, z: number) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

/** Near crown: a cloud of cards with normals pointing away from the crown centre, so it shades as one soft volume. */
function cardCrown(cards: number, flatten: number, offsetY: number, seedBase = 1) {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const shadeC: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < cards; i++) {
    const u = noise3(i, 1, seedBase) * 2 - 1;
    const t = noise3(i, 2, seedBase) * Math.PI * 2;
    const r = Math.pow(noise3(i, 3, seedBase), 0.42);
    const s = Math.sqrt(1 - u * u);
    const cx = Math.cos(t) * s * r;
    const cy = u * r * flatten;
    const cz = Math.sin(t) * s * r;
    const size = 0.24 + noise3(i, 4, seedBase) * 0.16;
    const nx0 = cx;
    const ny0 = cy / Math.max(flatten, 0.1) + 0.4;
    const nz0 = cz;
    const len = Math.hypot(nx0, ny0, nz0) || 1;
    const nx = nx0 / len;
    const ny = ny0 / len;
    const nz = nz0 / len;
    // Random in-plane orientation in the tangent of the crown, tilted a bit so it never turns edge-on all at once.
    const ax = noise3(i, 5, seedBase) * 2 - 1;
    const ay = noise3(i, 6, seedBase) * 2 - 1;
    const az = noise3(i, 7, seedBase) * 2 - 1;
    const tx = ay * nz - az * ny;
    const ty = az * nx - ax * nz;
    const tz = ax * ny - ay * nx;
    const tLen = Math.hypot(tx, ty, tz) || 1;
    const ux = tx / tLen;
    const uy = ty / tLen;
    const uz = tz / tLen;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;
    const base = pos.length / 3;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      pos.push(cx + (ux * a + vx * b) * size, cy + offsetY + (uy * a + vy * b) * size, cz + (uz * a + vz * b) * size);
      nor.push(nx, ny, nz);
      uv.push((a + 1) / 2, (b + 1) / 2);
      // Deep inside the crown little light arrives: baked occlusion gives the cards their volume.
      const ao = (0.42 + 0.58 * r) * (0.72 + 0.28 * (cy / Math.max(flatten, 0.1) * 0.5 + 0.5));
      shadeC.push(ao, ao, ao);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(shadeC, 3));
  g.setIndex(index);
  return g;
}

function coneCards(cards: number) {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < cards; i++) {
    const t = Math.pow(noise3(i, 11, 3), 0.75);
    const spread = (1 - t) * Math.sqrt(noise3(i, 12, 3));
    const a = noise3(i, 13, 3) * Math.PI * 2;
    const cx = Math.cos(a) * spread;
    const cz = Math.sin(a) * spread;
    const cy = -0.5 + t * 1.75;
    const size = 0.1 + (1 - t) * 0.2;
    const len = Math.hypot(cx, 0.45, cz) || 1;
    const nx = cx / len;
    const ny = 0.45 / len;
    const nz = cz / len;
    const tilt = 0.5 + noise3(i, 14, 3) * 0.5;
    const ux = -nz;
    const uz = nx;
    const base = pos.length / 3;
    const shade = 0.5 + 0.5 * (spread / Math.max(1 - t, 0.05));
    for (const [p, q] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      pos.push(cx + ux * p * size + nx * q * size * 0.3, cy + q * size * 1.6 * tilt, cz + uz * p * size + nz * q * size * 0.3);
      nor.push(nx, ny, nz);
      uv.push((p + 1) / 2, (q + 1) / 2);
      col.push(shade, shade, shade);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(index);
  return g;
}

/** Far crown: a lumpy solid, no alpha, a few dozen triangles. */
function solidCrown(detail: number, flatten: number, offsetY: number, seedBase = 2) {
  const raw = new THREE.IcosahedronGeometry(1, detail);
  raw.deleteAttribute("uv");
  raw.deleteAttribute("normal");
  const g = mergeVertices(raw, 1e-3);
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const seen = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let scale = seen.get(key);
    if (scale == null) {
      scale = 0.78 + noise3(x * 3, y * 3 + seedBase, z * 3) * 0.42;
      seen.set(key, scale);
    }
    p.setXYZ(i, x * scale, y * scale * flatten + offsetY, z * scale);
  }
  g.computeVertexNormals();
  return g;
}

function coneCrown(radial: number, layers: number, offsetY: number) {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < layers; i++) {
    const t = i / layers;
    const cone = new THREE.ConeGeometry(1 - t * 0.72, (1.5 / layers) * 1.5, radial, 1, true);
    cone.translate(0, offsetY + t * 1.35 - 0.45, 0);
    parts.push(cone);
  }
  return mergeGeometries(parts)!;
}

const SWAY = /* glsl */ `
  {
    float phase = instanceMatrix[3][0] * .13 + instanceMatrix[3][2] * .17;
    float bend = max(position.y, 0.);
    float sway = sin(uTime * 1.1 + phase) * .6 + sin(uTime * 2.7 + phase * 1.7) * .25 + sin(uTime * 5.3 + phase * 3.) * .08;
    transformed.xz += uWindVec * bend * bend * sway * uWindAmp * .022;
  }
`;

type Kind = { near: THREE.InstancedMesh; far: THREE.InstancedMesh; capacity: number };

export class Forest {
  private provenance = false;
  readonly group = new THREE.Group();
  private kinds: Kind[] = [];
  private trunks: THREE.InstancedMesh;
  private trees: TreeInstance[] = [];
  private density = 1;
  private nearRadius = 70;
  private lastX = Infinity;
  private lastZ = Infinity;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private heightAt: (x: number, z: number) => number;

  constructor(trees: TreeInstance[], heightAt: (x: number, z: number) => number, csm: CSM | null) {
    this.heightAt = heightAt;
    const leaf = leafTexture();
    const nearMaterial = shade(
      new THREE.MeshStandardMaterial({ map: leaf, alphaTest: 0.36, side: THREE.DoubleSide, roughness: 0.78, metalness: 0, envMapIntensity: 0.6, vertexColors: true }),
      { key: "leaves", vertexBegin: SWAY },
      csm,
    );
    const farMaterial = shade(
      new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: 0.55, flatShading: false }),
      {
        key: "crowns",
        vertexBegin: SWAY,
        // Solid crowns get their leafiness from world-space noise, so they do not read as polygons.
        afterRoughness: /* glsl */ `
          {
            float leafy = texture2D(uNoise, vW.xz * .23 + vW.y * .19).b * .6 + texture2D(uNoise, vW.zx * .9 + vW.y * .7).a * .4;
            diffuseColor.rgb *= .46 + leafy * 1.1;
          }`,
      },
      csm,
    );
    const trunkMaterial = shade(
      new THREE.MeshStandardMaterial({ color: 0x4b3f33, roughness: 0.95, metalness: 0 }),
      { key: "trunks", afterRoughness: `diffuseColor.rgb *= .55 + texture2D(uNoise, vec2(atan(vW.x, vW.z) * 3., vW.y * .35)).b * .95;` },
      csm,
    );

    const capacity = Math.max(32, trees.length);
    const shapes = [
      { near: cardCrown(150, 0.86, 0), far: solidCrown(2, 0.86, 0) },
      { near: coneCards(210), far: coneCrown(6, 2, -0.1) },
      { near: cardCrown(70, 0.82, 0, 5), far: solidCrown(1, 0.82, 0, 5) },
    ];
    this.kinds = shapes.map((shape) => {
      const near = new THREE.InstancedMesh(shape.near, nearMaterial, capacity);
      const far = new THREE.InstancedMesh(shape.far, farMaterial, capacity);
      near.castShadow = far.castShadow = true;
      near.receiveShadow = far.receiveShadow = true;
      near.frustumCulled = far.frustumCulled = false;
      near.count = far.count = 0;
      this.group.add(near, far);
      return { near, far, capacity };
    });
    const trunkGeo = new THREE.CylinderGeometry(0.62, 1, 1, 7, 1, true);
    trunkGeo.translate(0, 0.5, 0);
    this.trunks = new THREE.InstancedMesh(trunkGeo, trunkMaterial, capacity);
    this.trunks.castShadow = true;
    this.trunks.frustumCulled = false;
    this.trunks.count = 0;
    this.group.add(this.trunks);
    this.setTrees(trees);
  }

  setTrees(trees: TreeInstance[]) {
    this.trees = trees;
    this.lastX = Infinity;
  }

  /** Mapped trees and crowns read from the plate, in the provenance colours. */
  setProvenance(on: boolean) {
    this.provenance = on;
    this.lastX = Infinity;
  }

  setDetail(density: number, nearRadius: number) {
    this.density = density;
    this.nearRadius = nearRadius;
    this.lastX = Infinity;
  }

  /** Reassigns instances between card and solid LOD when the observer has walked a few metres. */
  update(x: number, z: number) {
    // The rebuild touches every instance: at 5 m it showed as a hitch in dense parks, and at this distance nobody sees a crown change detail.
    if (Math.hypot(x - this.lastX, z - this.lastZ) < 12) return;
    this.lastX = x;
    this.lastZ = z;
    const near2 = this.nearRadius * this.nearRadius;
    const counts = this.kinds.map(() => ({ near: 0, far: 0 }));
    let trunks = 0;
    const dummy = this.dummy;
    const color = this.color;
    let index = 0;
    for (const tree of this.trees) {
      index++;
      // Thinning is stable: the same trees vanish first whichever way one walks.
      const keep = tree.source === "osm" || ((index * 2654435761) >>> 0) / 4294967295 < this.density;
      if (!keep) continue;
      const kind = this.kinds[tree.kind] ?? this.kinds[0]!;
      const slot = counts[tree.kind] ?? counts[0]!;
      const d2 = (tree.x - x) ** 2 + (tree.z - z) ** 2;
      const near = d2 < near2;
      const mesh = near ? kind.near : kind.far;
      const i = near ? slot.near++ : slot.far++;
      if (i >= kind.capacity) continue;
      const ground = this.heightAt(tree.x, tree.z);
      const r = tree.r;
      const crownH = tree.kind === 1 ? tree.h * 0.86 : Math.min(tree.h * 0.72, Math.max(r * 1.7, tree.h * 0.55));
      const crownCenter = ground + tree.h - crownH * 0.5;
      dummy.position.set(tree.x, tree.kind === 1 ? ground + tree.h * 0.14 + crownH * 0.34 : crownCenter, tree.z);
      dummy.rotation.set(0, (index * 2.399) % 6.283, 0);
      if (tree.kind === 1) dummy.scale.set(r, crownH * 0.68, r);
      else if (near) dummy.scale.set(r * 0.94, crownH * 0.5, r * 0.94);
      else dummy.scale.set(r * 1.02, crownH * 0.56, r * 1.02);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // Plate colours are shadowed reflectance seen through haze: lift them toward leaf albedo.
      const [cr, cg, cb] = tree.color;
      color.setRGB(Math.pow(cr, 2.2) * 1.55 + 0.016, Math.pow(cg, 2.2) * 1.75 + 0.03, Math.pow(cb, 2.2) * 1.15 + 0.008);
      if (near && tree.kind !== 1) color.multiplyScalar(1.5);
      else if (!near) color.multiplyScalar(0.66);
      if (this.provenance) {
        if (tree.source === "osm") color.setRGB(0.041, 0.242, 0.783);
        else color.setRGB(0.694, 0.1, 0.019);
      }
      mesh.setColorAt(i, color);
      if (d2 < near2 * 9 && trunks < this.trunks.instanceMatrix.count) {
        const trunkR = Math.max(0.07, r * 0.035 + tree.h * 0.008);
        dummy.position.set(tree.x, ground - 0.2, tree.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(trunkR, tree.kind === 1 ? tree.h * 0.8 : Math.max(tree.h - crownH * 0.65, tree.h * 0.5), trunkR);
        dummy.updateMatrix();
        this.trunks.setMatrixAt(trunks++, dummy.matrix);
      }
    }
    this.kinds.forEach((kind, k) => {
      const slot = counts[k]!;
      kind.near.count = Math.min(slot.near, kind.capacity);
      kind.far.count = Math.min(slot.far, kind.capacity);
      kind.near.instanceMatrix.needsUpdate = true;
      kind.far.instanceMatrix.needsUpdate = true;
      if (kind.near.instanceColor) kind.near.instanceColor.needsUpdate = true;
      if (kind.far.instanceColor) kind.far.instanceColor.needsUpdate = true;
    });
    this.trunks.count = trunks;
    this.trunks.instanceMatrix.needsUpdate = true;
  }
}

/** Grass tufts live in a window around the observer, and only where the plate says there is a lawn. */
export class Meadow {
  readonly mesh: THREE.InstancedMesh;
  private lastX = Infinity;
  private lastZ = Infinity;
  private dummy = new THREE.Object3D();
  private classData: Uint8Array;
  private cw: number;
  private ch: number;
  private halfX: number;
  private halfZ: number;
  density = 0.5;

  constructor(classMap: Uint8Array, cw: number, ch: number, halfX: number, halfZ: number, private heightAt: (x: number, z: number) => number, csm: CSM | null) {
    this.classData = classMap;
    this.cw = cw;
    this.ch = ch;
    this.halfX = halfX;
    this.halfZ = halfZ;
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.PlaneGeometry(0.9, 0.5, 1, 2);
      const p = blade.getAttribute("position") as THREE.BufferAttribute;
      for (let k = 0; k < p.count; k++) {
        const up = (p.getY(k) + 0.25) / 0.5;
        p.setY(k, up * 0.5);
        p.setZ(k, up * up * 0.14);
      }
      blade.rotateY((i * Math.PI) / 3);
      parts.push(blade);
    }
    const geometry = mergeGeometries(parts)!;
    geometry.computeVertexNormals();
    const n = geometry.getAttribute("normal") as THREE.BufferAttribute;
    for (let k = 0; k < n.count; k++) n.setXYZ(k, 0, 1, 0);
    const material = shade(
      new THREE.MeshStandardMaterial({ map: grassTexture(), alphaTest: 0.38, side: THREE.DoubleSide, roughness: 0.95, metalness: 0, envMapIntensity: 0.5 }),
      {
        key: "grass",
        vertexPars: PLATE_GRASS_VERT,
        vertexBegin: /* glsl */ `
          {
            float phase = instanceMatrix[3][0] * .4 + instanceMatrix[3][2] * .5;
            float bend = position.y * position.y;
            transformed.xz += uWindVec * bend * (sin(uTime * 2.3 + phase) + .6 * sin(uTime * 4.1 + phase * 1.3)) * uWindAmp * .22;
            vec2 wxz = (modelMatrix * instanceMatrix * vec4(0., 0., 0., 1.)).xz;
            vTuftUv = vec2(wxz.x, -wxz.y) / uHalf * .5 + .5;
            vTuftH = position.y;
          }`,
        fragmentPars: /* glsl */ `
          uniform sampler2D uPlate, uGain;
          uniform float uDeshadow;
          varying vec2 vTuftUv;
          varying float vTuftH;`,
        map: /* glsl */ `
          vec4 tex = texture2D(map, vMapUv);
          vec3 ground = texture2D(uPlate, vTuftUv).rgb;
          if (uDeshadow > .5) { vec4 fillG = texture2D(uGain, vTuftUv); ground = mix(ground, pow(fillG.rgb, vec3(2.2)), fillG.a); }
          float g = dot(ground, vec3(.3, .6, .1));
          diffuseColor.a *= tex.a;
          diffuseColor.rgb = mix(ground, vec3(g * .8, g * 1.25, g * .42), .4) * mix(.75, 1.5, vTuftH * 2.) * tex.rgb;
        `,
      },
      csm,
    );
    this.mesh = new THREE.InstancedMesh(geometry, material, 26000);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
  }

  setClass(classMap: Uint8Array) {
    this.classData = classMap;
    this.lastX = Infinity;
  }

  update(x: number, z: number) {
    if (Math.hypot(x - this.lastX, z - this.lastZ) < 6) return;
    this.lastX = x;
    this.lastZ = z;
    this.mesh.count = 0;
    if (this.density <= 0.01) return;
    const radius = 22 + this.density * 30;
    const step = 0.9 / Math.sqrt(this.density);
    const dummy = this.dummy;
    const { classData, cw, ch, halfX, halfZ } = this;
    let count = 0;
    const gx0 = Math.floor((x - radius) / step);
    const gz0 = Math.floor((z - radius) / step);
    const cells = Math.ceil((radius * 2) / step);
    for (let j = 0; j < cells && count < this.mesh.instanceMatrix.count; j++) {
      for (let i = 0; i < cells && count < this.mesh.instanceMatrix.count; i++) {
        const cx = (gx0 + i) * step;
        const cz = (gz0 + j) * step;
        const hash = noise3(gx0 + i, gz0 + j, 3);
        const px = cx + (hash - 0.5) * step;
        const pz = cz + (noise3(gx0 + i, gz0 + j, 9) - 0.5) * step;
        const d2 = (px - x) ** 2 + (pz - z) ** 2;
        if (d2 > radius * radius) continue;
        const u = (px + halfX) / (2 * halfX);
        const v = (pz + halfZ) / (2 * halfZ);
        if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
        const k = (Math.floor(v * ch) * cw + Math.floor(u * cw)) * 4;
        if (classData[k + 1]! < 128) continue;
        const scale = 0.7 + hash * 0.85;
        dummy.position.set(px, this.heightAt(px, pz) - 0.02, pz);
        dummy.rotation.set(0, hash * 6.28, 0);
        dummy.scale.set(scale, scale * (0.8 + hash * 0.5), scale);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(count++, dummy.matrix);
      }
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const PLATE_GRASS_VERT = /* glsl */ `
  uniform vec2 uHalf;
  varying vec2 vTuftUv;
  varying float vTuftH;
`;

function grassTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  let seed = 19;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 46; i++) {
    const x = rand() * 128;
    const h = 42 + rand() * 82;
    const lean = (rand() - 0.5) * 20;
    const shade = 0.72 + rand() * 0.5;
    ctx.fillStyle = `rgb(${200 * shade} ${235 * shade} ${150 * shade})`;
    ctx.beginPath();
    ctx.moveTo(x - 2.2, 128);
    ctx.quadraticCurveTo(x + lean * 0.2, 128 - h * 0.6, x + lean, 128 - h);
    ctx.quadraticCurveTo(x + lean * 0.3, 128 - h * 0.5, x + 2.2, 128);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

void U;
