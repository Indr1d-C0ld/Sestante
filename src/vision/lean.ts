/**
 * The lean of a satellite plate: a satellite rarely looks straight down, so whatever stands at height z appears shifted
 * by z times a fixed vector, away from the satellite. Aerial orthophotos are corrected and show almost none; WorldView
 * mosaics showed 10 degrees (Paris) and 16 degrees (London). Pure code.
 *
 * Estimated from an airborne survey: every step in the surveyed surface, projected with a candidate lean, should land on
 * an edge of the plate. Without a survey the roofs' own edges were tried and were not reliable (a lean and a map shift
 * look alike when buildings are of similar height), so elsewhere the lean is set by hand.
 */

export type Lean = {
  /** Plate shift per metre of height, east and south (the world's x and z). */
  x: number;
  z: number;
  /** Shift of the ground itself between map and plate, in metres. */
  shiftX: number;
  shiftZ: number;
  /** How much better the edges line up than with no lean at all: 1 is no better. */
  gain: number;
  /** Survey edges the estimate rests on. */
  edges: number;
};

export type LeanSurface = { heights: ArrayLike<number>; cols: number; rows: number; cell: number };

/** Edge strength of a luminance raster, capped so that a few hard edges cannot outvote the rest. */
export function edgeMap(lum: ArrayLike<number>, cols: number, rows: number) {
  const out = new Float32Array(cols * rows);
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const k = j * cols + i;
      out[k] = Math.min(0.4, Math.hypot(lum[k + 1]! - lum[k - 1]!, lum[k + cols]! - lum[k - cols]!));
    }
  }
  return out;
}

/**
 * Lean from a survey. `lum` is the plate's luminance resampled on the survey's grid; `heights` the surface above the
 * ground. Coarse search of the lean with the ground fixed, then a joint refinement of lean and ground shift.
 */
export function leanFromSurface(lum: ArrayLike<number>, surface: LeanSurface, maxLean = 0.6): Lean | null {
  const { heights, cols, rows, cell } = surface;
  const plate = edgeMap(lum, cols, rows);
  // Steps of more than two metres on something taller than three: building and tree outlines, at the height of the top.
  const all: number[] = [];
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const k = j * cols + i;
      const z = heights[k]!;
      if (!(z > 3)) continue;
      const step = Math.max(Math.abs(heights[k + 1]! - heights[k - 1]!), Math.abs(heights[k + cols]! - heights[k - cols]!));
      if (step > 2) all.push(i, j, z / cell);
    }
  }
  const count = all.length / 3;
  if (count < 500) return null;
  const every = Math.max(1, Math.floor(count / 25000));
  const pts: number[] = [];
  for (let n = 0; n < count; n += every) pts.push(all[n * 3]!, all[n * 3 + 1]!, all[n * 3 + 2]!);
  const used = pts.length / 3;
  const score = (sx: number, sy: number, lx: number, ly: number) => {
    let s = 0;
    for (let n = 0; n < pts.length; n += 3) {
      const x = Math.round(pts[n]! + sx + lx * pts[n + 2]!);
      const y = Math.round(pts[n + 1]! + sy + ly * pts[n + 2]!);
      if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1) s += plate[y * cols + x]!;
    }
    return s / used;
  };
  let best = { v: -1, sx: 0, sy: 0, lx: 0, ly: 0 };
  for (let lx = -maxLean; lx <= maxLean + 1e-9; lx += 0.04) {
    for (let ly = -maxLean; ly <= maxLean + 1e-9; ly += 0.04) {
      const v = score(0, 0, lx, ly);
      if (v > best.v) best = { v, sx: 0, sy: 0, lx, ly };
    }
  }
  const reach = Math.max(1, Math.round(3 / cell));
  for (let round = 0; round < 3; round++) {
    const b = { ...best };
    for (let lx = b.lx - 0.04; lx <= b.lx + 0.04 + 1e-9; lx += 0.01) {
      for (let ly = b.ly - 0.04; ly <= b.ly + 0.04 + 1e-9; ly += 0.01) {
        for (let sy = b.sy - reach; sy <= b.sy + reach; sy++) {
          for (let sx = b.sx - reach; sx <= b.sx + reach; sx++) {
            const v = score(sx, sy, lx, ly);
            if (v > best.v) best = { v, sx, sy, lx, ly };
          }
        }
      }
    }
  }
  const none = score(0, 0, 0, 0);
  return { x: best.lx, z: best.ly, shiftX: best.sx * cell, shiftZ: best.sy * cell, gain: none > 0 ? best.v / none : 1, edges: used };
}

/** Lean as a photographer would say it: tilt from the vertical and the direction the tops fall towards, in degrees. */
export function describeLean(lean: { x: number; z: number }) {
  const tilt = (Math.atan(Math.hypot(lean.x, lean.z)) * 180) / Math.PI;
  const toward = ((Math.atan2(lean.x, -lean.z) * 180) / Math.PI + 360) % 360;
  return { tilt, toward };
}

/** Inverse of describeLean. */
export function leanFrom(tiltDeg: number, towardDeg: number) {
  const t = Math.tan((tiltDeg * Math.PI) / 180);
  const a = (towardDeg * Math.PI) / 180;
  return { x: t * Math.sin(a), z: -t * Math.cos(a) };
}
