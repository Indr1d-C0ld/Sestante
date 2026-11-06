import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, UA } from "./sources.ts";

type Bbox = { s: number; w: number; n: number; e: number };
type Raw = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
  members?: { type: string; ref: number; role: string }[];
  geometry?: { lat: number; lon: number }[];
};

export type LatLon = [number, number];
export type OsmFeature = { id: string; tags: Record<string, string>; rings?: LatLon[][]; line?: LatLon[]; at?: LatLon };
export type OsmBundle = {
  source: string;
  fetchedAt: string;
  buildings: OsmFeature[];
  parts: OsmFeature[];
  highways: OsmFeature[];
  railways: OsmFeature[];
  waterAreas: OsmFeature[];
  waterLines: OsmFeature[];
  landcover: OsmFeature[];
  barriers: OsmFeature[];
  structures: OsmFeature[];
  trees: OsmFeature[];
  props: OsmFeature[];
  places: OsmFeature[];
};

async function fetchMapApi(box: Bbox, depth = 0): Promise<Raw[]> {
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${box.w},${box.s},${box.e},${box.n}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(90_000),
  });
  if (res.status === 400 && depth < 3) {
    // The API refuses boxes holding over 50 000 nodes: split them and merge the pieces.
    const mx = (box.w + box.e) / 2;
    const my = (box.s + box.n) / 2;
    const parts = await Promise.all(
      [
        { s: box.s, w: box.w, n: my, e: mx },
        { s: box.s, w: mx, n: my, e: box.e },
        { s: my, w: box.w, n: box.n, e: mx },
        { s: my, w: mx, n: box.n, e: box.e },
      ].map((part) => fetchMapApi(part, depth + 1)),
    );
    return parts.flat();
  }
  if (!res.ok) throw new Error(`OSM API ${res.status}`);
  return ((await res.json()) as { elements: Raw[] }).elements;
}

async function fetchOverpass(box: Bbox): Promise<Raw[]> {
  const b = `${box.s},${box.w},${box.n},${box.e}`;
  const query = `[out:json][timeout:60];(nwr(${b}););(._;>;);out body;`;
  for (const host of ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]) {
    try {
      const res = await fetch(host, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(70_000),
      });
      if (res.ok) return ((await res.json()) as { elements: Raw[] }).elements;
    } catch {
      /* try the next mirror */
    }
  }
  throw new Error("Overpass non raggiungibile");
}

function closeRings(ways: LatLon[][]): LatLon[][] {
  const pending = ways.map((way) => [...way]);
  const rings: LatLon[][] = [];
  const same = (a: LatLon, b: LatLon) => a[0] === b[0] && a[1] === b[1];
  while (pending.length) {
    const ring = pending.shift()!;
    let grown = true;
    while (grown && !same(ring[0]!, ring[ring.length - 1]!)) {
      grown = false;
      for (let i = 0; i < pending.length; i++) {
        const way = pending[i]!;
        const tail = ring[ring.length - 1]!;
        if (same(way[0]!, tail)) ring.push(...way.slice(1));
        else if (same(way[way.length - 1]!, tail)) ring.push(...[...way].reverse().slice(1));
        else continue;
        pending.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0]!, ring[ring.length - 1]!)) rings.push(ring);
  }
  return rings;
}

const PROP_KEYS: [string, string[]][] = [
  ["highway", ["street_lamp", "traffic_signals", "bus_stop", "crossing"]],
  ["amenity", ["bench", "waste_basket", "fountain", "drinking_water", "bicycle_parking", "shelter", "post_box", "telephone"]],
  ["barrier", ["bollard", "gate", "lift_gate"]],
  ["man_made", ["mast", "tower", "chimney", "water_tower", "flagpole", "cross", "surveillance", "lighthouse", "silo", "storage_tank"]],
  ["historic", ["memorial", "monument", "wayside_cross", "wayside_shrine", "archaeological_site", "ruins", "column", "boundary_stone", "milestone", "tomb"]],
  ["tourism", ["artwork", "information", "viewpoint"]],
  ["power", ["pole", "tower"]],
  ["natural", ["rock", "stone", "spring", "peak", "cave_entrance"]],
];

function classify(elements: Raw[], source: string): OsmBundle {
  const nodes = new Map<number, Raw>();
  const ways = new Map<number, Raw>();
  for (const el of elements) {
    if (el.type === "node") nodes.set(el.id, el);
    else if (el.type === "way") ways.set(el.id, el);
  }
  const wayPts = (way: Raw): LatLon[] =>
    (way.nodes ?? []).flatMap((id) => {
      const node = nodes.get(id);
      return node && node.lat != null && node.lon != null ? [[node.lat, node.lon] as LatLon] : [];
    });

  const bundle: OsmBundle = {
    source,
    fetchedAt: new Date().toISOString(),
    buildings: [],
    parts: [],
    highways: [],
    railways: [],
    waterAreas: [],
    waterLines: [],
    landcover: [],
    barriers: [],
    structures: [],
    trees: [],
    props: [],
    places: [],
  };
  const seen = new Set<string>();

  const pushArea = (id: string, tags: Record<string, string>, rings: LatLon[][]) => {
    if (seen.has(id) || !rings.length) return;
    seen.add(id);
    const feature: OsmFeature = { id, tags, rings };
    if (tags["building:part"] && tags["building:part"] !== "no") bundle.parts.push(feature);
    else if (tags.building && tags.building !== "no") bundle.buildings.push(feature);
    else if (tags.natural === "water" || tags.waterway === "riverbank" || tags.landuse === "reservoir" || tags.landuse === "basin" || tags.leisure === "swimming_pool" || tags.amenity === "fountain")
      bundle.waterAreas.push(feature);
    else if (tags.man_made && ["tower", "chimney", "water_tower", "silo", "storage_tank", "bridge", "pier", "breakwater"].includes(tags.man_made)) bundle.structures.push(feature);
    else if (tags.landuse || tags.natural || tags.leisure || tags.amenity === "parking" || tags.place === "square" || tags.highway === "pedestrian" || tags.area === "yes")
      bundle.landcover.push(feature);
    if (tags.name && !tags.building && !tags.highway) bundle.places.push({ id, tags, rings });
  };

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (!el.tags) continue;
    if (el.type === "node" && el.lat != null && el.lon != null) {
      const at: LatLon = [el.lat, el.lon];
      if (tags.natural === "tree") {
        bundle.trees.push({ id: `n${el.id}`, tags, at });
        continue;
      }
      if (PROP_KEYS.some(([key, values]) => tags[key] && values.includes(tags[key]!))) {
        bundle.props.push({ id: `n${el.id}`, tags, at });
      }
      if (tags.name) bundle.places.push({ id: `n${el.id}`, tags, at });
    } else if (el.type === "way") {
      const pts = wayPts(el);
      if (pts.length < 2) continue;
      const closed = el.nodes![0] === el.nodes![el.nodes!.length - 1];
      const id = `w${el.id}`;
      if (tags.highway && !(closed && tags.area === "yes")) bundle.highways.push({ id, tags, line: pts });
      else if (tags.railway) bundle.railways.push({ id, tags, line: pts });
      else if (tags.waterway && !closed) bundle.waterLines.push({ id, tags, line: pts });
      else if (tags.barrier) bundle.barriers.push({ id, tags, line: pts });
      else if (tags.natural === "tree_row" || tags.man_made === "pipeline" || tags.power === "line") bundle.barriers.push({ id, tags, line: pts });
      else if (closed && pts.length >= 4) pushArea(id, tags, [pts]);
    } else if (el.type === "relation" && (tags.type === "multipolygon" || tags.type === "building")) {
      const outer: LatLon[][] = [];
      const inner: LatLon[][] = [];
      for (const member of el.members ?? []) {
        if (member.type !== "way") continue;
        const way = ways.get(member.ref);
        if (!way) continue;
        const pts = wayPts(way);
        if (pts.length < 2) continue;
        if (member.role === "inner") inner.push(pts);
        else if (member.role === "outer" || member.role === "") outer.push(pts);
      }
      const outers = closeRings(outer);
      const inners = closeRings(inner);
      if (!outers.length) continue;
      // Each ring list stores outer rings first; holes are matched by the client with a containment test.
      const feature = [...outers, ...inners.map((ring) => [...ring])];
      const merged = { ...tags };
      delete merged.type;
      pushArea(`r${el.id}`, { ...merged, "_outer": String(outers.length) }, feature);
      // Ways reused as outer lines of a relation should not be drawn twice as separate buildings.
      if (tags.building) for (const member of el.members ?? []) if (member.role === "outer") seen.add(`w${member.ref}`);
    }
  }
  // Ways tagged as buildings are pushed before their relation when they come first in the response: drop those.
  const dropOuter = new Set<string>();
  for (const el of elements) {
    if (el.type === "relation" && el.tags?.building) for (const member of el.members ?? []) if (member.role === "outer" && member.type === "way" && !ways.get(member.ref)?.tags?.building) dropOuter.add(`w${member.ref}`);
  }
  bundle.buildings = bundle.buildings.filter((feature) => !dropOuter.has(feature.id));
  return bundle;
}

export async function fetchBundle(box: Bbox): Promise<OsmBundle> {
  const key = createHash("sha1").update(`v3:${box.s.toFixed(5)},${box.w.toFixed(5)},${box.n.toFixed(5)},${box.e.toFixed(5)}`).digest("hex").slice(0, 18);
  const dir = join(DATA, "cache", "osm");
  const file = join(dir, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as OsmBundle;
  let elements: Raw[];
  let source = "OpenStreetMap API 0.6";
  try {
    elements = await fetchMapApi(box);
  } catch {
    elements = await fetchOverpass(box);
    source = "OpenStreetMap via Overpass";
  }
  const bundle = classify(elements, source);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(bundle));
  return bundle;
}
