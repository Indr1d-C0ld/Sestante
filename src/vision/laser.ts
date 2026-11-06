/**
 * GEDI measures from orbit with a laser, independently of every photograph: it is the one outside check on what
 * the shadows say. A footprint is a 25 m disc, so a reading counts for a building only when the building fills it. Pure code.
 */
export type LaserShot = {
  id: string;
  lat: number;
  lon: number;
  /** Lowest mode and highest return, metres above the WGS84 ellipsoid: not the map's heights above the geoid. */
  ground: number;
  top: number;
  rh98: number;
  rh50: number;
  srtm: number | null;
  sensitivity: number;
  good: boolean;
  date: string;
  beam: string;
  solar: number;
  cover: number | null;
};

export type PlacedShot = LaserShot & { x: number; z: number };

export type LaserBuilding = { id: string; height: number; top: number; source: string; shadowHeight: number | null; name: string };
export type LaserTree = { x: number; z: number; r: number; h: number };

export type ShotReading = {
  shot: PlacedShot;
  kind: "edificio" | "albero" | "aperto" | "misto";
  /** Share of the footprint covered by the building it is credited to. */
  share: number;
  building: LaserBuilding | null;
  /** Height above that building's ground, or the crown's height for a tree. */
  measured: number;
  model: number | null;
  error: number | null;
};

export type ErrorStats = { label: string; n: number; bias: number; typical: number; within3: number };

export type LaserAssessment = {
  /** What to subtract from a GEDI elevation to reach the map's heights, measured here and now. */
  datum: number;
  datumFrom: string;
  datumSpread: number;
  readings: ShotReading[];
  counts: { total: number; good: number; buildings: number; trees: number; open: number };
  bySource: ErrorStats[];
  shadows: ErrorStats | null;
  trees: ErrorStats | null;
  perBuilding: Record<string, { measured: number; shots: number; share: number }>;
};

export const FOOTPRINT_RADIUS = 12.5;
const MAX_PLAUSIBLE = 450;

const DISC: [number, number][] = (() => {
  const points: [number, number][] = [[0, 0]];
  for (const [radius, count] of [[0.33, 6], [0.66, 12], [1, 18]] as const) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      points.push([Math.cos(a) * radius * FOOTPRINT_RADIUS, Math.sin(a) * radius * FOOTPRINT_RADIUS]);
    }
  }
  return points;
})();

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function errorStats(label: string, errors: number[]): ErrorStats {
  return {
    label,
    n: errors.length,
    bias: median(errors),
    typical: median(errors.map(Math.abs)),
    within3: errors.length ? errors.filter((e) => Math.abs(e) <= 3).length / errors.length : 0,
  };
}

export function assessLaser(shots: PlacedShot[], world: { heightAt: (x: number, z: number) => number; buildingAt: (x: number, z: number) => LaserBuilding | null; trees: LaserTree[] }): LaserAssessment {
  // First pass: what each disc sits on. The datum comes from open ground, where the lowest mode really is the ground.
  const footing = shots.map((shot) => {
    const hits = new Map<string, { building: LaserBuilding; count: number }>();
    let covered = 0;
    for (const [dx, dz] of DISC) {
      const building = world.buildingAt(shot.x + dx, shot.z + dz);
      if (!building) continue;
      covered++;
      const row = hits.get(building.id);
      if (row) row.count++;
      else hits.set(building.id, { building, count: 1 });
    }
    const best = [...hits.values()].sort((a, b) => b.count - a.count)[0] ?? null;
    const crowns = world.trees.filter((tree) => Math.hypot(tree.x - shot.x, tree.z - shot.z) <= FOOTPRINT_RADIUS + tree.r * 0.5);
    return { shot, best, built: covered / DISC.length, crowns };
  });

  // The terrain model is itself a surface model, so under a park it rides on the crowns, and the laser's true ground would pull
  // the reference metres off. The SRTM height GEDI carries belongs to the same family as the terrain: it comes first.
  let datumRows = shots.filter((shot) => shot.srtm != null).map((shot) => shot.srtm! - world.heightAt(shot.x, shot.z));
  let datumFrom = `quota SRTM allegata a ${datumRows.length} impronte`;
  if (datumRows.length < 3) {
    datumRows = footing.filter((row) => row.built < 0.1 && !row.crowns.length && row.shot.good).map((row) => row.shot.ground - world.heightAt(row.shot.x, row.shot.z));
    datumFrom = `${datumRows.length} impronte su terreno aperto`;
  }
  if (datumRows.length < 3) {
    datumRows = shots.map((shot) => shot.ground - world.heightAt(shot.x, shot.z));
    datumFrom = `tutte le ${datumRows.length} impronte`;
  }
  const datum = median(datumRows);
  const datumSpread = median(datumRows.map((v) => Math.abs(v - datum)));

  const readings: ShotReading[] = footing.map(({ shot, best, built, crowns }) => {
    const share = best ? best.count / DISC.length : 0;
    if (best && share >= 0.55) {
      const b = best.building;
      const measured = shot.top - datum - (b.top - b.height);
      // A top below the building's own ground, or up among the clouds, says the reference failed here: it is no measure of the building.
      if (measured < 1 || measured > MAX_PLAUSIBLE) return { shot, kind: "misto", share, building: b, measured: shot.rh98, model: null, error: null };
      return { shot, kind: "edificio", share, building: b, measured, model: b.height, error: b.height - measured };
    }
    // Any wall inside the disc can supply the highest return, so a tree is judged only on clean ground.
    if (built < 0.05 && crowns.length) {
      const model = Math.max(...crowns.map((tree) => tree.h));
      return { shot, kind: "albero", share: 0, building: null, measured: shot.rh98, model, error: model - shot.rh98 };
    }
    if (built < 0.1) return { shot, kind: "aperto", share: 0, building: null, measured: shot.rh98, model: null, error: null };
    return { shot, kind: "misto", share, building: best?.building ?? null, measured: shot.rh98, model: null, error: null };
  });

  const usable = readings.filter((row) => row.shot.good);
  const onBuildings = usable.filter((row) => row.kind === "edificio");
  // A height set by the laser agrees with the laser by construction: it is no evidence of anything.
  const sources = [...new Set(onBuildings.map((row) => row.building!.source))].filter((source) => source !== "laser GEDI");
  const bySource = sources.map((source) => errorStats(source, onBuildings.filter((row) => row.building!.source === source).map((row) => row.error!))).sort((a, b) => b.n - a.n);
  const shadowErrors = onBuildings.filter((row) => row.building!.shadowHeight != null).map((row) => row.building!.shadowHeight! - row.measured);
  const treeRows = usable.filter((row) => row.kind === "albero").map((row) => row.error!);

  const perBuilding: LaserAssessment["perBuilding"] = {};
  for (const row of onBuildings) {
    const id = row.building!.id;
    const list = onBuildings.filter((item) => item.building!.id === id);
    perBuilding[id] ??= { measured: median(list.map((item) => item.measured)), shots: list.length, share: Math.max(...list.map((item) => item.share)) };
  }

  return {
    datum,
    datumFrom,
    datumSpread,
    readings,
    counts: { total: shots.length, good: usable.length, buildings: onBuildings.length, trees: treeRows.length, open: usable.filter((row) => row.kind === "aperto").length },
    bySource,
    shadows: shadowErrors.length ? errorStats("Ombre, su ogni edificio misurato", shadowErrors) : null,
    trees: treeRows.length ? errorStats("Alberi letti dalla lastra", treeRows) : null,
    perBuilding,
  };
}

/** Two surface models of the same box, years apart: their difference, without the offset between the two sensors. */
export function demDifference(older: Float32Array, newer: Float32Array) {
  const raw: number[] = [];
  for (let i = 0; i < older.length; i++) {
    const a = older[i]!;
    const b = newer[i]!;
    if (Number.isFinite(a) && Number.isFinite(b)) raw.push(b - a);
  }
  const bias = median(raw);
  const out = new Float32Array(older.length).fill(Number.NaN);
  let rose = 0;
  let sank = 0;
  let highest = 0;
  let lowest = 0;
  for (let i = 0; i < older.length; i++) {
    const a = older[i]!;
    const b = newer[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = b - a - bias;
    out[i] = d;
    if (d > 5) rose++;
    if (d < -5) sank++;
    highest = Math.max(highest, d);
    lowest = Math.min(lowest, d);
  }
  return { difference: out, bias, rose: raw.length ? rose / raw.length : 0, sank: raw.length ? sank / raw.length : 0, highest, lowest, cells: raw.length };
}

// --- Tree heights ---

/**
 * Measured against GEDI, a single crown's height read from a plate turned out to carry almost no information, shadow or not:
 * correlations near zero at three sites in Rome. What the laser does know is how tall the trees of a place are.
 * So the correction sets the height of the local stand and keeps only a damped trace of each tree's own reading,
 * and it is kept only if it beats the plate on whole orbits left out of the fit.
 */
export type TreePair = { x: number; z: number; rh98: number; group: string; crowns: number[] };

export type TreeModel = {
  kind: "sito" | "locale";
  radius: number;
  /** Median crown height as read from the plate, the unit of the damped variation. */
  unit: number;
  global: number;
  samples: { x: number; z: number; q: number }[];
};

export type TreeFit = {
  model: TreeModel | null;
  reason: string;
  n: number;
  groups: number;
  correlation: number;
  before: { typical: number; bias: number };
  after: { typical: number; bias: number } | null;
};

const VARIATION = 0.35;
const LOCAL_RADIUS = 300;
const MIN_PAIRS = 25;
const MIN_GROUPS = 6;
const MIN_GAIN = 0.1;

const damped = (h: number, unit: number) => Math.max(0.3, 1 + VARIATION * (h / unit - 1));

function fitOn(pairs: TreePair[], radius: number, unit: number): TreeModel {
  const samples = pairs.map((pair) => ({ x: pair.x, z: pair.z, q: pair.rh98 / Math.max(...pair.crowns.map((h) => damped(h, unit))) }));
  return { kind: Number.isFinite(radius) ? "locale" : "sito", radius, unit, global: median(samples.map((row) => row.q)), samples };
}

function localFactor(model: TreeModel, x: number, z: number) {
  if (model.kind === "sito") return model.global;
  const near: number[] = [];
  for (const row of model.samples) if (Math.hypot(row.x - x, row.z - z) < model.radius) near.push(row.q);
  return near.length >= 3 ? median(near) : model.global;
}

export function correctedHeight(model: TreeModel, x: number, z: number, h: number) {
  return localFactor(model, x, z) * damped(h, model.unit);
}

function pearson(x: number[], y: number[]) {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sum += (x[i]! - mx) * (y[i]! - my);
    sx += (x[i]! - mx) ** 2;
    sy += (y[i]! - my) ** 2;
  }
  return sx && sy ? sum / Math.sqrt(sx * sy) : 0;
}

/** Neighbouring shots on one orbit are nearly the same measurement: only leaving out a whole orbit and beam is a fair test. */
export function fitTrees(input: TreePair[]): TreeFit {
  const pairs = input.filter((pair) => pair.crowns.length && pair.rh98 > 0);
  const groups = [...new Set(pairs.map((pair) => pair.group))];
  const baseline = pairs.map((pair) => Math.max(...pair.crowns) - pair.rh98);
  const before = { typical: median(baseline.map(Math.abs)), bias: median(baseline) };
  const correlation = pearson(pairs.map((pair) => Math.max(...pair.crowns)), pairs.map((pair) => pair.rh98));
  const report = { n: pairs.length, groups: groups.length, correlation, before };
  if (pairs.length < MIN_PAIRS || groups.length < MIN_GROUPS) {
    return { ...report, model: null, after: null, reason: `Troppo poche misure per giudicare una correzione: ${pairs.length} impronte su ${groups.length} passaggi, ne servono almeno ${MIN_PAIRS} su ${MIN_GROUPS}.` };
  }
  const unit = median(pairs.flatMap((pair) => pair.crowns));
  let best: { radius: number; typical: number; bias: number } | null = null;
  for (const radius of [Infinity, LOCAL_RADIUS]) {
    const errors: number[] = [];
    for (const group of groups) {
      const model = fitOn(pairs.filter((pair) => pair.group !== group), radius, unit);
      for (const pair of pairs.filter((row) => row.group === group)) errors.push(Math.max(...pair.crowns.map((h) => correctedHeight(model, pair.x, pair.z, h))) - pair.rh98);
    }
    const typical = median(errors.map(Math.abs));
    if (!best || typical < best.typical) best = { radius, typical, bias: median(errors) };
  }
  const after = { typical: best!.typical, bias: best!.bias };
  if (after.typical > before.typical * (1 - MIN_GAIN)) {
    return { ...report, model: null, after, reason: `Sulle orbite escluse la correzione non migliora abbastanza: l'errore tipico passerebbe da ${before.typical.toFixed(1)} a ${after.typical.toFixed(1)} m. Gli alberi restano come letti dalla lastra.` };
  }
  return { ...report, model: fitOn(pairs, best!.radius, unit), after, reason: "" };
}
