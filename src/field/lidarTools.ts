import { api, type LidarOffer } from "../core/api.ts";
import type { BenchReport, LidarReport } from "../core/types.ts";
import { castShadows, fitSunAltitude, maskScore, resampleMask, type SurfaceGrid } from "../vision/bench.ts";
import { leanFromSurface, type Lean } from "../vision/lean.ts";
import { distanceToRings, insideRings, nearRectangle, roofSurfaceAt, smoothRoof, STEEP_REACH, steepShape, type RoofGrid } from "../core/roofs.ts";
import { familyId, SURVEY_PART, surveyedParts } from "../core/lidarParts.ts";

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
};
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
  const built = new Uint8Array(cols * rows);
  // Parts made by an earlier run of this, and the outlines they replaced, start over.
  engine.data.buildings = engine.data.buildings.filter((b) => !b.id.includes(SURVEY_PART));
  for (const b of engine.data.buildings) if (b.splitBySurvey) {
    b.hidden = false;
    b.splitBySurvey = false;
  }
  const added: Building[] = [];
  for (const { b, row, cells } of standingBuildings(engine, dsm, ground, cols, rows)) {
    for (const k of cells) built[k] = 1;
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
    // The roof too: the eave at the roof's median height, the surface above it as surveyed. A lower eave pulled the walls
    // down to unmapped courtyards and low annexes inside the outline, and the roofs hung over them like curtains.
    const rises = cells.map((k) => dsm[k]! - ground[k]!).filter((v) => Number.isFinite(v) && v > 1).sort((x, y) => x - y);
    const eave = rises[Math.floor(rises.length * 0.5)] ?? 0;
    // Only coherent roofs: ridge within 5 m of the median and the median at least 60% of the ridge. A footprint holding
    // a low annex and a tall wing, or a crane, turned into a rock; those keep the shape they had.
    if (rises.length >= 12 && !(row.height - eave <= 5 && eave >= row.height * 0.6) && !b.isPart) {
      // An outline holding parts of different heights: it gives way to the parts the survey sees.
      const parts = splitByParts(b, dsm, ground, cols, rows, cellX, cellZ, p.halfX, p.halfZ);
      // One part alone would only trade the map's outline for the survey's coarser one.
      if (parts.length >= 2) {
        b.hidden = true;
        b.splitBySurvey = true;
        added.push(...parts);
        changed++;
        continue;
      }
    }
    if (rises.length >= 12 && row.height - eave <= 5 && eave >= row.height * 0.6) {
      b.roofHeight = Math.max(0, row.height - eave);
      b.roofGrid = smoothRoof(roofPatch(b.rings[0]!, dsm, ground, cols, rows, cellX, cellZ, p.halfX, p.halfZ));
      b.roofShape = "rilevato";
      b.roofFrom = "LiDAR";
    }
    if (b.levels) b.levels = Math.max(1, Math.round((row.height - b.roofHeight) / 3.2));
    changed++;
  }
  engine.data.buildings.push(...added);
  engine.refreshBuildings();
  const trees = surveyTrees(engine, dsm, ground, built, cols, rows);
  tallest.sort((a, b) => b.measured - a.measured);
  return {
    provider: offer.id,
    name: offer.name,
    at: new Date().toISOString(),
    seen,
    changed,
    bySource: [...differences].map(([label, errors]) => errorStats(label, errors)).sort((a, b) => b.n - a.n),
    tallest: tallest.slice(0, 8),
    trees,
    parts: added.length ? { outlines: new Set(added.map((b) => familyId(b.id))).size, parts: added.length } : undefined,
  };
}

/**
 * Trees against the survey: each takes the highest point the laser saw under the inner part of its crown, away from
 * buildings. A tree read from the plate where the laser sees nothing taller than 3 m goes: per-tree heights read from
 * the plate had almost no relation to the laser's (correlation 0.0 to 0.4), and half of those trees stood on lawns,
 * hedges or shadows. Mapped trees stay, with the laser's height when it has one.
 */
function surveyTrees(engine: Engine, dsm: ArrayLike<number>, ground: ArrayLike<number>, built: Uint8Array, cols: number, rows: number) {
  const p = engine.data.projection;
  const cellX = (p.halfX * 2) / cols;
  const cellZ = (p.halfZ * 2) / rows;
  let measured = 0;
  let removed = 0;
  const keep = engine.plate.trees.filter((tree) => {
    const r = Math.max(cellX, tree.r * 0.7);
    let top = -Infinity;
    for (let z = tree.z - r; z <= tree.z + r; z += cellZ) {
      for (let x = tree.x - r; x <= tree.x + r; x += cellX) {
        if ((x - tree.x) ** 2 + (z - tree.z) ** 2 > r * r) continue;
        const i = Math.floor((x + p.halfX) / cellX);
        const j = Math.floor((z + p.halfZ) / cellZ);
        if (i < 0 || j < 0 || i >= cols || j >= rows || built[j * cols + i]) continue;
        const v = dsm[j * cols + i]! - ground[j * cols + i]!;
        if (Number.isFinite(v)) top = Math.max(top, v);
      }
    }
    // Outside the survey, or all under buildings: nothing to say.
    if (top === -Infinity) return true;
    if (top > 3) {
      tree.h = top;
      tree.origin = "laser";
      tree.rawH = undefined;
      measured++;
      return true;
    }
    if (tree.source === "osm") return true;
    removed++;
    return false;
  });
  engine.plate.trees.splice(0, engine.plate.trees.length, ...keep);
  engine.refreshTrees();
  return { measured, removed };
}

/**
 * Cells at least `reach` cells from any mapped building. Next to a wall the survey's tall cells are often the building
 * itself (eaves, a misplaced outline, the plate's lean): only away from them is "tall" mostly trees.
 */
function clearOf(built: Uint8Array, cols: number, rows: number, reach: number) {
  const near = new Uint8Array(built.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!built[j * cols + i]) continue;
      for (let dj = -reach; dj <= reach; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= rows) continue;
        for (let di = -reach; di <= reach; di++) {
          const ii = i + di;
          if (ii >= 0 && ii < cols) near[jj * cols + ii] = 1;
        }
      }
    }
  }
  for (let k = 0; k < near.length; k++) near[k] = near[k] ? 0 : 1;
  return near;
}

/** Trees read from the plate that stand on something the survey sees taller than 3 m, anywhere under their crown. */
function treesOnTall(engine: Engine, dsm: ArrayLike<number>, ground: ArrayLike<number>, cols: number, rows: number) {
  const p = engine.data.projection;
  const cellX = (p.halfX * 2) / cols;
  const cellZ = (p.halfZ * 2) / rows;
  let n = 0;
  let tall = 0;
  for (const tree of engine.plate.trees) {
    if (tree.source !== "ripresa") continue;
    n++;
    const r = Math.max(cellX, tree.r * 0.7);
    let top = 0;
    for (let z = tree.z - r; z <= tree.z + r; z += cellZ) {
      for (let x = tree.x - r; x <= tree.x + r; x += cellX) {
        if ((x - tree.x) ** 2 + (z - tree.z) ** 2 > r * r) continue;
        const i = Math.floor((x + p.halfX) / cellX);
        const j = Math.floor((z + p.halfZ) / cellZ);
        if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
        const v = dsm[j * cols + i]! - ground[j * cols + i]!;
        if (Number.isFinite(v)) top = Math.max(top, v);
      }
    }
    if (top > 3) tall++;
  }
  return n ? { n, onTall: tall / n } : null;
}

/**
 * One footprint split into the parts the survey sees: wings, annexes, with courtyards left open. Each part stands as a
 * building of its own (a part, as OpenStreetMap's building:part), with the parent's colour and tags, its own height, and
 * the surveyed roof when its roof is coherent, else a flat top at its median height.
 */
function splitByParts(b: Building, dsm: ArrayLike<number>, ground: ArrayLike<number>, cols: number, rows: number, cellX: number, cellZ: number, halfX: number, halfZ: number): Building[] {
  const patch = roofPatch(b.rings[0]!, dsm, ground, cols, rows, cellX, cellZ, halfX, halfZ);
  const inside = new Uint8Array(patch.cols * patch.rows);
  for (let j = 0; j < patch.rows; j++) {
    for (let i = 0; i < patch.cols; i++) inside[j * patch.cols + i] = insideRings(patch.x0 + i * patch.cell, patch.z0 + j * patch.cell, b.rings) ? 1 : 0;
  }
  const parts = surveyedParts({ heights: patch.heights, inside, cols: patch.cols, rows: patch.rows, x0: patch.x0 - patch.cell / 2, z0: patch.z0 - patch.cell / 2, cell: patch.cell });
  if (!parts.length) return [];
  const ground0 = b.top - b.height;
  const smooth = smoothRoof(patch);
  return parts.map((part, index) => {
    const coherent = part.height - part.median <= 5;
    const area = part.cells * patch.cell * patch.cell;
    const height = coherent ? part.height : part.median;
    return {
      ...b,
      id: `${b.id}${SURVEY_PART}${index}`,
      rings: part.rings,
      height,
      top: ground0 + height,
      source: "LiDAR",
      confidence: 0.95,
      levels: Math.max(1, Math.round(part.median / 3.2)),
      roofShape: coherent ? "rilevato" : "flat",
      roofFrom: "LiDAR",
      roofHeight: coherent ? Math.max(0, part.height - part.median) : 0,
      roofGrid: coherent ? smooth : undefined,
      isPart: true,
      hidden: false,
      area,
      minHeight: 0,
      splitBySurvey: false,
    } satisfies Building;
  });
}

/** The survey around one footprint, as heights above the ground, one cell beyond its bounds. */
function roofPatch(ring: number[], dsm: ArrayLike<number>, ground: ArrayLike<number>, cols: number, rows: number, cellX: number, cellZ: number, halfX: number, halfZ: number): RoofGrid {
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
  const i0 = Math.max(0, Math.floor((x0 + halfX) / cellX) - 1);
  const i1 = Math.min(cols - 1, Math.ceil((x1 + halfX) / cellX) + 1);
  const j0 = Math.max(0, Math.floor((z0 + halfZ) / cellZ) - 1);
  const j1 = Math.min(rows - 1, Math.ceil((z1 + halfZ) / cellZ) + 1);
  const w = i1 - i0 + 1;
  const h = j1 - j0 + 1;
  const heights = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = (j0 + j) * cols + i0 + i;
      const v = dsm[k]! - ground[k]!;
      heights[j * w + i] = Number.isFinite(v) ? v : NaN;
    }
  }
  // Cells are square enough here: the patch keeps the x spacing.
  return { x0: (i0 + 0.5) * cellX - halfX, z0: (j0 + 0.5) * cellZ - halfZ, cell: cellX, cols: w, rows: h, heights };
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
  const roofModel: number[] = [];
  const roofFlat: number[] = [];
  const roofGroups = new Map<string, { model: number[]; flat: number[] }>();
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
    // The roof as a surface, cell by cell: the model's against the survey's, and a flat top at the same height beside it.
    if (b.isPart || row.coverage < 0.7) continue;
    // Heights above the building's own ground, as the survey's are.
    const top = b.height;
    // As buildings.ts draws it: flat roofs, and steep ones over a complex plan, at the top.
    const flatTop = b.roofShape === "flat" || (steepShape(b.roofShape) && !(b.rings.length === 1 && nearRectangle(b.rings[0]!, b.area)));
    const eave = flatTop ? top : top - b.roofHeight;
    const rise = top - eave;
    let deepest = 0;
    const at: { x: number; z: number; h: number }[] = [];
    for (const k of cells) {
      const h = dsm[k]! - ground[k]!;
      if (!Number.isFinite(h) || h < 2) continue;
      const x = ((k % cols) + 0.5) * grid.cellX - p.halfX;
      const z = (Math.floor(k / cols) + 0.5) * grid.cellZ - p.halfZ;
      at.push({ x, z, h });
      if (rise > 0) deepest = Math.max(deepest, distanceToRings(x, z, b.rings));
    }
    if (at.length < 10) continue;
    if (steepShape(b.roofShape)) deepest = Math.min(deepest, STEEP_REACH);
    let model = 0;
    let flat = 0;
    for (const c of at) {
      model += Math.abs(c.h - roofSurfaceAt(c.x, c.z, b.rings, eave, rise, deepest));
      flat += Math.abs(c.h - top);
    }
    roofModel.push(model / at.length);
    roofFlat.push(flat / at.length);
    const group = roofGroups.get(b.roofFrom ?? "nessuna") ?? { model: [], flat: [] };
    group.model.push(model / at.length);
    group.flat.push(flat / at.length);
    roofGroups.set(b.roofFrom ?? "nessuna", group);
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
    trees: treesOnTall(engine, dsm, ground, cols, rows),
    roofSurface: roofModel.length ? { n: roofModel.length, model: median(roofModel), flat: median(roofFlat), byFrom: Object.fromEntries([...roofGroups].map(([k, g]) => [k, { n: g.model.length, model: median(g.model), flat: median(g.flat) }])) } : null,
    shadow,
    canopy: maskScore(canopyFound, tall, unbuilt),
    canopyClear: maskScore(canopyFound, tall, clearOf(built, cols, rows, Math.max(1, Math.round(4 / step)))),
    sun: { used: a.sun.altitude, method: a.sun.method, best: fit.altitude, iouUsed: shadow.iou, iouBest: fit.iou, reliable: !a.shadowsWeak && !fit.atEdge },
  };
}

/**
 * The plate's lean from the survey: surface steps projected with each candidate lean onto the plate's edges. One metre
 * cells at most, as in the benchmark; the search takes some fifteen seconds on a 600 m box.
 */
export async function measureLean(engine: Engine, offer: LidarOffer): Promise<Lean | null> {
  const p = engine.data.projection;
  const step = Math.max(offer.resolution, 1, (Math.max(p.halfX, p.halfZ) * 2) / 1024);
  const cols = Math.round((p.halfX * 2) / step);
  const rows = Math.round((p.halfZ * 2) / step);
  const box = engine.data.spec.bbox;
  const [dsm, dtm] = await Promise.all([api.lidarGrid(offer.id, "dsm", box, cols, rows), api.lidarGrid(offer.id, "dtm", box, cols, rows)]);
  const ground = fillGaps(dtm, cols, rows).heights;
  const heights = new Float32Array(cols * rows);
  for (let k = 0; k < heights.length; k++) heights[k] = Number.isFinite(dsm[k]!) ? Math.max(0, dsm[k]! - ground[k]!) : 0;
  // The plate on the same grid: drawn small, then read as luminance.
  const small = document.createElement("canvas");
  small.width = cols;
  small.height = rows;
  const ctx = small.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(engine.plate.canvas, 0, 0, cols, rows);
  const px = ctx.getImageData(0, 0, cols, rows).data;
  const lum = new Float32Array(cols * rows);
  for (let k = 0; k < lum.length; k++) lum[k] = (0.299 * px[k * 4]! + 0.587 * px[k * 4 + 1]! + 0.114 * px[k * 4 + 2]!) / 255;
  // Out of the event loop's way: the search is plain arithmetic, a pause lets the panel show that it started.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return leanFromSurface(lum, { heights, cols, rows, cell: (p.halfX * 2) / cols });
}
