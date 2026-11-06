import type { FootprintEvidence, HeightReading, SunReading } from "./analyze.ts";

/**
 * Reads the same place through many dated shots. Each sun is different, so each shot is an independent measurement:
 * together they give a height with an error bar, and tell when a building first appears. Pure code.
 */
export type StratumRead = {
  key: string;
  date: string;
  resolution: number | null;
  sun: Pick<SunReading, "sunAzimuth" | "altitude" | "confidence" | "method">;
  heights: Record<string, HeightReading>;
  evidence: Record<string, FootprintEvidence>;
};

export type HeightSeries = { h: number; low: number; high: number; n: number; samples: { date: string; h: number; c: number }[] };

export type Presence = { firstSeen: string | null; lastAbsent: string | null; confidence: number; absent: string[]; checked: number };

function weightedQuantile(rows: { v: number; w: number }[], q: number) {
  const sorted = [...rows].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((sum, row) => sum + row.w, 0);
  let acc = 0;
  for (const row of sorted) {
    acc += row.w;
    if (acc >= total * q) return row.v;
  }
  return sorted[sorted.length - 1]?.v ?? 0;
}

/** Weighted median with outliers set aside: one shadow falling on a hedge must not move a building by a floor. */
export function combineHeights(reads: StratumRead[], minConfidence = 0.1) {
  const byId = new Map<string, { date: string; h: number; c: number }[]>();
  for (const read of reads) {
    if (read.sun.method === "stima" || read.sun.altitude < 0.12) continue;
    for (const [id, row] of Object.entries(read.heights)) {
      if (row.h == null || row.confidence < minConfidence) continue;
      const list = byId.get(id) ?? [];
      list.push({ date: read.date, h: row.h, c: row.confidence });
      byId.set(id, list);
    }
  }
  const out: Record<string, HeightSeries> = {};
  for (const [id, samples] of byId) {
    const first = weightedQuantile(samples.map((row) => ({ v: row.h, w: row.c })), 0.5);
    const deviations = samples.map((row) => Math.abs(row.h - first)).sort((a, b) => a - b);
    const mad = deviations[deviations.length >> 1] ?? 0;
    const limit = Math.max(1.5, mad * 3.2);
    const kept = samples.filter((row) => Math.abs(row.h - first) <= limit);
    const weights = kept.map((row) => ({ v: row.h, w: row.c }));
    const h = weightedQuantile(weights, 0.5);
    const low = weightedQuantile(weights, 0.16);
    const high = weightedQuantile(weights, 0.84);
    out[id] = { h, low, high, n: kept.length, samples: samples.sort((a, b) => b.date.localeCompare(a.date)) };
  }
  return out;
}

const COARSEST = 1.3;

/**
 * Newest first. A building counts as missing only when several things agree: its outline has faded, greenery or plain
 * ground fills it, and the shot is sharp enough to tell. A faint roof in one blurry frame proves nothing.
 */
export function buildingPresence(reads: StratumRead[]) {
  const sharp = reads.filter((read) => read.date && (read.resolution == null || read.resolution <= COARSEST)).sort((a, b) => b.date.localeCompare(a.date));
  const out: Record<string, Presence> = {};
  if (sharp.length < 2) return out;
  const ids = new Set(sharp.flatMap((read) => Object.keys(read.evidence)));
  for (const id of ids) {
    const edges = sharp.slice(0, 3).map((read) => read.evidence[id]?.edge).filter((v): v is number => v != null).sort((a, b) => a - b);
    const reference = edges[edges.length >> 1] ?? 0;
    if (reference < 0.035) continue;
    const absent: { date: string; strength: number }[] = [];
    let firstSeen: string | null = null;
    let streakBroken = false;
    let checked = 0;
    for (const read of sharp) {
      const row = read.evidence[id];
      if (!row) continue;
      checked++;
      const ratio = row.edge / reference;
      const gone = ratio < 0.42 && (row.veg > 0.45 || row.edge < 0.03);
      if (gone && !streakBroken) {
        streakBroken = true;
        absent.push({ date: read.date, strength: 1 - ratio });
      } else if (gone) absent.push({ date: read.date, strength: 1 - ratio });
      else if (!streakBroken) firstSeen = read.date;
      else {
        // Seen again further back in time: this is a bad frame or cloud, not a construction date.
        absent.length = 0;
        streakBroken = false;
        firstSeen = read.date;
      }
    }
    const conclusive = absent.length >= 2 || (absent.length === 1 && absent[0]!.strength > 0.72);
    out[id] = conclusive
      ? { firstSeen, lastAbsent: absent[0]!.date, confidence: Math.min(1, absent.reduce((sum, row) => sum + row.strength, 0) / absent.length) * Math.min(1, absent.length / 2), absent: absent.map((row) => row.date), checked }
      : { firstSeen, lastAbsent: null, confidence: 0, absent: [], checked };
  }
  return out;
}

export const absentOn = (presence: Presence | undefined, date: string | null | undefined) => !!presence?.lastAbsent && !!date && date <= presence.lastAbsent;
