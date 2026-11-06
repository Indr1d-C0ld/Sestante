import { pointInRing } from "../core/geo.ts";
import type { Building, TreeInstance } from "../field/load.ts";
import type { PlacedProp } from "./details.ts";

export type Hit = {
  kind: "terreno" | "edificio" | "albero" | "arredo" | "cielo";
  dist: number;
  x: number;
  y: number;
  z: number;
  building?: Building;
  tree?: TreeInstance;
  prop?: PlacedProp;
};

type Fence = { ax: number; az: number; bx: number; bz: number; h: number; solid: boolean };

class Hash<T> {
  private map = new Map<number, T[]>();
  constructor(private cell: number) {}
  private key(i: number, j: number) {
    return (i + 32768) * 65536 + (j + 32768);
  }
  add(x0: number, z0: number, x1: number, z1: number, item: T) {
    const i0 = Math.floor(x0 / this.cell);
    const i1 = Math.floor(x1 / this.cell);
    const j0 = Math.floor(z0 / this.cell);
    const j1 = Math.floor(z1 / this.cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        const list = this.map.get(k);
        if (list) list.push(item);
        else this.map.set(k, [item]);
      }
    }
  }
  at(x: number, z: number) {
    return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? EMPTY;
  }
  clear() {
    this.map.clear();
  }
}

const EMPTY: never[] = [];

export function insideSolid(building: Building, x: number, z: number) {
  if (!pointInRing(x, z, building.rings[0]!)) return false;
  for (let h = 1; h < building.rings.length; h++) if (pointInRing(x, z, building.rings[h]!)) return false;
  return true;
}

export class WorldQuery {
  private buildings = new Hash<Building>(30);
  private trees = new Hash<TreeInstance>(14);
  private props = new Hash<PlacedProp>(14);
  private fences = new Hash<Fence>(14);
  decks: { pts: number[]; width: number; y: number[] }[] = [];

  constructor(public heightAt: (x: number, z: number) => number) {}

  setBuildings(list: Building[]) {
    this.buildings.clear();
    for (const building of list) {
      if (building.hidden) continue;
      const ring = building.rings[0]!;
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        x0 = Math.min(x0, ring[i]!);
        x1 = Math.max(x1, ring[i]!);
        z0 = Math.min(z0, ring[i + 1]!);
        z1 = Math.max(z1, ring[i + 1]!);
      }
      this.buildings.add(x0 - 1, z0 - 1, x1 + 1, z1 + 1, building);
    }
  }

  setTrees(list: TreeInstance[]) {
    this.trees.clear();
    for (const tree of list) this.trees.add(tree.x - tree.r, tree.z - tree.r, tree.x + tree.r, tree.z + tree.r, tree);
  }

  setProps(list: PlacedProp[]) {
    this.props.clear();
    for (const prop of list) this.props.add(prop.x - prop.r, prop.z - prop.r, prop.x + prop.r, prop.z + prop.r, prop);
  }

  setFences(list: Fence[]) {
    this.fences.clear();
    for (const fence of list) {
      if (!fence.solid) continue;
      this.fences.add(Math.min(fence.ax, fence.bx) - 1, Math.min(fence.az, fence.bz) - 1, Math.max(fence.ax, fence.bx) + 1, Math.max(fence.az, fence.bz) + 1, fence);
    }
  }

  buildingAt(x: number, z: number) {
    for (const building of this.buildings.at(x, z)) if (insideSolid(building, x, z)) return building;
    return null;
  }

  /** Walkable surface under the feet: terrain, or a roof or bridge deck the observer is already on. */
  floorAt(x: number, z: number, feetY: number) {
    let floor = this.heightAt(x, z);
    for (const building of this.buildings.at(x, z)) {
      if (!insideSolid(building, x, z)) continue;
      const top = building.top - building.roofHeight * 0.5;
      if (feetY >= top - 0.9) floor = Math.max(floor, top);
    }
    for (const deck of this.decks) {
      const n = deck.pts.length / 2;
      for (let i = 0; i + 1 < n; i++) {
        const ax = deck.pts[i * 2]!;
        const az = deck.pts[i * 2 + 1]!;
        const bx = deck.pts[i * 2 + 2]!;
        const bz = deck.pts[i * 2 + 3]!;
        const dx = bx - ax;
        const dz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz + 1e-6)));
        if (Math.hypot(x - ax - dx * t, z - az - dz * t) <= deck.width / 2) {
          const y = deck.y[i]! + (deck.y[i + 1]! - deck.y[i]!) * t;
          if (feetY >= y - 0.9) floor = Math.max(floor, y);
        }
      }
    }
    return floor;
  }

  /** Slides a walker of the given radius out of walls and fences. Returns the corrected position. */
  collide(x: number, z: number, feetY: number, radius: number) {
    let px = x;
    let pz = z;
    for (let pass = 0; pass < 3; pass++) {
      for (const building of this.buildings.at(px, pz)) {
        if (feetY >= building.top - 0.9) continue;
        if (building.minHeight > 2.2 && feetY + 1.8 < building.top - building.height + building.minHeight) continue;
        const inside = insideSolid(building, px, pz);
        let best = Infinity;
        let bx = 0;
        let bz = 0;
        for (const ring of building.rings) {
          const n = ring.length / 2;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const ax = ring[j * 2]!;
            const az = ring[j * 2 + 1]!;
            const ex = ring[i * 2]! - ax;
            const ez = ring[i * 2 + 1]! - az;
            const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez + 1e-9)));
            const qx = ax + ex * t;
            const qz = az + ez * t;
            const d = (px - qx) ** 2 + (pz - qz) ** 2;
            if (d < best) {
              best = d;
              bx = qx;
              bz = qz;
            }
          }
        }
        const dist = Math.sqrt(best);
        if (inside) {
          const nx = (bx - px) / (dist || 1);
          const nz = (bz - pz) / (dist || 1);
          px = bx + nx * radius;
          pz = bz + nz * radius;
        } else if (dist < radius) {
          const nx = (px - bx) / (dist || 1);
          const nz = (pz - bz) / (dist || 1);
          px = bx + nx * radius;
          pz = bz + nz * radius;
        }
      }
      for (const fence of this.fences.at(px, pz)) {
        const ground = this.heightAt(px, pz);
        if (feetY >= ground + fence.h - 0.45) continue;
        const ex = fence.bx - fence.ax;
        const ez = fence.bz - fence.az;
        const t = Math.max(0, Math.min(1, ((px - fence.ax) * ex + (pz - fence.az) * ez) / (ex * ex + ez * ez + 1e-9)));
        const qx = fence.ax + ex * t;
        const qz = fence.az + ez * t;
        const d = Math.hypot(px - qx, pz - qz);
        if (d < radius) {
          const nx = (px - qx) / (d || 1);
          const nz = (pz - qz) / (d || 1);
          px = qx + nx * radius;
          pz = qz + nz * radius;
        }
      }
      for (const tree of this.trees.at(px, pz)) {
        const trunk = Math.max(0.1, tree.r * 0.035 + tree.h * 0.008) + radius;
        const d = Math.hypot(px - tree.x, pz - tree.z);
        if (d < trunk && tree.kind !== 2 && feetY < this.heightAt(tree.x, tree.z) + tree.h * 0.5) {
          px = tree.x + ((px - tree.x) / (d || 1)) * trunk;
          pz = tree.z + ((pz - tree.z) / (d || 1)) * trunk;
        }
      }
    }
    return { x: px, z: pz };
  }

  /** Steps along a ray against terrain, prisms, crowns and street furniture: geometry-free, so a laser reading is cheap. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max = 4000): Hit {
    let t = 0.3;
    let step = 0.2;
    let prevT = t;
    while (t < max) {
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      if (y < this.heightAt(x, z)) {
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (oy + dy * mid < this.heightAt(ox + dx * mid, oz + dz * mid)) hi = mid;
          else lo = mid;
        }
        return { kind: "terreno", dist: hi, x: ox + dx * hi, y: oy + dy * hi, z: oz + dz * hi };
      }
      for (const building of this.buildings.at(x, z)) {
        if (y > building.top || y < building.base - 3) continue;
        if (building.minHeight > 0 && y < building.top - building.height + building.minHeight) continue;
        if (!insideSolid(building, x, z)) continue;
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          const yy = oy + dy * mid;
          if (yy <= building.top && insideSolid(building, ox + dx * mid, oz + dz * mid)) hi = mid;
          else lo = mid;
        }
        return { kind: "edificio", dist: hi, x: ox + dx * hi, y: oy + dy * hi, z: oz + dz * hi, building };
      }
      for (const tree of this.trees.at(x, z)) {
        const ground = this.heightAt(tree.x, tree.z);
        const crownH = Math.min(tree.h * 0.72, Math.max(tree.r * 1.7, tree.h * 0.55));
        const centre = ground + tree.h - crownH * 0.5;
        const q = ((x - tree.x) / tree.r) ** 2 + ((z - tree.z) / tree.r) ** 2 + ((y - centre) / (crownH * 0.56)) ** 2;
        const trunk = Math.hypot(x - tree.x, z - tree.z) < Math.max(0.2, tree.r * 0.09) && y < centre && y > ground;
        if (q < 0.82 || trunk) return { kind: "albero", dist: t, x, y, z, tree };
      }
      for (const prop of this.props.at(x, z)) {
        const ground = this.heightAt(prop.x, prop.z);
        const radius = Math.max(0.22, prop.r * 0.5);
        if (Math.hypot(x - prop.x, z - prop.z) < radius && y > ground && y < ground + prop.h) return { kind: "arredo", dist: t, x, y, z, prop };
      }
      prevT = t;
      step = Math.min(3, 0.2 + t * 0.012);
      t += step;
    }
    return { kind: "cielo", dist: Infinity, x: 0, y: 0, z: 0 };
  }

  /** Is the point out of direct sun? */
  shadedFrom(x: number, y: number, z: number, sx: number, sy: number, sz: number) {
    if (sy <= 0) return true;
    const hit = this.raycast(x, y, z, sx, sy, sz, 600);
    return hit.kind !== "cielo";
  }
}
