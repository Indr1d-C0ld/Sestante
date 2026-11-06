import type { Bbox } from "./geo.ts";
import { tileXY } from "./geo.ts";
import type { Capture, DownloadJob, Expedition, PlateVersion, TileSourceInfo } from "./types.ts";
import type { LaserShot } from "../vision/laser.ts";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(detail?.error ?? `Errore ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const post = <T,>(url: string, value: unknown) =>
  getJson<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

export type GeocodeHit = { name: string; lat: number; lon: number; type: string; bbox?: number[] };

export type EarthProduct = { id: string; label: string; note: string; sensor: "s2" | "s1"; composite?: boolean };
export type EarthScene = { id: string; date: string; time: string; cloud: number };
export type NdviRow = { from: string; to: string; mean: number; stDev: number; min: number; max: number; samples: number };
export type FireRow = { lat: number; lon: number; date: string; time: string; sensor: string; satellite: string; confidence: string; brightness: number; frp: number; night: boolean };
export type AirNow = { aqi: number; pm25: number; pm10: number; o3: number; no2: number; so2: number; co: number; nh3: number; at: string };
export type ForecastRow = { at: string; temp: number; pressure: number; humidity: number; wind: number; windDir: number; cloud: number; pop: number; rain: number; snow: number; description: string };
export type OwmNow = { station: string; at: string; description: string; temp: number; feels: number; humidity: number; pressure: number; wind: number; windDir: number; gust: number | null; cloud: number; visibility: number | null; air: AirNow | null; forecast: ForecastRow[] };
export type DeepLayer = { id: string; label: string; note: string; ext: string; maxZoom: number; times: string[] };
export type NasaEntry = { id: string; label: string; note: string; count: number | null; newest: string | null };
export type PlacePhoto = { id: string; source: "panoramax" | "commons"; title: string; lat: number; lon: number; date: string | null; heading: number | null; fov: number | null; pano: boolean; thumb: string; full: string; author: string; license: string; link: string };
export type PlaceArticle = { id: string; title: string; lat: number; lon: number; text: string; link: string; lang: string };
export type GediStatus = { state: "assente" | "in corso" | "pronto" | "fallito"; progress: number; message: string; granules: number; shots: LaserShot[]; at: string | null };
export type ServiceState = { id: string; label: string; state: "pronta" | "assente" | "scaduta"; detail: string };

const boxQuery = (b: Bbox) => `s=${b.s}&w=${b.w}&n=${b.n}&e=${b.e}`;

export type LidarOffer = { id: string; name: string; country: string; resolution: number; surface: boolean; license: string; url: string; share: number; error: string | null };

/** One line of the archive: enough to find an investigation again without opening it. */
export type ArchiveRow = {
  id: string;
  name?: string;
  bbox?: Bbox;
  updated: string;
  status: "aperta" | "conclusa";
  plate: string;
  thumb: string | null;
  notes: number;
  hypotheses: number;
  masses: number;
  routes: number;
  places: number;
  photoFinds: number;
  studies: { id: string; name: string; created: string; photo: string | null }[];
  search: string;
};

export const api = {
  services: () => getJson<ServiceState[]>("/api/services"),
  earthProducts: () => getJson<EarthProduct[]>("/api/earth/products"),
  earthScenes: (b: Bbox, from: string, to: string, cloud: number) => getJson<EarthScene[]>(`/api/earth/scenes?${boxQuery(b)}&from=${from}&to=${to}&cloud=${cloud}`),
  earthImageUrl: (b: Bbox, product: string, from: string, to: string | null, width: number, height: number) => `/api/earth/image?${boxQuery(b)}&product=${product}&from=${from}${to ? `&to=${to}` : ""}&width=${Math.round(width)}&height=${Math.round(height)}`,
  earthSpectrumUrl: (b: Bbox, from: string, to: string, width: number, height: number) => `/api/earth/spectrum?${boxQuery(b)}&from=${from}&to=${to}&width=${Math.round(width)}&height=${Math.round(height)}`,
  ndvi: (b: Bbox, from: string, to: string, days: number) => getJson<NdviRow[]>(`/api/earth/ndvi?${boxQuery(b)}&from=${from}&to=${to}&days=${days}`),
  fires: (b: Bbox, days: number, date: string | null) => getJson<FireRow[]>(`/api/earth/fires?${boxQuery(b)}&days=${days}${date ? `&date=${date}` : ""}`),
  owm: (lat: number, lon: number) => getJson<OwmNow>(`/api/earth/owm?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`),
  deepLayers: () => getJson<DeepLayer[]>("/api/earth/deep"),
  catalog: (b: Bbox) => getJson<NasaEntry[]>(`/api/earth/catalog?${boxQuery(b)}`),
  photos: (b: Bbox, source: "panoramax" | "commons") => getJson<PlacePhoto[]>(`/api/place/photos?${boxQuery(b)}&source=${source}`),
  photoUrl: (url: string) => `/api/place/image?url=${encodeURIComponent(url)}`,
  articles: (lat: number, lon: number, radius: number) => getJson<PlaceArticle[]>(`/api/place/articles?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius=${Math.round(radius)}`),
  demGrid: async (b: Bbox, cols: number, rows: number, source: "copernicus" | "nasadem") => {
    const res = await fetch(`/api/earth/dem?${boxQuery(b)}&cols=${cols}&rows=${rows}&source=${source}`);
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `Quote ${source}: errore ${res.status}`);
    }
    return new Float32Array(await res.arrayBuffer());
  },
  gedi: (b: Bbox) => getJson<GediStatus>(`/api/earth/gedi?${boxQuery(b)}`),
  startGedi: (b: Bbox) => post<GediStatus>(`/api/earth/gedi?${boxQuery(b)}`, {}),

  sources: () => getJson<TileSourceInfo[]>("/api/sources"),
  sourcesProblem: () => getJson<{ problem: string | null }>("/api/sources/problem"),
  addSource: (value: Partial<TileSourceInfo>) => post<TileSourceInfo>("/api/sources", value),
  versions: (lat: number, lon: number, z = 17) => getJson<PlateVersion[]>(`/api/wayback/versions?lat=${lat}&lon=${lon}&z=${z}`),
  newestRelease: () => getJson<{ release: number; date: string }>("/api/wayback/newest"),
  capture: (release: number, lat: number, lon: number, z: number) => getJson<Capture | null>(`/api/wayback/capture?release=${release}&lat=${lat}&lon=${lon}&z=${z}`),
  geocode: (q: string) => getJson<GeocodeHit[]>(`/api/geocode?q=${encodeURIComponent(q)}`),
  osm: <T,>(b: Bbox) => getJson<T>(`/api/osm?s=${b.s}&w=${b.w}&n=${b.n}&e=${b.e}`),
  weather: <T,>(lat: number, lon: number) => getJson<T>(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`),
  pastWeather: <T,>(lat: number, lon: number, date: string) => getJson<T>(`/api/weather/past?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&date=${date}`),
  jobs: () => getJson<DownloadJob[]>("/api/jobs"),
  countTiles: (b: Bbox, zMin: number, zMax: number) => getJson<{ total: number }>(`/api/jobs/count?s=${b.s}&w=${b.w}&n=${b.n}&e=${b.e}&zMin=${zMin}&zMax=${zMax}`),
  startJob: (value: { name: string; source: string; bbox: Bbox; zMin: number; zMax: number; format: string }) => post<DownloadJob>("/api/jobs", value),
  cancelJob: (id: string) => fetch(`/api/jobs/${id}/cancel`, { method: "POST" }),
  expeditions: () => getJson<ArchiveRow[]>("/api/expeditions"),
  lidarCoverage: (b: Bbox) => getJson<LidarOffer[]>(`/api/earth/lidar/coverage?${boxQuery(b)}`),
  lidarGrid: async (id: string, kind: "dtm" | "dsm", b: Bbox, cols: number, rows: number) => {
    const res = await fetch(`/api/earth/lidar?${boxQuery(b)}&id=${id}&kind=${kind}&cols=${cols}&rows=${rows}`);
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `Rilievo laser: errore ${res.status}`);
    }
    return new Float32Array(await res.arrayBuffer());
  },
  trash: () => getJson<{ id: string; name?: string; trashed: string }[]>("/api/trash"),
  trashExpedition: (id: string) => fetch(`/api/expeditions/${id}`, { method: "DELETE" }),
  restoreExpedition: (id: string) => fetch(`/api/trash/${id}/restore`, { method: "POST" }),
  expedition: (id: string) => getJson<Expedition>(`/api/expeditions/${id}`),
  saveExpedition: (value: Expedition) =>
    fetch(`/api/expeditions/${value.spec.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
  uploadMedia: async (id: string, blob: Blob, ext: string) => {
    const res = await fetch(`/api/expeditions/${id}/media?ext=${ext}`, { method: "POST", body: blob });
    return ((await res.json()) as { url: string }).url;
  },
};

async function fetchBitmap(url: string, signal?: AbortSignal) {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return createImageBitmap(await res.blob());
}

/** Draws one tile, walking up to coarser zooms when an archive has no picture at this depth. */
async function drawTile(ctx: CanvasRenderingContext2D, source: string, z: number, x: number, y: number, dx: number, dy: number, size: number, signal?: AbortSignal) {
  for (let up = 0; up <= 4; up++) {
    const zz = z - up;
    const px = x >> up;
    const py = y >> up;
    const url = source.startsWith("gibs/") ? `/api/earth/${source}/${zz}/${px}/${py}` : `/api/tile/${source}/${zz}/${px}/${py}`;
    const bitmap = await fetchBitmap(url, signal).catch(() => null);
    if (!bitmap) continue;
    const span = 256 >> up;
    const sx = (x - (px << up)) * span;
    const sy = (y - (py << up)) * span;
    ctx.drawImage(bitmap, sx, sy, span, span, dx, dy, size, size);
    bitmap.close();
    return true;
  }
  return false;
}

/** Stitches a source into a canvas whose edges match the box exactly. */
export async function stitchPlate(bbox: Bbox, source: string, z: number, onProgress?: (done: number, total: number) => void, signal?: AbortSignal) {
  const a = tileXY(bbox.n, bbox.w, z);
  const b = tileXY(bbox.s, bbox.e, z);
  const width = Math.max(1, Math.round((b.x - a.x) * 256));
  const height = Math.max(1, Math.round((b.y - a.y) * 256));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;
  ctx.fillStyle = "#3b3d36";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  const x0 = Math.floor(a.x);
  const y0 = Math.floor(a.y);
  const x1 = Math.floor(b.x);
  const y1 = Math.floor(b.y);
  const jobs: { x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push({ x, y });
  let cursor = 0;
  let done = 0;
  let missing = 0;
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++]!;
        const dx = (job.x - a.x) * 256;
        const dy = (job.y - a.y) * 256;
        const ok = await drawTile(ctx, source, z, job.x, job.y, dx, dy, 256, signal);
        if (!ok) missing++;
        done++;
        onProgress?.(done, jobs.length);
      }
    }),
  );
  return { canvas, missing, total: jobs.length };
}

/** Loads a same-origin image into a canvas of the box's shape, so it can be draped or compared. */
export async function imageCanvas(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Errore ${res.status}`);
  }
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

export function scaleCanvas(source: HTMLCanvasElement | HTMLImageElement | ImageBitmap, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return canvas;
}

export async function canvasBlob(canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.92) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas vuoto"))), type, quality));
}
