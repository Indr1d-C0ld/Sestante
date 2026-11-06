import { lidarCoverage, lidarGrid } from "./lidar.ts";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { cancelJob, countTiles, getTile, listJobs, startJob, type JobRequest } from "./jobs.ts";
import { fetchBundle } from "./osm.ts";
import { allSources, customSources, DATA, resolveSource, ROOT, saveCustomSources, UA, waybackReleases, type TileSource } from "./sources.ts";
import { copernicusDem, deepLayers, fires, gibsTile, isKnownImage, nasaCatalog, ndviSeries, openWeather, owmTile, placeArticles, placePhotos, PRODUCTS, proxiedImage, sentinelImage, sentinelScenes, sentinelSpectrum, servicesStatus } from "./earth.ts";
import { forgetGedi, gediStatus, nasademGrid, startGedi } from "./nasa.ts";
import { scrub } from "./secrets.ts";

const PORT = Number(process.env.PORT ?? 4173);
const DEV = process.argv.includes("--dev");
const EXPEDITIONS = join(DATA, "expeditions");
mkdirSync(EXPEDITIONS, { recursive: true });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pbf": "application/x-protobuf",
  ".wasm": "application/wasm",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const TRASH = join(DATA, "cestino");

/** What the archive shows of one investigation, and the text it can be searched by. */
function archiveRow(id: string, file: string) {
  type Named = { id?: string; name?: string; title?: string; text?: string; note?: string; created?: string; photo?: string };
  const value = JSON.parse(readFileSync(file, "utf8")) as {
    spec?: { name?: string; bbox?: unknown; plate?: { kind?: string; published?: string; date?: string; capture?: { date?: string } } };
    notes?: (Named & { photo?: string })[];
    hypotheses?: Named[];
    masses?: Named[];
    routes?: Named[];
    studies?: Named[];
    photoFinds?: Named[];
    investigation?: { candidates?: unknown[] };
    thumb?: string;
    status?: string;
  };
  const plate = value.spec?.plate;
  const words = [value.spec?.name, ...(value.notes ?? []).flatMap((row) => [row.title, row.text]), ...(value.hypotheses ?? []).flatMap((row) => [row.name, row.note]), ...(value.studies ?? []).map((row) => row.name)];
  return {
    id,
    name: value.spec?.name,
    bbox: value.spec?.bbox,
    updated: statSync(file).mtime.toISOString(),
    status: value.status === "conclusa" ? "conclusa" : "aperta",
    plate: plate?.capture?.date ?? plate?.date ?? plate?.published ?? "",
    thumb: value.thumb ?? value.notes?.find((row) => row.photo)?.photo ?? null,
    notes: value.notes?.length ?? 0,
    hypotheses: value.hypotheses?.length ?? 0,
    masses: value.masses?.length ?? 0,
    routes: value.routes?.length ?? 0,
    places: value.investigation?.candidates?.length ?? 0,
    photoFinds: value.photoFinds?.length ?? 0,
    studies: (value.studies ?? []).map((row) => ({ id: row.id, name: row.name, created: row.created, photo: row.photo ?? null })),
    search: words.filter(Boolean).join(" ").toLowerCase().slice(0, 20000),
  };
}

const safeId = (id: string) => /^[\w-]{1,64}$/.test(id);

/** Small in-memory cache for upstream JSON services. */
const memo = new Map<string, { until: number; value: unknown }>();
async function cachedJson(key: string, ttl: number, load: () => Promise<unknown>) {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await load();
  memo.set(key, { until: Date.now() + ttl, value });
  return value;
}

function tileAt(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

type Capture = {
  date: string | null;
  sensor: string | null;
  provider: string | null;
  product: string | null;
  resolution: number | null;
  accuracy: number | null;
  block: string | null;
};

async function captureMetadata(metaUrl: string, lat: number, lon: number, z: number): Promise<Capture | null> {
  const pad = 0.002;
  const url = `${metaUrl}/identify?f=json&geometry=${lon},${lat}&geometryType=esriGeometryPoint&sr=4326&tolerance=0&mapExtent=${lon - pad},${lat - pad},${lon + pad},${lat + pad}&imageDisplay=400,400,96&layers=all&returnGeometry=false`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: { attributes: Record<string, string> }[] };
  const rows = (data.results ?? []).map((row) => row.attributes);
  if (!rows.length) return null;
  const pick =
    rows.find((row) => Number(row.MinMapLevel) <= z && z <= Number(row.MaxMapLevel)) ?? rows[0]!;
  const raw = String(pick.SRC_DATE ?? "");
  const date = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
  return {
    date,
    sensor: pick.SRC_DESC || null,
    provider: pick.NICE_DESC || null,
    product: pick.NICE_NAME || null,
    resolution: Number(pick.SRC_RES) || null,
    accuracy: Number(pick.SRC_ACC) || null,
    block: pick.BlockName || null,
  };
}

/** Finds which Wayback releases really carry a different picture of this place, by hashing the same tile through time. */
async function distinctVersions(lat: number, lon: number, z: number) {
  const dir = join(DATA, "cache", "versions");
  mkdirSync(dir, { recursive: true });
  const { x, y } = tileAt(lat, lon, z);
  const file = join(dir, `${z}_${x}_${y}.json`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 30 * 86_400_000) return JSON.parse(readFileSync(file, "utf8"));
  const releases = await waybackReleases();
  const hashes = new Array<string | null>(releases.length).fill(null);
  const fetched = new Set<number>();
  const hashAt = async (index: number) => {
    if (fetched.has(index)) return hashes[index] ?? null;
    fetched.add(index);
    const source = await resolveSource(`wb-${releases[index]!.release}`);
    const tile = source ? await getTile(source, z, x, y).catch(() => null) : null;
    hashes[index] = tile ? createHash("md5").update(tile.body).digest("hex") : null;
    return hashes[index];
  };
  // Editions come in long runs of the same photo: bisecting finds the seams with a fraction of the requests.
  const bisect = async (lo: number, hi: number): Promise<void> => {
    const [a, b] = await Promise.all([hashAt(lo), hashAt(hi)]);
    if (hi - lo < 2) return;
    if (a && a === b) {
      for (let i = lo + 1; i < hi; i++) hashes[i] = a;
      return;
    }
    const mid = (lo + hi) >> 1;
    await Promise.all([bisect(lo, mid), bisect(mid, hi)]);
  };
  await bisect(0, releases.length - 1);
  const groups: { release: number; published: string; oldest: string; count: number; hash: string; metaUrl: string }[] = [];
  releases.forEach((row, index) => {
    const hash = hashes[index];
    if (!hash) return;
    const last = groups[groups.length - 1];
    if (last && last.hash === hash) {
      // Newest release first: the oldest release of a run is the closest to the real publication.
      last.oldest = row.date;
      last.release = row.release;
      last.metaUrl = row.metaUrl;
      last.count += 1;
    } else {
      groups.push({ release: row.release, published: row.date, oldest: row.date, count: 1, hash, metaUrl: row.metaUrl });
    }
  });
  const versions = [] as unknown[];
  for (let i = 0; i < groups.length; i += 6) {
    const slice = groups.slice(i, i + 6);
    const metas = await Promise.all(slice.map((group) => captureMetadata(group.metaUrl, lat, lon, z).catch(() => null)));
    slice.forEach((group, k) => {
      const { metaUrl: _meta, hash: _hash, ...rest } = group;
      versions.push({ ...rest, capture: metas[k] });
    });
  }
  writeFileSync(file, JSON.stringify(versions));
  return versions;
}

async function weather(lat: number, lon: number) {
  const current = "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,rain,snowfall,surface_pressure,pressure_msl,visibility,uv_index,is_day";
  const hourly = "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover,precipitation,surface_pressure,visibility";
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=${current}&hourly=${hourly}&daily=sunrise,sunset&forecast_days=2&past_days=1&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  return res.json();
}

async function pastWeather(lat: number, lon: number, date: string) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${date}&end_date=${date}&hourly=temperature_2m,cloud_cover,precipitation,wind_speed_10m,weather_code,surface_pressure&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo archivio ${res.status}`);
  return res.json();
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const q = url.searchParams;
  const num = (key: string) => Number(q.get(key));

  const tile = /^\/api\/tile\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
  if (tile) {
    const source = await resolveSource(tile[1]!);
    if (!source) return json(res, 404, { error: "fonte sconosciuta" }), true;
    const found = await getTile(source, Number(tile[2]), Number(tile[3]), Number(tile[4]));
    if (!found) return res.writeHead(404).end(), true;
    res.writeHead(200, {
      "Content-Type": source.ext === "png" ? "image/png" : "image/jpeg",
      "Cache-Control": "public, max-age=604800",
    });
    res.end(found.body);
    return true;
  }
  if (path === "/api/sources" && req.method === "GET") return json(res, 200, allSources()), true;
  if (path === "/api/sources" && req.method === "POST") {
    const input = JSON.parse((await body(req)).toString()) as Partial<TileSource>;
    const template = String(input.template ?? "");
    if (!/^https?:\/\//.test(template) || !/\{(x|y|z|quad)\}/.test(template)) return json(res, 400, { error: "Il modello deve essere un URL con {x} {y} {z} oppure {quad}." }), true;
    const custom = customSources();
    const source: TileSource = {
      id: `tuo-${createHash("md5").update(template).digest("hex").slice(0, 8)}`,
      label: String(input.label || "Fonte personale").slice(0, 60),
      group: "tuo",
      template,
      maxZoom: Math.min(23, Number(input.maxZoom) || 19),
      ext: /\.png/.test(template) ? "png" : "jpg",
      attribution: String(input.attribution || "Fonte aggiunta dall'utente").slice(0, 160),
    };
    saveCustomSources([...custom.filter((row) => row.id !== source.id), source]);
    return json(res, 200, source), true;
  }
  if (path === "/api/wayback/releases") return json(res, 200, await waybackReleases()), true;
  if (path === "/api/wayback/newest") return json(res, 200, (await waybackReleases())[0]), true;
  if (path === "/api/wayback/versions") return json(res, 200, await distinctVersions(num("lat"), num("lon"), num("z") || 17)), true;
  if (path === "/api/wayback/capture") {
    const releases = await waybackReleases();
    const row = releases.find((item) => item.release === num("release")) ?? releases[0]!;
    const value = await cachedJson(`cap:${row.release}:${q.get("lat")}:${q.get("lon")}:${q.get("z")}`, 86_400_000, () => captureMetadata(row.metaUrl, num("lat"), num("lon"), num("z") || 18));
    return json(res, 200, value), true;
  }
  if (path === "/api/osm") {
    const box = { s: num("s"), w: num("w"), n: num("n"), e: num("e") };
    if (![box.s, box.w, box.n, box.e].every(Number.isFinite) || box.n <= box.s || box.e <= box.w) return json(res, 400, { error: "riquadro invalido" }), true;
    if ((box.n - box.s) * (box.e - box.w) > 0.0625) return json(res, 400, { error: "riquadro troppo ampio per OSM" }), true;
    return json(res, 200, await fetchBundle(box)), true;
  }
  if (path === "/api/geocode") {
    const value = await cachedJson(`geo:${q.get("q")}`, 3_600_000, async () => {
      const upstream = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=it&q=${encodeURIComponent(q.get("q") ?? "")}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok) throw new Error("Il cercatore di luoghi non risponde.");
      const rows = (await upstream.json()) as { display_name: string; lat: string; lon: string; boundingbox: string[]; type: string }[];
      return rows.map((row) => ({
        name: row.display_name,
        lat: Number(row.lat),
        lon: Number(row.lon),
        type: row.type,
        bbox: row.boundingbox?.map(Number),
      }));
    });
    return json(res, 200, value), true;
  }
  if (path === "/api/weather") return json(res, 200, await cachedJson(`w:${q.get("lat")}:${q.get("lon")}`, 600_000, () => weather(num("lat"), num("lon")))), true;
  if (path === "/api/weather/past") return json(res, 200, await cachedJson(`wp:${q.get("lat")}:${q.get("lon")}:${q.get("date")}`, 86_400_000, () => pastWeather(num("lat"), num("lon"), q.get("date") ?? ""))), true;

  const earthBox = () => {
    const box = { s: num("s"), w: num("w"), n: num("n"), e: num("e") };
    if (![box.s, box.w, box.n, box.e].every(Number.isFinite) || box.n <= box.s || box.e <= box.w) throw new Error("riquadro invalido");
    return box;
  };
  const isDay = (value: string | null) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (path === "/api/services") return json(res, 200, await servicesStatus()), true;
  if (path === "/api/earth/products") return json(res, 200, PRODUCTS), true;
  if (path === "/api/earth/scenes") {
    if (!isDay(q.get("from")) || !isDay(q.get("to"))) return json(res, 400, { error: "data invalida" }), true;
    return json(res, 200, await sentinelScenes(earthBox(), q.get("from")!, q.get("to")!, Number(q.get("cloud") ?? 40))), true;
  }
  if (path === "/api/earth/image") {
    if (!isDay(q.get("from")) || !isDay(q.get("to"))) return json(res, 400, { error: "data invalida" }), true;
    const image = await sentinelImage(earthBox(), q.get("product") ?? "vero", q.get("from")!, q.get("to"), num("width") || 1024, num("height") || 1024);
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=2592000" });
    res.end(image);
    return true;
  }
  if (path === "/api/earth/spectrum") {
    if (!isDay(q.get("from")) || !isDay(q.get("to"))) return json(res, 400, { error: "data invalida" }), true;
    const tiff = await sentinelSpectrum(earthBox(), q.get("from")!, q.get("to")!, num("width") || 256, num("height") || 256);
    res.writeHead(200, { "Content-Type": "image/tiff", "Cache-Control": "public, max-age=2592000" });
    res.end(tiff);
    return true;
  }
  if (path === "/api/earth/ndvi") {
    if (!isDay(q.get("from")) || !isDay(q.get("to"))) return json(res, 400, { error: "data invalida" }), true;
    return json(res, 200, await ndviSeries(earthBox(), q.get("from")!, q.get("to")!, Math.max(5, Math.min(90, num("days") || 30)))), true;
  }
  if (path === "/api/earth/dem") {
    const cols = Math.max(2, Math.min(1024, num("cols") || 256));
    const rows = Math.max(2, Math.min(1024, num("rows") || 256));
    const bytes = q.get("source") === "nasadem" ? await nasademGrid(earthBox(), cols, rows) : await copernicusDem(earthBox(), cols, rows);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=2592000" });
    res.end(bytes);
    return true;
  }
  if (path === "/api/earth/lidar/coverage") return json(res, 200, await lidarCoverage(earthBox())), true;
  if (path === "/api/earth/lidar") {
    const cols = Math.max(2, Math.min(4096, num("cols") || 256));
    const rows = Math.max(2, Math.min(4096, num("rows") || 256));
    const bytes = await lidarGrid(q.get("id") ?? "", q.get("kind") === "dsm" ? "dsm" : "dtm", earthBox(), cols, rows);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=2592000" });
    res.end(bytes);
    return true;
  }
  if (path === "/api/earth/fires") {
    if (!isDay(q.get("date"))) return json(res, 400, { error: "data invalida" }), true;
    return json(res, 200, await fires(earthBox(), num("days") || 7, q.get("date"))), true;
  }
  if (path === "/api/earth/owm") return json(res, 200, await openWeather(num("lat"), num("lon"))), true;
  const owm = /^\/api\/earth\/owm-tile\/(\w+)\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
  if (owm) {
    const found = await owmTile(owm[1]!, Number(owm[2]), Number(owm[3]), Number(owm[4]));
    if (!found) return res.writeHead(404).end(), true;
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=1800" });
    res.end(found);
    return true;
  }
  if (path === "/api/earth/deep") return json(res, 200, await deepLayers()), true;
  const gibs = /^\/api\/earth\/gibs\/([\w-]+)\/([\d-]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
  if (gibs) {
    const found = await gibsTile(gibs[1]!, gibs[2]!, Number(gibs[3]), Number(gibs[4]), Number(gibs[5]));
    if (!found) return res.writeHead(404).end(), true;
    res.writeHead(200, { "Content-Type": found.ext === "png" ? "image/png" : "image/jpeg", "Cache-Control": "public, max-age=2592000" });
    res.end(found.body);
    return true;
  }
  if (path === "/api/earth/gedi" && req.method === "POST") return json(res, 200, await startGedi(earthBox())), true;
  if (path === "/api/earth/gedi" && req.method === "DELETE") return forgetGedi(earthBox()), json(res, 200, { ok: true }), true;
  if (path === "/api/earth/gedi") return json(res, 200, gediStatus(earthBox())), true;
  if (path === "/api/earth/catalog") return json(res, 200, await nasaCatalog(earthBox())), true;
  if (path === "/api/place/photos") return json(res, 200, await placePhotos(earthBox(), q.get("source") === "panoramax" || q.get("source") === "commons" ? (q.get("source") as "panoramax" | "commons") : null)), true;
  if (path === "/api/place/image") {
    const target = q.get("url") ?? "";
    if (!isKnownImage(target)) return json(res, 403, { error: "immagine non in catalogo" }), true;
    const image = await proxiedImage(target);
    if (!image) return res.writeHead(404).end(), true;
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=2592000" });
    res.end(image);
    return true;
  }
  if (path === "/api/place/articles") return json(res, 200, await placeArticles(num("lat"), num("lon"), num("radius") || 1000)), true;

  if (path === "/api/jobs" && req.method === "GET") return json(res, 200, listJobs()), true;
  if (path === "/api/jobs/count") {
    const box = { s: num("s"), w: num("w"), n: num("n"), e: num("e") };
    return json(res, 200, { total: countTiles(box, num("zMin"), num("zMax")) }), true;
  }
  if (path === "/api/jobs" && req.method === "POST") {
    const input = JSON.parse((await body(req)).toString()) as JobRequest;
    return json(res, 200, await startJob(input)), true;
  }
  const cancel = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(path);
  if (cancel && req.method === "POST") return cancelJob(cancel[1]!), json(res, 200, { ok: true }), true;

  if (path === "/api/expeditions" && req.method === "GET") {
    const rows = readdirSync(EXPEDITIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(EXPEDITIONS, entry.name, "spedizione.json")))
      .map((entry) => {
        const file = join(EXPEDITIONS, entry.name, "spedizione.json");
        return archiveRow(entry.name, file);
      })
      .sort((a, b) => b.updated.localeCompare(a.updated));
    return json(res, 200, rows), true;
  }
  if (path === "/api/trash" && req.method === "GET") {
    if (!existsSync(TRASH)) return json(res, 200, []), true;
    const rows = readdirSync(TRASH, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(TRASH, entry.name, "spedizione.json")))
      .map((entry) => {
        const dir = join(TRASH, entry.name);
        const value = JSON.parse(readFileSync(join(dir, "spedizione.json"), "utf8")) as { spec?: { name?: string } };
        return { id: entry.name, name: value.spec?.name, trashed: statSync(dir).mtime.toISOString() };
      })
      .sort((a, b) => b.trashed.localeCompare(a.trashed));
    return json(res, 200, rows), true;
  }
  const restore = /^\/api\/trash\/([\w-]+)\/restore$/.exec(path);
  if (restore && req.method === "POST" && safeId(restore[1]!)) {
    const from = join(TRASH, restore[1]!);
    const to = join(EXPEDITIONS, restore[1]!);
    if (!existsSync(from)) return json(res, 404, { error: "non nel cestino" }), true;
    if (existsSync(to)) return json(res, 409, { error: "esiste già un'indagine con questo nome" }), true;
    renameSync(from, to);
    return json(res, 200, { ok: true }), true;
  }
  const expedition = /^\/api\/expeditions\/([\w-]+)$/.exec(path);
  if (expedition && safeId(expedition[1]!)) {
    const dir = join(EXPEDITIONS, expedition[1]!);
    const file = join(dir, "spedizione.json");
    if (req.method === "DELETE") {
      // Into the bin, never gone: an investigation holds weeks of notes and one wrong click must not cost them.
      if (!existsSync(dir)) return json(res, 404, { error: "non trovata" }), true;
      mkdirSync(TRASH, { recursive: true });
      const target = join(TRASH, expedition[1]!);
      renameSync(dir, existsSync(target) ? `${target}-${Date.now().toString(36)}` : target);
      return json(res, 200, { ok: true }), true;
    }
    if (req.method === "GET") {
      if (!existsSync(file)) return json(res, 404, { error: "non trovata" }), true;
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(readFileSync(file));
      return true;
    }
    if (req.method === "PUT") {
      mkdirSync(dir, { recursive: true });
      const raw = await body(req);
      JSON.parse(raw.toString());
      writeFileSync(`${file}.tmp`, raw);
      writeFileSync(file, raw);
      return json(res, 200, { ok: true }), true;
    }
  }
  const media = /^\/api\/expeditions\/([\w-]+)\/media$/.exec(path);
  if (media && req.method === "POST" && safeId(media[1]!)) {
    const ext = (q.get("ext") ?? "jpg").replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
    const dir = join(EXPEDITIONS, media[1]!, "media");
    mkdirSync(dir, { recursive: true });
    const raw = await body(req);
    const name = `${Date.now()}-${createHash("md5").update(raw).digest("hex").slice(0, 8)}.${ext}`;
    writeFileSync(join(dir, name), raw);
    return json(res, 200, { url: `/media/${media[1]}/${name}` }), true;
  }
  return false;
}

function serveFile(res: ServerResponse, file: string) {
  res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const vite = DEV
  ? await (await import("vite")).createServer({ root: ROOT, server: { middlewareMode: true, hmr: { port: PORT + 1 } }, appType: "spa" })
  : null;

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    // Keys never leave through the dev server's static files either.
    if (/(^|\/)\.env/.test(decodeURIComponent(url.pathname))) return res.writeHead(404).end();
    if (url.pathname.startsWith("/api/")) {
      if (await api(req, res, url)) return;
      return json(res, 404, { error: "non trovato" });
    }
    const media = /^\/media\/([\w-]+)\/([\w.-]+)$/.exec(url.pathname);
    if (media && safeId(media[1]!)) {
      const file = join(EXPEDITIONS, media[1]!, "media", media[2]!);
      if (existsSync(file)) return serveFile(res, file);
      return res.writeHead(404).end();
    }
    if (vite) return vite.middlewares(req, res);
    const dist = join(ROOT, "dist");
    const target = resolve(dist, `.${normalize(url.pathname)}`);
    if (target.startsWith(dist) && existsSync(target) && statSync(target).isFile()) return serveFile(res, target);
    return serveFile(res, join(dist, "index.html"));
  } catch (error) {
    if (!res.headersSent) json(res, 502, { error: scrub((error as Error).message) });
    else res.end();
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Sestante su http://localhost:${PORT}`);
});
