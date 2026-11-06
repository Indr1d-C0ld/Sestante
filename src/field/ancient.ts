import { pointInRing } from "../core/geo.ts";
import type { Expedition } from "../core/types.ts";
import { type CostGrid, type Site } from "../core/routes.ts";
import type { Engine } from "../world/engine.ts";

export type WaterRule = "guado" | "invalicabile" | "ignora";
export const WATER_RULES: Record<WaterRule, string> = {
  guado: "Si guadano i fiumi, non i laghi",
  invalicabile: "L'acqua non si attraversa",
  ignora: "Ignora l'acqua",
};

/** Seconds to wade through one cell of river: enough to make a walker prefer a narrow crossing, not to forbid it. */
const FORD_SECONDS = 90;

/**
 * The land as a cost grid, from the terrain the world stands on. Cells of about 10 m are plenty for a route, and the small
 * bumps of a finer model would only make it wander. Today's rivers stand in for the past's: they may have moved.
 */
export function routeGrid(engine: Engine, water: WaterRule) {
  const { terrain } = engine.data;
  const factor = Math.max(1, Math.ceil(Math.max(10 / terrain.spacing, terrain.size / 500)));
  const size = Math.floor(terrain.size / factor);
  const spacing = terrain.spacing * factor;
  const half = ((terrain.size - 1) * terrain.spacing) / 2;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let sum = 0;
      for (let b = 0; b < factor; b++) for (let a = 0; a < factor; a++) sum += terrain.heights[(j * factor + b) * terrain.size + i * factor + a]!;
      heights[j * size + i] = sum / (factor * factor);
    }
  }
  const origin = { x: -half + ((factor - 1) * terrain.spacing) / 2, z: -half + ((factor - 1) * terrain.spacing) / 2 };
  const grid: CostGrid = { heights, size, spacing };
  if (water !== "ignora") {
    const barrier = new Float32Array(size * size);
    const mark = (x: number, z: number, cost: number) => {
      const i = Math.round((x - origin.x) / spacing);
      const j = Math.round((z - origin.z) / spacing);
      if (i >= 0 && j >= 0 && i < size && j < size) barrier[j * size + i] = Math.max(barrier[j * size + i]!, cost);
    };
    for (const area of engine.data.waterAreas) {
      const ring = area.rings[0];
      if (!ring) continue;
      const river = area.tags.water === "river" || area.tags.water === "canal" || !!area.tags.waterway;
      const cost = water === "guado" && river ? FORD_SECONDS : Infinity;
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
      for (let z = z0; z <= z1; z += spacing) for (let x = x0; x <= x1; x += spacing) if (pointInRing(x, z, ring)) mark(x, z, cost);
    }
    for (const line of engine.data.waterLines) {
      // Small streams are a step across, and only real rivers bar the way.
      if (line.tags.waterway !== "river" && line.tags.waterway !== "canal") continue;
      const cost = water === "guado" ? FORD_SECONDS : Infinity;
      for (let i = 0; i + 3 < line.pts.length; i += 2) {
        const dx = line.pts[i + 2]! - line.pts[i]!;
        const dz = line.pts[i + 3]! - line.pts[i + 1]!;
        const steps = Math.ceil(Math.hypot(dx, dz) / (spacing * 0.5));
        for (let s = 0; s <= steps; s++) mark(line.pts[i]! + (dx * s) / steps, line.pts[i + 1]! + (dz * s) / steps, cost);
      }
    }
    grid.barrier = barrier;
  }
  return { grid, origin };
}

const centreOf = (ring: ArrayLike<number>) => {
  let x = 0;
  let z = 0;
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i]!;
    z += ring[i + 1]!;
  }
  return { x: x / (ring.length / 2), z: z / (ring.length / 2) };
};

/** Places a route can join: stakes you planted, hypotheses, places under investigation, and what the map calls historic. */
export function sitesOf(engine: Engine, expedition: Expedition): Site[] {
  const out: Site[] = [];
  const p = engine.data.projection;
  const inBox = (x: number, z: number) => Math.abs(x) <= p.halfX * 1.05 && Math.abs(z) <= p.halfZ * 1.05;
  for (const pin of expedition.pins) out.push({ id: `pin-${pin.id}`, name: pin.label, x: pin.x, z: pin.z });
  for (const row of expedition.hypotheses ?? []) out.push({ id: `ip-${row.id}`, name: `Ipotesi: ${row.name}`, ...centreOf(row.ring) });
  (expedition.investigation?.candidates ?? []).slice(0, 8).forEach((row, index) => out.push({ id: `luogo-${row.id}`, name: `Luogo ${index + 1}`, x: row.x, z: row.z }));
  const names = new Set<string>();
  for (const b of engine.data.buildings) {
    const name = b.tags.name;
    if (!b.tags.historic || !name || names.has(name)) continue;
    const c = centreOf(b.rings[0]!);
    if (!inBox(c.x, c.z)) continue;
    names.add(name);
    out.push({ id: `osm-${b.id}`, name, ...c });
  }
  for (const prop of engine.data.props) {
    const name = prop.tags.name;
    if (!prop.tags.historic || !name || names.has(name) || !inBox(prop.x, prop.z)) continue;
    names.add(name);
    out.push({ id: `osm-${prop.id}`, name, x: prop.x, z: prop.z });
  }
  return out.slice(0, 80);
}

/** The band of land from which a detour stays within reach of the best route: narrow means the land forces the way. */
export function corridorCanvas(corridor: Uint8Array, size: number, spacing: number, origin: { x: number; z: number }, engine: Engine) {
  const p = engine.data.projection;
  const width = Math.min(1024, Math.ceil((p.halfX * 2) / spacing));
  const height = Math.min(1024, Math.ceil((p.halfZ * 2) / spacing));
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  const image = ctx.createImageData(width, height);
  for (let j = 0; j < height; j++) {
    const z = ((j + 0.5) / height) * 2 * p.halfZ - p.halfZ;
    const b = Math.round((z - origin.z) / spacing);
    for (let i = 0; i < width; i++) {
      const x = ((i + 0.5) / width) * 2 * p.halfX - p.halfX;
      const a = Math.round((x - origin.x) / spacing);
      if (a < 0 || b < 0 || a >= size || b >= size || !corridor[b * size + a]) continue;
      const k = (j * width + i) * 4;
      image.data[k] = 255;
      image.data[k + 1] = 181;
      image.data[k + 2] = 74;
      image.data[k + 3] = 110;
    }
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

export const formatDuration = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
};
