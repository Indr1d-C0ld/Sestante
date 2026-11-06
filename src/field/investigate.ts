import { api, imageCanvas } from "../core/api.ts";
import { pointInRing } from "../core/geo.ts";
import type { Expedition, Investigation, PlateRef, PlateVersion, SourceUse } from "../core/types.ts";
import { blobsAbove, rankPlaces, robustSpread, type Clue } from "../vision/anomalies.ts";
import { demDifference, type LaserAssessment } from "../vision/laser.ts";
import { detectChanges } from "../vision/filters.ts";
import { fillGaps, localRelief } from "../vision/lidar.ts";
import type { Engine } from "../world/engine.ts";
import { readPlate, type Building } from "./load.ts";
import { plateDate, vegetationAnomaly } from "./research.ts";

export type InvestigateArgs = { engine: Engine; expedition: Expedition; versions: PlateVersion[]; plateCache: Map<string, HTMLCanvasElement>; laser: LaserAssessment | null; onStep: (text: string) => void };

const centre = (b: Building) => {
  const r = b.rings[0]!;
  let x = 0;
  let z = 0;
  for (let i = 0; i < r.length; i += 2) {
    x += r[i]!;
    z += r[i + 1]!;
  }
  return { x: x / (r.length / 2), z: z / (r.length / 2) };
};

const nearLine = (x: number, z: number, line: number[], limit: number) => {
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i]!;
    const az = line[i + 1]!;
    const dx = line[i + 2]! - ax;
    const dz = line[i + 3]! - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) < limit) return true;
  }
  return false;
};

/** Shots of the place from two dates, in lighting-independent terms. Shadow on the current plate spoils the reading, so those patches go. */
async function changeClues({ engine, versions, plateCache, onStep }: InvestigateArgs): Promise<{ clues: Clue[]; use: SourceUse }> {
  const name = "Scatti a confronto";
  const dated = [...versions].sort((a, b) => (a.capture?.date ?? a.published).localeCompare(b.capture?.date ?? b.published));
  if (dated.length < 2) return { clues: [], use: { name, state: "saltata", detail: "Questa fonte ha un solo scatto." } };
  const load = async (row: PlateVersion) => {
    const key = `wb-${row.release}`;
    const known = plateCache.get(key);
    if (known) return known;
    const ref: PlateRef = { kind: "wayback", release: row.release, published: row.published, capture: row.capture };
    const canvas = await readPlate(ref, engine.data.spec, onStep);
    plateCache.set(key, canvas);
    return canvas;
  };
  const oldest = dated[0]!;
  const newest = dated[dated.length - 1]!;
  const before = await load(oldest);
  const after = await load(newest);
  const p = engine.data.projection;
  const mpp = (p.halfX * 2) / after.width;
  const { clusters } = detectChanges(after, before, mpp);
  const { analysis } = engine.plate;
  const clues: Clue[] = [];
  let shaded = 0;
  for (const row of clusters) {
    const cx = row.x + row.w / 2;
    const cy = row.y + row.h / 2;
    const k = Math.min(analysis.height - 1, Math.floor(cy * analysis.height)) * analysis.width + Math.min(analysis.width - 1, Math.floor(cx * analysis.width));
    if (analysis.gainMap[k * 4 + 3]! > 128 || /scurita|tono/.test(row.kind)) {
      shaded++;
      continue;
    }
    const base = /schiarita/.test(row.kind) ? 0.6 : 0.45;
    clues.push({ kind: "cambiamento", x: cx * 2 * p.halfX - p.halfX, z: cy * 2 * p.halfZ - p.halfZ, radius: Math.hypot(row.w * p.halfX, row.h * p.halfZ), strength: Math.min(1, base + row.area / 4000), text: `${row.kind}, ${row.area.toFixed(0)} m², fra ${oldest.capture?.date ?? oldest.published} e ${newest.capture?.date ?? newest.published}.` });
  }
  return { clues: clues.slice(0, 20), use: { name, state: "usata", detail: `Zone cambiate: ${clues.length}. Scartate perché in ombra o solo di tono: ${shaded}.` } };
}

function presenceClues({ engine, expedition }: InvestigateArgs): { clues: Clue[]; use: SourceUse } {
  const name = "Edifici nel tempo";
  const presence = expedition.strata?.presence;
  if (!presence) return { clues: [], use: { name, state: "saltata", detail: "Leggi prima tutte le riprese, nella scheda Riprese." } };
  const clues: Clue[] = [];
  for (const b of engine.data.buildings) {
    const row = presence[b.id];
    if (!row?.lastAbsent || row.confidence < 0.4 || b.hidden) continue;
    const c = centre(b);
    clues.push({ kind: "presenza", x: c.x, z: c.z, radius: Math.sqrt(b.area / Math.PI), strength: Math.min(1, row.confidence), text: `${b.tags.name ?? "Un edificio mappato"} non si vede ancora il ${row.lastAbsent}${row.firstSeen ? `, c'è il ${row.firstSeen}` : ""}.` });
  }
  clues.sort((a, b) => b.strength - a.strength);
  return { clues: clues.slice(0, 15), use: { name, state: "usata", detail: `Edifici comparsi nel periodo: ${clues.length}.` } };
}

function shadowClues({ engine }: InvestigateArgs): { clues: Clue[]; use: SourceUse } {
  const clues: Clue[] = [];
  for (const mass of engine.plate.masses) {
    if (mass.hidden) continue;
    const c = centre(mass);
    clues.push({ kind: "ombra", x: c.x, z: c.z, radius: Math.max(6, Math.sqrt(mass.area / Math.PI)), strength: Math.min(1, 0.35 + mass.confidence * 0.65), text: `Un corpo alto circa ${mass.height.toFixed(0)} m con la sua ombra, che la mappa non riporta.` });
  }
  return { clues, use: { name: "Ombre sulla lastra", state: "usata", detail: `Corpi senza edificio mappato: ${clues.length}.` } };
}

function laserClues({ laser }: InvestigateArgs): { clues: Clue[]; use: SourceUse } {
  const name = "Laser GEDI";
  if (!laser) return { clues: [], use: { name, state: "saltata", detail: "Chiedi prima le impronte, nella scheda Laser." } };
  const clues: Clue[] = [];
  for (const row of laser.readings) {
    if (!row.shot.good) continue;
    if (row.kind === "edificio" && row.error != null && Math.abs(row.error) > 8) {
      const b = row.building as (typeof row.building & { tags?: Record<string, string> }) | null;
      clues.push({ kind: "laser", x: row.shot.x, z: row.shot.z, radius: 12.5, strength: Math.min(1, Math.abs(row.error) / 30), text: `La mappa dice ${row.model!.toFixed(0)} m, il laser ${row.measured.toFixed(0)} m (${row.shot.date})${b?.tags?.name ? `, ${b.tags.name}` : ""}.` });
    } else if (row.kind === "aperto" && row.shot.rh98 > 8) {
      clues.push({ kind: "laser", x: row.shot.x, z: row.shot.z, radius: 12.5, strength: Math.min(1, row.shot.rh98 / 30), text: `Il laser trova qualcosa alto ${row.shot.rh98.toFixed(0)} m dove mappa e lastra non hanno nulla (${row.shot.date}).` });
    }
  }
  clues.sort((a, b) => b.strength - a.strength);
  return { clues: clues.slice(0, 15), use: { name, state: "usata", detail: `Impronte in disaccordo: ${clues.length} su ${laser.counts.good}.` } };
}

/** Steep ground is left out: there the two radars differ even when nothing changed, as Cheops shows. */
async function reliefClues({ engine, onStep }: InvestigateArgs): Promise<{ clues: Clue[]; use: SourceUse }> {
  const name = "Rilievo 2000 contro circa 2013";
  onStep("Confronto i due modelli del rilievo…");
  const p = engine.data.projection;
  const cols = Math.max(16, Math.min(256, Math.round((p.halfX * 2) / 30)));
  const rows = Math.max(16, Math.min(256, Math.round((p.halfZ * 2) / 30)));
  const box = engine.data.spec.bbox;
  try {
    const [older, newer] = await Promise.all([api.demGrid(box, cols, rows, "nasadem"), api.demGrid(box, cols, rows, "copernicus")]);
    const { difference } = demDifference(older, newer);
    const cellX = (p.halfX * 2) / cols;
    const cellZ = (p.halfZ * 2) / rows;
    const up = new Float32Array(cols * rows);
    const down = new Float32Array(cols * rows);
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const k = j * cols + i;
        const slope = Math.hypot((newer[k + 1]! - newer[k - 1]!) / (2 * cellX), (newer[k + cols]! - newer[k - cols]!) / (2 * cellZ));
        const d = difference[k]!;
        if (!Number.isFinite(d) || slope > 0.36) continue;
        up[k] = d;
        down[k] = -d;
      }
    }
    const clues: Clue[] = [];
    let urban = 0;
    for (const [values, word] of [[up, "più alto"], [down, "più basso"]] as const) {
      for (const blob of blobsAbove(values, cols, rows, 8, 3).slice(0, 16)) {
        const x = (blob.x + 0.5) * cellX - p.halfX;
        const z = (blob.y + 0.5) * cellZ - p.halfZ;
        const radius = Math.sqrt((blob.cells * cellX * cellZ) / Math.PI);
        // Between buildings a radar sees walls and shadows, and two of them disagree by many metres without anything having moved.
        let built = 0;
        for (let k = 0; k < 9; k++) if (engine.query.buildingAt(x + Math.cos(k * 0.7) * radius * (k / 9), z + Math.sin(k * 0.7) * radius * (k / 9))) built++;
        if (built >= 2) {
          urban++;
          continue;
        }
        clues.push({ kind: "rilievo", x, z, radius, strength: Math.min(1, blob.peak / 25), text: `Circa ${blob.peak.toFixed(0)} m ${word} nel modello recente, su ${((blob.cells * cellX * cellZ) / 10000).toFixed(1)} ha. Può essere un cambiamento vero o la diversa risposta dei due radar.` });
      }
    }
    return { clues, use: { name, state: "usata", detail: `Zone oltre 8 m: ${clues.length}, esclusi i pendii ripidi. Scartate fra gli edifici, dove i due radar non sono confrontabili: ${urban}.` } };
  } catch (e) {
    return { clues: [], use: { name, state: "saltata", detail: (e as Error).message } };
  }
}

async function vegetationClues({ engine, onStep }: InvestigateArgs): Promise<{ clues: Clue[]; use: SourceUse }> {
  const name = "Vegetazione da Sentinel-2";
  onStep("Chiedo a Sentinel-2 la vegetazione dell'ultima estate…");
  const p = engine.data.projection;
  const year = new Date().getUTCFullYear() - 1;
  const side = Math.min(768, Math.max(128, Math.round((p.halfX * 2) / 10)));
  const high = Math.max(64, Math.round((side * p.halfZ) / p.halfX));
  try {
    const raw = await imageCanvas(api.earthImageUrl(engine.data.spec.bbox, "anomalia", `${year}-06-15`, `${year}-09-15`, side, high));
    let field: { diff: Float32Array; sigma: number; width: number; height: number } | null = null;
    vegetationAnomaly(raw, (p.halfX * 2) / raw.width, (row) => (field = row));
    if (!field) throw new Error("nessun dato");
    const { diff, sigma, width, height } = field as { diff: Float32Array; sigma: number; width: number; height: number };
    const cellX = (p.halfX * 2) / width;
    const cellZ = (p.halfZ * 2) / height;
    const minCells = Math.max(4, Math.round(1200 / (cellX * cellZ)));
    const clues: Clue[] = [];
    for (const [sign, word] of [[1, "più verde"], [-1, "meno verde"]] as const) {
      const values = new Float32Array(diff.length);
      for (let k = 0; k < diff.length; k++) values[k] = (diff[k]! * sign) / sigma;
      for (const blob of blobsAbove(values, width, height, 2.5, minCells).slice(0, 6)) {
        const area = blob.cells * cellX * cellZ;
        clues.push({ kind: "vegetazione", x: (blob.x + 0.5) * cellX - p.halfX, z: (blob.y + 0.5) * cellZ - p.halfZ, radius: Math.sqrt(area / Math.PI), strength: Math.min(1, blob.peak / 6), text: `Una macchia di ${(area / 10000).toFixed(2)} ha ${word} dei dintorni nell'estate ${year}. Può rivelare suolo o strutture sepolte, o solo un'altra coltura.` });
      }
    }
    return { clues, use: { name, state: "usata", detail: `Macchie oltre 2,5 volte il rumore: ${clues.length}.` } };
  } catch (e) {
    return { clues: [], use: { name, state: "saltata", detail: (e as Error).message } };
  }
}

/** Banks and hollows too low for any photo, where a national survey exists. Modern buildings and roads make their own, so those go. */
async function lidarClues({ engine, onStep }: InvestigateArgs): Promise<{ clues: Clue[]; use: SourceUse }> {
  const name = "LiDAR nazionale";
  const box = engine.data.spec.bbox;
  try {
    const coverage = (await api.lidarCoverage(box)).filter((row) => row.share > 0.5);
    if (!coverage.length) return { clues: [], use: { name, state: "saltata", detail: "Nessun rilievo aperto copre questo riquadro." } };
    const best = coverage[0]!;
    onStep(`Scarico ${best.name}…`);
    const p = engine.data.projection;
    const cols = Math.min(1600, Math.round((p.halfX * 2) / Math.max(1, best.resolution)));
    const rows = Math.min(1600, Math.round((p.halfZ * 2) / Math.max(1, best.resolution)));
    const raw = await api.lidarGrid(best.id, "dtm", box, cols, rows);
    const cellX = (p.halfX * 2) / cols;
    const cellZ = (p.halfZ * 2) / rows;
    const ground = fillGaps(raw, cols, rows).heights;
    const relief = localRelief({ heights: ground, cols, rows, cellX, cellZ }, 15);
    // The edge of a plateau or a hill's shoulder also stands out from its surroundings, on a scale no earthwork has.
    const slopeAt = (i: number, j: number) => {
      const reach = Math.max(1, Math.round(15 / cellX));
      const a = Math.max(0, i - reach);
      const b = Math.min(cols - 1, i + reach);
      const c = Math.max(0, j - reach);
      const d = Math.min(rows - 1, j + reach);
      return Math.hypot((ground[j * cols + b]! - ground[j * cols + a]!) / ((b - a) * cellX), (ground[d * cols + i]! - ground[c * cols + i]!) / ((d - c) * cellZ));
    };
    const { spread } = robustSpread(relief, 7);
    const threshold = Math.max(0.35, spread * 4);
    const up = new Float32Array(relief.length);
    const down = new Float32Array(relief.length);
    for (let k = 0; k < relief.length; k++) {
      if (!Number.isFinite(raw[k]!)) continue;
      up[k] = relief[k]!;
      down[k] = -relief[k]!;
    }
    const roads = engine.data.highways.map((row) => row.pts);
    const minCells = Math.max(6, Math.round(30 / (cellX * cellZ)));
    const clues: Clue[] = [];
    let modern = 0;
    let natural = 0;
    for (const [values, word] of [[up, "Rialzo"], [down, "Avvallamento"]] as const) {
      for (const blob of blobsAbove(values, cols, rows, threshold, minCells).slice(0, 60)) {
        const x = (blob.x + 0.5) * cellX - p.halfX;
        const z = (blob.y + 0.5) * cellZ - p.halfZ;
        const onBuilding = [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]].some(([dx, dz]) => engine.query.buildingAt(x + dx!, z + dz!));
        if (onBuilding || roads.some((line) => nearLine(x, z, line, 10))) {
          modern++;
          continue;
        }
        const area = blob.cells * cellX * cellZ;
        if (area > 15000 || slopeAt(Math.round(blob.x), Math.round(blob.y)) > 0.3) {
          natural++;
          continue;
        }
        clues.push({ kind: "lidar", x, z, radius: Math.sqrt(area / Math.PI), strength: Math.min(1, blob.peak / 2.5), text: `${word} di ${blob.peak.toFixed(1)} m su ${area.toFixed(0)} m², lontano da edifici e strade mappati (${best.name}).` });
      }
    }
    clues.sort((a, b) => b.strength - a.strength);
    return { clues: clues.slice(0, 15), use: { name, state: "usata", detail: `${best.name}. Tracce: ${clues.length}. Scartate perché su edifici o strade: ${modern}. Scartate perché forme naturali del terreno, grandi o su forti pendii: ${natural}.` } };
  } catch (e) {
    return { clues: [], use: { name, state: "saltata", detail: (e as Error).message } };
  }
}

/** What the map already says of a spot: the ordinary answer comes first, and an investigation should see it. */
function mapExplanation(engine: Engine, x: number, z: number) {
  for (const area of engine.data.landcover) {
    const tag = area.tags.landuse ?? area.tags.natural ?? area.tags.leisure;
    if (!tag || !["construction", "quarry", "landfill", "brownfield", "greenfield", "railway"].includes(tag)) continue;
    if (area.rings[0] && pointInRing(x, z, area.rings[0])) {
      const words: Record<string, string> = { construction: "un cantiere", quarry: "una cava", landfill: "una discarica", brownfield: "un'area dismessa", greenfield: "un'area da edificare", railway: "una ferrovia" };
      return `La mappa qui segna ${words[tag]}.`;
    }
  }
  const b = engine.query.buildingAt(x, z);
  if (b?.tags.name) return `La mappa qui segna ${b.tags.name}.`;
  return null;
}

export async function investigate(args: InvestigateArgs): Promise<Investigation> {
  const clues: Clue[] = [];
  const sources: SourceUse[] = [];
  const add = (row: { clues: Clue[]; use: SourceUse }) => {
    clues.push(...row.clues);
    sources.push(row.use);
  };
  args.onStep("Confronto gli scatti…");
  add(await changeClues(args).catch((e: Error) => ({ clues: [], use: { name: "Scatti a confronto", state: "saltata" as const, detail: e.message } })));
  add(presenceClues(args));
  add(shadowClues(args));
  add(laserClues(args));
  add(await reliefClues(args));
  add(await vegetationClues(args));
  add(await lidarClues(args));
  const p = args.engine.data.projection;
  const inside = clues.filter((row) => Math.abs(row.x) <= p.halfX && Math.abs(row.z) <= p.halfZ);
  const before = new Map((args.expedition.investigation?.candidates ?? []).map((row) => [row.id, row.status]));
  const candidates = rankPlaces(inside).map((row) => ({ ...row, explained: mapExplanation(args.engine, row.x, row.z), status: before.get(row.id) ?? row.status }));
  return { at: new Date().toISOString(), plate: plateDate(args.engine.plate.ref), candidates, sources };
}
