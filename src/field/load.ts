import { fillGaps as closeGaps } from "../vision/lidar.ts";
import { api, scaleCanvas, stitchPlate } from "../core/api.ts";
import { bestZoom, pointInRing, Projection, ringArea, type Bbox } from "../core/geo.ts";
import type { FieldSpec, PlateRef } from "../core/types.ts";
import type { AnalysisInput, AnalysisResult, Footprint, TreeHeightOrigin } from "../vision/analyze.ts";
import type { WorkerReply } from "../vision/worker.ts";

type LatLon = [number, number];
type OsmFeature = { id: string; tags: Record<string, string>; rings?: LatLon[][]; line?: LatLon[]; at?: LatLon };
type OsmBundle = {
  source: string;
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

export type HeightSource = "OSM height" | "OSM piani" | "laser GEDI" | "ombre multi-data" | "ombra" | "quartiere" | "tipo edilizio" | "ripresa" | "LiDAR";

export type Building = {
  id: string;
  rings: number[][];
  tags: Record<string, string>;
  height: number;
  minHeight: number;
  source: HeightSource;
  confidence: number;
  levels: number;
  base: number;
  top: number;
  roofShape: string;
  roofHeight: number;
  roofTone: [number, number, number];
  isPart: boolean;
  hidden: boolean;
  area: number;
  shadowHeight: number | null;
  /** Spread of the multi-date reading, when the shots were read together. */
  range?: [number, number];
  shots?: number;
};

export type LineFeature = { id: string; tags: Record<string, string>; pts: number[]; width: number };
export type AreaFeature = { id: string; tags: Record<string, string>; rings: number[][] };
export type PointFeature = { id: string; tags: Record<string, string>; x: number; z: number };
export type TreeInstance = { x: number; z: number; r: number; h: number; origin?: TreeHeightOrigin; rawH?: number; color: [number, number, number]; kind: number; source: string; species?: string };

export type TerrainData = { size: number; spacing: number; heights: Float32Array; min: number; max: number };
export type FarField = { size: number; span: number; heights: Float32Array; plate: HTMLCanvasElement; attribution: string };

export type PlateState = {
  ref: PlateRef;
  canvas: HTMLCanvasElement;
  analysis: AnalysisResult;
  trees: TreeInstance[];
  masses: Building[];
};

export type LiveWeather = {
  timezone: string;
  utc_offset_seconds: number;
  current: Record<string, number | string>;
  hourly: Record<string, (number | string)[]>;
};

export type FieldData = {
  spec: FieldSpec;
  projection: Projection;
  plate: PlateState;
  buildings: Building[];
  highways: LineFeature[];
  railways: LineFeature[];
  barriers: LineFeature[];
  waterLines: LineFeature[];
  waterAreas: AreaFeature[];
  landcover: AreaFeature[];
  structures: AreaFeature[];
  props: PointFeature[];
  places: PointFeature[];
  osmTrees: PointFeature[];
  terrain: TerrainData;
  far: FarField | null;
  weather: LiveWeather | null;
  osmSource: string;
  log: string[];
};

function parseMeters(value: string | undefined) {
  if (!value) return Number.NaN;
  const feet = /(\d+(?:\.\d+)?)\s*(?:ft|')/.exec(value);
  if (feet) return Number(feet[1]) * 0.3048;
  return Number.parseFloat(value.replace(",", "."));
}

const TYPE_HEIGHTS: Record<string, number> = {
  shed: 3,
  garage: 3,
  garages: 3,
  hut: 3,
  roof: 4,
  carport: 2.8,
  kiosk: 3,
  house: 7,
  detached: 7,
  bungalow: 4,
  terrace: 8,
  semidetached_house: 7.5,
  farm_auxiliary: 5,
  barn: 7,
  greenhouse: 3.5,
  residential: 14,
  apartments: 16,
  commercial: 14,
  office: 22,
  retail: 7,
  industrial: 9,
  warehouse: 9,
  school: 11,
  university: 15,
  hospital: 18,
  church: 20,
  cathedral: 35,
  basilica: 35,
  chapel: 8,
  temple: 15,
  mosque: 14,
  synagogue: 14,
  amphitheatre: 40,
  ruins: 6,
  stadium: 25,
  grandstand: 10,
  train_station: 12,
  hotel: 20,
  civic: 15,
  public: 15,
  palace: 22,
  castle: 18,
  tower: 25,
};

const ROAD_WIDTH: Record<string, number> = {
  motorway: 12,
  trunk: 11,
  primary: 10,
  secondary: 9,
  tertiary: 8,
  unclassified: 6,
  residential: 6,
  living_street: 5,
  service: 4,
  pedestrian: 6,
  footway: 2,
  path: 1.4,
  cycleway: 2,
  steps: 2,
  track: 3,
};

const worker = new Worker(new URL("../vision/worker.ts", import.meta.url), { type: "module" });
let requestId = 0;

function runAnalysis(input: AnalysisInput) {
  return new Promise<AnalysisResult>((resolve, reject) => {
    const id = ++requestId;
    const listener = (event: MessageEvent<WorkerReply>) => {
      if (event.data.id !== id) return;
      worker.removeEventListener("message", listener);
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.addEventListener("message", listener);
    worker.postMessage({ id, input }, [input.rgba.buffer]);
  });
}

function sourceOf(ref: PlateRef) {
  if (ref.kind === "wayback") return `wb-${ref.release}`;
  if (ref.kind === "tiles") return ref.source;
  return null;
}

export async function readPlate(ref: PlateRef, spec: FieldSpec, onStep: (text: string) => void, known?: HTMLCanvasElement) {
  const source = sourceOf(ref);
  if (known) return known;
  if (source) {
    const { canvas } = await stitchPlate(spec.bbox, source, spec.zoom, (done, total) => {
      if (done % 8 === 0 || done === total) onStep(`Sviluppo la lastra: ${done}/${total} tessere`);
    });
    return canvas;
  }
  const upload = ref as Extract<PlateRef, { kind: "upload" }>;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Lastra caricata non leggibile"));
    el.src = upload.url;
  });
  const limit = 8192 / Math.max(image.naturalWidth, image.naturalHeight);
  const scale = Math.min(1, limit);
  return scaleCanvas(image, Math.round(image.naturalWidth * scale), Math.round(image.naturalHeight * scale));
}

/** Reads one plate against the mapped world: same call for the first descent and for every jump through time. */
export async function interpretPlate(
  ref: PlateRef,
  canvas: HTMLCanvasElement,
  ctx: {
    projection: Projection;
    footprints: Footprint[];
    roads: AnalysisInput["roads"];
    water: number[][];
    osmTrees: AnalysisInput["osmTrees"];
    pxScale: number;
    grid: { width: number; height: number; mpp: number };
    heightAt: (x: number, z: number) => number;
    elevation: Float32Array;
    elevationStep: number;
  },
): Promise<PlateState> {
  const { projection: p, grid } = ctx;
  const small = scaleCanvas(canvas, grid.width, grid.height);
  const rgba = small.getContext("2d")!.getImageData(0, 0, grid.width, grid.height).data;
  const capture = ref.kind === "tiles" ? null : ref.capture;
  const analysis = await runAnalysis({
    rgba: new Uint8ClampedArray(rgba),
    width: grid.width,
    height: grid.height,
    mpp: grid.mpp,
    lat: p.lat0,
    lon: p.lon0,
    captureDate: capture?.date ?? null,
    manualSun: ref.kind === "upload" ? ref.manualSun : null,
    footprints: ctx.footprints,
    roads: ctx.roads,
    water: ctx.water,
    osmTrees: ctx.osmTrees,
    elevation: ctx.elevation,
    elevationStep: ctx.elevationStep,
  });
  const offX = p.halfX;
  const offZ = p.halfZ;
  const trees: TreeInstance[] = analysis.trees.map((tree) => ({
    x: tree.x - offX,
    z: tree.y - offZ,
    r: tree.r,
    h: tree.h,
    origin: tree.origin,
    color: tree.color,
    kind: tree.kind,
    source: tree.source,
    species: tree.species,
  }));
  const masses: Building[] = analysis.masses.map((mass, index) => {
    const ring: number[] = [];
    for (let i = 0; i < mass.ring.length; i += 2) ring.push(mass.ring[i]! * grid.mpp - offX, mass.ring[i + 1]! * grid.mpp - offZ);
    const heights = [0, 2, 4, 6].map((i) => ctx.heightAt(ring[i]!, ring[i + 1]!));
    const base = Math.min(...heights);
    const tops = heights.reduce((a, b) => a + b, 0) / 4;
    return {
      id: `dedotto-${index}`,
      rings: [ring],
      tags: { "sestante:origine": "dedotto dalla ripresa" },
      height: mass.h,
      minHeight: 0,
      source: "ripresa",
      confidence: mass.confidence,
      levels: Math.max(1, Math.round(mass.h / 3.2)),
      base,
      top: tops + mass.h,
      roofShape: "flat",
      roofHeight: 0,
      roofTone: mass.color,
      isPart: false,
      hidden: false,
      area: Math.abs(ringArea(ring)),
      shadowHeight: mass.h,
    } satisfies Building;
  });
  return { ref, canvas, analysis, trees, masses };
}

function sampleTerrarium(bitmaps: Map<string, ImageData>, z: number, lat: number, lon: number) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const read = (px: number, py: number) => {
    const tx = Math.floor(px / 256);
    const ty = Math.floor(py / 256);
    const img = bitmaps.get(`${tx}/${ty}`);
    if (!img) return Number.NaN;
    const i = ((py - ty * 256) * 256 + (px - tx * 256)) * 4;
    return img.data[i]! * 256 + img.data[i + 1]! + img.data[i + 2]! / 256 - 32768;
  };
  const gx = fx * 256 - 0.5;
  const gy = fy * 256 - 0.5;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  // Catmull-Rom: bilinear DEMs show a visible grid when walked at eye level.
  const cubic = (a: number, b: number, c: number, d: number, t: number) => b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  const row = (y: number) => cubic(read(x0 - 1, y), read(x0, y), read(x0 + 1, y), read(x0 + 2, y), tx);
  return cubic(row(y0 - 1), row(y0), row(y0 + 1), row(y0 + 2), ty);
}

async function loadDem(bbox: Bbox, z: number) {
  const n = 2 ** z;
  const col = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const row = (lat: number) => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  };
  const jobs: [number, number][] = [];
  for (let x = col(bbox.w) - 1; x <= col(bbox.e) + 1; x++) for (let y = row(bbox.n) - 1; y <= row(bbox.s) + 1; y++) jobs.push([x, y]);
  const out = new Map<string, ImageData>();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < jobs.length) {
        const [x, y] = jobs[cursor++]!;
        const res = await fetch(`/api/tile/dem/${z}/${x}/${y}`).catch(() => null);
        if (!res?.ok) continue;
        const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        // Elevation is data, not picture: the canvas read must not be colour-managed away from the encoded bytes.
        const local = document.createElement("canvas");
        local.width = local.height = 256;
        const lctx = local.getContext("2d", { willReadFrequently: true })!;
        lctx.drawImage(bitmap, 0, 0);
        out.set(`${x}/${y}`, lctx.getImageData(0, 0, 256, 256));
        bitmap.close();
      }
    }),
  );
  void ctx;
  return out;
}

function fillGaps(heights: Float32Array, size: number) {
  for (let pass = 0; pass < 8; pass++) {
    let missing = 0;
    for (let k = 0; k < heights.length; k++) {
      if (Number.isFinite(heights[k]!)) continue;
      missing++;
      let sum = 0;
      let count = 0;
      for (const q of [k - 1, k + 1, k - size, k + size]) {
        const v = heights[q];
        if (v != null && Number.isFinite(v)) {
          sum += v;
          count++;
        }
      }
      if (count) heights[k] = sum / count;
    }
    if (!missing) break;
  }
  for (let k = 0; k < heights.length; k++) if (!Number.isFinite(heights[k]!)) heights[k] = 0;
}

function blurField(src: Float32Array, size: number, radius: number) {
  const a = new Float32Array(src);
  const b = new Float32Array(src.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < size; y++) {
      let acc = 0;
      for (let x = -radius; x <= radius; x++) acc += a[y * size + Math.max(0, Math.min(size - 1, x))]!;
      for (let x = 0; x < size; x++) {
        b[y * size + x] = acc / (2 * radius + 1);
        acc += a[y * size + Math.min(size - 1, x + radius + 1)]! - a[y * size + Math.max(0, x - radius)]!;
      }
    }
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) acc += b[Math.max(0, Math.min(size - 1, y)) * size + x]!;
      for (let y = 0; y < size; y++) {
        a[y * size + x] = acc / (2 * radius + 1);
        acc += b[Math.min(size - 1, y + radius + 1) * size + x]! - b[Math.max(0, y - radius) * size + x]!;
      }
    }
  }
  return a;
}

export function terrainSampler(terrain: TerrainData) {
  const { size, spacing, heights } = terrain;
  const half = ((size - 1) * spacing) / 2;
  return (x: number, z: number) => {
    const gx = Math.max(0, Math.min(size - 1.001, (x + half) / spacing));
    const gz = Math.max(0, Math.min(size - 1.001, (z + half) / spacing));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const tx = gx - i;
    const tz = gz - j;
    const k = j * size + i;
    return heights[k]! * (1 - tx) * (1 - tz) + heights[k + 1]! * tx * (1 - tz) + heights[k + size]! * (1 - tx) * tz + heights[k + size + 1]! * tx * tz;
  };
}

function pad(bbox: Bbox, meters: number): Bbox {
  const lat = meters / 111320;
  const lon = lat / Math.cos((((bbox.s + bbox.n) / 2) * Math.PI) / 180);
  return { s: bbox.s - lat, n: bbox.n + lat, w: bbox.w - lon, e: bbox.e + lon };
}

/** A national survey's bare ground, where one covers the whole area. The terrain has a margin beyond the box, so partial coverage is common. */
async function lidarTerrain(box: Bbox, cols: number, rows: number) {
  const offers = await api.lidarCoverage(box).catch(() => []);
  const offer = offers.find((row) => row.share > 0.5);
  if (!offer) return null;
  const raw = await api.lidarGrid(offer.id, "dtm", box, cols, rows).catch(() => null);
  return raw ? closeGaps(raw, cols, rows).heights : null;
}

/** A second elevation model on the terrain grid. Null when the service is out of reach, so the caller keeps its first source. */
async function otherDemGrid(projection: Projection, size: number, spacing: number, half: number, source: "copernicus" | "nasadem" | "lidar") {
  const corners = [projection.toLatLon(-half, -half), projection.toLatLon(half, half)];
  const box: Bbox = { n: corners[0]!.lat, w: corners[0]!.lon, s: corners[1]!.lat, e: corners[1]!.lon };
  const cols = Math.min(1024, size);
  const rows = Math.min(1024, size);
  const grid = source === "lidar" ? await lidarTerrain(box, cols, rows) : await api.demGrid(box, cols, rows, source).catch(() => null);
  if (!grid) return null;
  const out = new Float32Array(size * size);
  let holes = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const { lat, lon } = projection.toLatLon(-half + i * spacing, -half + j * spacing);
      const fx = ((lon - box.w) / (box.e - box.w)) * cols - 0.5;
      const fy = ((box.n - lat) / (box.n - box.s)) * rows - 0.5;
      const ix = Math.max(0, Math.min(cols - 2, Math.floor(fx)));
      const iy = Math.max(0, Math.min(rows - 2, Math.floor(fy)));
      const tx = Math.max(0, Math.min(1, fx - ix));
      const ty = Math.max(0, Math.min(1, fy - iy));
      const at = (a: number, b: number) => grid[b * cols + a]!;
      const v = at(ix, iy) * (1 - tx) * (1 - ty) + at(ix + 1, iy) * tx * (1 - ty) + at(ix, iy + 1) * (1 - tx) * ty + at(ix + 1, iy + 1) * tx * ty;
      if (!Number.isFinite(v)) holes++;
      out[j * size + i] = v;
    }
  }
  return { heights: out, holes };
}

export async function loadField(spec: FieldSpec, onStep: (text: string) => void, knownCanvas?: HTMLCanvasElement, demSource: "terrarium" | "copernicus" | "nasadem" | "lidar" = "terrarium"): Promise<{ data: FieldData; rereadCtx: Parameters<typeof interpretPlate>[2] }> {
  const projection = new Projection(spec.bbox);
  const log: string[] = [];

  onStep("Leggo le quote del terreno");
  const span = Math.max(projection.halfX, projection.halfZ) * 2;
  const margin = 80;
  const spanTotal = span + margin * 2;
  const demZ = spanTotal > 12000 ? 13 : spanTotal > 5000 ? 14 : 15;
  const dem = await loadDem(pad(spec.bbox, margin + 60), demZ);
  const size = Math.max(129, Math.min(641, Math.ceil(spanTotal / 2.2) | 1));
  const spacing = spanTotal / (size - 1);
  const half = spanTotal / 2;
  const raw = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const { lat, lon } = projection.toLatLon(-half + i * spacing, -half + j * spacing);
      const h = sampleTerrarium(dem, demZ, lat, lon);
      raw[j * size + i] = h > -500 && h < 9000 ? h : Number.NaN;
    }
  }
  fillGaps(raw, size);
  log.push(`Terreno ${size}×${size} a ${spacing.toFixed(1)} m, quote DEM z${demZ}.`);
  if (demSource !== "terrarium") {
    const demName = demSource === "copernicus" ? "Copernicus GLO-30" : demSource === "lidar" ? "LiDAR nazionale" : "NASADEM";
    onStep(`Leggo le quote ${demName}`);
    const cop = await otherDemGrid(projection, size, spacing, half, demSource);
    if (cop && cop.holes < raw.length * 0.5) {
      let sum = 0;
      let count = 0;
      for (let k = 0; k < raw.length; k++) {
        const v = cop.heights[k]!;
        if (!Number.isFinite(v)) continue;
        sum += v - raw[k]!;
        count++;
        raw[k] = v;
      }
      log.push(`Quote da ${demName}: in media ${(count ? sum / count : 0).toFixed(1)} m rispetto a Terrarium.`);
    } else log.push(`${demName} non raggiunto: restano le quote Terrarium.`);
  }

  onStep("Interrogo OpenStreetMap");
  let bundle: OsmBundle;
  try {
    bundle = await api.osm<OsmBundle>(pad(spec.bbox, margin));
    log.push(`Archivio mappato: ${bundle.source}.`);
  } catch (error) {
    bundle = { source: "nessuno", buildings: [], parts: [], highways: [], railways: [], waterAreas: [], waterLines: [], landcover: [], barriers: [], structures: [], trees: [], props: [], places: [] };
    log.push(`OSM non raggiunto (${(error as Error).message}): resta ciò che si legge dalla ripresa.`);
  }

  const toFlat = (ring: LatLon[]) => {
    const flat: number[] = [];
    const count = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.length - 1 : ring.length;
    for (let i = 0; i < count; i++) {
      const { x, z } = projection.toLocal(ring[i]![0], ring[i]![1]);
      flat.push(x, z);
    }
    return flat;
  };
  const inBox = (x: number, z: number, extra = 0) => Math.abs(x) <= projection.halfX + extra && Math.abs(z) <= projection.halfZ + extra;
  const groupRings = (feature: OsmFeature) => {
    const rings = (feature.rings ?? []).map(toFlat);
    const outerCount = Number(feature.tags._outer ?? rings.length);
    const groups: number[][][] = rings.slice(0, outerCount).map((ring) => [ring]);
    for (const hole of rings.slice(outerCount)) {
      const owner = groups.find((group) => pointInRing(hole[0]!, hole[1]!, group[0]!));
      if (owner) owner.push(hole);
    }
    return groups;
  };

  // The analysis grid: fine enough to separate crowns, cheap enough to stay under a few seconds.
  onStep("Sviluppo la lastra");
  const canvas = await readPlate(spec.plate, spec, onStep, knownCanvas);
  const gridMpp = Math.max((projection.halfX * 2) / canvas.width, (span / 2048));
  const analysisMpp = Math.max(0.42, gridMpp);
  const grid = {
    width: Math.max(16, Math.round((projection.halfX * 2) / analysisMpp)),
    height: Math.max(16, Math.round((projection.halfZ * 2) / analysisMpp)),
    mpp: analysisMpp,
  };
  const toPx = (ring: number[]) => ring.map((v, i) => (i % 2 ? (v + projection.halfZ) / grid.mpp : (v + projection.halfX) / grid.mpp));

  // Mapped features.
  type Pending = Omit<Building, "base" | "top" | "height" | "source" | "confidence" | "roofTone" | "shadowHeight"> & { tagHeight: number | null; levelHeight: number | null };
  const pending: Pending[] = [];
  const addBuilding = (feature: OsmFeature, isPart: boolean) => {
    groupRings(feature).forEach((rings, index) => {
      const outer = rings[0]!;
      if (outer.length < 6) return;
      let inside = false;
      for (let i = 0; i < outer.length; i += 2) if (inBox(outer[i]!, outer[i + 1]!, 8)) inside = true;
      if (!inside) return;
      const tags = feature.tags;
      const levelsTag = Number.parseFloat(tags["building:levels"] ?? tags.levels ?? "");
      const roofLevels = Number.parseFloat(tags["roof:levels"] ?? "");
      const tagHeight = parseMeters(tags.height ?? tags["building:height"] ?? tags.est_height);
      const levels = Number.isFinite(levelsTag) ? Math.max(1, levelsTag) : 0;
      const minLevel = Number.parseFloat(tags["building:min_level"] ?? tags.min_level ?? "");
      const minTag = parseMeters(tags.min_height ?? tags["building:min_height"]);
      const roofTag = parseMeters(tags["roof:height"]);
      pending.push({
        id: `${feature.id}${index ? `-${index}` : ""}`,
        rings,
        tags,
        tagHeight: Number.isFinite(tagHeight) && tagHeight > 0 ? tagHeight : null,
        levelHeight: levels ? levels * 3.2 + (Number.isFinite(roofLevels) ? roofLevels * 2.8 : 0) : null,
        minHeight: Number.isFinite(minTag) ? minTag : Number.isFinite(minLevel) ? minLevel * 3.2 : 0,
        levels,
        roofShape: tags["roof:shape"] ?? "",
        roofHeight: Number.isFinite(roofTag) ? roofTag : 0,
        isPart,
        hidden: false,
        area: Math.abs(ringArea(outer)),
      });
    });
  };
  for (const feature of bundle.buildings) addBuilding(feature, false);
  for (const feature of bundle.parts) addBuilding(feature, true);

  const parts = pending.filter((item) => item.isPart);
  for (const item of pending) {
    if (item.isPart) continue;
    const covered = parts.some((part) => {
      let cx = 0;
      let cz = 0;
      const ring = part.rings[0]!;
      for (let i = 0; i < ring.length; i += 2) {
        cx += ring[i]!;
        cz += ring[i + 1]!;
      }
      return pointInRing(cx / (ring.length / 2), cz / (ring.length / 2), item.rings[0]!);
    });
    if (covered) item.hidden = true;
    for (const part of parts) {
      let cx = 0;
      let cz = 0;
      const ring = part.rings[0]!;
      for (let i = 0; i < ring.length; i += 2) {
        cx += ring[i]!;
        cz += ring[i + 1]!;
      }
      if (!pointInRing(cx / (ring.length / 2), cz / (ring.length / 2), item.rings[0]!)) continue;
      const inherited = ["building", "historic", "historic:civilization", "building:architecture", "building:material", "building:colour", "ruins", "name"];
      for (const key of inherited) if (item.tags[key] && !part.tags[key]) part.tags = { ...part.tags, [key]: item.tags[key]! };
    }
  }

  const highways: LineFeature[] = bundle.highways.map((feature) => {
    const tags = feature.tags;
    const lanes = Number.parseFloat(tags.lanes ?? "");
    const tagged = parseMeters(tags.width);
    const width = Number.isFinite(tagged) ? tagged : Number.isFinite(lanes) ? lanes * 3.2 : (ROAD_WIDTH[tags.highway ?? ""] ?? 4);
    return { id: feature.id, tags, pts: toFlat(feature.line!), width };
  });
  const lineOf = (feature: OsmFeature, width: number): LineFeature => ({ id: feature.id, tags: feature.tags, pts: toFlat(feature.line!), width });
  const waterAreas: AreaFeature[] = bundle.waterAreas.map((feature) => ({ id: feature.id, tags: feature.tags, rings: (feature.rings ?? []).map(toFlat) }));
  const waterLines = bundle.waterLines.map((feature) => {
    const tagged = parseMeters(feature.tags.width);
    const kind = feature.tags.waterway;
    return lineOf(feature, Number.isFinite(tagged) ? tagged : kind === "river" ? 30 : kind === "canal" ? 10 : kind === "stream" ? 2.5 : 1.5);
  });
  const pointOf = (feature: OsmFeature): PointFeature => {
    if (feature.at) {
      const { x, z } = projection.toLocal(feature.at[0], feature.at[1]);
      return { id: feature.id, tags: feature.tags, x, z };
    }
    const ring = toFlat(feature.rings?.[0] ?? []);
    let x = 0;
    let z = 0;
    for (let i = 0; i < ring.length; i += 2) {
      x += ring[i]!;
      z += ring[i + 1]!;
    }
    return { id: feature.id, tags: feature.tags, x: x / Math.max(1, ring.length / 2), z: z / Math.max(1, ring.length / 2) };
  };
  const osmTrees = bundle.trees.map(pointOf).filter((tree) => inBox(tree.x, tree.z));

  const footprints: Footprint[] = pending
    .filter((item) => !item.isPart)
    .map((item) => ({
      id: item.id,
      rings: item.rings.map(toPx),
      tagHeight: item.tagHeight ?? item.levelHeight ?? undefined,
    }));
  const roads = highways
    .filter((road) => !["footway", "path", "steps", "cycleway", "track", "corridor", "proposed", "construction"].includes(road.tags.highway ?? "") && road.tags.tunnel !== "yes")
    .map((road) => ({ pts: toPx(road.pts), halfWidth: road.width / 2 / grid.mpp }));
  const waterPx = [...waterAreas.flatMap((area) => area.rings)].map(toPx);

  // Terrain: SRTM is a surface model, so a city's roofs show through as bumps: smooth harder where it is built.
  const built = new Float32Array(size * size);
  for (const item of pending) {
    if (item.isPart) continue;
    const ring = item.rings[0]!;
    for (let i = 0; i < ring.length; i += 2) {
      const gx = Math.round((ring[i]! + half) / spacing);
      const gz = Math.round((ring[i + 1]! + half) / spacing);
      if (gx >= 0 && gz >= 0 && gx < size && gz < size) built[gz * size + gx] = 1;
    }
  }
  const density = blurField(built, size, Math.round(20 / spacing));
  let peak = 0;
  for (const v of density) peak = Math.max(peak, v);
  const soft = blurField(raw, size, Math.max(1, Math.round(9 / spacing)));
  const hard = blurField(raw, size, Math.max(2, Math.round(28 / spacing)));
  const heights = new Float32Array(size * size);
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    const t = peak > 0 ? Math.min(1, (density[k]! / peak) * 2.5) : 0;
    const value = soft[k]! * (1 - t) + hard[k]! * t;
    heights[k] = value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const terrain: TerrainData = { size, spacing, heights, min, max };
  const heightAt = terrainSampler(terrain);

  onStep("Leggo ombre, sole, chiome e tetti dalla ripresa");
  const elevationStep = Math.max(2, Math.round(10 / grid.mpp));
  const elevW = Math.ceil(grid.width / elevationStep);
  const elevH = Math.ceil(grid.height / elevationStep);
  const elevation = new Float32Array(elevW * elevH);
  for (let y = 0; y < elevH; y++) {
    for (let x = 0; x < elevW; x++) elevation[y * elevW + x] = heightAt((x + 0.5) * elevationStep * grid.mpp - projection.halfX, (y + 0.5) * elevationStep * grid.mpp - projection.halfZ);
  }
  const context = {
    elevation,
    elevationStep,
    projection,
    footprints,
    roads,
    water: waterPx,
    osmTrees: osmTrees.map((tree) => ({ x: (tree.x + projection.halfX) / grid.mpp, y: (tree.z + projection.halfZ) / grid.mpp, tags: tree.tags })),
    pxScale: 1 / grid.mpp,
    grid,
    heightAt,
  };
  const plate = await interpretPlate(spec.plate, canvas, context);
  const reading = plate.analysis;
  const shift = reading.registration;
  if (shift.applied) log.push(`Mappa e lastra co-registrate: spostamento ${shift.dx.toFixed(1)} m E, ${(-shift.dy).toFixed(1)} m N.`);

  const applyShift = (ring: number[]) => {
    if (!shift.applied) return ring;
    return ring.map((v, i) => v + (i % 2 ? shift.dy : shift.dx));
  };

  const measured: { x: number; z: number; h: number }[] = [];
  const centroid = (ring: number[]) => {
    let x = 0;
    let z = 0;
    for (let i = 0; i < ring.length; i += 2) {
      x += ring[i]!;
      z += ring[i + 1]!;
    }
    return { x: x / (ring.length / 2), z: z / (ring.length / 2) };
  };
  for (const item of pending) {
    const read = reading.heights[item.id];
    const known = item.tagHeight ?? item.levelHeight ?? (read?.h != null && read.confidence > 0.2 ? read.h : null);
    if (known != null && !item.isPart) measured.push({ ...centroid(item.rings[0]!), h: known });
  }

  const buildings: Building[] = pending.map((item) => {
    const rings = item.rings.map(applyShift);
    const read = reading.heights[item.id];
    const kind = item.tags.building ?? item.tags["building:part"] ?? "yes";
    let height: number;
    let source: HeightSource;
    let confidence: number;
    if (item.tagHeight != null) {
      height = item.tagHeight;
      source = "OSM height";
      confidence = 1;
    } else if (item.levelHeight != null) {
      height = item.levelHeight;
      source = "OSM piani";
      confidence = 0.85;
    } else if (read?.h != null && read.confidence > 0.2) {
      height = read.h;
      source = "ombra";
      confidence = read.confidence;
    } else {
      const c = centroid(item.rings[0]!);
      const near = measured.filter((row) => Math.hypot(row.x - c.x, row.z - c.z) < 180).map((row) => row.h).sort((a, b) => a - b);
      if (near.length >= 3 && !TYPE_HEIGHTS[kind]) {
        height = near[near.length >> 1]!;
        source = "quartiere";
        confidence = 0.35;
      } else {
        height = TYPE_HEIGHTS[kind] ?? 9;
        source = "tipo edilizio";
        confidence = 0.2;
      }
    }
    const outer = rings[0]!;
    let base = Infinity;
    let sum = 0;
    const count = outer.length / 2;
    for (let i = 0; i < outer.length; i += 2) {
      const h = heightAt(outer[i]!, outer[i + 1]!);
      base = Math.min(base, h);
      sum += h;
    }
    const tone = reading.roofTones[item.id] ?? ([0.5, 0.46, 0.42] as [number, number, number]);
    let roofShape = item.roofShape;
    let roofHeight = item.roofHeight;
    const solidKinds = ["pyramid", "tumulus", "mound"];
    if (solidKinds.includes(kind) || item.tags.man_made === "pyramid" || item.tags.historic === "pyramid") {
      roofShape = kind === "tumulus" || kind === "mound" ? "dome" : "pyramidal";
      roofHeight = height;
    }
    if (!roofShape && !item.isPart) {
      // Terracotta tones from the plate suggest a pitched roof where the map says nothing.
      const reddish = tone[0] > tone[1] * 1.14 && tone[0] > tone[2] * 1.3;
      if (reddish && item.area < 900 && item.rings.length === 1) roofShape = "hipped";
    }
    if (roofShape && roofShape !== "flat" && !roofHeight) {
      const width = Math.sqrt(item.area);
      roofHeight = roofShape === "dome" || roofShape === "onion" ? width * 0.42 : Math.min(height * 0.45, Math.max(1.4, width * 0.24));
    }
    if (item.levels === 0) item.levels = Math.max(1, Math.round((height - roofHeight) / 3.2));
    return {
      ...item,
      rings,
      height,
      source,
      confidence,
      roofShape: roofShape || "flat",
      roofHeight,
      roofTone: tone,
      base,
      top: sum / count + height,
      shadowHeight: read?.h ?? null,
    } satisfies Building;
  });

  // Footprints the plate shows but the map does not, once checked against what is mapped.
  plate.masses = plate.masses.filter((mass) => mass.area > 18);

  onStep("Guardo la terra intorno alla ripresa");
  const far = await loadFarField(spec, projection, plate.ref).catch(() => null);

  onStep("Chiedo il tempo alla stazione");
  const weather = await api.weather<LiveWeather>(projection.lat0, projection.lon0).catch(() => null);
  if (weather) log.push(`Meteo reale ${weather.timezone}, fonte Open-Meteo.`);

  const shiftLine = (line: LineFeature): LineFeature => ({ ...line, pts: applyShift(line.pts) });
  const shiftPoint = (point: PointFeature): PointFeature => (shift.applied ? { ...point, x: point.x + shift.dx, z: point.z + shift.dy } : point);

  return {
    rereadCtx: context,
    data: {
      spec,
      projection,
      plate,
      buildings,
      highways: highways.map(shiftLine),
      railways: bundle.railways.map((feature) => shiftLine(lineOf(feature, 1.6))),
      barriers: bundle.barriers.map((feature) => shiftLine(lineOf(feature, 0.3))),
      waterLines: waterLines.map(shiftLine),
      waterAreas,
      landcover: bundle.landcover.map((feature) => ({ id: feature.id, tags: feature.tags, rings: (feature.rings ?? []).map(toFlat) })),
      structures: bundle.structures.map((feature) => ({ id: feature.id, tags: feature.tags, rings: (feature.rings ?? []).map(toFlat).map(applyShift) })),
      props: bundle.props.map(pointOf).map(shiftPoint).filter((prop) => inBox(prop.x, prop.z)),
      places: bundle.places.map(pointOf).map(shiftPoint),
      osmTrees,
      terrain,
      far,
      weather,
      osmSource: bundle.source,
      log,
    },
  };
}

async function loadFarField(spec: FieldSpec, projection: Projection, ref: PlateRef): Promise<FarField> {
  const span = 24000;
  const k = projection.k;
  const box: Bbox = {
    w: projection.toLatLon(-span / 2, 0).lon,
    e: projection.toLatLon(span / 2, 0).lon,
    n: projection.toLatLon(0, -span / 2).lat,
    s: projection.toLatLon(0, span / 2).lat,
  };
  void k;
  const source = ref.kind === "wayback" ? `wb-${ref.release}` : ref.kind === "tiles" && ref.source !== "dem" ? ref.source : "esri";
  const z = bestZoom(box, 2048, 15);
  const { canvas } = await stitchPlate(box, source, z);
  const demZ = 11;
  const dem = await loadDem(box, demZ);
  const size = 129;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = -span / 2 + (i / (size - 1)) * span;
      const zz = -span / 2 + (j / (size - 1)) * span;
      const { lat, lon } = projection.toLatLon(x, zz);
      const h = sampleTerrarium(dem, demZ, lat, lon);
      heights[j * size + i] = h > -500 && h < 9000 ? h : Number.NaN;
    }
  }
  fillGaps(heights, size);
  return { size, span, heights, plate: canvas, attribution: spec.name };
}
