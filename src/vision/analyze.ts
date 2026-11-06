import { solveShotInstant, sunPosition } from "../core/solar.ts";

/**
 * Reads the plate as a photo-interpreter would: shadows → sun → heights.
 * Everything works in analysis pixels; +x east, +y south, like the raster. Pure code, usable in a worker and in tests.
 */
export type Footprint = { id: string; rings: number[][]; tagHeight?: number };

export type AnalysisInput = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  mpp: number;
  lat: number;
  lon: number;
  captureDate: string | null;
  manualSun?: { azimuth: number; altitude: number } | null;
  footprints: Footprint[];
  roads: { pts: number[]; halfWidth: number }[];
  water: number[][];
  osmTrees: { x: number; y: number; tags: Record<string, string> }[];
  register?: boolean;
  /** Elevation resampled on the same grid, downscaled by `elevationStep`: water is flat, and the DEM knows it. */
  elevation?: Float32Array;
  elevationStep?: number;
};

export type SunReading = {
  sunAzimuth: number;
  altitude: number;
  confidence: number;
  method: "ombre+data" | "ombre" | "metadati" | "manuale" | "stima";
  instant: string | null;
  crossCheckAltitude: number | null;
  crossCheckSamples: number;
};

export type HeightReading = { h: number | null; confidence: number; rays: number };

export type TreeHeightOrigin = "mappa" | "ombra" | "chioma" | "griglia";

export type TreeReading = { x: number; y: number; r: number; h: number; origin: TreeHeightOrigin; color: [number, number, number]; kind: number; source: "ripresa" | "osm"; species?: string };

export type FootprintEvidence = { edge: number; veg: number };

export type MassReading = { ring: number[]; h: number; confidence: number; color: [number, number, number] };

export type AnalysisResult = {
  width: number;
  height: number;
  mpp: number;
  sun: SunReading;
  registration: { dx: number; dy: number; score: number; applied: boolean };
  heights: Record<string, HeightReading>;
  roofTones: Record<string, [number, number, number]>;
  trees: TreeReading[];
  masses: MassReading[];
  /** Whether each mapped footprint is visibly there: contrast across its outline and greenery just inside it. */
  evidence: Record<string, FootprintEvidence>;
  /** R canopy, G lawn, B water, A paved. */
  classMap: Uint8Array;
  /** RGB holds what the ground would look like without baked shadows, A how much of it to use. */
  gainMap: Uint8Array;
  stats: { canopy: number; lawn: number; shadow: number; water: number; paved: number; shadowRatioR: number; shadowRatioG: number; shadowRatioB: number };
};

type Grid = { w: number; h: number };

function integral(src: Float32Array, { w, h }: Grid) {
  const out = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x]!;
      out[(y + 1) * (w + 1) + x + 1] = out[y * (w + 1) + x + 1]! + row;
    }
  }
  return out;
}

function boxMean(table: Float64Array, { w, h }: Grid, x: number, y: number, r: number) {
  const x0 = Math.max(0, x - r);
  const y0 = Math.max(0, y - r);
  const x1 = Math.min(w, x + r + 1);
  const y1 = Math.min(h, y + r + 1);
  const W = w + 1;
  const sum = table[y1 * W + x1]! - table[y0 * W + x1]! - table[y1 * W + x0]! + table[y0 * W + x0]!;
  return sum / ((x1 - x0) * (y1 - y0));
}

export function fillRing(mask: Uint8Array, { w, h }: Grid, rings: number[][], value = 1) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) for (let i = 1; i < ring.length; i += 2) {
    minY = Math.min(minY, ring[i]!);
    maxY = Math.max(maxY, ring[i]!);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    xs.length = 0;
    const sy = y + 0.5;
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[i * 2 + 1]!;
        const yj = ring[j * 2 + 1]!;
        if (yi > sy !== yj > sy) xs.push(ring[i * 2]! + ((sy - yi) / (yj - yi)) * (ring[j * 2]! - ring[i * 2]!));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = a; x <= b; x++) mask[y * w + x] = value;
    }
  }
}

function stampRoad(mask: Uint8Array, { w, h }: Grid, pts: number[], halfWidth: number) {
  const r = Math.max(1, halfWidth);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i]!;
    const ay = pts[i + 1]!;
    const bx = pts[i + 2]!;
    const by = pts[i + 3]!;
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / Math.max(1, r * 0.8)));
    for (let s = 0; s <= steps; s++) {
      const cx = ax + ((bx - ax) * s) / steps;
      const cy = ay + ((by - ay) * s) / steps;
      const x0 = Math.max(0, Math.floor(cx - r));
      const x1 = Math.min(w - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r));
      const y1 = Math.min(h - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * w + x] = 1;
    }
  }
}

/** Boundary samples of a footprint with outward normals. */
export function boundarySamples(fp: Footprint, step: number) {
  const out: { x: number; y: number; nx: number; ny: number }[] = [];
  for (const ring of fp.rings) {
    const n = ring.length / 2;
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!;
    // In a y-down raster, positive shoelace means clockwise on screen: the outward normal is (dy, -dx).
    const sign = area >= 0 ? 1 : -1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[j * 2]!;
      const ay = ring[j * 2 + 1]!;
      const bx = ring[i * 2]!;
      const by = ring[i * 2 + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.5) continue;
      const nx = (sign * (by - ay)) / len;
      const ny = (sign * -(bx - ax)) / len;
      const count = Math.max(1, Math.floor(len / step));
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count;
        out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, nx, ny });
      }
    }
  }
  return out;
}

function shiftFootprint(fp: Footprint, dx: number, dy: number): Footprint {
  return { ...fp, rings: fp.rings.map((ring) => ring.map((v, i) => (i % 2 ? v + dy : v + dx))) };
}

/** Finds the translation that best lands footprint edges on image edges: OSM and imagery rarely agree to the metre. */
function coRegister(lum: Float32Array, grid: Grid, footprints: Footprint[], mpp: number) {
  const { w, h } = grid;
  const grad = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      const gx = lum[k + 1]! - lum[k - 1]!;
      const gy = lum[k + w]! - lum[k - w]!;
      grad[k] = Math.min(0.4, Math.hypot(gx, gy));
    }
  }
  const big = [...footprints].sort((a, b) => b.rings[0]!.length - a.rings[0]!.length).slice(0, 320);
  const pts = big.flatMap((fp) => boundarySamples(fp, 3));
  if (pts.length < 60) return { dx: 0, dy: 0, score: 0, applied: false };
  const span = Math.min(40, Math.round(14 / mpp));
  const stride = Math.max(1, Math.round(1 / mpp));
  const score = (dx: number, dy: number) => {
    let sum = 0;
    let count = 0;
    for (const p of pts) {
      const x = Math.round(p.x + dx);
      const y = Math.round(p.y + dy);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      sum += grad[y * w + x]!;
      count++;
    }
    return count > pts.length * 0.3 ? sum / count : 0;
  };
  let best = { dx: 0, dy: 0, value: score(0, 0) };
  const samples: number[] = [];
  for (let dy = -span; dy <= span; dy += stride) {
    for (let dx = -span; dx <= span; dx += stride) {
      const value = score(dx, dy);
      samples.push(value);
      if (value > best.value) best = { dx, dy, value };
    }
  }
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >> 1] ?? 0;
  const contrast = median > 0 ? best.value / median : 1;
  const applied = contrast > 1.12;
  return { dx: applied ? best.dx : 0, dy: applied ? best.dy : 0, score: contrast, applied };
}

/** Which way do shadows fall? For each direction, compares darkness on the side of objects facing away from it. */
function shadowDirection(shadow: Uint8Array, object: Uint8Array, grid: Grid, pts: { x: number; y: number; nx: number; ny: number }[], mpp: number) {
  const { w, h } = grid;
  const steps = [3, 6, 10, 16].map((m) => m / mpp);
  const count = 36;
  const profile = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const az = ((i * 360) / count) * (Math.PI / 180);
    const dx = Math.sin(az);
    const dy = -Math.cos(az);
    let fall = 0;
    let fallN = 0;
    let lit = 0;
    let litN = 0;
    for (const p of pts) {
      const dot = p.nx * dx + p.ny * dy;
      if (Math.abs(dot) < 0.6) continue;
      const sign = Math.sign(dot);
      for (const s of steps) {
        const x = Math.round(p.x + dx * sign * s);
        const y = Math.round(p.y + dy * sign * s);
        if (x < 0 || y < 0 || x >= w || y >= h || object[y * w + x]) continue;
        if (dot > 0) {
          fall += shadow[y * w + x]!;
          fallN++;
        } else {
          lit += shadow[y * w + x]!;
          litN++;
        }
      }
    }
    profile[i] = fallN > 20 && litN > 20 ? fall / fallN - lit / litN : 0;
  }
  // The profile is antisymmetric, so its first harmonic is the shadow direction. Street grids add higher harmonics, which this ignores.
  let re = 0;
  let im = 0;
  for (let i = 0; i < count; i++) {
    const az = ((i * 360) / count) * (Math.PI / 180);
    re += profile[i]! * Math.cos(az);
    im += profile[i]! * Math.sin(az);
  }
  re *= 2 / count;
  im *= 2 / count;
  const amplitude = Math.hypot(re, im);
  const azimuth = (Math.atan2(im, re) + 2 * Math.PI) % (2 * Math.PI);
  let residual = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const az = ((i * 360) / count) * (Math.PI / 180);
    const model = amplitude * Math.cos(az - azimuth);
    residual += (profile[i]! - model) ** 2;
    total += profile[i]! ** 2;
  }
  return { azimuth, strength: amplitude, fit: total > 0 ? 1 - residual / total : 0 };
}

function percentile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

function shadowHeights(shadow: Uint8Array, built: Uint8Array, grid: Grid, footprints: Footprint[], azimuth: number, mpp: number) {
  const { w, h } = grid;
  const dx = Math.sin(azimuth);
  const dy = -Math.cos(azimuth);
  const out: Record<string, { length: number; rays: number; spread: number }> = {};
  const limit = 140 / mpp;
  for (const fp of footprints) {
    const lengths: number[] = [];
    const mask = 2;
    for (const p of boundarySamples(fp, Math.max(1, 1.5 / mpp))) {
      if (p.nx * dx + p.ny * dy < 0.4) continue;
      let gap = 0;
      let last = 0;
      let blocked = false;
      for (let s = 1; s < limit; s += 1) {
        const x = Math.round(p.x + dx * s);
        const y = Math.round(p.y + dy * s);
        if (x < 0 || y < 0 || x >= w || y >= h) {
          blocked = true;
          break;
        }
        const k = y * w + x;
        if (built[k] && s > 2 / mpp) {
          blocked = gap < 3;
          break;
        }
        if (shadow[k]) {
          last = s;
          gap = 0;
        } else if (++gap > Math.max(2, 1 / mpp)) break;
      }
      if (!blocked && last * mpp >= 1.5) lengths.push(last * mpp);
    }
    void mask;
    if (lengths.length < 4) continue;
    const q50 = percentile(lengths, 0.5);
    out[fp.id] = {
      length: percentile(lengths, 0.72),
      rays: lengths.length,
      spread: q50 > 0 ? (percentile(lengths, 0.85) - percentile(lengths, 0.25)) / q50 : 1,
    };
  }
  return out;
}

function distanceTransform(mask: Uint8Array, { w, h }: Grid) {
  const inf = 1e6;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? inf : 0;
  const diag = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!d[k]) continue;
      let v = d[k]!;
      if (x > 0) v = Math.min(v, d[k - 1]! + 1);
      else v = Math.min(v, 1);
      if (y > 0) {
        v = Math.min(v, d[k - w]! + 1);
        if (x > 0) v = Math.min(v, d[k - w - 1]! + diag);
        if (x < w - 1) v = Math.min(v, d[k - w + 1]! + diag);
      } else v = Math.min(v, 1);
      d[k] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const k = y * w + x;
      if (!d[k]) continue;
      let v = d[k]!;
      if (x < w - 1) v = Math.min(v, d[k + 1]! + 1);
      else v = Math.min(v, 1);
      if (y < h - 1) {
        v = Math.min(v, d[k + w]! + 1);
        if (x > 0) v = Math.min(v, d[k + w - 1]! + diag);
        if (x < w - 1) v = Math.min(v, d[k + w + 1]! + diag);
      } else v = Math.min(v, 1);
      d[k] = v;
    }
  }
  return d;
}

function hash2(a: number, b: number) {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

export function classifyPixels(rgba: Uint8ClampedArray, grid: Grid, mpp: number) {
  const { w, h } = grid;
  const n = w * h;
  const lum = new Float32Array(n);
  const exg = new Float32Array(n);
  const lum2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]! / 255;
    const g = rgba[i * 4 + 1]! / 255;
    const b = rgba[i * 4 + 2]! / 255;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    lum[i] = l;
    lum2[i] = l * l;
    exg[i] = (2 * g - r - b) / (r + g + b + 0.04);
  }
  const lumT = integral(lum, grid);
  const lum2T = integral(lum2, grid);
  const rLocal = Math.max(8, Math.round(28 / mpp));
  const rTex = Math.max(2, Math.round(2.5 / mpp));

  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.floor(lum[i]! * 255))]!++;
  // Otsu on luminance: on urban and rural scenes alike its lower class holds the cast shadows.
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let otsu = 60;
  let otsuEnd = 60;
  let bestVar = -1;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]!;
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > bestVar * 1.0005) {
      bestVar = between;
      otsu = i;
      otsuEnd = i;
    } else if (between >= bestVar * 0.9995) otsuEnd = i;
  }
  // A scene with an empty gap in its histogram gives a plateau of equal splits: take its middle.
  const firstSplit = (otsu + otsuEnd) / 2;
  let absolute = Math.min(0.32, (firstSplit / 255) * 0.82);
  // Dark foliage and dark roofs share the lower class with real shadows: split it once more, if it really is two populations.
  {
    const top = Math.floor(firstSplit);
    let count = 0;
    let total = 0;
    for (let i = 0; i <= top; i++) {
      count += hist[i]!;
      total += i * hist[i]!;
    }
    let w0 = 0;
    let s0 = 0;
    let best = -1;
    let split = -1;
    let gap = 0;
    for (let i = 0; i <= top; i++) {
      w0 += hist[i]!;
      if (!w0) continue;
      const w1 = count - w0;
      if (!w1) break;
      s0 += i * hist[i]!;
      const m0 = s0 / w0;
      const m1 = (total - s0) / w1;
      const between = w0 * w1 * (m0 - m1) ** 2;
      if (between > best) {
        best = between;
        split = i;
        gap = m1 - m0;
      }
    }
    if (split > 0 && gap > 28 && hist.slice(0, split + 1).reduce((a, b) => a + b, 0) > n * 0.02) absolute = Math.min(absolute, (split + 6) / 255);
  }

  const shadowRaw = new Uint8Array(n);
  const veg = new Uint8Array(n);
  const texture = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const l = lum[k]!;
      const mean = boxMean(lumT, grid, x, y, rLocal);
      const greenLit = exg[k]! > 0.09 && l > 0.1;
      if (l < absolute && l < mean * 0.72 && !greenLit) shadowRaw[k] = 1;
      const m = boxMean(lumT, grid, x, y, rTex);
      const m2 = boxMean(lum2T, grid, x, y, rTex);
      texture[k] = Math.sqrt(Math.max(0, m2 - m * m));
      const r = rgba[k * 4]!;
      const g = rgba[k * 4 + 1]!;
      const b = rgba[k * 4 + 2]!;
      if (exg[k]! > 0.045 && g >= r * 0.98 && g > b * 1.02 && g > 22) veg[k] = 1;
    }
  }
  // Morphological opening keeps cast shadows and drops isolated dark speckles such as cars and dark roofs' texture.
  const shadow = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (shadowRaw[k] && shadowRaw[k - 1]! + shadowRaw[k + 1]! + shadowRaw[k - w]! + shadowRaw[k + w]! >= 2) shadow[k] = 1;
    }
  }
  return { lum, exg, shadow, veg, texture, lumT };
}

export function analyzePlate(input: AnalysisInput): AnalysisResult {
  const { rgba, width: w, height: h, mpp, lat, lon } = input;
  const grid: Grid = { w, h };
  const n = w * h;
  const { lum, exg, shadow, veg, texture } = classifyPixels(rgba, grid, mpp);

  const registration = input.register === false ? { dx: 0, dy: 0, score: 0, applied: false } : coRegister(lum, grid, input.footprints, mpp);
  const footprints = registration.applied ? input.footprints.map((fp) => shiftFootprint(fp, registration.dx, registration.dy)) : input.footprints;

  const built = new Uint8Array(n);
  for (const fp of footprints) fillRing(built, grid, fp.rings);
  const road = new Uint8Array(n);
  for (const item of input.roads) stampRoad(road, grid, item.pts, item.halfWidth);
  const water = new Uint8Array(n);
  for (const ring of input.water) fillRing(water, grid, [ring]);

  markOpenWater(input, water, built, road, texture, lum);

  // Objects cast shadows: footprints when mapped, otherwise tree blobs act as gnomons.
  let casterPts = footprints.flatMap((fp) => boundarySamples(fp, 2 / mpp));
  const casterMask = new Uint8Array(built);
  if (casterPts.length < 150) {
    const canopy = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (veg[i] && texture[i]! > 0.03) canopy[i] = 1;
    casterMask.set(canopy);
    const step = Math.max(2, Math.round(2 / mpp));
    casterPts = casterPts.slice();
    for (let y = step; y < h - step; y += step) {
      for (let x = step; x < w - step; x += step) {
        const k = y * w + x;
        if (!canopy[k]) continue;
        const nx = canopy[k + step]! - canopy[k - step]!;
        const ny = canopy[k + step * w]! - canopy[k - step * w]!;
        if (nx || ny) {
          const len = Math.hypot(nx, ny);
          casterPts.push({ x, y, nx: -nx / len, ny: -ny / len });
        }
      }
    }
  }
  const direction = shadowDirection(shadow, casterMask, grid, casterPts, mpp);
  const sunAzimuthRead = (direction.azimuth + Math.PI) % (2 * Math.PI);
  const shadowConfidence = Math.max(0, Math.min(1, direction.fit * 1.1)) * Math.min(1, direction.strength / 0.05) * Math.min(1, casterPts.length / 300);

  let sun: SunReading;
  if (input.manualSun) {
    sun = { sunAzimuth: input.manualSun.azimuth, altitude: input.manualSun.altitude, confidence: 1, method: "manuale", instant: null, crossCheckAltitude: null, crossCheckSamples: 0 };
  } else if (input.captureDate && shadowConfidence > 0.15) {
    const shot = solveShotInstant(input.captureDate, lat, lon, sunAzimuthRead);
    const plausible = shot && shot.error < (25 * Math.PI) / 180;
    sun = plausible
      ? { sunAzimuth: sunAzimuthRead, altitude: shot.altitude, confidence: shadowConfidence * (1 - shot.error / 0.5), method: "ombre+data", instant: shot.date.toISOString(), crossCheckAltitude: null, crossCheckSamples: 0 }
      : metadataSun(input.captureDate, lat, lon, shadowConfidence * 0.3);
  } else if (input.captureDate) {
    sun = metadataSun(input.captureDate, lat, lon, 0.25);
  } else {
    sun = { sunAzimuth: sunAzimuthRead, altitude: Math.max(0.35, 1.05 - Math.abs(lat) * 0.012), confidence: shadowConfidence * 0.4, method: shadowConfidence > 0.15 ? "ombre" : "stima", instant: null, crossCheckAltitude: null, crossCheckSamples: 0 };
  }

  const shadowAz = (sun.sunAzimuth + Math.PI) % (2 * Math.PI);
  const rawHeights = shadowHeights(shadow, built, grid, footprints, shadowAz, mpp);

  // Buildings with a mapped height are ground truth: they check the solar geometry and rescue undated plates.
  const tanSamples: number[] = [];
  for (const fp of footprints) {
    const raw = rawHeights[fp.id];
    if (fp.tagHeight && raw && raw.rays >= 8 && raw.spread < 0.6) tanSamples.push(fp.tagHeight / raw.length);
  }
  if (tanSamples.length >= 3) {
    const tan = percentile(tanSamples, 0.5);
    sun.crossCheckAltitude = Math.atan(tan);
    sun.crossCheckSamples = tanSamples.length;
    if (!input.captureDate && !input.manualSun) sun.altitude = sun.crossCheckAltitude;
  }

  // With enough ground truth, its median ratio replaces pure geometry: it also absorbs satellite lean and mask bias.
  let tan = Math.tan(Math.max(0.09, sun.altitude));
  if (tanSamples.length >= 5) tan = percentile(tanSamples, 0.5);
  const heights: Record<string, HeightReading> = {};
  const roofTones: Record<string, [number, number, number]> = {};
  const evidence: Record<string, FootprintEvidence> = {};
  const offset = Math.max(1, 1.8 / mpp);
  for (const fp of footprints) {
    let contrast = 0;
    let green = 0;
    let samples = 0;
    for (const p of boundarySamples(fp, Math.max(1, 2 / mpp))) {
      const ix = Math.round(p.x - p.nx * offset);
      const iy = Math.round(p.y - p.ny * offset);
      const ox = Math.round(p.x + p.nx * offset);
      const oy = Math.round(p.y + p.ny * offset);
      if (ix < 0 || iy < 0 || ox < 0 || oy < 0 || ix >= w || iy >= h || ox >= w || oy >= h) continue;
      contrast += Math.abs(lum[iy * w + ix]! - lum[oy * w + ox]!);
      green += veg[iy * w + ix]!;
      samples++;
    }
    if (samples >= 6) evidence[fp.id] = { edge: contrast / samples, veg: green / samples };
  }
  for (const fp of footprints) {
    const raw = rawHeights[fp.id];
    heights[fp.id] = raw
      ? {
          h: Math.max(2.4, Math.min(320, raw.length * tan)),
          confidence: Math.max(0.05, Math.min(1, raw.rays / 24) * Math.max(0.1, 1 - raw.spread) * Math.max(0.25, sun.confidence)),
          rays: raw.rays,
        }
      : { h: null, confidence: 0, rays: 0 };
    const ring = fp.rings[0]!;
    let cx = 0;
    let cy = 0;
    const count = ring.length / 2;
    for (let i = 0; i < ring.length; i += 2) {
      cx += ring[i]!;
      cy += ring[i + 1]!;
    }
    const toneAt = (x: number, y: number) => {
      const k = Math.max(0, Math.min(h - 1, Math.round(y))) * w + Math.max(0, Math.min(w - 1, Math.round(x)));
      return [rgba[k * 4]! / 255, rgba[k * 4 + 1]! / 255, rgba[k * 4 + 2]! / 255] as [number, number, number];
    };
    roofTones[fp.id] = toneAt(cx / count, cy / count);
  }

  // Lawn or canopy: canopy is rough, dark or next to its own shadow.
  const canopyMask = new Uint8Array(n);
  const lawnMask = new Uint8Array(n);
  let canopyCount = 0;
  let lawnCount = 0;
  const sdx = Math.sin(shadowAz);
  const sdy = -Math.cos(shadowAz);
  const reach = Math.max(2, Math.round(3 / mpp));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!veg[k] || built[k] || water[k]) continue;
      const nx = Math.round(x + sdx * reach);
      const ny = Math.round(y + sdy * reach);
      const nearShadow = nx >= 0 && ny >= 0 && nx < w && ny < h && shadow[ny * w + nx]!;
      if (texture[k]! > 0.032 || lum[k]! < 0.17 || (nearShadow && texture[k]! > 0.02)) {
        canopyMask[k] = 1;
        canopyCount++;
      } else {
        lawnMask[k] = 1;
        lawnCount++;
      }
    }
  }

  const trees = detectTrees(rgba, grid, mpp, canopyMask, shadow, built, shadowAz, tan, input.osmTrees);
  const masses = input.footprints.length < 8000 ? detectMasses(rgba, grid, mpp, shadow, built, veg, road, water, lum, shadowAz, tan) : [];

  // Per-channel ratio between sunlit and shadowed ground: it undoes both the darkening and the blue cast.
  let lit = [0, 0, 0];
  let shade = [0, 0, 0];
  let litN = 0;
  let shadeN = 0;
  for (let i = 0; i < n; i += 3) {
    if (built[i] || veg[i] || water[i]) continue;
    if (shadow[i]) {
      for (let c = 0; c < 3; c++) shade[c]! += rgba[i * 4 + c]!;
      shadeN++;
    } else if (lum[i]! < 0.7) {
      for (let c = 0; c < 3; c++) lit[c]! += rgba[i * 4 + c]!;
      litN++;
    }
  }
  const ratio = [1, 1, 1].map((_, c) => (shadeN > 50 && litN > 50 ? Math.max(1, Math.min(7.5, lit[c]! / litN / Math.max(4, shade[c]! / shadeN))) : 1)) as [number, number, number];
  lit = [];
  shade = [];

  // Shadows are filled from their sunlit surroundings: below the noise floor a dark pixel holds no colour worth amplifying.
  const soft = new Float32Array(n);
  for (let i = 0; i < n; i++) soft[i] = shadow[i]! && !water[i] ? 1 : 0;
  const softT = integral(soft, grid);
  const fill = pushPull(rgba, shadow, grid);
  const classMap = new Uint8Array(n * 4);
  const gainMap = new Uint8Array(n * 4);
  let shadowCount = 0;
  let waterCount = 0;
  let pavedCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const i = k * 4;
      const s = boxMean(softT, grid, x, y, 1);
      classMap[i] = canopyMask[k]! * 255;
      classMap[i + 1] = lawnMask[k]! * 255;
      classMap[i + 2] = water[k]! * 255;
      const paved = road[k] || (!veg[k] && !water[k] && exg[k]! < 0.02 && !built[k]) ? 1 : 0;
      classMap[i + 3] = (road[k] ? 255 : paved ? 110 : 0) as number;
      if (road[k]) pavedCount++;
      if (shadow[k]) shadowCount++;
      if (water[k]) waterCount++;
      gainMap[i] = fill[i]!;
      gainMap[i + 1] = fill[i + 1]!;
      gainMap[i + 2] = fill[i + 2]!;
      gainMap[i + 3] = Math.round(s * 255);
    }
  }

  return {
    width: w,
    height: h,
    mpp,
    sun,
    registration: { ...registration, dx: registration.dx * mpp, dy: registration.dy * mpp },
    heights,
    roofTones,
    trees,
    masses,
    evidence,
    classMap,
    gainMap,
    stats: {
      canopy: (canopyCount * mpp * mpp) | 0,
      lawn: (lawnCount * mpp * mpp) | 0,
      shadow: (shadowCount * mpp * mpp) | 0,
      water: (waterCount * mpp * mpp) | 0,
      paved: (pavedCount * mpp * mpp) | 0,
      shadowRatioR: ratio[0],
      shadowRatioG: ratio[1],
      shadowRatioB: ratio[2],
    },
  };
}

/** Sea and lakes are often not polygons on the map (OSM coastlines are lines): they read as large, smooth, flat, bluish regions. */
function markOpenWater(input: AnalysisInput, water: Uint8Array, built: Uint8Array, road: Uint8Array, texture: Float32Array, lum: Float32Array) {
  const { width: w, height: h, rgba, mpp, elevation, elevationStep } = input;
  if (!elevation || !elevationStep) return;
  const ew = Math.ceil(w / elevationStep);
  const eh = Math.ceil(h / elevationStep);
  const flat = new Uint8Array(ew * eh);
  for (let y = 0; y < eh; y++) {
    for (let x = 0; x < ew; x++) {
      const k = y * ew + x;
      const v = elevation[k]!;
      let range = 0;
      for (const q of [k - 1, k + 1, k - ew, k + ew]) {
        const o = elevation[q];
        if (o != null) range = Math.max(range, Math.abs(o - v));
      }
      flat[k] = range < 0.5 * Math.max(1, (elevationStep * mpp) / 12) ? 1 : 0;
    }
  }
  const candidate = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (built[k] || road[k]) continue;
      const g = rgba[k * 4 + 1]!;
      const b = rgba[k * 4 + 2]!;
      const r = rgba[k * 4]!;
      if (texture[k]! < 0.024 && lum[k]! < 0.55 && b > g * 0.76 && b > r * 0.92 && flat[Math.floor(y / elevationStep) * ew + Math.floor(x / elevationStep)]) candidate[k] = 1;
    }
  }
  const seen = new Uint8Array(w * h);
  const minPixels = 1500 / (mpp * mpp);
  const stack: number[] = [];
  const region: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!candidate[start] || seen[start]) continue;
    stack.length = 0;
    region.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      region.push(k);
      for (const q of [k - 1, k + 1, k - w, k + w]) {
        if (q >= 0 && q < w * h && candidate[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (region.length >= minPixels) for (const k of region) water[k] = 1;
  }
}

/** Push-pull inpainting: averages lit pixels down a pyramid, then pulls them back into the holes. */
function pushPull(rgba: Uint8ClampedArray, hole: Uint8Array, { w, h }: Grid) {
  type Level = { w: number; h: number; c: Float32Array; a: Float32Array };
  const base: Level = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
  for (let k = 0; k < w * h; k++) {
    // One pixel of margin: the penumbra is neither lit nor shaded.
    const near = hole[k] || hole[k - 1] || hole[k + 1] || hole[k - w] || hole[k + w];
    if (near) continue;
    base.a[k] = 1;
    base.c[k * 3] = rgba[k * 4]!;
    base.c[k * 3 + 1] = rgba[k * 4 + 1]!;
    base.c[k * 3 + 2] = rgba[k * 4 + 2]!;
  }
  const levels = [base];
  while (levels[levels.length - 1]!.w > 1 || levels[levels.length - 1]!.h > 1) {
    const fine = levels[levels.length - 1]!;
    const cw = Math.max(1, fine.w >> 1);
    const ch = Math.max(1, fine.h >> 1);
    const next: Level = { w: cw, h: ch, c: new Float32Array(cw * ch * 3), a: new Float32Array(cw * ch) };
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        const q = Math.min(ch - 1, y >> 1) * cw + Math.min(cw - 1, x >> 1);
        const k = y * fine.w + x;
        const alpha = fine.a[k]!;
        next.a[q]! += alpha;
        for (let c = 0; c < 3; c++) next.c[q * 3 + c]! += fine.c[k * 3 + c]! * alpha;
      }
    }
    for (let q = 0; q < cw * ch; q++) {
      const alpha = next.a[q]!;
      if (alpha > 0) for (let c = 0; c < 3; c++) next.c[q * 3 + c]! /= alpha;
      next.a[q] = Math.min(1, alpha);
    }
    levels.push(next);
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l]!;
    const coarse = levels[l + 1]!;
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        const k = y * fine.w + x;
        const alpha = fine.a[k]!;
        if (alpha >= 1) continue;
        // Bilinear pull keeps the blocks of the coarse level from showing.
        const fx = Math.min(coarse.w - 1.001, Math.max(0, (x + 0.5) / 2 - 0.5));
        const fy = Math.min(coarse.h - 1.001, Math.max(0, (y + 0.5) / 2 - 0.5));
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const ix1 = Math.min(coarse.w - 1, ix + 1);
        const iy1 = Math.min(coarse.h - 1, iy + 1);
        for (let c = 0; c < 3; c++) {
          const v =
            coarse.c[(iy * coarse.w + ix) * 3 + c]! * (1 - tx) * (1 - ty) +
            coarse.c[(iy * coarse.w + ix1) * 3 + c]! * tx * (1 - ty) +
            coarse.c[(iy1 * coarse.w + ix) * 3 + c]! * (1 - tx) * ty +
            coarse.c[(iy1 * coarse.w + ix1) * 3 + c]! * tx * ty;
          fine.c[k * 3 + c] = fine.c[k * 3 + c]! * alpha + v * (1 - alpha);
        }
        fine.a[k] = 1;
      }
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    out[k * 4] = base.c[k * 3]!;
    out[k * 4 + 1] = base.c[k * 3 + 1]!;
    out[k * 4 + 2] = base.c[k * 3 + 2]!;
    out[k * 4 + 3] = 255;
  }
  return out;
}

/** Commercial satellites pass near 10:30 local solar time: without readable shadows, that is the best guess. */
function metadataSun(date: string, lat: number, lon: number, confidence: number): SunReading {
  const when = new Date(Date.parse(`${date}T10:30:00Z`) - (lon / 15) * 3_600_000);
  const pos = sunPosition(when, lat, lon);
  return { sunAzimuth: pos.azimuth, altitude: Math.max(0.1, pos.altitude), confidence, method: "metadati", instant: when.toISOString(), crossCheckAltitude: null, crossCheckSamples: 0 };
}

function detectTrees(
  rgba: Uint8ClampedArray,
  grid: Grid,
  mpp: number,
  canopy: Uint8Array,
  shadow: Uint8Array,
  built: Uint8Array,
  shadowAz: number,
  tan: number,
  osmTrees: AnalysisInput["osmTrees"],
) {
  const { w, h } = grid;
  const dt = distanceTransform(canopy, grid);
  const candidates: { k: number; d: number }[] = [];
  const minR = 1.1 / mpp;
  const win = Math.max(1, Math.round(1.2 / mpp));
  for (let y = win; y < h - win; y += 1) {
    for (let x = win; x < w - win; x += 1) {
      const k = y * w + x;
      const d = dt[k]!;
      if (d < minR) continue;
      let top = true;
      for (let j = -win; j <= win && top; j++) for (let i = -win; i <= win; i++) if (dt[k + j * w + i]! > d) { top = false; break; }
      if (top) candidates.push({ k, d });
    }
  }
  candidates.sort((a, b) => b.d - a.d);
  const taken = new Uint8Array(w * h);
  const trees: TreeReading[] = [];
  const sdx = Math.sin(shadowAz);
  const sdy = -Math.cos(shadowAz);
  const maxR = 8.5 / mpp;

  const addAt = (x: number, y: number, rPx: number, source: "ripresa" | "osm", tags?: Record<string, string>, filler = false) => {
    let cr = 0;
    let cg = 0;
    let cb = 0;
    let count = 0;
    const span = Math.ceil(rPx);
    for (let j = -span; j <= span; j += Math.max(1, span >> 2)) {
      for (let i = -span; i <= span; i += Math.max(1, span >> 2)) {
        const px = x + i;
        const py = y + j;
        if (px < 0 || py < 0 || px >= w || py >= h || i * i + j * j > span * span) continue;
        const q = py * w + px;
        cr += rgba[q * 4]!;
        cg += rgba[q * 4 + 1]!;
        cb += rgba[q * 4 + 2]!;
        count++;
      }
    }
    // Shadow tip distance from the trunk gives height; allometry bounds it when the shadow falls on something else.
    let tip = 0;
    let gap = 0;
    for (let s = rPx; s < 70 / mpp; s += 1) {
      const px = Math.round(x + sdx * s);
      const py = Math.round(y + sdy * s);
      if (px < 0 || py < 0 || px >= w || py >= h || built[py * w + px]) break;
      if (shadow[py * w + px]) {
        tip = s;
        gap = 0;
      } else if (++gap > 2) break;
    }
    const rM = rPx * mpp;
    const measured = tip * mpp * tan;
    const tagged = Number.parseFloat(tags?.height ?? "");
    const treeH = Number.isFinite(tagged) && tagged > 0 ? tagged : tip > rPx ? Math.max(rM * 2.1, Math.min(rM * 5, measured)) : rM * 2.9;
    const leaf = tags?.leaf_type;
    const dark = count ? (cr + cg + cb) / (3 * count) < 62 : false;
    const kind = rM < 1.7 && treeH < 4 ? 2 : leaf === "needleleaved" || (!leaf && dark && treeH / rM > 3.4) ? 1 : 0;
    trees.push({
      x: x * mpp,
      y: y * mpp,
      r: rM,
      h: treeH,
      origin: Number.isFinite(tagged) && tagged > 0 ? "mappa" : filler ? "griglia" : tip > rPx ? "ombra" : "chioma",
      color: count ? [cr / count / 255, cg / count / 255, cb / count / 255] : [0.2, 0.3, 0.14],
      kind,
      source,
      species: tags?.species ?? tags?.genus ?? tags?.["species:it"],
    });
    const m = Math.ceil(rPx * 0.9);
    for (let j = -m; j <= m; j++) {
      for (let i = -m; i <= m; i++) {
        const px = x + i;
        const py = y + j;
        if (px >= 0 && py >= 0 && px < w && py < h && i * i + j * j <= m * m) taken[py * w + px] = 1;
      }
    }
  };

  for (const tree of osmTrees) {
    const x = Math.round(tree.x);
    const y = Math.round(tree.y);
    if (x < 0 || y < 0 || x >= w || y >= h || built[y * w + x]) continue;
    // A mapped tree often sits inside a crown the plate shows: borrow its radius.
    let best = 0;
    const span = Math.round(3 / mpp);
    for (let j = -span; j <= span; j += 1) {
      for (let i = -span; i <= span; i += 1) {
        const px = x + i;
        const py = y + j;
        if (px >= 0 && py >= 0 && px < w && py < h) best = Math.max(best, dt[py * w + px]!);
      }
    }
    const taggedCrown = Number.parseFloat(tree.tags.diameter_crown ?? "");
    const r = Number.isFinite(taggedCrown) && taggedCrown > 0 ? taggedCrown / 2 / mpp : Math.min(maxR, Math.max(2.4 / mpp, best));
    addAt(x, y, r, "osm", tree.tags);
  }
  for (const { k, d } of candidates) {
    if (taken[k] || trees.length > 9000) continue;
    addAt(k % w, Math.floor(k / w), Math.min(maxR, d * 1.05), "ripresa");
  }
  // Wide canopies merge into one blob: fill what is left with a jittered grid, as a forest of crowns.
  const pitch = Math.max(3, Math.round(6 / mpp));
  for (let y = pitch; y < h - pitch; y += pitch) {
    for (let x = pitch; x < w - pitch; x += pitch) {
      const px = Math.min(w - 1, x + Math.round((hash2(x, y) - 0.5) * pitch * 0.8));
      const py = Math.min(h - 1, y + Math.round((hash2(y, x) - 0.5) * pitch * 0.8));
      const k = py * w + px;
      if (canopy[k] && !taken[k] && dt[k]! > 0.7 / mpp && trees.length < 9000) addAt(px, py, (2.4 + hash2(px, py) * 1.8) / mpp, "ripresa", undefined, true);
    }
  }
  return trees;
}

/** Unmapped buildings: a compact, non-vegetated region with a fresh cast shadow on the side facing away from the sun. */
function detectMasses(
  rgba: Uint8ClampedArray,
  grid: Grid,
  mpp: number,
  shadow: Uint8Array,
  built: Uint8Array,
  veg: Uint8Array,
  road: Uint8Array,
  water: Uint8Array,
  lum: Float32Array,
  shadowAz: number,
  tan: number,
) {
  const { w, h } = grid;
  const seen = new Uint8Array(w * h);
  const sdx = Math.sin(shadowAz);
  const sdy = -Math.cos(shadowAz);
  const masses: MassReading[] = [];
  const stack: number[] = [];
  const back = Math.round(2.5 / mpp);
  const stride = Math.max(1, Math.round(1.5 / mpp));
  const claimed = new Uint8Array(w * h);
  for (let y = 2; y < h - 2 && masses.length < 400; y += stride) {
    for (let x = 2; x < w - 2 && masses.length < 400; x += stride) {
      const k = y * w + x;
      if (!shadow[k] || seen[k]) continue;
      // Shadow blob: measure it along the shadow direction.
      stack.length = 0;
      stack.push(k);
      seen[k] = 1;
      const blob: number[] = [];
      while (stack.length && blob.length < 60_000) {
        const q = stack.pop()!;
        blob.push(q);
        for (const nb of [q - 1, q + 1, q - w, q + w]) {
          if (nb >= 0 && nb < w * h && shadow[nb] && !seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        }
      }
      const area = blob.length * mpp * mpp;
      if (area < 6 || area > 2500) continue;
      // Sun-side edge of the blob: where the caster stands.
      let minAlong = Infinity;
      let maxAlong = -Infinity;
      let sx = 0;
      let sy = 0;
      for (const q of blob) {
        const qx = q % w;
        const qy = Math.floor(q / w);
        const along = qx * sdx + qy * sdy;
        minAlong = Math.min(minAlong, along);
        maxAlong = Math.max(maxAlong, along);
        sx += qx;
        sy += qy;
      }
      sx /= blob.length;
      sy /= blob.length;
      const seedAlong = minAlong - back;
      const centreAlong = sx * sdx + sy * sdy;
      const seedX = Math.round(sx + sdx * (seedAlong - centreAlong));
      const seedY = Math.round(sy + sdy * (seedAlong - centreAlong));
      if (seedX < 2 || seedY < 2 || seedX >= w - 2 || seedY >= h - 2) continue;
      const seed = seedY * w + seedX;
      if (built[seed] || veg[seed] || road[seed] || water[seed] || claimed[seed] || shadow[seed]) continue;
      let owned = false;
      for (let s = 0; s < 60 / mpp && !owned; s += 2) {
        const px = Math.round(seedX - sdx * s);
        const py = Math.round(seedY - sdy * s);
        if (px < 0 || py < 0 || px >= w || py >= h) break;
        if (built[py * w + px]) owned = true;
      }
      if (owned) continue;
      const r0 = rgba[seed * 4]!;
      const g0 = rgba[seed * 4 + 1]!;
      const b0 = rgba[seed * 4 + 2]!;
      const region: number[] = [];
      const queue = [seed];
      const local = new Set<number>([seed]);
      const limit = 1800 / (mpp * mpp);
      let refused = false;
      while (queue.length) {
        const q = queue.pop()!;
        region.push(q);
        if (region.length > limit) {
          refused = true;
          break;
        }
        for (const nb of [q - 1, q + 1, q - w, q + w]) {
          if (nb < 0 || nb >= w * h || local.has(nb)) continue;
          if (built[nb] || shadow[nb] || veg[nb] || water[nb]) continue;
          const d = Math.abs(rgba[nb * 4]! - r0) + Math.abs(rgba[nb * 4 + 1]! - g0) + Math.abs(rgba[nb * 4 + 2]! - b0);
          if (d > 46) continue;
          local.add(nb);
          queue.push(nb);
        }
      }
      if (refused) continue;
      const roofArea = region.length * mpp * mpp;
      if (roofArea < 18) continue;
      let onRoad = 0;
      let mx = 0;
      let my = 0;
      for (const q of region) {
        if (road[q]) onRoad++;
        mx += q % w;
        my += Math.floor(q / w);
      }
      if (onRoad / region.length > 0.15) continue;
      mx /= region.length;
      my /= region.length;
      // PCA gives the oriented rectangle; low fill means an irregular patch of ground, not a roof.
      let cxx = 0;
      let cyy = 0;
      let cxy = 0;
      for (const q of region) {
        const dx = (q % w) - mx;
        const dy = Math.floor(q / w) - my;
        cxx += dx * dx;
        cyy += dy * dy;
        cxy += dx * dy;
      }
      const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const q of region) {
        const dx = (q % w) - mx;
        const dy = Math.floor(q / w) - my;
        const a = dx * ux + dy * uy;
        const b = -dx * uy + dy * ux;
        aMin = Math.min(aMin, a);
        aMax = Math.max(aMax, a);
        bMin = Math.min(bMin, b);
        bMax = Math.max(bMax, b);
      }
      const rectArea = (aMax - aMin + 1) * (bMax - bMin + 1) * mpp * mpp;
      const fill = roofArea / rectArea;
      if (fill < 0.62 || (aMax - aMin) * mpp > 90 || (bMax - bMin) * mpp < 3) continue;
      for (const q of region) claimed[q] = 1;
      const length = (maxAlong - minAlong) * mpp;
      // Footprint and shadow must be about as wide as each other, seen across the shadow direction.
      let across0 = Infinity;
      let across1 = -Infinity;
      for (const q of blob) {
        const v = -(q % w) * sdy + Math.floor(q / w) * sdx;
        across0 = Math.min(across0, v);
        across1 = Math.max(across1, v);
      }
      let roof0 = Infinity;
      let roof1 = -Infinity;
      for (const q of region) {
        const v = -(q % w) * sdy + Math.floor(q / w) * sdx;
        roof0 = Math.min(roof0, v);
        roof1 = Math.max(roof1, v);
      }
      const widthRatio = (across1 - across0 + 1) / (roof1 - roof0 + 1);
      if (widthRatio < 0.45 || widthRatio > 1.9) continue;
      const massH = Math.max(2.6, Math.min(32, length * tan));
      if (length * tan > 40) continue;
      void lum;
      const ring = [
        [aMin, bMin],
        [aMax, bMin],
        [aMax, bMax],
        [aMin, bMax],
      ].flatMap(([a, b]) => [mx + a! * ux - b! * uy, my + a! * uy + b! * ux]);
      masses.push({ ring, h: massH, confidence: Math.min(1, (fill - 0.5) * 2) * 0.7, color: [r0 / 255, g0 / 255, b0 / 255] });
    }
  }
  return masses;
}
