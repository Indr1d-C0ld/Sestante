/**
 * Volumes with their uncertainty stated. Solids come from plan × height; masses on the land from a surface model minus
 * the ground rebuilt from their rim. A figure without its interval is not offered. Pure code.
 */
export type VolumeRange = { value: number; low: number; high: number };

/** Half-width of the printed interval, in units of the typical (median absolute) error: about 80% for a normal spread. */
export const INTERVAL_FACTOR = 2;

/** Share of the eave-to-top box a roof fills. Pitched shapes beyond these are approximations, and the card says so. */
export function roofFactor(shape: string) {
  if (shape === "pyramidal" || shape === "cone") return 1 / 3;
  if (shape === "gabled" || shape === "skillion" || shape === "lean_to") return 0.5;
  if (shape === "hipped" || shape === "half-hipped" || shape === "saltbox" || shape === "gambrel" || shape === "mansard") return 0.42;
  if (shape === "dome" || shape === "round") return 2 / 3;
  if (shape === "onion") return 0.6;
  return 0;
}

function ringMeasures(ring: ArrayLike<number>) {
  let area = 0;
  let perimeter = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!;
    perimeter += Math.hypot(ring[i * 2]! - ring[j * 2]!, ring[i * 2 + 1]! - ring[j * 2 + 1]!);
  }
  return { area: Math.abs(area) / 2, perimeter };
}

/** Plan area with courtyards taken out, and the outline length that a misplaced edge would act along. */
export function planMeasures(rings: ArrayLike<number>[]) {
  let area = 0;
  let perimeter = 0;
  rings.forEach((ring, index) => {
    const row = ringMeasures(ring);
    area += index === 0 ? row.area : -row.area;
    perimeter += row.perimeter;
  });
  return { area: Math.max(0, area), perimeter };
}

export type SolidInput = { rings: ArrayLike<number>[]; height: number; minHeight?: number; roofHeight?: number; roofShape?: string };

export function solidVolume(solid: SolidInput) {
  const { area, perimeter } = planMeasures(solid.rings);
  const floor = solid.minHeight ?? 0;
  const rise = Math.min(solid.roofHeight ?? 0, Math.max(0, solid.height - floor));
  const walls = Math.max(0, solid.height - floor - rise);
  const factor = roofFactor(solid.roofShape ?? "flat");
  // A roof the map calls flat holds no rise: the whole height is walls.
  const meanHeight = factor > 0 ? walls + rise * factor : walls + rise;
  return { area, perimeter, meanHeight, volume: area * meanHeight, fullHeight: solid.height - floor };
}

/** The typical height error propagates in proportion; a footprint edge off by `edgeError` metres adds an independent term. */
export function solidRange(solid: SolidInput, heightError: number, edgeError = 0.7): VolumeRange & { area: number; meanHeight: number } {
  const { area, perimeter, meanHeight, volume, fullHeight } = solidVolume(solid);
  const fromHeight = fullHeight > 0 ? (volume * heightError) / fullHeight : 0;
  const fromPlan = perimeter * edgeError * meanHeight;
  const half = Math.hypot(fromHeight, fromPlan) * INTERVAL_FACTOR;
  return { value: volume, low: Math.max(0, volume - half), high: volume + half, area, meanHeight };
}

/** Very rough on purpose: the crown's shape is assumed, and its height is the weakest reading in the whole system. */
export function crownVolume(radius: number, height: number) {
  const crownHeight = Math.min(height * 0.72, Math.max(radius * 1.7, height * 0.55));
  const value = (4 / 3) * Math.PI * radius * radius * (crownHeight / 2);
  return { value, low: value * 0.4, high: value * 1.8 };
}

const pointInside = (x: number, z: number, ring: ArrayLike<number>) => {
  let hit = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2]!;
    const zi = ring[i * 2 + 1]!;
    const xj = ring[j * 2]!;
    const zj = ring[j * 2 + 1]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};

/**
 * Several parts of one structure overlap in plan, and adding them counts the overlap twice. On a raster each column
 * takes only its tallest part, whatever the plan. Height errors add across columns, since parts share a source and do not
 * cancel. A misplaced edge acts only along the structure's outer outline: walls between parts would add nothing.
 */
export function complexRange(parts: (SolidInput & { heightError: number })[], edgeError = 0.7): VolumeRange & { area: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const solids = parts.map((part) => {
    const outer = part.rings[0]!;
    for (let i = 0; i < outer.length; i += 2) {
      minX = Math.min(minX, outer[i]!);
      maxX = Math.max(maxX, outer[i]!);
      minZ = Math.min(minZ, outer[i + 1]!);
      maxZ = Math.max(maxZ, outer[i + 1]!);
    }
    return { part, ...solidVolume(part) };
  });
  if (!solids.length) return { value: 0, low: 0, high: 0, area: 0 };
  const cell = Math.max(0.5, Math.sqrt(((maxX - minX) * (maxZ - minZ)) / 60000));
  const boxes = solids.map(({ part }) => {
    const outer = part.rings[0]!;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < outer.length; i += 2) {
      x0 = Math.min(x0, outer[i]!);
      x1 = Math.max(x1, outer[i]!);
      z0 = Math.min(z0, outer[i + 1]!);
      z1 = Math.max(z1, outer[i + 1]!);
    }
    return { x0, x1, z0, z1 };
  });
  let value = 0;
  let cells = 0;
  let fromHeight = 0;
  const cols = Math.ceil((maxX - minX) / cell);
  const rows = Math.ceil((maxZ - minZ) / cell);
  const covered = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const z = minZ + (j + 0.5) * cell;
    for (let i = 0; i < cols; i++) {
      const x = minX + (i + 0.5) * cell;
      let top = -Infinity;
      let topError = 0;
      for (let s = 0; s < solids.length; s++) {
        const box = boxes[s]!;
        if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) continue;
        const solid = solids[s]!;
        const rings = solid.part.rings;
        if (!pointInside(x, z, rings[0]!)) continue;
        let hole = false;
        for (let h = 1; h < rings.length && !hole; h++) hole = pointInside(x, z, rings[h]!);
        if (!hole && solid.meanHeight > top) {
          top = solid.meanHeight;
          topError = solid.fullHeight > 0 ? (solid.meanHeight * solid.part.heightError) / solid.fullHeight : 0;
        }
      }
      if (top > -Infinity) {
        value += top * cell * cell;
        fromHeight += topError * cell * cell;
        covered[j * cols + i] = 1;
        cells++;
      }
    }
  }
  let edges = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!covered[j * cols + i]) continue;
      if (i === 0 || !covered[j * cols + i - 1]) edges++;
      if (i === cols - 1 || !covered[j * cols + i + 1]) edges++;
      if (j === 0 || !covered[(j - 1) * cols + i]) edges++;
      if (j === rows - 1 || !covered[(j + 1) * cols + i]) edges++;
    }
  }
  const area = cells * cell * cell;
  // A staircase on a raster runs 4/π longer than the line it follows, on average over directions.
  const perimeter = (edges * cell * Math.PI) / 4;
  const half = Math.hypot(fromHeight, perimeter * edgeError * (area > 0 ? value / area : 0)) * INTERVAL_FACTOR;
  return { value, low: Math.max(0, value - half), high: value + half, area };
}

/**
 * Many objects measured the same way: their own errors largely cancel in a total, but a bias they share does not.
 * `sharedError` is that common height bias in metres, acting over all their plan.
 */
export function sumRange(items: (VolumeRange & { area: number })[], sharedError: number): VolumeRange {
  let value = 0;
  let area = 0;
  let own = 0;
  for (const row of items) {
    value += row.value;
    area += row.area;
    own += (row.high - row.value) ** 2;
  }
  const half = sharedError * area * INTERVAL_FACTOR + Math.sqrt(own);
  return { value, low: Math.max(0, value - half), high: value + half };
}

// --- Masses on the land ---

export type DemGrid = { heights: Float32Array; cols: number; rows: number; cellX: number; cellZ: number; inside: Uint8Array };

export type MassResult = {
  fill: VolumeRange;
  cut: VolumeRange;
  net: number;
  peak: number;
  pit: number;
  area: number;
  /** Cells of the source's own 30 m grid under the outline: the honest count of independent measurements. */
  nativeCells: number;
  rimRoughness: number;
  base: Float32Array;
};

/**
 * The ground the mass stands on is unknown, so it is rebuilt by stretching a membrane from the rim across the outline.
 * The rim is what makes or breaks this: an uneven rim means an uncertain base, and the interval grows with it.
 */
export function massVolume(grid: DemGrid, nativeCell = 30): MassResult | null {
  const { heights, cols, rows, cellX, cellZ, inside } = grid;
  const n = cols * rows;
  const base = new Float32Array(n);
  const fixed = new Uint8Array(n);
  let rimSum = 0;
  let rimCount = 0;
  const rimValues: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (inside[k]) continue;
      const neighbour = (i > 0 && inside[k - 1]) || (i < cols - 1 && inside[k + 1]) || (j > 0 && inside[k - cols]) || (j < rows - 1 && inside[k + cols]);
      if (neighbour) {
        if (!Number.isFinite(heights[k]!)) return null;
        fixed[k] = 1;
        base[k] = heights[k]!;
        rimSum += heights[k]!;
        rimCount++;
        rimValues.push(heights[k]!);
      }
    }
  }
  if (!rimCount) return null;
  const mean = rimSum / rimCount;
  for (let k = 0; k < n; k++) if (inside[k] && !fixed[k]) base[k] = mean;
  // Over-relaxed Gauss-Seidel: the outline sizes this app deals with settle well inside this many sweeps.
  const omega = 1.85;
  for (let sweep = 0; sweep < 900; sweep++) {
    let change = 0;
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const k = j * cols + i;
        if (!inside[k]) continue;
        const neighbours = [k - 1, k + 1, k - cols, k + cols].filter((q) => inside[q] || fixed[q]);
        if (!neighbours.length) continue;
        const target = neighbours.reduce((sum, q) => sum + base[q]!, 0) / neighbours.length;
        const step = (target - base[k]!) * omega;
        base[k] = base[k]! + step;
        change = Math.max(change, Math.abs(step));
      }
    }
    if (change < 0.002) break;
  }
  let fill = 0;
  let cut = 0;
  let peak = 0;
  let pit = 0;
  let count = 0;
  const cellArea = cellX * cellZ;
  for (let k = 0; k < n; k++) {
    if (!inside[k]) continue;
    const h = heights[k]!;
    if (!Number.isFinite(h)) return null;
    const d = h - base[k]!;
    if (d > 0) fill += d * cellArea;
    else cut -= d * cellArea;
    peak = Math.max(peak, d);
    pit = Math.min(pit, d);
    count++;
  }
  if (!count) return null;
  // How far the rim departs from its own best plane says how far to trust a surface stretched across it.
  let sx = 0;
  let sz = 0;
  let ss = 0;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  let sxs = 0;
  let szs = 0;
  let rim = 0;
  const points: [number, number, number][] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!fixed[k]) continue;
      const x = i * cellX;
      const z = j * cellZ;
      const h = heights[k]! - mean;
      points.push([x, z, h]);
      sx += x;
      sz += z;
      ss += h;
      sxx += x * x;
      szz += z * z;
      sxz += x * z;
      sxs += x * h;
      szs += z * h;
      rim++;
    }
  }
  const mx = sx / rim;
  const mz = sz / rim;
  const cxx = sxx - rim * mx * mx;
  const czz = szz - rim * mz * mz;
  const cxz = sxz - rim * mx * mz;
  const cxs = sxs - rim * mx * (ss / rim);
  const czs = szs - rim * mz * (ss / rim);
  const det = cxx * czz - cxz * cxz;
  const a = det ? (cxs * czz - czs * cxz) / det : 0;
  const b = det ? (czs * cxx - cxs * cxz) / det : 0;
  const residuals = points.map(([x, z, h]) => Math.abs(h - ss / rim - a * (x - mx) - b * (z - mz)));
  residuals.sort((p, q) => p - q);
  const rimRoughness = residuals[residuals.length >> 1] ?? 0;
  const area = count * cellArea;
  // Vertical noise of a 30 m surface model, plus the base's own doubt. Both act over the whole outline, so they do not average out.
  const half = area * Math.hypot(1.5, rimRoughness * 0.6) * INTERVAL_FACTOR * 0.5;
  const range = (value: number): VolumeRange => ({ value, low: Math.max(0, value - half), high: value + half });
  return { fill: range(fill), cut: range(cut), net: fill - cut, peak, pit, area, nativeCells: area / (nativeCell * nativeCell), rimRoughness, base };
}

/** Volume gained or lost between two surface models. The band outside the outline tells the two sensors' offset here. */
export function changeVolume(older: Float32Array, newer: Float32Array, grid: Pick<DemGrid, "cols" | "rows" | "cellX" | "cellZ" | "inside">) {
  const outside: number[] = [];
  for (let k = 0; k < older.length; k++) {
    if (grid.inside[k]) continue;
    const d = newer[k]! - older[k]!;
    if (Number.isFinite(d)) outside.push(d);
  }
  if (outside.length < 8) return null;
  outside.sort((a, b) => a - b);
  const bias = outside[outside.length >> 1]!;
  const noise = outside.map((d) => Math.abs(d - bias)).sort((a, b) => a - b)[outside.length >> 1]!;
  const cellArea = grid.cellX * grid.cellZ;
  let gained = 0;
  let lost = 0;
  let area = 0;
  for (let k = 0; k < older.length; k++) {
    if (!grid.inside[k]) continue;
    const d = newer[k]! - older[k]! - bias;
    if (!Number.isFinite(d)) continue;
    if (d > 0) gained += d * cellArea;
    else lost -= d * cellArea;
    area += cellArea;
  }
  const net = gained - lost;
  // The whole outline can sit off by the local noise at once, so it scales with area rather than shrinking with cell count.
  const half = area * noise * INTERVAL_FACTOR;
  return { net, gained, lost, bias, noise, low: net - half, high: net + half, significant: Math.abs(net) > half };
}

/** "125 000 m³", with the scale read as a person would say it. */
export function formatVolume(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 1 : 2)} milioni di m³`;
  if (abs >= 1000) return `${Math.round(value / 100) * 100} m³`.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${Math.round(value)} m³`;
}

export function formatRange(row: VolumeRange) {
  const low = formatVolume(row.low);
  const high = formatVolume(row.high);
  const unit = high.endsWith("milioni di m³") ? " milioni di m³" : " m³";
  return `${low.endsWith(unit) ? low.slice(0, -unit.length) : low} – ${high}`;
}
