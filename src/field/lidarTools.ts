import { api, type LidarOffer } from "../core/api.ts";
import type { LidarReport } from "../core/types.ts";
import { errorStats } from "../vision/laser.ts";
import { fillGaps, hillshade, localRelief, standingHeight, type ReliefGrid } from "../vision/lidar.ts";
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
    if (!row || row.coverage < 0.5 || row.height < 2) continue;
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
