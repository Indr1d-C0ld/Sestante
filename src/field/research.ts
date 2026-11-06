import { stitchPlate } from "../core/api.ts";
import { bestZoom, type Bbox, type Projection } from "../core/geo.ts";
import type { Affine, Viewshed } from "../core/fieldwork.ts";
import { api } from "../core/api.ts";
import { pointInRing } from "../core/geo.ts";
import type { MassReport, PlateRef, PlateVersion, StrataSummary } from "../core/types.ts";
import { changeVolume, complexRange, formatVolume, INTERVAL_FACTOR, massVolume, solidRange, solidVolume, sumRange, type VolumeRange } from "../vision/volume.ts";
import type { AnalysisResult } from "../vision/analyze.ts";
import { bestHeight, predictShadow, scoreShadow, verdict, type ShadowPlate, type ShadowScore } from "../vision/shadowTest.ts";
import { absentOn, buildingPresence, combineHeights, type StratumRead } from "../vision/timeline.ts";
import { assessLaser, correctedHeight, FOOTPRINT_RADIUS, type LaserAssessment, type LaserShot, type PlacedShot, type TreeModel, type TreePair } from "../vision/laser.ts";
import type { Engine } from "../world/engine.ts";
import { interpretPlate, readPlate, type Building, type TreeInstance } from "./load.ts";

export function shadowPlateOf(analysis: AnalysisResult, date: string): ShadowPlate {
  const alpha = new Uint8Array(analysis.width * analysis.height);
  for (let k = 0; k < alpha.length; k++) alpha[k] = analysis.gainMap[k * 4 + 3]!;
  return { date, width: analysis.width, height: analysis.height, mpp: analysis.mpp, sunAzimuth: analysis.sun.sunAzimuth, altitude: analysis.sun.altitude, confidence: analysis.sun.confidence, alpha };
}

export const plateDate = (ref: PlateRef) => (ref.kind === "tiles" ? (ref.date ?? "") : ref.kind === "wayback" ? (ref.capture?.date ?? ref.published) : (ref.capture?.date ?? ""));

export type StrataRun = { summary: StrataSummary; plates: ShadowPlate[] };

/** Develops and reads every distinct shot of this place, oldest last. Tiles stay cached, so a second run costs almost nothing. */
export async function readStrata(
  engine: Engine,
  context: Parameters<typeof interpretPlate>[2],
  versions: PlateVersion[],
  limit: number,
  cache: Map<string, HTMLCanvasElement>,
  onStep: (text: string, done: number, total: number) => void,
  stop: () => boolean,
): Promise<StrataRun> {
  const rows = versions.slice(0, limit);
  const reads: StratumRead[] = [];
  const plates: ShadowPlate[] = [];
  const shots: StrataSummary["shots"] = [];
  for (let i = 0; i < rows.length; i++) {
    if (stop()) break;
    const row = rows[i]!;
    const date = row.capture?.date ?? row.published;
    onStep(`Sviluppo ${date}`, i, rows.length);
    const ref: PlateRef = { kind: "wayback", release: row.release, published: row.published, capture: row.capture };
    const key = `wb-${row.release}`;
    let canvas = cache.get(key);
    if (!canvas) {
      canvas = await readPlate(ref, engine.data.spec, (text) => onStep(`${date}: ${text.replace("Sviluppo la lastra: ", "")}`, i, rows.length));
      cache.set(key, canvas);
    }
    onStep(`Leggo ombre e sagome di ${date}`, i, rows.length);
    const state = await interpretPlate(ref, canvas, context);
    const a = state.analysis;
    // A shot known only by its publication date can still measure a shadow, but it cannot date a building.
    reads.push({ key, date, resolution: row.capture?.resolution ?? null, sun: { sunAzimuth: a.sun.sunAzimuth, altitude: a.sun.altitude, confidence: a.sun.confidence, method: a.sun.method }, heights: a.heights, evidence: row.capture?.date ? a.evidence : {} });
    plates.push(shadowPlateOf(a, date));
    shots.push({ date, sensor: row.capture?.sensor ?? null, resolution: row.capture?.resolution ?? null, sunAzimuth: a.sun.sunAzimuth, altitude: a.sun.altitude, confidence: a.sun.confidence, method: a.sun.method, instant: a.sun.instant });
  }
  onStep("Metto insieme le letture", rows.length, rows.length);
  return { summary: { at: new Date().toISOString(), shots, heights: combineHeights(reads), presence: buildingPresence(reads) }, plates };
}

/** What the shots add to the mapped world. A height written on the map is never overwritten: disagreement is only reported. */
export function applyStrata(engine: Engine, summary: StrataSummary) {
  let improved = 0;
  for (const building of engine.data.buildings) {
    const series = summary.heights[building.id];
    if (!series) continue;
    building.shots = series.n;
    building.range = [series.low, series.high];
    building.shadowHeight = series.h;
    if (building.source === "OSM height" || building.source === "OSM piani" || building.source === "laser GEDI" || building.isPart || series.n < 2) continue;
    const tops = building.top - building.height;
    building.height = series.h;
    building.top = tops + series.h;
    building.source = "ombre multi-data";
    const width = (series.high - series.low) / Math.max(1, series.h);
    building.confidence = Math.max(0.3, Math.min(0.95, (0.45 + series.n * 0.06) * (1 - Math.min(0.7, width))));
    if (building.levels) building.levels = Math.max(1, Math.round((series.h - building.roofHeight) / 3.2));
    improved++;
  }
  return improved;
}

export function placeShots(shots: LaserShot[], projection: Projection): PlacedShot[] {
  return shots.map((shot) => ({ ...shot, ...projection.toLocal(shot.lat, shot.lon) }));
}

export function assessWorld(engine: Engine, shots: LaserShot[]) {
  return assessLaser(placeShots(shots, engine.data.projection), {
    heightAt: engine.heightAt,
    buildingAt: (x, z) => {
      const b = engine.query.buildingAt(x, z);
      return b ? { id: b.id, height: b.height, top: b.top, source: b.source, shadowHeight: b.shadowHeight, name: b.tags.name ?? (b.tags.building && b.tags.building !== "yes" ? b.tags.building : "edificio") } : null;
    },
    trees: engine.plate.trees,
  });
}

// --- Volumes ---

export type HeightError = { typical: number; shared: number; basis: string };

/**
 * Typical height error of each source, and the bias its buildings share. The figures marked as measured come from GEDI
 * at Prati, Rome; the laser's own table takes over wherever this box has enough footprints. A bias not measured is taken
 * as half the typical error, which is about what the measured sources show.
 */
const HEIGHT_ERRORS: Record<string, HeightError> = {
  "OSM height": { typical: 2, shared: 1, basis: "presunto: troppe poche misure per stimarlo" },
  "OSM piani": { typical: 5.2, shared: 4.5, basis: "misurato col laser a Prati" },
  LiDAR: { typical: 1, shared: 0.3, basis: "presunto: precisione dichiarata dei rilievi nazionali" },
  "laser GEDI": { typical: 2.5, shared: 1.2, basis: "presunto: precisione del disco e del punto" },
  "ombre multi-data": { typical: 2.9, shared: 0.7, basis: "misurato col laser a Prati" },
  ombra: { typical: 5, shared: 2.6, basis: "misurato col laser a Prati" },
  ripresa: { typical: 5, shared: 2.5, basis: "come l'ombra di una ripresa" },
  quartiere: { typical: 8.5, shared: 4.2, basis: "misurato col laser a Prati" },
  "tipo edilizio": { typical: 6, shared: 3, basis: "presunto: troppe poche misure per stimarlo" },
};

export function heightErrorsFrom(laser: LaserAssessment | null) {
  const out: Record<string, HeightError> = { ...HEIGHT_ERRORS };
  for (const row of laser?.bySource ?? []) if (row.n >= 5) out[row.label] = { typical: Math.max(1, row.typical), shared: Math.abs(row.bias), basis: `misurato qui col laser su ${row.n} impronte` };
  return out;
}

const errorOf = (building: Building, errors: Record<string, HeightError>) => {
  const row = errors[building.source] ?? { typical: 5, shared: 2.5, basis: "presunto" };
  // Disagreement between dated shots is direct evidence of doubt about this very building.
  const spread = building.range ? (building.range[1] - building.range[0]) / 2 : 0;
  return { typical: Math.max(row.typical, spread), shared: row.shared, basis: row.basis };
};

export type BuildingVolume = {
  own: VolumeRange & { area: number };
  area: number;
  meanHeight: number;
  error: HeightError;
  complex: (VolumeRange & { name: string; parts: number; area: number }) | null;
};

const complexCache = new Map<string, BuildingVolume["complex"]>();

function complexFor(part: Building, buildings: Building[], errors: Record<string, HeightError>) {
  const ring = part.rings[0]!;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i += 2) {
    cx += ring[i]!;
    cz += ring[i + 1]!;
  }
  cx /= ring.length / 2;
  cz /= ring.length / 2;
  const parent = buildings.find((row) => row.hidden && !row.isPart && pointInRing(cx, cz, row.rings[0]!));
  if (!parent) return null;
  const parts = buildings.filter((row) => {
    if (!row.isPart) return false;
    const r = row.rings[0]!;
    let x = 0;
    let z = 0;
    for (let i = 0; i < r.length; i += 2) {
      x += r[i]!;
      z += r[i + 1]!;
    }
    return pointInRing(x / (r.length / 2), z / (r.length / 2), parent.rings[0]!);
  });
  if (parts.length < 2) return null;
  const key = `${parent.id}:${parts.reduce((sum, row) => sum + row.height, 0).toFixed(1)}:${parts.map((row) => errorOf(row, errors).typical.toFixed(1)).join()}`;
  if (complexCache.has(key)) return complexCache.get(key)!;
  const range = complexRange(parts.map((row) => ({ rings: row.rings, height: row.height, minHeight: row.minHeight, roofHeight: row.roofHeight, roofShape: row.roofShape, heightError: errorOf(row, errors).typical })));
  const result = { ...range, name: parent.tags.name ?? part.tags.name ?? "struttura", parts: parts.length };
  complexCache.set(key, result);
  return result;
}

export function volumeOfBuilding(building: Building, buildings: Building[], errors: Record<string, HeightError>): BuildingVolume {
  const error = errorOf(building, errors);
  const own = solidRange({ rings: building.rings, height: building.height, minHeight: building.minHeight, roofHeight: building.roofHeight, roofShape: building.roofShape }, error.typical);
  return { own, area: own.area, meanHeight: own.meanHeight, error, complex: building.isPart ? complexFor(building, buildings, errors) : null };
}

/** Everything standing in the box, source by source. Sources are independent of each other, so their intervals add in quadrature. */
export function cubature(buildings: Building[], masses: Building[], errors: Record<string, HeightError>) {
  const groups = new Map<string, BuildingVolume["own"][]>();
  for (const building of [...buildings, ...masses]) {
    if (building.hidden) continue;
    const { own } = volumeOfBuilding({ ...building, isPart: false }, [], errors);
    groups.set(building.source, [...(groups.get(building.source) ?? []), own]);
  }
  const rows = [...groups].map(([source, items]) => {
    const total = sumRange(items, errors[source]?.shared ?? 2.5);
    return { source, count: items.length, value: total.value, half: total.high - total.value };
  });
  return rows.sort((a, b) => b.value - a.value);
}

/** How often the laser falls inside the interval this table would print: the check that the intervals mean what they say. */
export function intervalCoverage(laser: LaserAssessment | null, errors: Record<string, HeightError>) {
  const rows = (laser?.readings ?? []).filter((row) => row.kind === "edificio" && row.shot.good && row.building!.source !== "laser GEDI");
  if (!rows.length) return null;
  const hits = rows.filter((row) => Math.abs(row.error!) <= (errors[row.building!.source]?.typical ?? 5) * INTERVAL_FACTOR).length;
  return { hits, total: rows.length, share: hits / rows.length };
}

/** A mass outlined on the land, measured on each surface model available. */
export async function measureMass(engine: Engine, ring: number[], name: string): Promise<MassReport> {
  const projection = engine.data.projection;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]!);
    maxX = Math.max(maxX, ring[i]!);
    minZ = Math.min(minZ, ring[i + 1]!);
    maxZ = Math.max(maxZ, ring[i + 1]!);
  }
  const margin = 70;
  const nw = projection.toLatLon(minX - margin, minZ - margin);
  const se = projection.toLatLon(maxX + margin, maxZ + margin);
  const box = { n: nw.lat, w: nw.lon, s: se.lat, e: se.lon };
  // The models are 30 m grids: 10 m sampling draws the outline well, but adds no detail, which nativeCells keeps in view.
  const width = maxX - minX + margin * 2;
  const height = maxZ - minZ + margin * 2;
  const step = Math.max(10, Math.max(width, height) / 400);
  const cols = Math.max(8, Math.round(width / step));
  const rows = Math.max(8, Math.round(height / step));
  const cellX = width / cols;
  const cellZ = height / rows;
  const inside = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (pointInRing(minX - margin + (i + 0.5) * cellX, minZ - margin + (j + 0.5) * cellZ, ring)) inside[j * cols + i] = 1;
    }
  }
  const [cop, nasa] = await Promise.all([api.demGrid(box, cols, rows, "copernicus").catch(() => null), api.demGrid(box, cols, rows, "nasadem").catch(() => null)]);
  const main = cop ?? nasa;
  if (!main) throw new Error("Nessun modello del terreno raggiunto per quest'area.");
  const primary = massVolume({ heights: main, cols, rows, cellX, cellZ, inside });
  if (!primary) throw new Error("Il contorno cade dove il modello non ha quote.");
  const second = cop && nasa ? massVolume({ heights: nasa, cols, rows, cellX, cellZ, inside }) : null;
  // Two independent surveys of one object: when they disagree by more than the interval, the interval must grow to hold both.
  const widen = (row: VolumeRange, other: VolumeRange | undefined): VolumeRange => (other ? { value: row.value, low: Math.max(0, Math.min(row.low, other.value)), high: Math.max(row.high, other.value) } : row);
  const change = cop && nasa ? changeVolume(nasa, cop, { cols, rows, cellX, cellZ, inside }) : null;
  const warnings: string[] = [];
  if (primary.nativeCells < 4) warnings.push("Il contorno copre meno di quattro celle del modello a 30 m: questo numero non è una misura.");
  else if (primary.nativeCells < 25) warnings.push("Il contorno copre poche celle del modello a 30 m: prendilo come ordine di grandezza.");
  // Radar models do not follow steep walls and lose narrow summits: Cheops rises 33 m on Copernicus and 60 m on NASADEM, out of 138.
  // Nothing inside one model shows it. Two models that disagree do, and so do solids on the map that outweigh the measure.
  if (second && Math.max(primary.fill.value, second.fill.value) > 20000 && Math.max(primary.fill.value, second.fill.value) > 1.3 * Math.min(primary.fill.value, second.fill.value)) {
    warnings.push(`I due modelli non concordano (${formatVolume(primary.fill.value)} contro ${formatVolume(second.fill.value)}): pareti ripide che il radar non segue, alberi, o un cambiamento vero fra il 2000 e il 2013. Il valore vero può stare anche sopra l'intervallo.`);
  }
  let mapVolume = 0;
  for (const building of [...engine.data.buildings, ...engine.plate.masses]) {
    if (building.hidden) continue;
    const r = building.rings[0]!;
    let x = 0;
    let z = 0;
    for (let i = 0; i < r.length; i += 2) {
      x += r[i]!;
      z += r[i + 1]!;
    }
    if (pointInRing(x / (r.length / 2), z / (r.length / 2), ring)) mapVolume += solidVolume(building).volume;
  }
  const seen = Math.max(primary.fill.value, second?.fill.value ?? 0);
  if (mapVolume > 20000 && mapVolume > 1.5 * seen) warnings.push(`Gli edifici sulla carta dentro il contorno valgono già ${formatVolume(mapVolume)}: il rilievo non li vede interi, e per loro vale il volume da pianta e altezza.`);
  const warning = warnings.join(" ");
  return {
    id: Date.now().toString(36),
    name,
    ring,
    area: primary.area,
    nativeCells: primary.nativeCells,
    fill: widen(primary.fill, second?.fill),
    cut: widen(primary.cut, second?.cut),
    peak: primary.peak,
    pit: primary.pit,
    rimRoughness: primary.rimRoughness,
    sources: cop && nasa ? "Copernicus GLO-30, controllato su NASADEM" : cop ? "Copernicus GLO-30" : "NASADEM",
    warning,
    models: [
      { name: cop ? "Copernicus GLO-30" : "NASADEM", fill: primary.fill.value, peak: primary.peak },
      ...(second ? [{ name: "NASADEM", fill: second.fill.value, peak: second.peak }] : []),
    ],
    mapVolume,
    change: change ? { net: change.net, low: change.low, high: change.high, significant: change.significant, noise: change.noise } : null,
    created: new Date().toISOString(),
  };
}

/** Footprints over clean canopy against the crowns as first read from the plate, never against an earlier correction. */
export function treePairs(assessment: LaserAssessment, trees: TreeInstance[]): TreePair[] {
  const pairs: TreePair[] = [];
  for (const { kind, shot } of assessment.readings) {
    if (kind !== "albero" || !shot.good) continue;
    const crowns = trees.filter((tree) => tree.origin !== "mappa" && Math.hypot(tree.x - shot.x, tree.z - shot.z) <= FOOTPRINT_RADIUS + tree.r * 0.5).map((tree) => tree.rawH ?? tree.h);
    if (crowns.length) pairs.push({ x: shot.x, z: shot.z, rh98: shot.rh98, group: `${shot.date}${shot.beam}`, crowns });
  }
  return pairs;
}

/** Applies in place, always from the plate's own reading, so plates and repeated runs never compound. A height tagged on the map stays. */
export function correctTrees(trees: TreeInstance[], model: TreeModel | null) {
  for (const tree of trees) {
    if (tree.origin === "mappa") continue;
    const raw = tree.rawH ?? tree.h;
    if (!model) {
      tree.h = raw;
      delete tree.rawH;
      continue;
    }
    tree.rawH = raw;
    // A crown cannot be wider than the tree is tall by much: it would read as a mushroom.
    tree.h = Math.min(45, Math.max(2, tree.r * 1.4, correctedHeight(model, tree.x, tree.z, raw)));
  }
}

/** Lets the laser set the heights nobody measured. Written heights stay: a disagreement with the map is shown, not overruled. */
export function applyLaser(engine: Engine, assessment: LaserAssessment) {
  let changed = 0;
  for (const building of engine.data.buildings) {
    const reading = assessment.perBuilding[building.id];
    if (!reading || reading.share < 0.7 || reading.measured < 2 || building.source === "OSM height" || building.source === "OSM piani" || building.source === "laser GEDI" || building.source === "ripresa") continue;
    const ground = building.top - building.height;
    building.height = reading.measured;
    building.top = ground + reading.measured;
    building.source = "laser GEDI";
    building.confidence = Math.min(0.95, 0.65 + reading.shots * 0.08);
    if (building.levels) building.levels = Math.max(1, Math.round((reading.measured - building.roofHeight) / 3.2));
    changed++;
  }
  return changed;
}

/** Height gained or lost between two surface models, in the plate's frame. Blue rose, orange sank, grey within the noise. */
export function demChangeCanvas(difference: Float32Array, cols: number, rows: number) {
  const out = document.createElement("canvas");
  out.width = cols;
  out.height = rows;
  const ctx = out.getContext("2d")!;
  const image = ctx.createImageData(cols, rows);
  const grey = [0.5, 0.5, 0.5];
  for (let k = 0; k < difference.length; k++) {
    const d = difference[k]!;
    if (!Number.isFinite(d)) continue;
    const t = Math.max(-1, Math.min(1, d / 15));
    const pole = t > 0 ? [0.22, 0.53, 0.9] : [0.85, 0.35, 0.15];
    const a = Math.abs(t);
    for (let c = 0; c < 3; c++) image.data[k * 4 + c] = (grey[c]! + (pole[c]! - grey[c]!) * a) * 255;
    image.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

export function absentIds(summary: StrataSummary | null | undefined, date: string) {
  const out = new Set<string>();
  if (!summary || !date) return out;
  for (const [id, presence] of Object.entries(summary.presence)) if (absentOn(presence, date) && presence.confidence > 0.35) out.add(id);
  return out;
}

export type BenchResult = { scores: ShadowScore[]; best: { date: string; h: number; f1: number }[]; label: string; lift: number; suggested: number | null; picture: HTMLCanvasElement };

/** Throws a volume's shadow onto every shot read so far, and draws the strongest test on the plate for the register. */
export function runBench(rings: number[][], height: number, plates: ShadowPlate[], plateCanvas: HTMLCanvasElement, projection: Projection): BenchResult {
  const toPx = (plate: ShadowPlate) => rings.map((ring) => ring.map((v, i) => (v + (i % 2 ? projection.halfZ : projection.halfX)) / plate.mpp));
  const usable = plates.filter((plate) => plate.altitude > 0.12);
  const scores = usable.map((plate) => scoreShadow(toPx(plate), height, plate));
  const best = usable.map((plate) => ({ date: plate.date, ...bestHeight(toPx(plate), plate) })).filter((row) => row.f1 > 0.25);
  const weights = [...best].sort((a, b) => a.h - b.h);
  const v = verdict(scores);
  // A best fit means something only once the shadow is really there: otherwise it just found the nearest dark patch.
  const suggested = weights.length && v.meanLift > 0.2 ? weights[weights.length >> 1]!.h : null;

  const plate = usable[0] ?? plates[0]!;
  const px = toPx(plate);
  const { mask } = predictShadow(px, height, plate);
  let minX = plate.width;
  let maxX = 0;
  let minY = plate.height;
  let maxY = 0;
  const widen = (x: number, y: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (const ring of px) for (let i = 0; i < ring.length; i += 2) widen(ring[i]!, ring[i + 1]!);
  for (let y = 0; y < plate.height; y++) for (let x = 0; x < plate.width; x++) if (mask[y * plate.width + x]) widen(x, y);
  const pad = Math.max(16, (maxX - minX + maxY - minY) * 0.25);
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(plate.width - sx, maxX - minX + pad * 2);
  const sh = Math.min(plate.height - sy, maxY - minY + pad * 2);
  const k = plateCanvas.width / plate.width;
  const scale = Math.min(4, 1200 / Math.max(sw, sh));
  const picture = document.createElement("canvas");
  picture.width = Math.max(16, Math.round(sw * scale));
  picture.height = Math.max(16, Math.round(sh * scale));
  const ctx = picture.getContext("2d")!;
  ctx.drawImage(plateCanvas, sx * k, sy * k, sw * k, sh * k, 0, 0, picture.width, picture.height);
  ctx.fillStyle = "rgba(217,89,38,.42)";
  for (let y = Math.floor(sy); y < sy + sh; y++) {
    for (let x = Math.floor(sx); x < sx + sw; x++) {
      if (mask[y * plate.width + x]) ctx.fillRect((x - sx) * scale, (y - sy) * scale, Math.ceil(scale), Math.ceil(scale));
    }
  }
  ctx.strokeStyle = "#ffd27a";
  ctx.lineWidth = 2.5;
  for (const ring of px) {
    ctx.beginPath();
    for (let i = 0; i < ring.length; i += 2) {
      const x = (ring[i]! - sx) * scale;
      const y = (ring[i + 1]! - sy) * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  return { scores, best, label: v.label, lift: v.meanLift, suggested, picture };
}

// --- Layers built in the browser ---

/**
 * High-pass over a season's median NDVI: fields go flat, and what differs from its surroundings stands out.
 * Green above, brown below, grey near zero. At 10 m per pixel only large buried features can show.
 */
export function vegetationAnomaly(source: HTMLCanvasElement, metresPerPixel: number, onField?: (field: { diff: Float32Array; sigma: number; width: number; height: number }) => void) {
  const w = source.width;
  const h = source.height;
  const data = source.getContext("2d")!.getImageData(0, 0, w, h).data;
  const value = new Float32Array(w * h);
  const valid = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    value[k] = (data[k * 4]! / 255) * 2 - 1;
    valid[k] = data[k * 4 + 3]! > 0 ? 1 : 0;
  }
  const table = new Float64Array((w + 1) * (h + 1));
  const count = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const up = y * (w + 1) + x + 1;
      const at = (y + 1) * (w + 1) + x + 1;
      table[at] = (valid[k] ? value[k]! : 0) + table[up]! + table[at - 1]! - table[up - 1]!;
      count[at] = valid[k]! + count[up]! + count[at - 1]! - count[up - 1]!;
    }
  }
  const r = Math.max(2, Math.round(120 / metresPerPixel));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  const image = ctx.createImageData(w, h);
  let spread = 0;
  let used = 0;
  const diff = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!valid[k]) continue;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = table[y1 * (w + 1) + x1]! - table[y0 * (w + 1) + x1]! - table[y1 * (w + 1) + x0]! + table[y0 * (w + 1) + x0]!;
      const n = count[y1 * (w + 1) + x1]! - count[y0 * (w + 1) + x1]! - count[y1 * (w + 1) + x0]! + count[y0 * (w + 1) + x0]!;
      diff[k] = value[k]! - sum / Math.max(1, n);
      spread += diff[k]! * diff[k]!;
      used++;
    }
  }
  const sigma = Math.sqrt(spread / Math.max(1, used)) || 0.01;
  onField?.({ diff, sigma, width: w, height: h });
  for (let k = 0; k < w * h; k++) {
    if (!valid[k]) continue;
    const t = Math.max(-1, Math.min(1, diff[k]! / (sigma * 2.5)));
    const g = 0.5;
    const pole = t > 0 ? [0.1, 0.62, 0.44] : [0.85, 0.35, 0.15];
    const a = Math.abs(t);
    image.data[k * 4] = (g + (pole[0]! - g) * a) * 255;
    image.data[k * 4 + 1] = (g + (pole[1]! - g) * a) * 255;
    image.data[k * 4 + 2] = (g + (pole[2]! - g) * a) * 255;
    image.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

export async function deepCanvas(bbox: Bbox, layer: string, time: string, maxZoom: number) {
  const z = Math.min(maxZoom, bestZoom(bbox, 2048, maxZoom));
  return (await stitchPlate(bbox, `gibs/${layer}/${time}`, z)).canvas;
}

/** Paints a line-of-sight result on the plate's rectangle: seen cells bright, the rest left transparent over a dim veil. */
export function viewshedCanvas(v: Viewshed, ox: number, oz: number, projection: Projection, side = 1024) {
  const aspect = projection.halfZ / projection.halfX;
  const out = document.createElement("canvas");
  out.width = side;
  out.height = Math.max(16, Math.round(side * aspect));
  const ctx = out.getContext("2d")!;
  const image = ctx.createImageData(out.width, out.height);
  const center = (v.size - 1) / 2;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const wx = ((x + 0.5) / out.width) * 2 * projection.halfX - projection.halfX;
      const wz = ((y + 0.5) / out.height) * 2 * projection.halfZ - projection.halfZ;
      const i = Math.round(center + (wx - ox) / v.cell);
      const j = Math.round(center + (wz - oz) / v.cell);
      const k = (y * out.width + x) * 4;
      const inside = i >= 0 && j >= 0 && i < v.size && j < v.size && (i - center) ** 2 + (j - center) ** 2 <= center ** 2;
      if (!inside) continue;
      const seen = v.visible[j * v.size + i];
      image.data[k] = seen ? 57 : 34;
      image.data[k + 1] = seen ? 135 : 30;
      image.data[k + 2] = seen ? 229 : 26;
      image.data[k + 3] = seen ? 150 : 170;
    }
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

/** Warps a scanned map onto the plate rectangle through its fitted transform. */
export function warpOverlay(image: CanvasImageSource & { width: number; height: number }, t: Pick<Affine, "a" | "b" | "c" | "d" | "e" | "f">, projection: Projection, side = 2048) {
  const out = document.createElement("canvas");
  out.width = side;
  out.height = Math.max(16, Math.round(side * (projection.halfZ / projection.halfX)));
  const ctx = out.getContext("2d")!;
  const sx = out.width / (2 * projection.halfX);
  const sz = out.height / (2 * projection.halfZ);
  ctx.setTransform(t.a * sx, t.d * sz, t.b * sx, t.e * sz, (t.c + projection.halfX) * sx, (t.f + projection.halfZ) * sz);
  ctx.drawImage(image, 0, 0);
  return out;
}

export type Spectrum = { width: number; height: number; bands: Float32Array[]; from: string; to: string };

export const BANDS = [
  { id: "B02", name: "Blu", nm: 490 },
  { id: "B03", name: "Verde", nm: 560 },
  { id: "B04", name: "Rosso", nm: 665 },
  { id: "B05", name: "Bordo rosso", nm: 705 },
  { id: "B08", name: "Vicino IR", nm: 842 },
  { id: "B11", name: "IR corto 1", nm: 1610 },
  { id: "B12", name: "IR corto 2", nm: 2190 },
];

export async function loadSpectrum(url: string, from: string, to: string): Promise<Spectrum> {
  const res = await fetch(url);
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Errore ${res.status}`);
  }
  const { fromArrayBuffer } = await import("geotiff");
  const tiff = await fromArrayBuffer(await res.arrayBuffer());
  const image = await tiff.getImage();
  const rasters = (await image.readRasters()) as unknown as Float32Array[];
  return { width: image.getWidth(), height: image.getHeight(), bands: Array.from({ length: rasters.length }, (_, i) => rasters[i]!), from, to };
}

export function sampleSpectrum(spectrum: Spectrum, x: number, z: number, projection: Projection) {
  const u = Math.floor(((x + projection.halfX) / (2 * projection.halfX)) * spectrum.width);
  const v = Math.floor(((z + projection.halfZ) / (2 * projection.halfZ)) * spectrum.height);
  if (u < 0 || v < 0 || u >= spectrum.width || v >= spectrum.height) return null;
  const k = v * spectrum.width + u;
  if (!spectrum.bands[7]?.[k]) return null;
  const values = BANDS.map((_, index) => spectrum.bands[index]![k]!);
  const [, green, red, , nir, swir1, swir2] = values as [number, number, number, number, number, number, number];
  const blue = values[0]!;
  const ratio = (a: number, b: number) => (a - b) / (a + b + 1e-6);
  const ndvi = ratio(nir, red);
  const ndwi = ratio(green, nir);
  const nbr = ratio(nir, swir2);
  const bsi = ratio(swir1 + red, nir + blue);
  const kind = ndwi > 0.15 ? "acqua" : ndvi > 0.55 ? "vegetazione densa" : ndvi > 0.28 ? "vegetazione rada" : bsi > 0.1 ? "suolo nudo o costruito chiaro" : "costruito o roccia";
  return { values, ndvi, ndwi, nbr, bsi, kind };
}
