/**
 * Scoring a reconstruction against an airborne laser survey, the only source here that measured shape directly. Pure code.
 * The survey has its own date: trees grow and lose leaves, buildings change, so a score is a comparison and not a verdict.
 */
export type SurfaceGrid = { surface: Float32Array; ground: Float32Array; cols: number; rows: number; cellX: number; cellZ: number };

/**
 * Cells in cast shadow for one sun: each looks towards the sun over the surface and asks whether anything stands higher
 * than the ray. Azimuth clockwise from north, +x east and +z south like every raster here. 1 is shadow.
 */
export function castShadows(grid: SurfaceGrid, sunAzimuth: number, altitude: number, clearance = 0.6) {
  const { surface, cols, rows, cellX, cellZ } = grid;
  const out = new Uint8Array(cols * rows);
  const tan = Math.tan(Math.max(0.02, altitude));
  let highest = -Infinity;
  for (const v of surface) if (v > highest) highest = v;
  const step = Math.min(cellX, cellZ);
  const dx = (Math.sin(sunAzimuth) * step) / cellX;
  const dz = (-Math.cos(sunAzimuth) * step) / cellZ;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const from = surface[j * cols + i]! + clearance;
      // Past this distance the ray is above everything in the grid.
      const steps = Math.ceil((highest - from) / (tan * step));
      let x = i;
      let z = j;
      for (let s = 1; s <= steps; s++) {
        x += dx;
        z += dz;
        const xi = Math.round(x);
        const zi = Math.round(z);
        if (xi < 0 || zi < 0 || xi >= cols || zi >= rows) break;
        if (surface[zi * cols + xi]! > from + s * step * tan) {
          out[j * cols + i] = 1;
          break;
        }
      }
    }
  }
  return out;
}

export type MaskScore = { cells: number; found: number; expected: number; precision: number; recall: number; iou: number };

/** How well one mask matches another over the cells that count. Precision: how much of what was found is real. */
export function maskScore(found: ArrayLike<number>, expected: ArrayLike<number>, valid: ArrayLike<number>): MaskScore {
  let both = 0;
  let onlyFound = 0;
  let onlyExpected = 0;
  let cells = 0;
  for (let k = 0; k < valid.length; k++) {
    if (!valid[k]) continue;
    cells++;
    if (found[k] && expected[k]) both++;
    else if (found[k]) onlyFound++;
    else if (expected[k]) onlyExpected++;
  }
  return {
    cells,
    found: both + onlyFound,
    expected: both + onlyExpected,
    precision: both + onlyFound ? both / (both + onlyFound) : 0,
    recall: both + onlyExpected ? both / (both + onlyExpected) : 0,
    iou: both + onlyFound + onlyExpected ? both / (both + onlyFound + onlyExpected) : 0,
  };
}

/** A mask on one raster read on another that covers the same box, by nearest cell. */
export function resampleMask(mask: ArrayLike<number>, width: number, height: number, cols: number, rows: number, channel = 0, stride = 1, threshold = 0) {
  const out = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y = Math.min(height - 1, Math.floor(((j + 0.5) / rows) * height));
    for (let i = 0; i < cols; i++) {
      const x = Math.min(width - 1, Math.floor(((i + 0.5) / cols) * width));
      out[j * cols + i] = mask[(y * width + x) * stride + channel]! > threshold ? 1 : 0;
    }
  }
  return out;
}

export type SunFit = { altitude: number; iou: number; tried: { altitude: number; iou: number }[] };

/** The sun height whose laser-cast shadows best match the shadows found on the plate, at a known azimuth. */
export function fitSunAltitude(grid: SurfaceGrid, sunAzimuth: number, found: ArrayLike<number>, valid: ArrayLike<number>, from = 0.14, to = 1.25, step = 0.035): SunFit {
  const tried: SunFit["tried"] = [];
  let best = { altitude: from, iou: -1 };
  for (let altitude = from; altitude <= to + 1e-9; altitude += step) {
    const iou = maskScore(found, castShadows(grid, sunAzimuth, altitude), valid).iou;
    tried.push({ altitude, iou });
    if (iou > best.iou) best = { altitude, iou };
  }
  return { ...best, tried };
}
