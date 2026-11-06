import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA, UA, expandTemplate, resolveSource, type TileSource } from "./sources.ts";

export type Bbox = { s: number; w: number; n: number; e: number };
export type JobFormat = "directory" | "mbtiles" | "stitched";
export type JobRequest = { name: string; source: string; bbox: Bbox; zMin: number; zMax: number; format: JobFormat };

export type Job = JobRequest & {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  total: number;
  done: number;
  failed: number;
  fromCache: number;
  output: string;
  message: string;
  started: string;
  attribution: string;
};

const jobs = new Map<string, Job & { abort: AbortController }>();
const TILE_CACHE = join(DATA, "cache", "tiles");

export function tileRange(bbox: Bbox, z: number) {
  const n = 2 ** z;
  const col = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const row = (lat: number) => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  };
  return { x0: col(bbox.w), x1: col(bbox.e), y0: row(bbox.n), y1: row(bbox.s) };
}

export function countTiles(bbox: Bbox, zMin: number, zMax: number) {
  let count = 0;
  for (let z = zMin; z <= zMax; z++) {
    const r = tileRange(bbox, z);
    count += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  }
  return count;
}

export async function getTile(source: TileSource, z: number, x: number, y: number, signal?: AbortSignal) {
  const file = join(TILE_CACHE, source.id, String(z), String(x), `${y}.${source.ext}`);
  if (existsSync(file)) return { body: readFileSync(file), cached: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(expandTemplate(source.template, z, x, y), {
        headers: { "User-Agent": UA },
        signal: signal ?? AbortSignal.timeout(20_000),
      });
      if (res.status === 404 || res.status === 204) return null;
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
          continue;
        }
        return null;
      }
      const body = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      return { body, cached: false };
    } catch (error) {
      if (signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  return null;
}

function publicJob(job: Job & { abort: AbortController }): Job {
  const { abort: _abort, ...rest } = job;
  return rest;
}

export const listJobs = () => [...jobs.values()].map(publicJob).reverse();

export function cancelJob(id: string) {
  const job = jobs.get(id);
  if (job && job.state === "running") job.abort.abort();
}

export async function startJob(request: JobRequest): Promise<Job> {
  const source = await resolveSource(request.source);
  if (!source) throw new Error("Fonte sconosciuta.");
  const zMin = Math.max(0, Math.min(request.zMin, request.zMax));
  const zMax = Math.min(source.maxZoom, Math.max(request.zMin, request.zMax));
  const total = countTiles(request.bbox, zMin, zMax);
  if (total > 250_000) throw new Error(`${total} tessere: oltre il limite di 250 000 per lavoro. Riduci il riquadro o lo zoom.`);
  if (source.bulkLimit && total > source.bulkLimit) throw new Error(`${source.label}: al massimo ${source.bulkLimit} tessere per lavoro, ne hai chieste ${total}.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safe = (request.name || "riquadro").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40);
  const output = join(DATA, "downloads", `${stamp}_${safe}_${source.id}`);
  mkdirSync(output, { recursive: true });
  const job = {
    ...request,
    zMin,
    zMax,
    id: randomUUID().slice(0, 8),
    state: "running" as Job["state"],
    total,
    done: 0,
    failed: 0,
    fromCache: 0,
    output,
    message: "Scarico",
    started: new Date().toISOString(),
    attribution: source.attribution,
    abort: new AbortController(),
  };
  jobs.set(job.id, job);
  void run(job, source).catch((error: Error) => {
    job.state = job.abort.signal.aborted ? "cancelled" : "failed";
    job.message = job.abort.signal.aborted ? "Annullato" : error.message;
  });
  return publicJob(job);
}

async function run(job: Job & { abort: AbortController }, source: TileSource) {
  const items: { z: number; x: number; y: number }[] = [];
  for (let z = job.zMin; z <= job.zMax; z++) {
    const r = tileRange(job.bbox, z);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) items.push({ z, x, y });
  }

  let db: DatabaseSync | null = null;
  let insert: ReturnType<DatabaseSync["prepare"]> | null = null;
  if (job.format === "mbtiles") {
    db = new DatabaseSync(join(job.output, "tiles.mbtiles"));
    db.exec("CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);");
    const meta = db.prepare("INSERT INTO metadata VALUES (?, ?)");
    const { s, w, n, e } = job.bbox;
    for (const [key, value] of [
      ["name", job.name],
      ["format", source.ext],
      ["bounds", `${w},${s},${e},${n}`],
      ["center", `${(w + e) / 2},${(s + n) / 2},${job.zMax}`],
      ["minzoom", String(job.zMin)],
      ["maxzoom", String(job.zMax)],
      ["type", "baselayer"],
      ["attribution", source.attribution],
    ] as const)
      meta.run(key, value);
    insert = db.prepare("INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)");
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length && !job.abort.signal.aborted) {
      const { z, x, y } = items[cursor++]!;
      try {
        const tile = await getTile(source, z, x, y, job.abort.signal);
        if (!tile) job.failed++;
        else {
          if (tile.cached) job.fromCache++;
          if (job.format === "directory") {
            const file = join(job.output, String(z), String(x), `${y}.${source.ext}`);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, tile.body);
          } else if (insert) {
            insert.run(z, x, 2 ** z - 1 - y, tile.body);
          }
        }
      } catch {
        if (job.abort.signal.aborted) break;
        job.failed++;
      }
      job.done++;
    }
  };
  await Promise.all(Array.from({ length: source.bulkLimit ? 2 : 8 }, worker));
  db?.close();
  if (job.abort.signal.aborted) {
    job.state = "cancelled";
    job.message = "Annullato";
    return;
  }
  if (job.format === "stitched") {
    job.message = "Cucio il mosaico";
    await stitch(job, source);
  }
  writeFileSync(
    join(job.output, "provenienza.json"),
    JSON.stringify(
      {
        strumento: "Sestante 2",
        fonte: source.label,
        modello: source.template,
        attribuzione: source.attribution,
        riquadro: job.bbox,
        zoom: [job.zMin, job.zMax],
        formato: job.format,
        tessere: job.total,
        fallite: job.failed,
        scaricato: job.started,
      },
      null,
      1,
    ),
  );
  job.state = "done";
  job.message = job.failed ? `Finito, ${job.failed} tessere mancanti` : "Finito";
}

/** Writes a PNG mosaic of the deepest zoom plus a world file, so a GIS can place it without extra steps. */
async function stitch(job: Job, source: TileSource) {
  const { default: sharp } = await import("sharp");
  const z = job.zMax;
  const r = tileRange(job.bbox, z);
  const cols = r.x1 - r.x0 + 1;
  const rows = r.y1 - r.y0 + 1;
  const width = cols * 256;
  const height = rows * 256;
  if (width > 24_000 || height > 24_000) throw new Error("Mosaico oltre 24 000 px per lato: riduci riquadro o zoom.");
  const raster = Buffer.alloc(width * height * 3, 0);
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const tile = await getTile(source, z, x, y);
      if (!tile) continue;
      const pixels = await sharp(tile.body).removeAlpha().resize(256, 256).raw().toBuffer();
      const left = (x - r.x0) * 256;
      const top = (y - r.y0) * 256;
      for (let line = 0; line < 256; line++) {
        pixels.copy(raster, ((top + line) * width + left) * 3, line * 768, (line + 1) * 768);
      }
    }
  }
  await sharp(raster, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 6 }).toFile(join(job.output, `mosaico_z${z}.png`));
  const world = 40075016.685578488;
  const size = world / 2 ** z / 256;
  const ox = -world / 2 + (r.x0 / 2 ** z) * world;
  const oy = world / 2 - (r.y0 / 2 ** z) * world;
  writeFileSync(join(job.output, `mosaico_z${z}.pgw`), [size, 0, 0, -size, ox + size / 2, oy - size / 2].join("\n"));
  writeFileSync(join(job.output, `mosaico_z${z}.prj.txt`), "EPSG:3857 (Web Mercator)\n");
}
