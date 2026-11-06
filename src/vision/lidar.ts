/** Reading airborne laser models: closing their holes, making traces visible, measuring what stands on the ground. Pure code. */

export type ReliefGrid = { heights: Float32Array; cols: number; rows: number; cellX: number; cellZ: number };

/**
 * Bare-ground models leave holes under buildings and water. Holes close from their edges inward, over a pyramid of
 * averages, so a wide hole takes the level of its surroundings and a narrow one stays exact at the border.
 */
export function fillGaps(heights: Float32Array, cols: number, rows: number) {
  const out = new Float32Array(heights);
  let missing = 0;
  for (const v of heights) if (!Number.isFinite(v)) missing++;
  if (!missing || missing === heights.length) return { heights: out, filled: missing };
  const levels: { w: number; h: number; sum: Float32Array }[] = [];
  let w = cols;
  let h = rows;
  let data = new Float32Array(out);
  levels.push({ w, h, sum: data });
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const next = new Float32Array(nw * nh);
    for (let j = 0; j < nh; j++) {
      for (let i = 0; i < nw; i++) {
        let sum = 0;
        let n = 0;
        for (let y = j * 2; y < Math.min(h, j * 2 + 2 + (h % 2 && j === nh - 1 ? 1 : 0)); y++) {
          for (let x = i * 2; x < Math.min(w, i * 2 + 2 + (w % 2 && i === nw - 1 ? 1 : 0)); x++) {
            const v = data[y * w + x]!;
            if (Number.isFinite(v)) {
              sum += v;
              n++;
            }
          }
        }
        next[j * nw + i] = n ? sum / n : Number.NaN;
      }
    }
    levels.push({ w: nw, h: nh, sum: next });
    data = next;
    w = nw;
    h = nh;
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l]!;
    const coarse = levels[l + 1]!;
    for (let j = 0; j < fine.h; j++) {
      for (let i = 0; i < fine.w; i++) {
        if (Number.isFinite(fine.sum[j * fine.w + i]!)) continue;
        const fx = Math.min(coarse.w - 1.001, Math.max(0, (i + 0.5) / 2 - 0.5));
        const fy = Math.min(coarse.h - 1.001, Math.max(0, (j + 0.5) / 2 - 0.5));
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const at = (a: number, b: number) => coarse.sum[Math.min(coarse.h - 1, b) * coarse.w + Math.min(coarse.w - 1, a)]!;
        fine.sum[j * fine.w + i] = at(ix, iy) * (1 - tx) * (1 - ty) + at(ix + 1, iy) * tx * (1 - ty) + at(ix, iy + 1) * (1 - tx) * ty + at(ix + 1, iy + 1) * tx * ty;
      }
    }
  }
  return { heights: levels[0]!.sum, filled: missing };
}

function boxBlur(values: Float32Array, cols: number, rows: number, rx: number, rz: number) {
  const across = new Float32Array(values.length);
  for (let j = 0; j < rows; j++) {
    let sum = 0;
    for (let i = -rx; i <= rx; i++) sum += values[j * cols + Math.max(0, Math.min(cols - 1, i))]!;
    for (let i = 0; i < cols; i++) {
      across[j * cols + i] = sum / (rx * 2 + 1);
      sum += values[j * cols + Math.min(cols - 1, i + rx + 1)]! - values[j * cols + Math.max(0, i - rx)]!;
    }
  }
  const out = new Float32Array(values.length);
  for (let i = 0; i < cols; i++) {
    let sum = 0;
    for (let j = -rz; j <= rz; j++) sum += across[Math.max(0, Math.min(rows - 1, j)) * cols + i]!;
    for (let j = 0; j < rows; j++) {
      out[j * cols + i] = sum / (rz * 2 + 1);
      sum += across[Math.min(rows - 1, j + rz + 1) * cols + i]! - across[Math.max(0, j - rz) * cols + i]!;
    }
  }
  return out;
}

/** The ground minus its own broad shape: what is left is banks, ditches, mounds, whatever the sun direction. Metres. */
export function localRelief(grid: ReliefGrid, radius = 15) {
  const rx = Math.max(1, Math.round(radius / grid.cellX));
  const rz = Math.max(1, Math.round(radius / grid.cellZ));
  // Two passes of a box come close to a Gaussian and leave no square halos around strong features.
  const smooth = boxBlur(boxBlur(grid.heights, grid.cols, grid.rows, rx, rz), grid.cols, grid.rows, rx, rz);
  const out = new Float32Array(grid.heights.length);
  for (let k = 0; k < out.length; k++) out[k] = grid.heights[k]! - smooth[k]!;
  return out;
}

/** Light from several sides, so a bank parallel to one sun does not vanish. Values 0–255. */
export function hillshade(grid: ReliefGrid, exaggeration = 2, altitude = 35) {
  const { heights, cols, rows, cellX, cellZ } = grid;
  const out = new Uint8Array(cols * rows);
  const lights = [315, 15, 75, 255].map((azimuth, index) => {
    const az = (azimuth * Math.PI) / 180;
    const alt = (altitude * Math.PI) / 180;
    return { x: Math.sin(az) * Math.cos(alt), y: Math.sin(alt), z: -Math.cos(az) * Math.cos(alt), weight: index === 0 ? 0.4 : 0.2 };
  });
  for (let j = 0; j < rows; j++) {
    const up = Math.max(0, j - 1);
    const down = Math.min(rows - 1, j + 1);
    for (let i = 0; i < cols; i++) {
      const left = Math.max(0, i - 1);
      const right = Math.min(cols - 1, i + 1);
      const dx = ((heights[j * cols + right]! - heights[j * cols + left]!) / ((right - left) * cellX)) * exaggeration;
      const dz = ((heights[down * cols + i]! - heights[up * cols + i]!) / ((down - up) * cellZ)) * exaggeration;
      const norm = Math.hypot(dx, 1, dz);
      let light = 0;
      for (const row of lights) light += Math.max(0, (-dx * row.x + row.y - dz * row.z) / norm) * row.weight;
      out[j * cols + i] = Math.max(0, Math.min(255, light * 290));
    }
  }
  return out;
}

export type StandingHeight = { height: number; roofMedian: number; cells: number; coverage: number };

/**
 * How tall something stands from a surface and a ground model, inside the cells of its outline. The 95th percentile: a
 * tower reaches its full height, and one crane or overhanging crown does not decide. Null when too little was seen.
 */
export function standingHeight(dsm: ArrayLike<number>, ground: ArrayLike<number>, cells: number[], minCells = 6): StandingHeight | null {
  const rises: number[] = [];
  for (const k of cells) {
    const top = dsm[k]!;
    const base = ground[k]!;
    if (Number.isFinite(top) && Number.isFinite(base)) rises.push(top - base);
  }
  if (rises.length < minCells) return null;
  rises.sort((a, b) => a - b);
  return { height: rises[Math.floor((rises.length - 1) * 0.95)]!, roofMedian: rises[rises.length >> 1]!, cells: rises.length, coverage: rises.length / cells.length };
}
