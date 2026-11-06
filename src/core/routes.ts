/**
 * Paths of least effort on the land, the classic method for ancient roads, and who can see whom. A route found here is a
 * hypothesis about where walking was easiest: it does not prove that a road ran there, and the land has changed since.
 */
export type RouteMode = "piedi" | "carico";

export const ROUTE_MODES: Record<RouteMode, { label: string; note: string }> = {
  piedi: { label: "A piedi", note: "Funzione di Tobler: 6 km/h al massimo, su una lieve discesa" },
  carico: { label: "Carro o animale carico", note: "Costo che cresce col quadrato della pendenza, con pendenza critica all'8%: i carri evitano le salite ripide più che le lunghe" },
};

/** Seconds per metre of ground travelled, for a signed slope (rise over run) in the direction of travel. */
export function secondsPerMetre(slope: number, mode: RouteMode) {
  if (mode === "piedi") return 3.6 / (6 * Math.exp(-3.5 * Math.abs(slope + 0.05)));
  // Going down is just as hard for a loaded cart as going up: it has to be held back.
  return (3.6 / 3) * (1 + (slope / 0.08) ** 2);
}

export type CostGrid = {
  heights: ArrayLike<number>;
  size: number;
  spacing: number;
  /** Extra seconds to enter a cell, such as a ford. Infinity forbids it. */
  barrier?: ArrayLike<number>;
};

// Eight neighbours plus the knight's moves: paths are not forced into steps of 45°.
const MOVES: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];

class Heap {
  private keys: Float64Array;
  private items: Int32Array;
  size = 0;
  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.items = new Int32Array(capacity);
  }
  push(key: number, item: number) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      const items = new Int32Array(this.size * 2);
      keys.set(this.keys);
      items.set(this.items);
      this.keys = keys;
      this.items = items;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= key) break;
      this.keys[i] = this.keys[parent]!;
      this.items[i] = this.items[parent]!;
      i = parent;
    }
    this.keys[i] = key;
    this.items[i] = item;
  }
  pop() {
    const top = this.items[0]!;
    const topKey = this.keys[0]!;
    const key = this.keys[--this.size]!;
    const item = this.items[this.size]!;
    let i = 0;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1]! < this.keys[child]!) child++;
      if (this.keys[child]! >= key) break;
      this.keys[i] = this.keys[child]!;
      this.items[i] = this.items[child]!;
      i = child;
    }
    this.keys[i] = key;
    this.items[i] = item;
    return { item: top, key: topKey };
  }
}

/** Time from one cell to all others, walking forward; with `reverse`, the time from all others to that cell. */
export function travelTimes(grid: CostGrid, start: number, mode: RouteMode, reverse = false) {
  const { heights, size, spacing, barrier } = grid;
  const times = new Float64Array(size * size).fill(Infinity);
  const parent = new Int32Array(size * size).fill(-1);
  const heap = new Heap(size * 8);
  times[start] = 0;
  heap.push(0, start);
  while (heap.size) {
    const { item, key } = heap.pop();
    if (key > times[item]!) continue;
    const x = item % size;
    const y = (item - x) / size;
    const here = heights[item]!;
    for (const [dx, dy] of MOVES) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const next = ny * size + nx;
      const entered = reverse ? item : next;
      let extra = barrier?.[entered] ?? 0;
      if (barrier && Math.abs(dx) + Math.abs(dy) === 3) {
        // A knight's move crosses two cells on its way, and must not jump a river.
        const a = Math.abs(dx) === 2 ? (y * size + x + Math.sign(dx)) : ((y + Math.sign(dy)) * size + x);
        const b = Math.abs(dx) === 2 ? (ny * size + x + Math.sign(dx)) : ((y + Math.sign(dy)) * size + nx);
        extra = Math.max(extra, barrier[a] ?? 0, barrier[b] ?? 0);
      }
      if (extra === Infinity) continue;
      const run = Math.hypot(dx, dy) * spacing;
      const rise = reverse ? here - heights[next]! : heights[next]! - here;
      if (!Number.isFinite(rise)) continue;
      const cost = key + Math.hypot(run, rise) * secondsPerMetre(rise / run, mode) + extra;
      if (cost < times[next]!) {
        times[next] = cost;
        parent[next] = item;
        heap.push(cost, next);
      }
    }
  }
  return { times, parent };
}

export type LeastCostRoute = {
  points: { x: number; z: number }[];
  seconds: number;
  length: number;
  ascent: number;
  descent: number;
  straight: number;
  straightSeconds: number | null;
  /** Share of the box from which a trip through that cell costs at most `slack` more: narrow means the land forces the way. */
  corridor: Uint8Array;
  corridorShare: number;
};

export function leastCostRoute(grid: CostGrid, from: { x: number; z: number }, to: { x: number; z: number }, origin: { x: number; z: number }, mode: RouteMode, slack = 0.1): LeastCostRoute | null {
  const { size, spacing, heights } = grid;
  const toCell = (p: { x: number; z: number }) => {
    const i = Math.max(0, Math.min(size - 1, Math.round((p.x - origin.x) / spacing)));
    const j = Math.max(0, Math.min(size - 1, Math.round((p.z - origin.z) / spacing)));
    return j * size + i;
  };
  const start = toCell(from);
  const end = toCell(to);
  const out = travelTimes(grid, start, mode);
  if (out.times[end] === Infinity) return null;
  const back = travelTimes(grid, end, mode, true);
  const seconds = out.times[end]!;
  const corridor = new Uint8Array(size * size);
  let inside = 0;
  for (let k = 0; k < corridor.length; k++) {
    if (out.times[k]! + back.times[k]! <= seconds * (1 + slack)) {
      corridor[k] = 1;
      inside++;
    }
  }
  const cells: number[] = [];
  for (let k = end; k !== -1; k = out.parent[k]!) cells.push(k);
  cells.reverse();
  let length = 0;
  let ascent = 0;
  let descent = 0;
  const points = cells.map((k) => ({ x: origin.x + (k % size) * spacing, z: origin.z + Math.floor(k / size) * spacing }));
  for (let i = 1; i < cells.length; i++) {
    const rise = heights[cells[i]!]! - heights[cells[i - 1]!]!;
    length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z, rise);
    if (rise > 0) ascent += rise;
    else descent -= rise;
  }
  const straight = Math.hypot(to.x - from.x, to.z - from.z);
  // Walking the straight line, for comparison: what the land saves by turning aside.
  let straightSeconds: number | null = 0;
  const steps = Math.max(1, Math.ceil(straight / spacing));
  let last = heights[toCell(from)]!;
  for (let s = 1; s <= steps; s++) {
    const p = { x: from.x + ((to.x - from.x) * s) / steps, z: from.z + ((to.z - from.z) * s) / steps };
    const k = toCell(p);
    const rise = heights[k]! - last;
    const run = straight / steps;
    if ((grid.barrier?.[k] ?? 0) === Infinity) {
      straightSeconds = null;
      break;
    }
    straightSeconds! += Math.hypot(run, rise) * secondsPerMetre(rise / run, mode) + (grid.barrier?.[k] ?? 0);
    last = heights[k]!;
  }
  return { points: simplify(points, spacing * 0.6), seconds, length, ascent, descent, straight, straightSeconds, corridor, corridorShare: inside / corridor.length };
}

/** Douglas-Peucker: the raster's little steps are not information about the path. */
export function simplify(points: { x: number; z: number }[], tolerance: number) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a]!;
    const pb = points[b]!;
    const len = Math.hypot(pb.x - pa.x, pb.z - pa.z) || 1;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i]!;
      const d = Math.abs((pb.z - pa.z) * (p.x - pa.x) - (pb.x - pa.x) * (p.z - pa.z)) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export type Site = { id: string; name: string; x: number; z: number };
export type SightLine = { a: string; b: string; distance: number; visible: boolean; clearance: number };

/**
 * Who sees whom on the bare land, from a person's eye to a person-sized mark. `clearance` is the narrowest gap in metres:
 * negative when something stands in the way, and small when a few metres of error would change the answer.
 */
export function sightLines(sites: Site[], heightAt: (x: number, z: number) => number, eye = 1.6, step = 15): SightLine[] {
  const out: SightLine[] = [];
  const R = 6371000 / 0.87;
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i]!;
      const b = sites[j]!;
      const distance = Math.hypot(b.x - a.x, b.z - a.z);
      const from = heightAt(a.x, a.z) + eye;
      const to = heightAt(b.x, b.z) + eye;
      let clearance = Infinity;
      const steps = Math.max(2, Math.ceil(distance / step));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const d = t * distance;
        // Ground drops away by the Earth's curve measured from both ends of the line of sight.
        const bulge = (d * (distance - d)) / (2 * R);
        clearance = Math.min(clearance, from + (to - from) * t - bulge - heightAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
      }
      out.push({ a: a.id, b: b.id, distance, visible: clearance > 0, clearance });
    }
  }
  return out.sort((p, q) => p.distance - q.distance);
}
