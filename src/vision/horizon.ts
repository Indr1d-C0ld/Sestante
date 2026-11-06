/**
 * "Where was this photo taken?": the line of the land against the sky is a fingerprint, comparable with the profile any
 * spot would see on an elevation model. Works where the horizon has shape, and says so where it does not. Pure code.
 */
import { sunPosition } from "../core/solar.ts";

const RAD = Math.PI / 180;
export const PROFILE_RAYS = 720;

export type HeightField = {
  heights: ArrayLike<number>;
  size: number;
  spacing: number;
  originX: number;
  originZ: number;
  /** A finer model of the surroundings: the ridge in front of the camera is what most of the line is made of. */
  near?: { heights: ArrayLike<number>; size: number; spacing: number; originX: number; originZ: number };
};

/** Sight-horizon elevation in degrees all around a point, every half degree; index 0 is north, growing clockwise. */
export function horizonProfile(field: HeightField, x: number, z: number, eye = 1.7, out = new Float32Array(PROFILE_RAYS)) {
  const { heights, size, spacing, originX, originZ, near } = field;
  const sample = (px: number, pz: number) => {
    if (near) {
      const a = Math.round((px - near.originX) / near.spacing);
      const b = Math.round((pz - near.originZ) / near.spacing);
      if (a >= 0 && b >= 0 && a < near.size && b < near.size) {
        const v = near.heights[b * near.size + a]!;
        if (!Number.isNaN(v)) return v;
      }
    }
    const i = Math.round((px - originX) / spacing);
    const j = Math.round((pz - originZ) / spacing);
    return i < 0 || j < 0 || i >= size || j >= size ? Number.NaN : heights[j * size + i]!;
  };
  const base = sample(x, z);
  const from = (Number.isFinite(base) ? base : 0) + eye;
  const first = near ? near.spacing : spacing;
  const limit = spacing * size * 1.5;
  // Steps grow with distance, since far ground changes the angle ever more slowly.
  for (let r = 0; r < PROFILE_RAYS; r++) {
    const az = (r / PROFILE_RAYS) * 2 * Math.PI;
    const sx = Math.sin(az);
    const sz = -Math.cos(az);
    let best = -90;
    let d = first;
    while (d < limit) {
      const h = sample(x + sx * d, z + sz * d);
      if (!Number.isNaN(h)) {
        const angle = Math.atan2(h - from - (d * d) / (2 * 7320000), d) / RAD;
        if (angle > best) best = angle;
      }
      d += Math.max(first, d * 0.03);
    }
    out[r] = best;
  }
  return out;
}

export type Skyline = { y: Float32Array; confidence: Float32Array; width: number; height: number; quality: number };

/**
 * Where the sky ends. Each column alone is easily fooled, by a cloud's edge above or by the shadow on a snowfield below, so
 * the whole line is chosen at once by dynamic programming: it must run along a sharp edge, with only sky above it and
 * something textured below it, and it may not jump far from one column to the next. A hand can correct any part of it.
 */
export function extractSkyline(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Skyline {
  const stepX = Math.max(1, Math.floor(width / 320));
  const stepY = Math.max(1, Math.floor(height / 240));
  const cols = Math.floor(width / stepX);
  const rows = Math.floor(height / stepY);
  const luma = new Float32Array(cols * rows);
  const blue = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let l = 0;
      let b = 0;
      for (let y = 0; y < stepY; y++) {
        for (let x = 0; x < stepX; x++) {
          const k = ((j * stepY + y) * width + i * stepX + x) * 4;
          l += 0.3 * rgba[k]! + 0.59 * rgba[k + 1]! + 0.11 * rgba[k + 2]!;
          b += rgba[k + 2]! - rgba[k]!;
        }
      }
      luma[j * cols + i] = l / (stepX * stepY);
      blue[j * cols + i] = b / (stepX * stepY);
    }
  }
  const at = (a: Float32Array, i: number, j: number) => a[Math.max(0, Math.min(rows - 1, j)) * cols + Math.max(0, Math.min(cols - 1, i))]!;
  const texture = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) texture[j * cols + i] = (Math.abs(at(luma, i + 1, j) - at(luma, i - 1, j)) + Math.abs(at(luma, i, j + 1) - at(luma, i, j - 1))) / 2;
  }
  // What the sky looks like here: its top band, whatever the weather.
  const band = Math.max(1, Math.floor(rows * 0.06));
  let topLuma = 0;
  let topBlue = 0;
  for (let k = 0; k < band * cols; k++) {
    topLuma += luma[k]!;
    topBlue += blue[k]!;
  }
  topLuma /= band * cols;
  topBlue /= band * cols;
  const clearSky = topBlue > 25;
  const skyLike = new Uint8Array(cols * rows);
  for (let k = 0; k < skyLike.length; k++) {
    const smooth = texture[k]! < 7;
    const cloud = smooth && luma[k]! > 150 && blue[k]! > -14;
    const clear = clearSky ? blue[k]! > topBlue * 0.45 && smooth : Math.abs(luma[k]! - topLuma) < 45 && smooth;
    skyLike[k] = cloud || clear ? 1 : 0;
  }
  // Score of the line passing below each cell.
  const score = new Float32Array(cols * rows);
  for (let i = 0; i < cols; i++) {
    let above = 0;
    for (let j = 0; j < rows - 1; j++) {
      const k = j * cols + i;
      const jump = Math.abs(at(luma, i, j + 1) - at(luma, i, j)) + Math.abs(at(blue, i, j + 1) - at(blue, i, j)) * 0.8;
      let rough = 0;
      let solid = 0;
      for (let d = 1; d <= 6; d++) {
        rough += at(texture, i, j + d);
        solid += skyLike[Math.min(rows - 1, j + d) * cols + i]! ? 0 : 1;
      }
      // An edge counts in full only with solid ground under it: a cloud's rim has more sky below.
      score[k] = Math.min(40, jump) * (0.2 + (0.8 * solid) / 6) + Math.min(15, rough / 6) * 1.5 + solid * 5 - above * 5;
      if (!skyLike[k]) above++;
    }
  }
  const reach = 5;
  const best = new Float32Array(cols * rows);
  const from = new Int16Array(cols * rows);
  for (let j = 0; j < rows; j++) best[j * cols] = score[j * cols]!;
  for (let i = 1; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      let top = -Infinity;
      let row = j;
      for (let d = -reach; d <= reach; d++) {
        const q = j + d;
        if (q < 0 || q >= rows) continue;
        const v = best[q * cols + i - 1]! - Math.abs(d) * 1.5;
        if (v > top) {
          top = v;
          row = q;
        }
      }
      best[j * cols + i] = top + score[j * cols + i]!;
      from[j * cols + i] = row;
    }
  }
  let end = 0;
  for (let j = 1; j < rows; j++) if (best[j * cols + cols - 1]! > best[end * cols + cols - 1]!) end = j;
  const line = new Int32Array(cols);
  for (let i = cols - 1, j = end; i >= 0; i--) {
    line[i] = j;
    j = from[j * cols + i]!;
  }
  // Back to pixels, walking each column's small block to its sharpest edge.
  const y = new Float32Array(width);
  const confidence = new Float32Array(width);
  let quality = 0;
  for (let px = 0; px < width; px++) {
    const u = Math.min(cols - 1, Math.floor(px / stepX));
    const next = Math.min(cols - 1, u + 1);
    const t = (px - u * stepX) / stepX;
    const row = line[u]! * (1 - t) + line[next]! * t;
    y[px] = (row + 1) * stepY;
    const j = line[u]!;
    const jump = Math.abs(at(luma, u, j + 1) - at(luma, u, j)) + Math.abs(at(blue, u, j + 1) - at(blue, u, j)) * 0.8;
    // Foreground reaching the top of the frame, or a line at the very edge, is no skyline.
    confidence[px] = j < Math.max(2, rows * 0.04) || j > rows - 3 ? 0 : Math.max(0.2, Math.min(1, jump / 30));
    quality += confidence[px]!;
  }
  return { y, confidence, width, height, quality: quality / width };
}

/** The skyline as elevation over bearing, relative to the camera axis, for a horizontal field of view. Pitch and roll stay unknown. */
export function skylineAngles(skyline: Skyline, hfov: number, samples = 90) {
  const f = skyline.width / 2 / Math.tan((hfov * RAD) / 2);
  const bearing: number[] = [];
  const elevation: number[] = [];
  const weight: number[] = [];
  for (let n = 0; n < samples; n++) {
    const i = Math.round(((n + 0.5) / samples) * skyline.width - 0.5);
    if (skyline.confidence[i]! < 0.15) continue;
    const px = i + 0.5 - skyline.width / 2;
    const py = skyline.height / 2 - skyline.y[i]!;
    bearing.push(Math.atan2(px, f) / RAD);
    elevation.push(Math.atan2(py * Math.cos(Math.atan2(px, f)), f) / RAD);
    weight.push(skyline.confidence[i]!);
  }
  return { bearing, elevation, weight };
}

export type HorizonFit = { rmse: number; azimuth: number; pitch: number; hfov: number };

/** Best heading for one profile against an observed line. The offset is the unknown camera pitch, the slope a small unknown roll. */
export function fitProfile(profile: ArrayLike<number>, angles: { bearing: number[]; elevation: number[]; weight: number[] }, hfov: number, stepDeg = 1): HorizonFit {
  const { bearing, elevation, weight } = angles;
  const scale = PROFILE_RAYS / 360;
  let best: HorizonFit = { rmse: Infinity, azimuth: 0, pitch: 0, hfov };
  let total = 0;
  let meanB = 0;
  for (let k = 0; k < bearing.length; k++) {
    total += weight[k]!;
    meanB += bearing[k]! * weight[k]!;
  }
  meanB /= total;
  let varB = 0;
  for (let k = 0; k < bearing.length; k++) varB += (bearing[k]! - meanB) ** 2 * weight[k]!;
  const n = bearing.length;
  const diff = new Float64Array(n);
  const MAX_ROLL = Math.tan(3 * RAD);
  for (let a = 0; a < 360; a += stepDeg) {
    let meanDiff = 0;
    let cov = 0;
    for (let k = 0; k < n; k++) {
      const r = (Math.round((a + bearing[k]!) * scale) + PROFILE_RAYS * 2) % PROFILE_RAYS;
      const d = profile[r]! - elevation[k]!;
      diff[k] = d;
      meanDiff += d * weight[k]!;
    }
    meanDiff /= total;
    for (let k = 0; k < n; k++) cov += (bearing[k]! - meanB) * (diff[k]! - meanDiff) * weight[k]!;
    const slope = varB > 0 ? Math.max(-MAX_ROLL, Math.min(MAX_ROLL, cov / varB)) : 0;
    let sq = 0;
    for (let k = 0; k < n; k++) {
      const e = diff[k]! - meanDiff - slope * (bearing[k]! - meanB);
      sq += e * e * weight[k]!;
    }
    const rmse = Math.sqrt(sq / total);
    if (rmse < best.rmse) best = { rmse, azimuth: a, pitch: meanDiff, hfov };
  }
  return best;
}

/** The fit as a share of the line's own spread: a narrow lens squeezes every angle, so raw degrees would always favour it. */
export type PhotoSpot = HorizonFit & { x: number; z: number; share: number };

export type PhotoSearch = {
  spots: PhotoSpot[];
  /** Spread of the observed line in degrees: below about half a degree any spot fits and no answer is possible. */
  relief: number;
  /** Best error over the next distinct place's: near 1 means many places look the same. */
  uniqueness: number;
  /** Metres around the best spot within which others fit about as well: how far the fingerprint can pin it down. */
  region: number;
  verdict: "plausibile" | "ambiguo" | "impossibile";
  tried: number;
};

/** Tries every position of a grid and every candidate lens, then refines around the best few. Yields to the page now and then. */
export async function searchPhoto(field: HeightField, skyline: Skyline, area: { minX: number; maxX: number; minZ: number; maxZ: number }, step: number, fovs: number[], onProgress?: (share: number) => void): Promise<PhotoSearch> {
  const spreadOf = (values: number[]) => {
    const mean = values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
    return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, values.length));
  };
  const sets = fovs.map((hfov) => {
    const angles = skylineAngles(skyline, hfov);
    return { hfov, angles, spread: spreadOf(angles.elevation) };
  });
  const widest = [...sets].sort((a, b) => b.hfov - a.hfov)[0]!;
  const relief = widest.spread;
  if (widest.angles.elevation.length < 12 || relief < 0.4) return { spots: [], relief, uniqueness: 1, region: 0, verdict: "impossibile", tried: 0 };
  const profile = new Float32Array(PROFILE_RAYS);
  const coarse: PhotoSpot[] = [];
  const total = (Math.floor((area.maxX - area.minX) / step) + 1) * (Math.floor((area.maxZ - area.minZ) / step) + 1);
  let tried = 0;
  let pause = performance.now();
  const fitAll = (x: number, z: number, stepDeg: number): PhotoSpot => {
    horizonProfile(field, x, z, 1.7, profile);
    let top: PhotoSpot | null = null;
    for (const set of sets) {
      const fit = fitProfile(profile, set.angles, set.hfov, stepDeg);
      const share = fit.rmse / Math.max(0.05, set.spread);
      if (!top || share < top.share) top = { ...fit, x, z, share };
    }
    return top!;
  };
  for (let z = area.minZ; z <= area.maxZ; z += step) {
    for (let x = area.minX; x <= area.maxX; x += step) {
      coarse.push(fitAll(x, z, 1));
      tried++;
      if (performance.now() - pause > 60) {
        onProgress?.(tried / total);
        await new Promise((resolve) => setTimeout(resolve));
        pause = performance.now();
      }
    }
  }
  coarse.sort((a, b) => a.share - b.share);
  // Distinct places first: neighbours of a good spot are good too and say nothing new.
  const distinct: PhotoSpot[] = [];
  for (const spot of coarse) {
    if (distinct.every((row) => Math.hypot(row.x - spot.x, row.z - spot.z) > step * 4)) distinct.push(spot);
    if (distinct.length >= 8) break;
  }
  const refined: PhotoSpot[] = [];
  for (const spot of distinct) {
    let best = spot;
    for (let dz = -step; dz <= step; dz += step / 3) {
      for (let dx = -step; dx <= step; dx += step / 3) {
        const row = fitAll(spot.x + dx, spot.z + dz, 0.5);
        if (row.share < best.share) best = row;
      }
    }
    refined.push(best);
    await new Promise((resolve) => setTimeout(resolve));
  }
  refined.sort((a, b) => a.share - b.share);
  const top = refined[0]!;
  const good = Math.max(top.share * 1.3, top.share + 0.03);
  // Other places that fit about as well count too: the answer is only as narrow as all of them together.
  const near = [...coarse, ...refined].filter((spot) => spot.share <= good).map((spot) => Math.hypot(spot.x - top.x, spot.z - top.z)).sort((a, b) => a - b);
  const region = Math.max(step, near.length ? near[Math.floor((near.length - 1) * 0.9)]! : step);
  const uniqueness = refined.length > 1 ? refined[1]!.share / Math.max(0.005, top.share) : 1;
  // A fit must leave little of the line unexplained, and not fit elsewhere just as well.
  const plausible = top.share < 0.2 && top.rmse < 0.35 && uniqueness > 1.25;
  return { spots: refined, relief, uniqueness, region, verdict: plausible ? "plausibile" : "ambiguo", tried };
}

export type PixelPoint = { u: number; v: number };

/**
 * Sun altitude and azimuth from one upright object in the photo: its foot, its top, and the tip of its shadow on level
 * ground. Camera height cancels, since everything is a ratio. `pitch` and `azimuth` come from the horizon fit or the user.
 */
export function sunFromShadow(foot: PixelPoint, top: PixelPoint, tip: PixelPoint, width: number, height: number, hfov: number, pitchDeg: number, azimuthDeg: number) {
  const f = width / 2 / Math.tan((hfov * RAD) / 2);
  const pitch = pitchDeg * RAD;
  const ground = (p: PixelPoint) => {
    const x = p.u - width / 2;
    const y = height / 2 - p.v;
    const forward = f * Math.cos(pitch) - y * Math.sin(pitch);
    const up = f * Math.sin(pitch) + y * Math.cos(pitch);
    if (up >= 0) return null;
    // Ground plane one camera-height below the eye.
    const t = -1 / up;
    return { side: x * t, ahead: forward * t };
  };
  const a = ground(foot);
  const s = ground(tip);
  if (!a || !s) return null;
  const dSide = s.side - a.side;
  const dAhead = s.ahead - a.ahead;
  const length = Math.hypot(dSide, dAhead);
  if (length < 1e-6) return null;
  // The object's top lies straight above the foot: same plan distance, so its elevation gives its height.
  const x = top.u - width / 2;
  const y = height / 2 - top.v;
  const forward = f * Math.cos(pitch) - y * Math.sin(pitch);
  const up = f * Math.sin(pitch) + y * Math.cos(pitch);
  const ratio = Math.hypot(a.side, a.ahead) / Math.hypot(x, forward);
  const objectHeight = 1 + up * ratio;
  if (objectHeight <= 0) return null;
  const altitude = Math.atan2(objectHeight, length) / RAD;
  const shadowBearing = Math.atan2(dSide, dAhead) / RAD;
  return { altitude, azimuth: (azimuthDeg + shadowBearing + 180 + 360) % 360 };
}

export type SunMatch = { date: Date; altitude: number; azimuth: number; error: number };

/**
 * Dates and hours when the Sun stood there, as seen from a place. With a known day this gives an hour; without one, the
 * same Sun returns twice a year, so several answers are all right and the list shows them. Times are UTC.
 */
export function matchSun(altitude: number, azimuth: number, lat: number, lon: number, year: number, day?: Date, tolerance = 2.5, limit = 12): SunMatch[] {
  const hits: SunMatch[] = [];
  const days = day ? [Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())] : Array.from({ length: 73 }, (_, i) => Date.UTC(year, 0, 1 + i * 5));
  for (const start of days) {
    let best: SunMatch | null = null;
    for (let minutes = 0; minutes < 1440; minutes += 5) {
      const date = new Date(start + minutes * 60000);
      const sun = sunPosition(date, lat, lon);
      if (sun.altitude <= 0) continue;
      const alt = sun.altitude / RAD;
      const az = sun.azimuth / RAD;
      const error = Math.hypot(alt - altitude, Math.cos(altitude * RAD) * (((az - azimuth + 540) % 360) - 180));
      if (error < tolerance && (!best || error < best.error)) best = { date, altitude: alt, azimuth: az, error };
    }
    if (best) hits.push(best);
  }
  return hits.sort((a, b) => a.error - b.error).slice(0, limit);
}
