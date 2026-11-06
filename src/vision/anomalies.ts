/**
 * "What is odd here?": independent clues gathered into places worth a visit. A rank says where to look first and proves
 * nothing. Two clues from unrelated instruments agreeing on a spot outweigh one strong clue. Pure code.
 */
export type ClueKind = "cambiamento" | "vegetazione" | "ombra" | "laser" | "rilievo" | "lidar" | "presenza";

export const CLUE_NAMES: Record<ClueKind, string> = {
  cambiamento: "Cambia fra gli scatti",
  vegetazione: "Vegetazione anomala",
  ombra: "Ombra senza edificio",
  laser: "Mappa e laser in disaccordo",
  rilievo: "Rilievo cambiato",
  lidar: "Traccia nel LiDAR",
  presenza: "Costruzione comparsa o sparita",
};

/** How much one clue weighs alone, from how often a clue of that kind turns out to be a mere artefact. */
const WEIGHT: Record<ClueKind, number> = { cambiamento: 0.7, vegetazione: 0.8, ombra: 0.9, laser: 1, rilievo: 0.6, lidar: 1.2, presenza: 0.7 };

export type Clue = { kind: ClueKind; x: number; z: number; radius: number; strength: number; text: string };

export type Blob = { x: number; y: number; cells: number; peak: number; mean: number };

/** Connected patches above a threshold, 4-connected, on a raster of absolute or signed values. */
export function blobsAbove(values: ArrayLike<number>, width: number, height: number, threshold: number, minCells = 4): Blob[] {
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const out: Blob[] = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !(values[start]! >= threshold)) continue;
    seen[start] = 1;
    stack.push(start);
    let cells = 0;
    let sx = 0;
    let sy = 0;
    let peak = 0;
    let sum = 0;
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % width;
      const y = (k - x) / width;
      cells++;
      sx += x;
      sy += y;
      sum += values[k]!;
      peak = Math.max(peak, values[k]!);
      for (const n of [x > 0 ? k - 1 : -1, x < width - 1 ? k + 1 : -1, y > 0 ? k - width : -1, y < height - 1 ? k + width : -1]) {
        if (n >= 0 && !seen[n] && values[n]! >= threshold) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (cells >= minCells) out.push({ x: sx / cells, y: sy / cells, cells, peak, mean: sum / cells });
  }
  return out.sort((a, b) => b.cells * b.mean - a.cells * a.mean);
}

/** Median and robust spread of a raster sample, so thresholds follow each image rather than a fixed number. */
export function robustSpread(values: ArrayLike<number>, stride = 1) {
  const sample: number[] = [];
  for (let k = 0; k < values.length; k += stride) if (Number.isFinite(values[k]!)) sample.push(values[k]!);
  if (!sample.length) return { median: 0, spread: 0 };
  sample.sort((a, b) => a - b);
  const median = sample[sample.length >> 1]!;
  const dev = sample.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return { median, spread: dev[dev.length >> 1]! * 1.4826 };
}

export type Candidate = { id: string; x: number; z: number; radius: number; score: number; clues: Clue[]; kinds: ClueKind[]; explained: string | null; status: "da vedere" | "visto" | "spiegato" | "interessante" };

/**
 * Clues closer than the sum of their radii, plus a tolerance for plate and model misalignment, join into a place.
 * A place scores its best clue of each kind, then gets a bonus for each further kind that agrees.
 */
export function rankPlaces(clues: Clue[], tolerance = 15, limit = 25): Candidate[] {
  const parent = clues.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < clues.length; i++) {
    for (let j = i + 1; j < clues.length; j++) {
      const a = clues[i]!;
      const b = clues[j]!;
      if (Math.hypot(a.x - b.x, a.z - b.z) <= Math.min(a.radius + b.radius, 80) + tolerance) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Clue[]>();
  clues.forEach((clue, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), clue]));
  const out: Candidate[] = [];
  for (const group of groups.values()) {
    const best = new Map<ClueKind, number>();
    let wx = 0;
    let wz = 0;
    let w = 0;
    for (const clue of group) {
      best.set(clue.kind, Math.max(best.get(clue.kind) ?? 0, clue.strength * WEIGHT[clue.kind]));
      wx += clue.x * clue.strength;
      wz += clue.z * clue.strength;
      w += clue.strength;
    }
    const x = wx / (w || 1);
    const z = wz / (w || 1);
    const radius = Math.max(...group.map((clue) => Math.hypot(clue.x - x, clue.z - z) + clue.radius));
    const scores = [...best.values()].sort((a, b) => b - a);
    const score = scores.reduce((sum, v) => sum + v, 0) + (scores.length - 1) * 0.5;
    out.push({ id: `c${Math.round(x)}_${Math.round(z)}`, x, z, radius, score, clues: group.sort((a, b) => b.strength - a.strength), kinds: [...best.keys()], explained: null, status: "da vedere" });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
