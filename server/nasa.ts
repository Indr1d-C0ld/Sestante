import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { LaserShot } from "../src/vision/laser.ts";
import { jwtExpiry, scrub, secret } from "./secrets.ts";
import { DATA, UA } from "./sources.ts";

type Box = { s: number; w: number; n: number; e: number };

const CACHE = join(DATA, "cache", "nasa");
mkdirSync(CACHE, { recursive: true });

const hash = (value: unknown) => createHash("md5").update(JSON.stringify(value)).digest("hex");

function earthdataHeaders() {
  const token = secret("NASA_EARTHDATA_TOKEN");
  if (!token) throw new Error("Token Earthdata assente: va nel file .env.");
  const expiry = jwtExpiry(token);
  if (expiry && Date.parse(expiry) < Date.now()) throw new Error(`Token Earthdata scaduto il ${expiry.slice(0, 10)}: rigeneralo su urs.earthdata.nasa.gov e salvalo nel file .env.`);
  return { Authorization: `Bearer ${token}`, "User-Agent": UA };
}

/** One member of a zip archive, enough for the single-file archives LP DAAC serves. */
export function readZipEntry(zip: Buffer, suffix: string) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Archivio zip non valido.");
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(cursor + 10);
    const packed = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extra = zip.readUInt16LE(cursor + 30);
    const comment = zip.readUInt16LE(cursor + 32);
    const local = zip.readUInt32LE(cursor + 42);
    const name = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (name.toLowerCase().endsWith(suffix)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const body = zip.subarray(start, start + packed);
      return method === 0 ? Buffer.from(body) : inflateRawSync(body);
    }
    cursor += 46 + nameLength + extra + comment;
  }
  throw new Error(`Nell'archivio manca ${suffix}.`);
}

/** A 1° HGT tile: big-endian int16, row 0 on the north edge, samples on the arc-second grid corners. */
export function sampleHgt(hgt: Buffer, tileLat: number, tileLon: number, lat: number, lon: number) {
  const side = Math.round(Math.sqrt(hgt.length / 2));
  const span = side - 1;
  const fx = (lon - tileLon) * span;
  const fy = (tileLat + 1 - lat) * span;
  const ix = Math.max(0, Math.min(span - 1, Math.floor(fx)));
  const iy = Math.max(0, Math.min(span - 1, Math.floor(fy)));
  const tx = fx - ix;
  const ty = fy - iy;
  const at = (x: number, y: number) => {
    const v = hgt.readInt16BE((y * side + x) * 2);
    return v === -32768 ? Number.NaN : v;
  };
  // A void only matters where it carries weight: on a grid line, the neighbour across it does not count.
  const part = (x: number, y: number, weight: number) => (weight === 0 ? 0 : at(x, y) * weight);
  return part(ix, iy, (1 - tx) * (1 - ty)) + part(ix + 1, iy, tx * (1 - ty)) + part(ix, iy + 1, (1 - tx) * ty) + part(ix + 1, iy + 1, tx * ty);
}

async function nasademTile(lat: number, lon: number) {
  const name = `${lat >= 0 ? "n" : "s"}${String(Math.abs(lat)).padStart(2, "0")}${lon >= 0 ? "e" : "w"}${String(Math.abs(lon)).padStart(3, "0")}`;
  const file = join(CACHE, `nasadem_${name}.hgt`);
  if (existsSync(file)) return readFileSync(file);
  const url = `https://data.lpdaac.earthdatacloud.nasa.gov/lp-prod-protected/NASADEM_HGT.001/NASADEM_HGT_${name}/NASADEM_HGT_${name}.zip`;
  const res = await fetch(url, { headers: earthdataHeaders(), redirect: "follow", signal: AbortSignal.timeout(120_000) });
  // Open sea has no tile at all: that is a gap in the data, not a failure.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`NASADEM risponde ${res.status}${res.status === 401 ? ": token Earthdata rifiutato" : ""}.`);
  const hgt = readZipEntry(Buffer.from(await res.arrayBuffer()), ".hgt");
  writeFileSync(file, hgt);
  return hgt;
}

/** Same contract as the Copernicus grid: little-endian Float32, regular lat/lon, row 0 at the north edge, NaN in the gaps. */
export async function nasademGrid(box: Box, cols: number, rows: number) {
  const file = join(CACHE, `grid_${hash({ box, cols, rows })}.f32`);
  if (existsSync(file)) return readFileSync(file);
  const out = new Float32Array(cols * rows).fill(Number.NaN);
  for (let lat = Math.floor(box.s); lat <= Math.floor(box.n - 1e-9); lat++) {
    for (let lon = Math.floor(box.w); lon <= Math.floor(box.e - 1e-9); lon++) {
      const hgt = await nasademTile(lat, lon);
      if (!hgt) continue;
      for (let j = 0; j < rows; j++) {
        const la = box.n - ((j + 0.5) / rows) * (box.n - box.s);
        if (la < lat || la >= lat + 1) continue;
        for (let i = 0; i < cols; i++) {
          const lo = box.w + ((i + 0.5) / cols) * (box.e - box.w);
          if (lo < lon || lo >= lon + 1) continue;
          out[j * cols + i] = sampleHgt(hgt, lat, lon, la, lo);
        }
      }
    }
  }
  const bytes = Buffer.from(out.buffer);
  writeFileSync(file, bytes);
  return bytes;
}

// --- GEDI through Harmony: NASA cuts each 2 GB orbit down to the box, on its own machines ---

export type GediStatus = {
  state: "assente" | "in corso" | "pronto" | "fallito";
  progress: number;
  message: string;
  granules: number;
  shots: LaserShot[];
  at: string | null;
  /** EGM96 geoid height at the box's centre, added by the route when the shots are ready. */
  geoid?: number | null;
};

const HARMONY = "https://harmony.earthdata.nasa.gov";

/** A product Harmony cuts down to the box: GEDI's footprints, ICESat-2's ground segments. */
type Product<T> = { prefix: string; shortName: string; noun: string; read: (file: string, name: string, box: Box) => Promise<T[]>; sort: (a: T, b: T) => number };
type HarmonyStatus<T> = { state: "assente" | "in corso" | "pronto" | "fallito"; progress: number; message: string; granules: number; shots: T[]; at: string | null };
const running = new Map<string, HarmonyStatus<unknown>>();

/** "GEDI02_A_2019209152911_…": year and day of year. */
export function granuleDate(name: string) {
  const match = /GEDI02_A_(\d{4})(\d{3})/.exec(name);
  if (!match) return "";
  return new Date(Date.UTC(Number(match[1]), 0, Number(match[2]))).toISOString().slice(0, 10);
}

async function newestCollection(shortName: string) {
  const res = await fetch(`https://cmr.earthdata.nasa.gov/search/collections.umm_json?short_name=${shortName}&page_size=20`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Catalogo NASA: ${res.status}`);
  const items = ((await res.json()) as { items?: { meta: { "concept-id": string }; umm: { Version: string } }[] }).items ?? [];
  // Several versions stay listed side by side: the newest has the best geolocation.
  const newest = items.sort((a, b) => Number(b.umm.Version) - Number(a.umm.Version))[0];
  if (!newest) throw new Error(`${shortName} non è nel catalogo NASA.`);
  return newest.meta["concept-id"];
}

async function readSubset(file: string, name: string, box: Box) {
  const { default: h5wasm } = (await import("h5wasm/node")) as unknown as { default: { ready: Promise<unknown>; File: new (path: string, mode: string) => H5Group & { close(): void } } };
  await h5wasm.ready;
  const h5 = new h5wasm.File(file, "r");
  const date = granuleDate(name);
  const shots: LaserShot[] = [];
  try {
    for (const beam of h5.keys().filter((key) => key.startsWith("BEAM"))) {
      const group = h5.get(beam) as H5Group;
      const shape = (group.get("lat_lowestmode") as H5Dataset | null)?.shape;
      const count = shape?.[0] ?? 0;
      if (!count) continue;
      const values = (key: string) => (group.get(key) as H5Dataset | null)?.value as ArrayLike<number> | undefined;
      const lat = values("lat_lowestmode")!;
      const lon = values("lon_lowestmode")!;
      const ground = values("elev_lowestmode")!;
      const top = values("elev_highestreturn")!;
      const sensitivity = values("sensitivity")!;
      const degrade = values("degrade_flag");
      const quality = values("l2a_quality_flag_rel3") ?? values("quality_flag");
      const rh = values("rh");
      const srtm = values("digital_elevation_model_srtm");
      const solar = values("solar_elevation");
      const numbers = (group.get("shot_number") as H5Dataset | null)?.value as ArrayLike<unknown> | undefined;
      const cover = values("land_cover_data/landsat_treecover");
      for (let i = 0; i < count; i++) {
        if (lat[i]! < box.s || lat[i]! > box.n || lon[i]! < box.w || lon[i]! > box.e) continue;
        shots.push({
          id: String(numbers?.[i] ?? `${name}-${beam}-${i}`),
          lat: lat[i]!,
          lon: lon[i]!,
          ground: ground[i]!,
          top: top[i]!,
          rh98: rh ? rh[i * 101 + 98]! : top[i]! - ground[i]!,
          rh50: rh ? rh[i * 101 + 50]! : 0,
          srtm: srtm && Number.isFinite(srtm[i]) && srtm[i]! > -999 ? srtm[i]! : null,
          sensitivity: sensitivity[i]!,
          // The mission's own rule: a usable waveform, a healthy pointing system, and enough power to reach the ground.
          good: (quality ? quality[i] === 1 : true) && (degrade ? degrade[i] === 0 : true) && sensitivity[i]! >= 0.9,
          date,
          beam,
          solar: solar ? solar[i]! : 0,
          cover: cover && cover[i]! >= 0 && cover[i]! <= 100 ? cover[i]! : null,
        });
      }
    }
  } finally {
    h5.close();
  }
  return shots;
}

type H5Dataset = { shape: number[]; value: unknown };
type H5Group = { keys(): string[]; get(path: string): unknown };

type HarmonyJob = { jobID: string; status: string; progress: number; links?: { rel: string; href: string }[]; errors?: { message?: string }[] };

async function followJob<T>(product: Product<T>, jobID: string, box: Box, key: string, status: HarmonyStatus<T>) {
  const headers = earthdataHeaders();
  const done = join(CACHE, `${product.prefix}_${key}.json`);
  let job: HarmonyJob;
  for (;;) {
    const res = await fetch(`${HARMONY}/jobs/${jobID}?limit=2000`, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Harmony risponde ${res.status} per il lavoro in corso.`);
    job = (await res.json()) as HarmonyJob;
    status.progress = Math.round(job.progress * 0.85);
    status.message = `NASA ritaglia le orbite sul riquadro: ${job.progress}%`;
    if (["successful", "complete_with_errors"].includes(job.status)) break;
    if (["failed", "canceled"].includes(job.status)) throw new Error(job.errors?.[0]?.message ? `Harmony: ${job.errors[0].message.slice(0, 200)}` : `Harmony: lavoro ${job.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  const links = (job.links ?? []).filter((link) => link.rel === "data");
  status.granules = links.length;
  for (let i = 0; i < links.length; i++) {
    status.message = `Leggo le orbite: ${i + 1}/${links.length}`;
    status.progress = 85 + Math.round((i / links.length) * 15);
    const name = links[i]!.href.split("/").pop() ?? `${product.prefix}.h5`;
    const res = await fetch(links[i]!.href, { headers, redirect: "follow", signal: AbortSignal.timeout(180_000) });
    if (!res.ok) continue;
    const temp = join(CACHE, `tmp_${product.prefix}_${key}_${i}.h5`);
    writeFileSync(temp, Buffer.from(await res.arrayBuffer()));
    try {
      status.shots.push(...(await product.read(temp, name, box)));
    } finally {
      rmSync(temp, { force: true });
    }
  }
  status.shots.sort(product.sort);
  status.state = "pronto";
  status.progress = 100;
  status.at = new Date().toISOString();
  status.message = `${status.shots.length} ${product.noun} da ${links.length} orbite.`;
  writeFileSync(done, JSON.stringify(status));
  rmSync(join(CACHE, `${product.prefix}_${key}.job`), { force: true });
}

function watch<T>(product: Product<T>, jobID: string, box: Box, key: string, status: HarmonyStatus<T>) {
  followJob(product, jobID, box, key, status).catch((error: Error) => {
    status.state = "fallito";
    status.message = scrub(error.message);
    rmSync(join(CACHE, `${product.prefix}_${key}.job`), { force: true });
  });
}

/** Where this box stands. A job already sent to NASA is picked up again after a restart, not paid for twice. */
function harmonyStatus<T>(product: Product<T>, box: Box): HarmonyStatus<T> {
  const key = hash(box);
  const live = running.get(`${product.prefix}:${key}`) as HarmonyStatus<T> | undefined;
  if (live) return live;
  const done = join(CACHE, `${product.prefix}_${key}.json`);
  if (existsSync(done)) return JSON.parse(readFileSync(done, "utf8")) as HarmonyStatus<T>;
  const pending = join(CACHE, `${product.prefix}_${key}.job`);
  if (existsSync(pending)) {
    const status: HarmonyStatus<T> = { state: "in corso", progress: 0, message: "Riprendo il lavoro già inviato a NASA", granules: 0, shots: [], at: null };
    running.set(`${product.prefix}:${key}`, status);
    watch(product, readFileSync(pending, "utf8").trim(), box, key, status);
    return status;
  }
  return { state: "assente", progress: 0, message: "", granules: 0, shots: [], at: null };
}

async function startHarmony<T>(product: Product<T>, box: Box): Promise<HarmonyStatus<T>> {
  const current = harmonyStatus(product, box);
  if (current.state === "in corso") return current;
  const key = hash(box);
  const headers = earthdataHeaders();
  const status: HarmonyStatus<T> = { state: "in corso", progress: 0, message: "Invio la richiesta a NASA", granules: 0, shots: [], at: null };
  running.set(`${product.prefix}:${key}`, status);
  try {
    const collection = await newestCollection(product.shortName);
    const query = new URLSearchParams({ maxResults: "100", forceAsync: "true", skipPreview: "true", variable: "all" });
    query.append("subset", `lat(${box.s}:${box.n})`);
    query.append("subset", `lon(${box.w}:${box.e})`);
    const res = await fetch(`${HARMONY}/${collection}/ogc-api-coverages/1.0.0/collections/parameter_vars/coverage/rangeset?${query}`, { headers, redirect: "follow", signal: AbortSignal.timeout(120_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Harmony risponde ${res.status}: ${scrub(text).slice(0, 200)}`);
    const job = JSON.parse(text) as HarmonyJob;
    writeFileSync(join(CACHE, `${product.prefix}_${key}.job`), job.jobID);
    watch(product, job.jobID, box, key, status);
  } catch (error) {
    status.state = "fallito";
    status.message = scrub((error as Error).message);
  }
  return status;
}

function forgetHarmony<T>(product: Product<T>, box: Box) {
  const key = hash(box);
  running.delete(`${product.prefix}:${key}`);
  rmSync(join(CACHE, `${product.prefix}_${key}.json`), { force: true });
}

const GEDI: Product<LaserShot> = { prefix: "gedi", shortName: "GEDI02_A", noun: "impronte", read: readSubset, sort: (a, b) => b.date.localeCompare(a.date) };
export const gediStatus = (box: Box) => harmonyStatus(GEDI, box) as GediStatus;
export const startGedi = (box: Box) => startHarmony(GEDI, box) as Promise<GediStatus>;
export const forgetGedi = (box: Box) => forgetHarmony(GEDI, box);

// --- ICESat-2 ATL08: the ground under every 100 m of track, all over the globe ---

/** One ATL08 land segment: the terrain's best-fit height on the WGS84 ellipsoid, and how sure it is. */
export type GroundSegment = { lat: number; lon: number; h: number; sigma: number; photons: number; date: string; beam: string; good: boolean };
export type IcesatStatus = HarmonyStatus<GroundSegment>;

/** "ATL08_20190101123456_…": the date. */
export function atl08Date(name: string) {
  const match = /ATL08_(\d{4})(\d{2})(\d{2})/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

/** Which ATL08 segments to trust: checked against six airborne surveys, the stricter rules only threw data away. */
export const icesatGood = (photons: number, sigma: number) => photons >= 10 && sigma < 5;

async function readAtl08(file: string, name: string, box: Box) {
  const { default: h5wasm } = (await import("h5wasm/node")) as unknown as { default: { ready: Promise<unknown>; File: new (path: string, mode: string) => H5Group & { close(): void } } };
  await h5wasm.ready;
  const h5 = new h5wasm.File(file, "r");
  const date = atl08Date(name);
  const out: GroundSegment[] = [];
  try {
    for (const beam of h5.keys().filter((key) => /^gt[123][lr]$/.test(key))) {
      const values = (key: string) => (h5.get(`${beam}/land_segments/${key}`) as H5Dataset | null)?.value as ArrayLike<number> | undefined;
      const lat = values("latitude");
      const lon = values("longitude");
      const h = values("terrain/h_te_best_fit");
      if (!lat || !lon || !h) continue;
      const sigma = values("terrain/h_te_uncertainty");
      const photons = values("terrain/n_te_photons");
      for (let i = 0; i < lat.length; i++) {
        if (lat[i]! < box.s || lat[i]! > box.n || lon[i]! < box.w || lon[i]! > box.e) continue;
        const v = h[i]!;
        if (!Number.isFinite(v) || Math.abs(v) > 1e4) continue;
        const s = sigma && Number.isFinite(sigma[i]) && sigma[i]! < 1e4 ? sigma[i]! : 99;
        const n = photons ? photons[i]! : 0;
        // Enough ground photons to fit a surface, and a fit within 5 m. The cloud flag is left out: in Rotterdam it threw away
        // every segment, while the segments themselves sat within 0.1 m of the airborne survey's ground.
        out.push({ lat: lat[i]!, lon: lon[i]!, h: v, sigma: s, photons: n, date, beam, good: icesatGood(n, s) });
      }
    }
  } finally {
    h5.close();
  }
  return out;
}

const ICESAT: Product<GroundSegment> = { prefix: "atl08", shortName: "ATL08", noun: "tratti di suolo", read: readAtl08, sort: (a, b) => b.date.localeCompare(a.date) };
export const icesatStatus = (box: Box) => harmonyStatus(ICESAT, box);
export const startIcesat = (box: Box) => startHarmony(ICESAT, box);
export const forgetIcesat = (box: Box) => forgetHarmony(ICESAT, box);
