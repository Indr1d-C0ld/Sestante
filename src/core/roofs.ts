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
