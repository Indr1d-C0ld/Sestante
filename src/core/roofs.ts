/**
 * Roofs as surfaces over any footprint, courtyards included. Pure code: the same functions build the mesh and score it
 * against a survey.
 *
 * A roof that rises with the distance from the nearest edge, up to a ridge, is a hipped roof on a rectangle and keeps
 * to the outline on any other plan: it never spills over a courtyard or past an L's inner corner.
 */

/** Distance from a point to the nearest edge of any ring (flat x,z arrays). */
export function distanceToRings(x: number, z: number, rings: number[][]) {
  let best = Infinity;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[j * 2]!;
      const az = ring[j * 2 + 1]!;
      const bx = ring[i * 2]!;
      const bz = ring[i * 2 + 1]!;
      const dx = bx - ax;
      const dz = bz - az;
      const len = dx * dx + dz * dz;
      const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
  }
  return best;
}

/**
 * Height of a roof surface at a point, as the mesh builds it: flat roofs at the top, every other shape rising from the
 * eave with the distance from the nearest edge, up to `rise` at `deepest`. Gabled and domed roofs are not exactly this;
 * for scoring a surface against a survey the difference is small.
 */
export function roofSurfaceAt(x: number, z: number, rings: number[][], eave: number, rise: number, deepest: number) {
  if (rise <= 0 || deepest <= 0) return eave + rise;
  return eave + rise * Math.min(1, distanceToRings(x, z, rings) / deepest);
}

/**
 * Mansards and the like rise steeply at the edge and are nearly flat on top: their surface reaches the ridge this far
 * in. Drawn as hipped roofs, Paris's and Lyon's mapped mansards sat further from the laser than flat tops did.
 */
export const STEEP_REACH = 2.5;
export const steepShape = (shape: string) => shape === "mansard" || shape === "gambrel" || shape === "many";


/** Whether a footprint is close enough to a rectangle for the classic hipped or gabled roof along its long axis. */
export function nearRectangle(ring: number[], area: number) {
  const n = ring.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2]!;
    cz += ring[i * 2 + 1]!;
  }
  cx /= n;
  cz /= n;
  // The smallest bounding rectangle over the directions of the ring's own edges.
  let best = Infinity;
  for (let e = 0; e < n; e++) {
    const f = (e + 1) % n;
    const ex = ring[f * 2]! - ring[e * 2]!;
    const ez = ring[f * 2 + 1]! - ring[e * 2 + 1]!;
    const len = Math.hypot(ex, ez);
    if (len < 0.5) continue;
    const ax = ex / len;
    const az = ez / len;
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = ring[i * 2]! - cx;
      const dz = ring[i * 2 + 1]! - cz;
      const a = dx * ax + dz * az;
      const b = -dx * az + dz * ax;
      minA = Math.min(minA, a);
      maxA = Math.max(maxA, a);
      minB = Math.min(minB, b);
      maxB = Math.max(maxB, b);
    }
    best = Math.min(best, (maxA - minA) * (maxB - minB));
  }
  return best < Infinity && area / best > 0.88;
}

/**
 * The rise of a roof whose shape nobody mapped: a quarter of the footprint's width, between 1.4 m and 45% of the
 * height. On 1,800 buildings of Amsterdam, Paris, London and Zurich such a roof, over any plan, put the surface closer
 * to the laser than a flat top at the same height: median error from 3.2 to 2.2 m, 4.1 to 3.5, 4.3 to 4.0, 2.8 to 2.8.
 */
export function presumedRise(height: number, area: number) {
  return Math.min(height * 0.45, Math.max(1.4, Math.sqrt(area) * 0.24));
}

/**
 * Which buildings get a presumed pitched roof: nothing mapped about the roof, not a part, at least 8 m tall and under
 * 1,000 m². Below 8 m and above 1,000 m² a flat top was closer to the laser, more often than not. load.ts adds a last
 * condition, a near-rectangular plan: over complex plans a roof rising from every edge rippled into a tent, and on
 * eleven boxes the presumption kept its gain in ten without them.
 */
export function presumePitched(height: number, area: number, roofShapeMapped: boolean, isPart: boolean) {
  return !roofShapeMapped && !isPart && height >= 8 && area < 1000;
}

/** Whether a point lies inside the outer ring and outside every hole. */
export function insideRings(x: number, z: number, rings: number[][]) {
  let inside = false;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    let hit = false;
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const zi = ring[i * 2 + 1]!;
      const zj = ring[j * 2 + 1]!;
      if (zi > z !== zj > z && x < ((ring[j * 2]! - ring[i * 2]!) * (z - zi)) / (zj - zi) + ring[i * 2]!) hit = !hit;
    }
    if (r === 0) inside = hit;
    else if (hit) return false;
  }
  return inside;
}

/**
 * Delaunay triangulation (Bowyer-Watson) of a few thousand points: plain, quadratic in the worst case, enough for one
 * roof. Returns index triples.
 */
export function delaunay(xs: Float64Array, zs: Float64Array) {
  const n = xs.length;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]!);
    maxX = Math.max(maxX, xs[i]!);
    minZ = Math.min(minZ, zs[i]!);
    maxZ = Math.max(maxZ, zs[i]!);
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 1) * 20;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const px = Array.from(xs);
  const pz = Array.from(zs);
  px.push(cx - span, cx, cx + span);
  pz.push(cz - span, cz + span, cz - span);
  type Tri = { a: number; b: number; c: number; ox: number; oz: number; r2: number };
  const circle = (a: number, b: number, c: number): Tri => {
    const ax = px[a]!;
    const az = pz[a]!;
    const bx = px[b]!;
    const bz = pz[b]!;
    const qx = px[c]!;
    const qz = pz[c]!;
    const d = 2 * (ax * (bz - qz) + bx * (qz - az) + qx * (az - bz));
    if (Math.abs(d) < 1e-12) return { a, b, c, ox: 0, oz: 0, r2: Infinity };
    const ox = ((ax * ax + az * az) * (bz - qz) + (bx * bx + bz * bz) * (qz - az) + (qx * qx + qz * qz) * (az - bz)) / d;
    const oz = ((ax * ax + az * az) * (qx - bx) + (bx * bx + bz * bz) * (ax - qx) + (qx * qx + qz * qz) * (bx - ax)) / d;
    return { a, b, c, ox, oz, r2: (ax - ox) ** 2 + (az - oz) ** 2 };
  };
  let tris: Tri[] = [circle(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const x = px[i]!;
    const z = pz[i]!;
    const bad: Tri[] = [];
    const keep: Tri[] = [];
    for (const t of tris) ((x - t.ox) ** 2 + (z - t.oz) ** 2 < t.r2 ? bad : keep).push(t);
    // The hole's outline: edges of bad triangles that no other bad triangle shares.
    const edges = new Map<string, [number, number]>();
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [u, v]);
      }
    }
    for (const [u, v] of edges.values()) keep.push(circle(u, v, i));
    tris = keep;
  }
  const out: number[][] = [];
  for (const t of tris) if (t.a < n && t.b < n && t.c < n) out.push([t.a, t.b, t.c]);
  return out;
}

/** A surveyed roof patch: heights above the building's ground on a regular grid, x and z of its first cell's centre. */
export type RoofGrid = { x0: number; z0: number; cell: number; cols: number; rows: number; heights: Float32Array };

/** Bilinear reading of a roof patch; NaN outside it or where the survey has no value. */
export function roofGridAt(grid: RoofGrid, x: number, z: number) {
  const gx = (x - grid.x0) / grid.cell;
  const gz = (z - grid.z0) / grid.cell;
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  if (i < 0 || j < 0 || i >= grid.cols - 1 || j >= grid.rows - 1) {
    const ci = Math.max(0, Math.min(grid.cols - 1, Math.round(gx)));
    const cj = Math.max(0, Math.min(grid.rows - 1, Math.round(gz)));
    return grid.heights[cj * grid.cols + ci]!;
  }
  const fx = gx - i;
  const fz = gz - j;
  const h = (a: number, b: number) => grid.heights[b * grid.cols + a]!;
  return h(i, j) * (1 - fx) * (1 - fz) + h(i + 1, j) * fx * (1 - fz) + h(i, j + 1) * (1 - fx) * fz + h(i + 1, j + 1) * fx * fz;
}

/**
 * The surveyed roof as triangles: points on a grid inside the plan and along its edges, Delaunay-triangulated, kept where
 * the triangle's centre is inside. Edge points sit at the eave, where the walls end; inside points take the survey's
 * height, never below the eave (a sample of the street next door must not punch a hole) nor above the top.
 */
export function surveyedRoof(rings: number[][], grid: RoofGrid, eave: number, top: number, spacing = 1.5) {
  const xs: number[] = [];
  const zs: number[] = [];
  const ys: number[] = [];
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2]!;
      const az = ring[i * 2 + 1]!;
      const len = Math.hypot(ring[j * 2]! - ax, ring[j * 2 + 1]! - az);
      const steps = Math.max(1, Math.ceil(len / (spacing * 0.5)));
      for (let s = 0; s < steps; s++) {
        xs.push(ax + ((ring[j * 2]! - ax) * s) / steps);
        zs.push(az + ((ring[j * 2 + 1]! - az) * s) / steps);
        ys.push(eave);
      }
    }
  }
  const outer = rings[0]!;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    minX = Math.min(minX, outer[i]!);
    maxX = Math.max(maxX, outer[i]!);
    minZ = Math.min(minZ, outer[i + 1]!);
    maxZ = Math.max(maxZ, outer[i + 1]!);
  }
  for (let z = minZ + spacing / 2; z < maxZ; z += spacing) {
    for (let x = minX + spacing / 2; x < maxX; x += spacing) {
      if (!insideRings(x, z, rings) || distanceToRings(x, z, rings) < spacing * 0.35) continue;
      const h = roofGridAt(grid, x, z);
      xs.push(x);
      zs.push(z);
      ys.push(Number.isFinite(h) ? Math.max(eave, Math.min(top, h)) : eave);
    }
  }
  const tris = delaunay(Float64Array.from(xs), Float64Array.from(zs)).filter(([a, b, c]) => insideRings((xs[a]! + xs[b]! + xs[c]!) / 3, (zs[a]! + zs[b]! + zs[c]!) / 3, rings));
  return { xs, zs, ys, tris };
}
