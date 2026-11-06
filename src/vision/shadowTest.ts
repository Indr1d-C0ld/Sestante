import { fillRing } from "./analyze.ts";

/**
 * The shadow bench: given a volume and a dated shot, where must its shadow fall, and is it there?
 * Works on analysis pixels, +x east, +y south. A hypothesis that casts no observed shadow in several shots is in trouble.
 */
export type ShadowPlate = { date: string; width: number; height: number; mpp: number; sunAzimuth: number; altitude: number; confidence: number; alpha: Uint8Array };

export type ShadowScore = { date: string; expected: number; covered: number; background: number; lift: number; lengthM: number };

export function predictShadow(rings: number[][], heightM: number, plate: Pick<ShadowPlate, "width" | "height" | "mpp" | "sunAzimuth" | "altitude">) {
  const { width: w, height: h, mpp, sunAzimuth, altitude } = plate;
  const grid = { w, h };
  const solid = new Uint8Array(w * h);
  fillRing(solid, grid, rings);
  const mask = new Uint8Array(w * h);
  const lengthPx = heightM / Math.max(0.05, Math.tan(altitude)) / mpp;
  const az = sunAzimuth + Math.PI;
  const dx = Math.sin(az);
  const dy = -Math.cos(az);
  const steps = Math.ceil(lengthPx);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid[y * w + x]) continue;
      // Sweeps only from pixels on the downsun edge: the interior would just retrace the same rays.
      const nx = Math.round(x + dx * 1.5);
      const ny = Math.round(y + dy * 1.5);
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && solid[ny * w + nx]) continue;
      for (let s = 1; s <= steps; s++) {
        const px = Math.round(x + dx * s);
        const py = Math.round(y + dy * s);
        if (px < 0 || py < 0 || px >= w || py >= h) break;
        const k = py * w + px;
        if (!solid[k]) mask[k] = 1;
      }
    }
  }
  return { mask, solid, lengthM: lengthPx * mpp };
}

/** Covered is the share of predicted shadow that is dark in the shot; background is the same share in the ground around it. */
export function scoreShadow(rings: number[][], heightM: number, plate: ShadowPlate): ShadowScore {
  const { mask, solid, lengthM } = predictShadow(rings, heightM, plate);
  const { width: w, height: h, mpp, alpha } = plate;
  let expected = 0;
  let hits = 0;
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!mask[k]) continue;
      expected++;
      if (alpha[k]! > 110) hits++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const pad = Math.round(Math.max(8 / mpp, (maxX - minX + maxY - minY) * 0.35));
  let around = 0;
  let aroundDark = 0;
  for (let y = Math.max(0, minY - pad); y <= Math.min(h - 1, maxY + pad); y++) {
    for (let x = Math.max(0, minX - pad); x <= Math.min(w - 1, maxX + pad); x++) {
      const k = y * w + x;
      if (mask[k] || solid[k]) continue;
      around++;
      if (alpha[k]! > 110) aroundDark++;
    }
  }
  const covered = expected ? hits / expected : 0;
  const background = around ? aroundDark / around : 0;
  return { date: plate.date, expected: expected * mpp * mpp, covered, background, lift: covered - background, lengthM };
}

/** The height whose predicted shadow best matches what is dark, by balancing what it explains against what it overshoots. */
export function bestHeight(rings: number[][], plate: ShadowPlate, maxM = 80) {
  let best = { h: 0, f1: 0 };
  const widest = predictShadow(rings, maxM, plate);
  const { alpha, width: w, height: h } = plate;
  let observed = 0;
  for (let k = 0; k < w * h; k++) if (widest.mask[k] && alpha[k]! > 110) observed++;
  if (!observed) return best;
  for (let height = 1; height <= maxM; height += height < 20 ? 0.5 : 1) {
    const { mask } = predictShadow(rings, height, plate);
    let predicted = 0;
    let hits = 0;
    for (let k = 0; k < w * h; k++) {
      if (!mask[k]) continue;
      predicted++;
      if (alpha[k]! > 110) hits++;
    }
    if (!predicted) continue;
    const precision = hits / predicted;
    const recall = hits / observed;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    if (f1 > best.f1) best = { h: height, f1 };
  }
  return best;
}

/** How to read a score, in words a field notebook can keep. */
export function verdict(scores: ShadowScore[]) {
  const usable = scores.filter((row) => row.expected > 0);
  if (!usable.length) return { label: "non verificabile", meanLift: 0 };
  const meanLift = usable.reduce((sum, row) => sum + row.lift, 0) / usable.length;
  const label = meanLift > 0.45 ? "compatibile: l'ombra prevista c'è" : meanLift > 0.2 ? "parzialmente compatibile" : meanLift > 0.05 ? "debole: poco sopra il fondo" : "non compatibile con le ombre osservate";
  return { label, meanLift };
}
