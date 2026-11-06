/** Survey arithmetic with no rendering in it: georeferencing, traverses, sections, lines of sight, flooding. */

export type ControlPoint = { u: number; v: number; x: number; z: number };

export type Affine = { a: number; b: number; c: number; d: number; e: number; f: number; rms: number; residuals: number[] };

function solve3(m: number[][], r: number[]) {
  const a = m.map((row, i) => [...row, r[i]!]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    if (Math.abs(a[col]![col]!) < 1e-12) return null;
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const k = a[row]![col]! / a[col]![col]!;
      for (let c = col; c < 4; c++) a[row]![c]! -= k * a[col]![c]!;
    }
  }
  return [a[0]![3]! / a[0]![0]!, a[1]![3]! / a[1]![1]!, a[2]![3]! / a[2]![2]!];
}

/** x = a·u + b·v + c, z = d·u + e·v + f by least squares. Three points fix it; more points give a real error figure. */
export function fitAffine(points: ControlPoint[]): Affine | null {
  if (points.length < 3) return null;
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rx = [0, 0, 0];
  const rz = [0, 0, 0];
  for (const p of points) {
    const row = [p.u, p.v, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) m[i]![j]! += row[i]! * row[j]!;
      rx[i]! += row[i]! * p.x;
      rz[i]! += row[i]! * p.z;
    }
  }
  const sx = solve3(m, rx);
  const sz = solve3(m, rz);
  if (!sx || !sz) return null;
  const residuals = points.map((p) => Math.hypot(sx[0]! * p.u + sx[1]! * p.v + sx[2]! - p.x, sz[0]! * p.u + sz[1]! * p.v + sz[2]! - p.z));
  const rms = points.length > 3 ? Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / (points.length - 3)) : 0;
  return { a: sx[0]!, b: sx[1]!, c: sx[2]!, d: sz[0]!, e: sz[1]!, f: sz[2]!, rms, residuals };
}

export type InstrumentClass = { id: string; label: string; angleSd: number; distanceSd: (d: number) => number; zSd: (d: number) => number };

const SEC = 1 / 3600;

export const SURVEY_CLASSES: InstrumentClass[] = [
  { id: "stazione", label: "Stazione totale ±2″, ±(2 mm + 2 ppm)", angleSd: 2 * SEC, distanceSd: (d) => 0.002 + d * 2e-6, zSd: (d) => 0.003 + d * 1e-5 },
  { id: "bussola", label: "Bussola e cordella ±0,5°, 1:300", angleSd: 0.5, distanceSd: (d) => d / 300, zSd: (d) => 0.05 + d * 0.005 },
];

export type TraverseLeg = { azimuth: number; distance: number; dz: number };

/** A measured leg: the truth from the world, plus the error a real instrument of this class would make. */
export function measureLeg(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, cls: InstrumentClass, gauss: () => number): TraverseLeg {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  return {
    azimuth: ((Math.atan2(dx, -dz) * 180) / Math.PI + cls.angleSd * gauss() + 360) % 360,
    distance: d + cls.distanceSd(d) * gauss(),
    dz: to.y - from.y + cls.zSd(d) * gauss(),
  };
}

export type TraverseResult = {
  stations: { x: number; y: number; z: number }[];
  adjusted: { x: number; y: number; z: number }[];
  length: number;
  misclosure: { dx: number; dz: number; dy: number; linear: number; ratio: number };
};

/** Runs the legs from the start and, on a closed loop, spreads the error along them by the compass (Bowditch) rule. */
export function adjustTraverse(start: { x: number; y: number; z: number }, legs: TraverseLeg[], closed: boolean): TraverseResult {
  const stations = [{ ...start }];
  let length = 0;
  for (const leg of legs) {
    const last = stations[stations.length - 1]!;
    const az = (leg.azimuth * Math.PI) / 180;
    stations.push({ x: last.x + Math.sin(az) * leg.distance, y: last.y + leg.dz, z: last.z - Math.cos(az) * leg.distance });
    length += leg.distance;
  }
  const end = stations[stations.length - 1]!;
  const dx = closed ? end.x - start.x : 0;
  const dz = closed ? end.z - start.z : 0;
  const dy = closed ? end.y - start.y : 0;
  const linear = Math.hypot(dx, dz);
  let run = 0;
  const adjusted = stations.map((point, index) => {
    if (index) run += legs[index - 1]!.distance;
    const k = length > 0 ? run / length : 0;
    return { x: point.x - dx * k, y: point.y - dy * k, z: point.z - dz * k };
  });
  return { stations, adjusted, length, misclosure: { dx, dz, dy, linear, ratio: linear > 0 ? length / linear : Infinity } };
}

export type Section = { distance: number[]; ground: number[]; surface: number[]; length: number; gain: number; loss: number; min: number; max: number; maxSlope: number };

/** Profile along a polyline: the ground, and what stands on it. */
export function sectionAlong(points: { x: number; z: number }[], heightAt: (x: number, z: number) => number, surfaceAt: (x: number, z: number) => number, samples = 400): Section {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
  const length = cumulative[cumulative.length - 1]!;
  const distance: number[] = [];
  const ground: number[] = [];
  const surface: number[] = [];
  let leg = 0;
  for (let s = 0; s < samples; s++) {
    const d = (s / (samples - 1)) * length;
    while (leg < points.length - 2 && cumulative[leg + 1]! < d) leg++;
    const span = cumulative[leg + 1]! - cumulative[leg]! || 1;
    const t = (d - cumulative[leg]!) / span;
    const x = points[leg]!.x + (points[leg + 1]!.x - points[leg]!.x) * t;
    const z = points[leg]!.z + (points[leg + 1]!.z - points[leg]!.z) * t;
    distance.push(d);
    ground.push(heightAt(x, z));
    surface.push(Math.max(heightAt(x, z), surfaceAt(x, z)));
  }
  let gain = 0;
  let loss = 0;
  let maxSlope = 0;
  const window = Math.max(1, Math.round(samples / 80));
  for (let i = window; i < samples; i += window) {
    const dy = ground[i]! - ground[i - window]!;
    if (dy > 0) gain += dy;
    else loss -= dy;
    const run = distance[i]! - distance[i - window]!;
    if (run > 0) maxSlope = Math.max(maxSlope, Math.abs(Math.atan2(dy, run)));
  }
  return { distance, ground, surface, length, gain, loss, min: Math.min(...ground), max: Math.max(...surface), maxSlope: (maxSlope * 180) / Math.PI };
}

export type Viewshed = { size: number; radius: number; cell: number; visible: Uint8Array; share: number; farthest: number };

/**
 * Radial line of sight over the surface: a cell is seen when nothing nearer rises above the sightline to it.
 * Earth curvature and refraction matter past a couple of kilometres, so they are included.
 */
export function viewshed(ox: number, oz: number, eye: number, radius: number, surfaceAt: (x: number, z: number) => number, size = 513, targetHeight = 0): Viewshed {
  const visible = new Uint8Array(size * size);
  const cell = (radius * 2) / (size - 1);
  const rays = Math.ceil(Math.PI * size * 1.5);
  const center = (size - 1) / 2;
  let farthest = 0;
  for (let r = 0; r < rays; r++) {
    const az = (r / rays) * Math.PI * 2;
    const sx = Math.sin(az);
    const sz = -Math.cos(az);
    let maxTan = -Infinity;
    for (let d = cell * 0.75; d <= radius; d += cell * 0.75) {
      const px = ox + sx * d;
      const pz = oz + sz * d;
      const drop = (d * d) / (2 * 6371000 * 1.17);
      const y = surfaceAt(px, pz) - drop;
      const tan = (y + targetHeight - eye) / d;
      const i = Math.round(center + (sx * d) / cell);
      const j = Math.round(center + (sz * d) / cell);
      if (tan >= maxTan && i >= 0 && j >= 0 && i < size && j < size) {
        visible[j * size + i] = 1;
        if (d > farthest) farthest = d;
      }
      const blockTan = (y - eye) / d;
      if (blockTan > maxTan) maxTan = blockTan;
    }
  }
  let seen = 0;
  let inside = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if ((i - center) ** 2 + (j - center) ** 2 > center ** 2) continue;
      inside++;
      if (visible[j * size + i]) seen++;
    }
  }
  return { size, radius, cell, visible, share: inside ? seen / inside : 0, farthest };
}

/** What a water level does to this terrain. Connectivity is ignored on purpose: basins below the level count as flooded, and the note says so. */
export function floodStats(heights: Float32Array, spacing: number, level: number) {
  let cells = 0;
  let depthSum = 0;
  let deepest = 0;
  for (const h of heights) {
    if (h >= level) continue;
    cells++;
    depthSum += level - h;
    deepest = Math.max(deepest, level - h);
  }
  const cellArea = spacing * spacing;
  return { area: cells * cellArea, share: heights.length ? cells / heights.length : 0, volume: depthSum * cellArea, deepest };
}
