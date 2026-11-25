import { api, type LidarOffer } from "../core/api.ts";
import type { BenchReport, LidarReport } from "../core/types.ts";
import { castShadows, fitSunAltitude, maskScore, resampleMask, type SurfaceGrid } from "../vision/bench.ts";
import { errorStats } from "../vision/laser.ts";
import { fillGaps, hillshade, localRelief, standingHeight, type ReliefGrid, type StandingHeight } from "../vision/lidar.ts";
import type { Building } from "./load.ts";
import type { Engine } from "../world/engine.ts";

const pointInside = (x: number, z: number, ring: ArrayLike<number>) => {
  let hit = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const zi = ring[i * 2 + 1]!;
    const zj = ring[j * 2 + 1]!;
    if (zi > z !== zj > z && x < ((ring[j * 2]! - ring[i * 2]!) * (z - zi)) / (zj - zi) + ring[i * 2]!) hit = !hit;
  }
  return hit;
};

/** Output size for a box: never finer than the survey, and never beyond what a browser holds comfortably. */
export function lidarSize(engine: Engine, offer: LidarOffer) {
  const p = engine.data.projection;
  const step = Math.max(offer.resolution, (Math.max(p.halfX, p.halfZ) * 2) / 2048);
  return { cols: Math.round((p.halfX * 2) / step), rows: Math.round((p.halfZ * 2) / step), cellX: (p.halfX * 2) / Math.round((p.halfX * 2) / step), cellZ: (p.halfZ * 2) / Math.round((p.halfZ * 2) / step) };
}

export async function bareGround(engine: Engine, offer: LidarOffer): Promise<ReliefGrid & { filled: number }> {
  const { cols, rows, cellX, cellZ } = lidarSize(engine, offer);
  const raw = await api.lidarGrid(offer.id, "dtm", engine.data.spec.bbox, cols, rows);
  const { heights, filled } = fillGaps(raw, cols, rows);
  return { heights, cols, rows, cellX, cellZ, filled };
}

export function shadedCanvas(grid: ReliefGrid) {
  const shade = hillshade(grid);
  const out = document.createElement("canvas");
  out.width = grid.cols;
  out.height = grid.rows;
  const ctx = out.getContext("2d")!;
  const image = ctx.createImageData(grid.cols, grid.rows);
  for (let k = 0; k < shade.length; k++) {
    image.data[k * 4] = image.data[k * 4 + 1] = image.data[k * 4 + 2] = shade[k]!;
    image.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

/** Blue rises above its surroundings, orange sinks below, grey is the land's own shape. Full colour at one metre. */
export function reliefCanvas(grid: ReliefGrid, radius = 15) {
  const relief = localRelief(grid, radius);
  const out = document.createElement("canvas");
  out.width = grid.cols;
  out.height = grid.rows;
  const ctx = out.getContext("2d")!;
  const image = ctx.createImageData(grid.cols, grid.rows);
  for (let k = 0; k < relief.length; k++) {
    const t = Math.max(-1, Math.min(1, relief[k]!));
    const a = Math.abs(t);
    const pole = t > 0 ? [57, 135, 229] : [217, 89, 38];
    image.data[k * 4] = 128 + (pole[0]! - 128) * a;
    image.data[k * 4 + 1] = 128 + (pole[1]! - 128) * a;
    image.data[k * 4 + 2] = 128 + (pole[2]! - 128) * a;
    image.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

/**
 * Heights from a surface model minus a ground model, footprint by footprint. A height written on the map is kept: the
 * comparison is what tells which of the two to trust. Surveys have their own date, which may be years from the plate's.
 */
export async function applyLidar(engine: Engine, offer: LidarOffer): Promise<LidarReport> {
  const { cols, rows } = lidarSize(engine, offer);
  const box = engine.data.spec.bbox;
  const [dsm, dtm] = await Promise.all([api.lidarGrid(offer.id, "dsm", box, cols, rows), api.lidarGrid(offer.id, "dtm", box, cols, rows)]);
  const ground = fillGaps(dtm, cols, rows).heights;
  const p = engine.data.projection;
  const cellX = (p.halfX * 2) / cols;
  const cellZ = (p.halfZ * 2) / rows;
  const differences = new Map<string, number[]>();
  const tallest: LidarReport["tallest"] = [];
  let changed = 0;
  let seen = 0;
  for (const { b, row } of standingBuildings(engine, dsm, ground, cols, rows)) {
    if (row.coverage < 0.5 || row.height < 2) continue;
    seen++;
    differences.set(b.source, [...(differences.get(b.source) ?? []), b.height - row.height]);
    tallest.push({ name: b.tags.name ?? "edificio", measured: row.height, mapped: b.height, source: b.source });
    if (b.source === "OSM height" || b.source === "ripresa") continue;
    const base = b.top - b.height;
    b.height = row.height;
    b.top = base + row.height;
    b.source = "LiDAR";
    b.confidence = 0.95;
    if (b.levels) b.levels = Math.max(1, Math.round((row.height - b.roofHeight) / 3.2));
    changed++;
  }
  engine.refreshBuildings();
  tallest.sort((a, b) => b.measured - a.measured);
  return {
    provider: offer.id,
    name: offer.name,
    at: new Date().toISOString(),
    seen,
    changed,
    bySource: [...differences].map(([label, errors]) => errorStats(label, errors)).sort((a, b) => b.n - a.n),
    tallest: tallest.slice(0, 8),
  };
}

/** Every visible building with what the survey saw inside its outline, and the cells it covers. */
function standingBuildings(engine: Engine, dsm: ArrayLike<number>, ground: ArrayLike<number>, cols: number, rows: number) {
  const p = engine.data.projection;
  const cellX = (p.halfX * 2) / cols;
  const cellZ = (p.halfZ * 2) / rows;
  const out: { b: Building; row: StandingHeight; cells: number[] }[] = [];
  for (const b of engine.data.buildings) {
    if (b.hidden) continue;
    const ring = b.rings[0]!;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]!);
      x1 = Math.max(x1, ring[i]!);
      z0 = Math.min(z0, ring[i + 1]!);
      z1 = Math.max(z1, ring[i + 1]!);
    }
    const cells: number[] = [];
    for (let j = Math.max(0, Math.floor((z0 + p.halfZ) / cellZ)); j < Math.min(rows, Math.ceil((z1 + p.halfZ) / cellZ)); j++) {
      const z = (j + 0.5) * cellZ - p.halfZ;
      for (let i = Math.max(0, Math.floor((x0 + p.halfX) / cellX)); i < Math.min(cols, Math.ceil((x1 + p.halfX) / cellX)); i++) {
        const x = (i + 0.5) * cellX - p.halfX;
        if (!pointInside(x, z, ring)) continue;
        let hole = false;
        for (let h = 1; h < b.rings.length && !hole; h++) hole = pointInside(x, z, b.rings[h]!);
        if (!hole) cells.push(j * cols + i);
      }
    }
    const row = standingHeight(dsm, ground, cells);
    if (row) out.push({ b, row, cells });
  }
  return out;
}

/**
 * Scores what the plate analysis found against the survey, and changes nothing in the world: shadows against the ones the
 * surveyed shapes would cast, canopy against what stands above three metres, heights source by source.
 */
export async function benchmark(engine: Engine, offer: LidarOffer): Promise<BenchReport> {
  const p = engine.data.projection;
  // A metre is enough to judge a 0.3 m plate's shadows, and keeps the sun search to a few seconds.
  const step = Math.max(offer.resolution, 1, (Math.max(p.halfX, p.halfZ) * 2) / 1024);
  const cols = Math.round((p.halfX * 2) / step);
  const rows = Math.round((p.halfZ * 2) / step);
  const box = engine.data.spec.bbox;
  const [dsm, dtm] = await Promise.all([api.lidarGrid(offer.id, "dsm", box, cols, rows), api.lidarGrid(offer.id, "dtm", box, cols, rows)]);
  const ground = fillGaps(dtm, cols, rows).heights;
  const surface = new Float32Array(dsm.length);
  for (let k = 0; k < surface.length; k++) surface[k] = Number.isFinite(dsm[k]!) ? Math.max(dsm[k]!, ground[k]!) : ground[k]!;
  const grid: SurfaceGrid = { surface, ground, cols, rows, cellX: (p.halfX * 2) / cols, cellZ: (p.halfZ * 2) / rows };

  const built = new Uint8Array(cols * rows);
  const bySource = new Map<string, number[]>();
  const fromShadows: number[] = [];
  const fromShadowsRoof: number[] = [];
  let floors = 0;
  let floorsHeld = 0;
  for (const { b, row, cells } of standingBuildings(engine, dsm, ground, cols, rows)) {
    for (const k of cells) built[k] = 1;
    if (row.coverage < 0.5 || row.height < 2 || b.source === "LiDAR") continue;
    bySource.set(b.source, [...(bySource.get(b.source) ?? []), b.height - row.height]);
    if (b.shadowHeight != null) {
      fromShadows.push(b.shadowHeight - row.height);
      fromShadowsRoof.push(b.shadowHeight - row.roofMedian);
    }
    if (b.shadowFloor != null) {
      floors++;
      if (b.shadowFloor <= row.height + 1.5) floorsHeld++;
    }
  }

  const a = engine.data.plate.analysis;
  const at = (channel: number, from: ArrayLike<number>) => resampleMask(from, a.width, a.height, cols, rows, channel, 4, 127);
  const shadowFound = at(3, a.gainMap);
  const canopyFound = at(0, a.classMap);
  const water = at(2, a.classMap);
  // Shadows are judged on open ground: on roofs and crowns the plate's own lean moves them.
  const open = new Uint8Array(cols * rows);
  const unbuilt = new Uint8Array(cols * rows);
  const tall = new Uint8Array(cols * rows);
  for (let k = 0; k < open.length; k++) {
    const rise = surface[k]! - ground[k]!;
    unbuilt[k] = built[k] || water[k] ? 0 : 1;
    open[k] = unbuilt[k] && rise < 0.7 ? 1 : 0;
    tall[k] = rise > 3 ? 1 : 0;
  }
  const expected = castShadows(grid, a.sun.sunAzimuth, a.sun.altitude);
  const shadow = maskScore(shadowFound, expected, open);
  const fit = fitSunAltitude(grid, a.sun.sunAzimuth, shadowFound, open);
  return {
    provider: offer.id,
    name: offer.name,
    at: new Date().toISOString(),
    cell: step,
    plateDate: engine.data.plate.ref.kind === "tiles" ? (engine.data.plate.ref.date ?? null) : (engine.data.plate.ref.capture?.date ?? null),
    heights: [...bySource].map(([label, errors]) => errorStats(label, errors)).sort((x, y) => y.n - x.n),
    shadowHeights: fromShadows.length ? errorStats("ombra", fromShadows) : null,
    shadowRoof: fromShadowsRoof.length ? errorStats("ombra", fromShadowsRoof) : null,
    shadowFloors: floors ? { n: floors, held: floorsHeld } : null,
    shadow,
    canopy: maskScore(canopyFound, tall, unbuilt),
    sun: { used: a.sun.altitude, method: a.sun.method, best: fit.altitude, iouUsed: shadow.iou, iouBest: fit.iou, reliable: !a.shadowsWeak && !fit.atEdge },
  };
}
