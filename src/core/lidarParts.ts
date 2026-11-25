/**
 * A footprint split into the parts an airborne survey sees at different heights: wings, low annexes, courtyards. A map
 * outline holding a six-storey front and a one-storey back shop is one building to the map and two to the laser. Pure code.
 *
 * Neighbouring cells belong to the same part when the surface changes little between them, as it does along a roof's
 * slope, and to different parts where it jumps, as it does at a wall. Ground-level parts are courtyards and stay empty.
 */

/** Parts the laser survey split out of a building carry its id followed by this; colour and presence follow the building. */
export const SURVEY_PART = ":rilievo";
export const familyId = (id: string) => id.split(SURVEY_PART)[0]!;

export type PartGrid = {
  /** Heights above the ground, NaN where the survey has nothing. */
  heights: Float32Array;
  /** 1 where the cell's centre is inside the footprint. */
  inside: Uint8Array;
  cols: number;
  rows: number;
  /** World position of the first cell's corner (not centre), and the cell size. */
  x0: number;
  z0: number;
  cell: number;
};

export type SurveyedPart = { rings: number[][]; height: number; median: number; cells: number };

/** Steps between neighbouring cells larger than this are walls; smaller ones are roof slopes. */
const STEP = 1.6;
/** Parts lower than this are courtyards, yards or passages: left open. */
const OPEN = 2.5;

/**
 * Connected parts of the footprint by height continuity. Parts smaller than `minCells` join the neighbour they share most
 * edge with: one tall cell of a chimney or a lamp is not a wing.
 */
export function segmentParts(grid: PartGrid, minCells = 12) {
  const { heights, inside, cols, rows } = grid;
  const label = new Int32Array(cols * rows).fill(-1);
  const sizes: number[] = [];
  let count = 0;
  for (let start = 0; start < cols * rows; start++) {
    if (!inside[start] || label[start]! >= 0 || !Number.isFinite(heights[start]!)) continue;
    const stack = [start];
    label[start] = count;
    let size = 0;
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const i = k % cols;
      const j = (k - i) / cols;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const n = nj * cols + ni;
        if (!inside[n] || label[n]! >= 0 || !Number.isFinite(heights[n]!)) continue;
        if (Math.abs(heights[n]! - heights[k]!) > STEP) continue;
        label[n] = count;
        stack.push(n);
      }
    }
    sizes.push(size);
    count++;
  }
  // Small parts join their most connected neighbour, smallest first, until none is left.
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let p = 0; p < count; p++) {
      if (sizes[p]! === 0 || sizes[p]! >= minCells) continue;
      const touch = new Map<number, number>();
      for (let k = 0; k < cols * rows; k++) {
        if (label[k] !== p) continue;
        const i = k % cols;
        for (const n of [k + 1, k - 1, k + cols, k - cols]) {
          if (n < 0 || n >= cols * rows || (n === k + 1 && i === cols - 1) || (n === k - 1 && i === 0)) continue;
          const q = label[n]!;
          if (q >= 0 && q !== p) touch.set(q, (touch.get(q) ?? 0) + 1);
        }
      }
      let best = -1;
      let most = 0;
      for (const [q, c] of touch) if (c > most) [best, most] = [q, c];
      if (best < 0) continue;
      for (let k = 0; k < cols * rows; k++) if (label[k] === p) label[k] = best;
      sizes[best]! += sizes[p]!;
      sizes[p] = 0;
      moved = true;
    }
    if (!moved) break;
  }
  return { label, count };
}

/**
 * Outlines of the cells where `mask` is set, as closed rings in world coordinates: outer rings counter-clockwise (in
 * x,z with z south), holes the other way. Built from the cell edges between inside and outside, chained into loops.
 */
export function traceRings(mask: Uint8Array, cols: number, rows: number, x0: number, z0: number, cell: number) {
  // Directed edges with the inside on the left, as corner index pairs on a (cols+1) x (rows+1) lattice.
  const W = cols + 1;
  const next = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    const list = next.get(a);
    if (list) list.push(b);
    else next.set(a, [b]);
  };
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < cols && j < rows && mask[j * cols + i] === 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!on(i, j)) continue;
      const tl = j * W + i;
      const tr = tl + 1;
      const bl = tl + W;
      const br = bl + 1;
      if (!on(i, j - 1)) add(tr, tl);
      if (!on(i, j + 1)) add(bl, br);
      if (!on(i - 1, j)) add(tl, bl);
      if (!on(i + 1, j)) add(br, tr);
    }
  }
  const rings: number[][] = [];
  while (next.size) {
    const [start] = next.keys();
    const loop: number[] = [start!];
    let at = start!;
    for (let guard = 0; guard < 1e6; guard++) {
      const list = next.get(at);
      if (!list?.length) break;
      const to = list.pop()!;
      if (!list.length) next.delete(at);
      if (to === start) break;
      loop.push(to);
      at = to;
    }
    if (loop.length < 4) continue;
    const ring: number[] = [];
    for (const c of loop) ring.push(x0 + (c % W) * cell, z0 + Math.floor(c / W) * cell);
    rings.push(ring);
  }
  return rings;
}

/** Douglas-Peucker on a closed ring, keeping its two farthest-apart points fixed. */
export function simplifyRing(ring: number[], tolerance: number) {
  const n = ring.length / 2;
  if (n <= 4) return ring;
  const a = 0;
  let b = 0;
  let far = -1;
  for (let i = 0; i < n; i++) {
    const d = (ring[i * 2]! - ring[0]!) ** 2 + (ring[i * 2 + 1]! - ring[1]!) ** 2;
    if (d > far) [far, b] = [d, i];
  }
  const keep = new Uint8Array(n);
  keep[a] = keep[b] = 1;
  const run = (from: number, to: number) => {
    const span = (to - from + n) % n;
    if (span < 2) return;
    const ax = ring[from * 2]!;
    const az = ring[from * 2 + 1]!;
    const bx = ring[to * 2]!;
    const bz = ring[to * 2 + 1]!;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    let worst = -1;
    let at = -1;
    for (let s = 1; s < span; s++) {
      const k = (from + s) % n;
      const d = Math.abs((bx - ax) * (az - ring[k * 2 + 1]!) - (ax - ring[k * 2]!) * (bz - az)) / len;
      if (d > worst) [worst, at] = [d, k];
    }
    if (worst > tolerance) {
      keep[at] = 1;
      run(from, at);
      run(at, to);
    }
  };
  run(a, b);
  run(b, a);
  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) kept.push(ring[i * 2]!, ring[i * 2 + 1]!);
  // The fixed starting point may sit in the middle of a straight side: drop points that make no turn.
  const m = kept.length / 2;
  const out: number[] = [];
  for (let i = 0; i < m; i++) {
    const p = (i + m - 1) % m;
    const q = (i + 1) % m;
    const cross = (kept[i * 2]! - kept[p * 2]!) * (kept[q * 2 + 1]! - kept[i * 2 + 1]!) - (kept[i * 2 + 1]! - kept[p * 2 + 1]!) * (kept[q * 2]! - kept[i * 2]!);
    if (Math.abs(cross) > 1e-9) out.push(kept[i * 2]!, kept[i * 2 + 1]!);
  }
  return out.length >= 6 ? out : ring;
}

const signedArea = (ring: number[]) => {
  let s = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) s += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!;
  return s / 2;
};

/**
 * The parts of one footprint: each with its outline (outer ring first, then holes), its 95th-percentile height and its
 * median, ready to stand as a building of its own. Courtyards and anything lower than 2.5 m are left out.
 */
export function surveyedParts(grid: PartGrid, tolerance = 0.8, minArea = 12): SurveyedPart[] {
  const { label, count } = segmentParts(grid);
  const out: SurveyedPart[] = [];
  for (let p = 0; p < count; p++) {
    const values: number[] = [];
    const mask = new Uint8Array(grid.cols * grid.rows);
    for (let k = 0; k < mask.length; k++) {
      if (label[k] !== p) continue;
      mask[k] = 1;
      values.push(grid.heights[k]!);
    }
    if (!values.length) continue;
    values.sort((a, b) => a - b);
    const median = values[values.length >> 1]!;
    if (median < OPEN || values.length * grid.cell * grid.cell < minArea) continue;
    const rings = traceRings(mask, grid.cols, grid.rows, grid.x0, grid.z0, grid.cell)
      .map((ring) => simplifyRing(ring, tolerance))
      .filter((ring) => Math.abs(signedArea(ring)) >= grid.cell * grid.cell * 2);
    if (!rings.length) continue;
    // The largest ring is the outline; the others, inside it, are holes.
    rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    out.push({ rings, height: values[Math.floor((values.length - 1) * 0.95)]!, median, cells: values.length });
  }
  return out;
}
