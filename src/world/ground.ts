import * as THREE from "three";
import { valueNoise } from "./shading.ts";

/**
 * What the ground is made of at arm's length, where a plate at 0.3 m per pixel has nothing to say. Each layer tiles and
 * holds a slope in RG, a brightness around one half in B and a roughness in A. This is invented texture laid under the
 * plate's own colour, never a reading: the class of the ground comes from the plate, its grain does not.
 */
export const GROUND_LAYERS = [
  { id: "asfalto", tile: 2.2, depth: 0.004 },
  { id: "lastre", tile: 3, depth: 0.009 },
  { id: "terra", tile: 3.2, depth: 0.03 },
  { id: "prato", tile: 2.4, depth: 0.035 },
] as const;

const hash = (a: number, b: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type Sample = { h: number; tone: number; rough: number };

function layerFunctions(): ((u: number, v: number) => Sample)[] {
  const n = (period: number, seed: number) => {
    const fn = valueNoise(period, seed);
    return (u: number, v: number) => fn(u * period, v * period);
  };
  const a4 = n(4, 3), a6 = n(6, 5), a16 = n(16, 7), a64 = n(64, 11), a128 = n(128, 13), a256 = n(256, 17);
  const asphalt = (u: number, v: number): Sample => {
    const stone = smooth(0.52, 0.8, a128(u, v));
    const speck = a256(u, v);
    // Cracks follow the level lines of a slow noise, and only where another one allows them.
    const crack = (1 - smooth(0, 0.007, Math.abs(a4(u, v) - 0.5))) * smooth(0.6, 0.74, a6(u, v));
    const patch = a16(u, v) - 0.5;
    return { h: 0.45 * a64(u, v) + 0.35 * stone + 0.2 * speck - crack * 0.9, tone: 0.5 + (stone - 0.35) * 0.22 + (speck - 0.5) * 0.16 + patch * 0.14 - crack * 0.16, rough: 0.88 - patch * 0.12 + crack * 0.08 };
  };
  const s32 = n(32, 23), s128 = n(128, 29), s256 = n(256, 31);
  const slabs = (u: number, v: number): Sample => {
    const row = Math.floor(v * 10);
    const across = u * 5 + (row % 2) * 0.5;
    const col = Math.floor(across) % 5;
    const fu = across - Math.floor(across);
    const fv = v * 10 - row;
    const edge = Math.min(Math.min(fu, 1 - fu) * 0.6, Math.min(fv, 1 - fv) * 0.3);
    const joint = 1 - smooth(0.003, 0.011, edge);
    const each = hash(col + 1, row + 1);
    const grain = s128(u, v) * 0.6 + s256(u, v) * 0.4;
    // Each slab sits a little off level, as laid ones do.
    const tilt = (hash(col + 7, row + 3) - 0.5) * (fu - 0.5) * 0.5 + (hash(col + 2, row + 9) - 0.5) * (fv - 0.5) * 0.5;
    return { h: (1 - joint) * (0.75 + tilt + (each - 0.5) * 0.2) + grain * 0.12, tone: 0.5 + (each - 0.5) * 0.16 + (grain - 0.5) * 0.14 + (s32(u, v) - 0.5) * 0.1 - joint * 0.28, rough: 0.8 + joint * 0.15 + (grain - 0.5) * 0.1 };
  };
  const e8 = n(8, 37), e32 = n(32, 41), e48 = n(48, 43), e128 = n(128, 47), e256 = n(256, 53);
  const soil = (u: number, v: number): Sample => {
    const body = e8(u, v) * 0.4 + e32(u, v) * 0.3 + e128(u, v) * 0.2 + e256(u, v) * 0.1;
    const pebble = smooth(0.7, 0.86, e48(u, v));
    return { h: body + pebble * 0.25, tone: 0.5 + (body - 0.5) * 0.55 + pebble * 0.14 + (e256(u, v) - 0.5) * 0.12, rough: 0.95 - pebble * 0.12 };
  };
  const g16 = n(16, 59), g64 = n(64, 61), g128 = n(128, 67), g256 = n(256, 71);
  const lawn = (u: number, v: number): Sample => {
    const clump = g16(u, v) * 0.45 + g64(u, v) * 0.55;
    const blade = g128(u, v) * 0.5 + g256(u, v) * 0.5;
    return { h: clump * 0.6 + blade * 0.4, tone: 0.5 + (clump - 0.5) * 0.4 + (blade - 0.5) * 0.36, rough: 0.96 };
  };
  return [asphalt, slabs, soil, lawn];
}

export function makeGroundMaterials(size = 512) {
  const layers = layerFunctions();
  const data = new Uint8Array(size * size * 4 * layers.length);
  const heights = new Float32Array(size * size);
  const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255)));
  layers.forEach((sample, layer) => {
    const base = layer * size * size * 4;
    let toneSum = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = sample(x / size, y / size);
        heights[y * size + x] = s.h;
        data[base + (y * size + x) * 4 + 2] = byte(s.tone);
        data[base + (y * size + x) * 4 + 3] = byte(s.rough);
        toneSum += s.tone;
      }
    }
    // The grain must not change the plate's own brightness: its mean is brought to one half.
    const shift = 0.5 - toneSum / (size * size);
    const spec = GROUND_LAYERS[layer]!;
    const texel = spec.tile / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = base + (y * size + x) * 4;
        const dx = ((heights[y * size + ((x + 1) % size)]! - heights[y * size + ((x + size - 1) % size)]!) * spec.depth) / (2 * texel);
        const dy = ((heights[((y + 1) % size) * size + x]! - heights[((y + size - 1) % size) * size + x]!) * spec.depth) / (2 * texel);
        data[k] = byte(0.5 - dx * 0.5);
        data[k + 1] = byte(0.5 - dy * 0.5);
        data[k + 2] = byte(data[k + 2]! / 255 + shift);
      }
    }
  });
  const texture = new THREE.DataArrayTexture(data, size, size, layers.length);
  texture.format = THREE.RGBAFormat;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
