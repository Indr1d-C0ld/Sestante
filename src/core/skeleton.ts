/**
 * The straight skeleton of a footprint, holes included: every side moves inward at the same speed, and where the moving
 * sides meet they draw the hips, valleys and ridges of a roof whose slopes are all equal. Each side ends up owning one
 * flat face, so the roof over an L, a T or a courtyard block is made of planes, as real roofs are. Pure code.
 *
 * The wavefront is followed event by event (after Felkel and Obdržálek): an edge event when a side shrinks to nothing, a
 * split event when a reflex corner runs into the side opposite. Exact parallel sides are common on mapped buildings and
 * make events tie; a millimetre of deterministic jitter breaks the ties. Whatever goes wrong, the result is checked: the
 * faces must cover the footprint's area, or there is no skeleton and the caller keeps its old roof.
 */

type Edge = { ax: number; az: number; dx: number; dz: number; nx: number; nz: number };
type Vertex = {
  x: number;
  z: number;
  t: number;
  vx: number;
  vz: number;
  prev: Vertex;
  next: Vertex;
  prevEdge: number;
  nextEdge: number;
  reflex: boolean;
  valid: boolean;
  node: number;
};
type Event = { t: number; kind: 0 | 1; a: Vertex; b: Vertex | null; edge: number; x: number; z: number };

/** One roof face: the side it belongs to (its line and inward normal) and its outline as x, z, t triples. */
export type SkeletonFace = { ax: number; az: number; nx: number; nz: number; points: number[] };
export type Skeleton = { faces: SkeletonFace[]; deepest: number };

const signedArea = (ring: number[]) => {
  let s = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) s += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!;
  return s / 2;
};

/** Without repeated points and with nearly straight corners removed: they add nothing to a roof but ties. */
function cleanRing(ring: number[]) {
  let pts: number[] = [];
  const n0 = ring.length / 2;
  for (let i = 0; i < n0; i++) {
    const x = ring[i * 2]!;
    const z = ring[i * 2 + 1]!;
    const m = pts.length / 2;
    if (m && Math.hypot(x - pts[(m - 1) * 2]!, z - pts[(m - 1) * 2 + 1]!) < 0.05) continue;
    pts.push(x, z);
  }
  let m = pts.length / 2;
  if (m > 1 && Math.hypot(pts[0]! - pts[(m - 1) * 2]!, pts[1]! - pts[(m - 1) * 2 + 1]!) < 0.05) pts = pts.slice(0, (m - 1) * 2);
  for (let changed = true; changed && pts.length >= 6; ) {
    changed = false;
    m = pts.length / 2;
    for (let i = 0; i < m && m >= 3; i++) {
      const p = (i + m - 1) % m;
      const q = (i + 1) % m;
      const ax = pts[i * 2]! - pts[p * 2]!;
      const az = pts[i * 2 + 1]! - pts[p * 2 + 1]!;
      const bx = pts[q * 2]! - pts[i * 2]!;
      const bz = pts[q * 2 + 1]! - pts[i * 2 + 1]!;
      const sin = (ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1);
      if (Math.abs(sin) < 0.02) {
        pts.splice(i * 2, 2);
        changed = true;
        break;
      }
    }
  }
  return pts.length >= 6 ? pts : null;
}

/** A binary heap of events, earliest first, edge events before split events at the same time. */
class Queue {
  private items: Event[] = [];
  get size() {
    return this.items.length;
  }
  private before(a: Event, b: Event) {
    return a.t < b.t - 1e-12 || (Math.abs(a.t - b.t) <= 1e-12 && a.kind < b.kind);
  }
  push(e: Event) {
    const h = this.items;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.before(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  pop() {
    const h = this.items;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.before(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.before(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The skeleton of an outline (first ring) with holes (the others), in any orientation. Null when the outline is
 * degenerate, too detailed (over 400 corners) or the computation does not close.
 */
export function straightSkeleton(rings: number[][]): Skeleton | null {
  const cleaned: number[][] = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = cleanRing(rings[r]!);
    if (!ring) {
      if (r === 0) return null;
      continue;
    }
    // Outer ring counter-clockwise in (x, z), holes clockwise: the inside is always on the left of a side.
    const area = signedArea(ring);
    if ((r === 0) !== area > 0) {
      const rev: number[] = [];
      for (let i = ring.length / 2 - 1; i >= 0; i--) rev.push(ring[i * 2]!, ring[i * 2 + 1]!);
      cleaned.push(rev);
    } else cleaned.push(ring);
  }
  const corners = cleaned.reduce((s, ring) => s + ring.length / 2, 0);
  if (corners > 400) return null;
  // Work around the outline's centre, with a millimetre of jitter against exact ties.
  const outer = cleaned[0]!;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < outer.length; i += 2) {
    cx += outer[i]!;
    cz += outer[i + 1]!;
  }
  cx /= outer.length / 2;
  cz /= outer.length / 2;
  let seed = 0;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 2e-3;
  };
  const nodes: number[] = [];
  const edges: Edge[] = [];
  const ringStart: number[] = [];
  for (const ring of cleaned) {
    ringStart.push(nodes.length / 3);
    for (let i = 0; i < ring.length; i += 2) nodes.push(ring[i]! - cx + jitter(), ring[i + 1]! - cz + jitter(), 0);
  }
  for (let r = 0; r < cleaned.length; r++) {
    const n = cleaned[r]!.length / 2;
    for (let i = 0; i < n; i++) {
      const a = ringStart[r]! + i;
      const b = ringStart[r]! + ((i + 1) % n);
      const dx = nodes[b * 3]! - nodes[a * 3]!;
      const dz = nodes[b * 3 + 1]! - nodes[a * 3 + 1]!;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) return null;
      edges.push({ ax: nodes[a * 3]!, az: nodes[a * 3 + 1]!, dx: dx / len, dz: dz / len, nx: -dz / len, nz: dx / len });
    }
  }
  // Edge e runs from node e to node edgeEnd[e].
  const edgeEnd: number[] = [];
  for (let r = 0; r < cleaned.length; r++) {
    const n = cleaned[r]!.length / 2;
    for (let i = 0; i < n; i++) edgeEnd.push(ringStart[r]! + ((i + 1) % n));
  }

  const arcs: { a: number; b: number; e1: number; e2: number }[] = [];
  const all: Vertex[] = [];
  const queue = new Queue();

  const makeVertex = (x: number, z: number, t: number, prevEdge: number, nextEdge: number, node: number): Vertex | null => {
    const e1 = edges[prevEdge]!;
    const e2 = edges[nextEdge]!;
    const det = e1.nx * e2.nz - e1.nz * e2.nx;
    let vx: number;
    let vz: number;
    if (Math.abs(det) < 1e-12) {
      if (e1.nx * e2.nx + e1.nz * e2.nz < 0) return null;
      vx = e1.nx;
      vz = e1.nz;
    } else {
      vx = (e2.nz - e1.nz) / det;
      vz = (e1.nx - e2.nx) / det;
    }
    const v = { x, z, t, vx, vz, prevEdge, nextEdge, reflex: e1.dx * e2.dz - e1.dz * e2.dx < 0, valid: true, node } as Vertex;
    all.push(v);
    return v;
  };

  const edgeEvent = (a: Vertex, b: Vertex) => {
    const det = b.vx * a.vz - a.vx * b.vz;
    if (Math.abs(det) < 1e-12) return;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const s = (b.vx * dz - dx * b.vz) / det;
    const u = (a.vx * dz - a.vz * dx) / det;
    if (s < -1e-9 || u < -1e-9) return;
    const t = Math.max(a.t + s, b.t + u);
    queue.push({ t, kind: 0, a, b, edge: -1, x: a.x + s * a.vx, z: a.z + s * a.vz });
  };

  const splitEvents = (v: Vertex) => {
    for (let e = 0; e < edges.length; e++) {
      if (e === v.prevEdge || e === v.nextEdge) continue;
      const E = edges[e]!;
      const k = v.vx * E.nx + v.vz * E.nz;
      if (1 - k <= 1e-9) continue;
      const d0 = (v.x - E.ax) * E.nx + (v.z - E.az) * E.nz;
      const s = (d0 - v.t) / (1 - k);
      if (s < -1e-9) continue;
      queue.push({ t: v.t + s, kind: 1, a: v, b: null, edge: e, x: v.x + s * v.vx, z: v.z + s * v.vz });
    }
  };

  const addNode = (x: number, z: number, t: number) => {
    nodes.push(x, z, t);
    return nodes.length / 3 - 1;
  };
  const arc = (v: Vertex, node: number) => arcs.push({ a: v.node, b: node, e1: v.prevEdge, e2: v.nextEdge });

  /** A wavefront loop of one or two vertices is finished: two vertices are joined by a ridge. */
  const settle = (w: Vertex) => {
    if (w.next === w) {
      w.valid = false;
      return;
    }
    if (w.next.next === w) {
      arcs.push({ a: w.node, b: w.next.node, e1: w.prevEdge, e2: w.nextEdge });
      w.valid = w.next.valid = false;
      return;
    }
    edgeEvent(w.prev, w);
    edgeEvent(w, w.next);
    if (w.reflex) splitEvents(w);
  };

  // The initial wavefront: the outline's corners.
  for (let r = 0; r < cleaned.length; r++) {
    const n = cleaned[r]!.length / 2;
    const ring: Vertex[] = [];
    for (let i = 0; i < n; i++) {
      const node = ringStart[r]! + i;
      const prevEdge = ringStart[r]! + ((i + n - 1) % n);
      const v = makeVertex(nodes[node * 3]!, nodes[node * 3 + 1]!, 0, prevEdge, node, node);
      if (!v) return null;
      ring.push(v);
    }
    for (let i = 0; i < n; i++) {
      ring[i]!.next = ring[(i + 1) % n]!;
      ring[i]!.prev = ring[(i + n - 1) % n]!;
    }
  }
  for (const v of [...all]) {
    edgeEvent(v, v.next);
    if (v.reflex) splitEvents(v);
  }

  const limit = 50000 + corners * corners * 20;
  for (let step = 0; queue.size; step++) {
    if (step > limit) return null;
    const ev = queue.pop();
    if (ev.kind === 0) {
      const a = ev.a;
      const b = ev.b!;
      if (!a.valid || !b.valid || a.next !== b) continue;
      const node = addNode(ev.x, ev.z, ev.t);
      if (a.prev === b.next) {
        // The last three corners of a loop meet at one point: a peak.
        for (const v of [a, b, b.next]) {
          arc(v, node);
          v.valid = false;
        }
        continue;
      }
      arc(a, node);
      arc(b, node);
      a.valid = b.valid = false;
      const w = makeVertex(ev.x, ev.z, ev.t, a.prevEdge, b.nextEdge, node);
      if (!w) return null;
      w.prev = a.prev;
      w.next = b.next;
      a.prev.next = w;
      b.next.prev = w;
      settle(w);
    } else {
      const v = ev.a;
      if (!v.valid) continue;
      const E = edges[ev.edge]!;
      // The stretch of the opposite side's wavefront that the corner actually hits, if it still exists.
      let holder: Vertex | null = null;
      for (const x of all) {
        if (!x.valid || x.nextEdge !== ev.edge || x === v || x.next === v) continue;
        const y = x.next;
        const xx = x.x + (ev.t - x.t) * x.vx;
        const xz = x.z + (ev.t - x.t) * x.vz;
        const yx = y.x + (ev.t - y.t) * y.vx;
        const yz = y.z + (ev.t - y.t) * y.vz;
        const along = (ev.x - xx) * E.dx + (ev.z - xz) * E.dz;
        const span = (yx - xx) * E.dx + (yz - xz) * E.dz;
        if (along >= -1e-6 && along <= span + 1e-6) {
          holder = x;
          break;
        }
      }
      if (!holder) continue;
      const node = addNode(ev.x, ev.z, ev.t);
      arc(v, node);
      v.valid = false;
      const w1 = makeVertex(ev.x, ev.z, ev.t, v.prevEdge, ev.edge, node);
      const w2 = makeVertex(ev.x, ev.z, ev.t, ev.edge, v.nextEdge, node);
      if (!w1 || !w2) return null;
      const p0 = v.prev;
      const n0 = v.next;
      const y = holder.next;
      p0.next = w1;
      w1.prev = p0;
      w1.next = y;
      y.prev = w1;
      holder.next = w2;
      w2.prev = holder;
      w2.next = n0;
      n0.prev = w2;
      settle(w1);
      if (w2.valid) settle(w2);
    }
  }
  if (all.some((v) => v.valid)) return null;

  // Each side's face: the side itself, then the arcs that border it, walked from its end back to its start.
  const faces: SkeletonFace[] = [];
  const byEdge = new Map<number, number[]>();
  arcs.forEach((a, i) => {
    for (const e of [a.e1, a.e2]) {
      const list = byEdge.get(e);
      if (list) list.push(i);
      else byEdge.set(e, [i]);
    }
  });
  let covered = 0;
  let deepest = 0;
  for (let e = 0; e < edges.length; e++) {
    const start = e;
    const end = edgeEnd[e]!;
    const near = new Map<number, number[]>();
    for (const i of byEdge.get(e) ?? []) {
      const { a, b } = arcs[i]!;
      if (a === b) continue;
      for (const [p, q] of [[a, b], [b, a]] as const) {
        const list = near.get(p);
        if (list) list.push(i);
        else near.set(p, [i]);
        void q;
      }
    }
    const used = new Set<number>();
    const path = [start, end];
    let at = end;
    for (let guard = 0; at !== start; guard++) {
      if (guard > arcs.length + 2) return null;
      const next = (near.get(at) ?? []).find((i) => !used.has(i));
      if (next == null) return null;
      used.add(next);
      const { a, b } = arcs[next]!;
      at = a === at ? b : a;
      if (at !== start) path.push(at);
    }
    const E = edges[e]!;
    const points: number[] = [];
    const flat: number[] = [];
    for (const k of path) {
      const t = nodes[k * 3 + 2]!;
      deepest = Math.max(deepest, t);
      points.push(nodes[k * 3]! + cx, nodes[k * 3 + 1]! + cz, t);
      flat.push(nodes[k * 3]!, nodes[k * 3 + 1]!);
    }
    covered += Math.abs(signedArea(flat));
    faces.push({ ax: E.ax + cx, az: E.az + cz, nx: E.nx, nz: E.nz, points });
  }
  const area = cleaned.reduce((s, ring) => s + signedArea(ring), 0);
  if (Math.abs(covered - area) > Math.max(0.5, area * 0.01)) return null;
  return { faces, deepest };
}

/** Whether a point lies inside a face's outline. */
function insideFace(x: number, z: number, points: number[]) {
  let hit = false;
  const n = points.length / 3;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const zi = points[i * 3 + 1]!;
    const zj = points[j * 3 + 1]!;
    if (zi > z !== zj > z && x < ((points[j * 3]! - points[i * 3]!) * (z - zi)) / (zj - zi) + points[i * 3]!) hit = !hit;
  }
  return hit;
}

/** How far the wavefront had to travel to reach a point: its distance from the side whose face holds it. NaN outside. */
export function skeletonDepth(skeleton: Skeleton, x: number, z: number) {
  for (const f of skeleton.faces) {
    if (insideFace(x, z, f.points)) return Math.max(0, (x - f.ax) * f.nx + (z - f.az) * f.nz);
  }
  return NaN;
}

/**
 * A face cut at depth `reach`: the part below, which slopes, and the part above, which is the flat top of a mansard.
 * Depth is linear over a face, so the cut is a straight line. Each part is a list of x, z, t triples.
 */
export function cutFace(points: number[], reach: number) {
  const low: number[] = [];
  const high: number[] = [];
  const n = points.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ti = points[i * 3 + 2]!;
    const tj = points[j * 3 + 2]!;
    const p = [points[i * 3]!, points[i * 3 + 1]!, ti];
    if (ti <= reach) low.push(...p);
    if (ti >= reach) high.push(...p);
    if ((ti < reach && tj > reach) || (ti > reach && tj < reach)) {
      const f = (reach - ti) / (tj - ti);
      const q = [points[i * 3]! + (points[j * 3]! - points[i * 3]!) * f, points[i * 3 + 1]! + (points[j * 3 + 1]! - points[i * 3 + 1]!) * f, reach];
      low.push(...q);
      high.push(...q);
    }
  }
  return { low: low.length >= 9 ? low : null, high: high.length >= 9 ? high : null };
}
