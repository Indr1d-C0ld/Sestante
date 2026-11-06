import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromUrl } from "geotiff";
import { jwtExpiry, scrub, secret } from "./secrets.ts";
import { DATA, UA } from "./sources.ts";

export type Box = { s: number; w: number; n: number; e: number };

const CACHE = join(DATA, "cache", "terra");
mkdirSync(CACHE, { recursive: true });

const hash = (value: unknown) => createHash("md5").update(JSON.stringify(value)).digest("hex");

/** Remembers an upstream answer on disk, so a place already studied keeps working offline and costs no quota. */
async function diskJson<T>(key: unknown, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const file = join(CACHE, `${hash(key)}.json`);
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { at: number; value: T };
    if (Date.now() - stored.at < ttlMs) return stored.value;
  }
  try {
    const value = await load();
    writeFileSync(file, JSON.stringify({ at: Date.now(), value }));
    return value;
  } catch (error) {
    if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf8")) as { value: T }).value;
    throw error;
  }
}

async function getJson<T>(url: string, init?: RequestInit, timeout = 30_000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout), headers: { "User-Agent": UA, ...init?.headers } });
  if (!res.ok) throw new Error(scrub(`${new URL(url).hostname} risponde ${res.status}: ${(await res.text()).slice(0, 220)}`));
  return res.json() as Promise<T>;
}

// --- Copernicus Data Space: Sentinel-1, Sentinel-2, statistics ---

let cdse: { token: string; until: number } | null = null;

async function cdseToken() {
  if (cdse && cdse.until > Date.now()) return cdse.token;
  const id = secret("COPERNICUS_CLIENT_ID");
  const key = secret("COPERNICUS_CLIENT_SECRET");
  if (!id || !key) throw new Error("Credenziali Copernicus assenti: vanno nel file .env.");
  const reply = await getJson<{ access_token: string; expires_in: number }>("https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: key }),
  });
  cdse = { token: reply.access_token, until: Date.now() + (reply.expires_in - 60) * 1000 };
  return cdse.token;
}

const OPTICAL = (bands: string[], body: string, out = 3) => `//VERSION=3
function setup(){return{input:[{bands:${JSON.stringify([...bands, "dataMask"])}}],output:{bands:${out + 1},sampleType:"AUTO"}}}
const ramp=(v,stops)=>{for(let i=1;i<stops.length;i++){if(v<=stops[i][0]){const a=stops[i-1],b=stops[i],t=(v-a[0])/(b[0]-a[0]);return [a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t,a[3]+(b[3]-a[3])*t];}}const l=stops[stops.length-1];return [l[1],l[2],l[3]];};
function evaluatePixel(s){const c=(function(){${body}})();return [...c,s.dataMask];}`;

const VEG = "[[-0.2,0.35,0.3,0.45],[0,0.72,0.66,0.55],[0.2,0.85,0.8,0.42],[0.4,0.55,0.75,0.3],[0.6,0.2,0.58,0.2],[0.9,0.02,0.3,0.1]]";
const WET = "[[-0.6,0.55,0.4,0.22],[-0.2,0.85,0.8,0.65],[0,0.8,0.88,0.85],[0.3,0.3,0.6,0.88],[0.8,0.03,0.18,0.55]]";

export type Product = { id: string; label: string; note: string; sensor: "s2" | "s1"; composite?: boolean };

export const PRODUCTS: Product[] = [
  { id: "vero", label: "Colore vero", note: "Rosso, verde e blu a 10 m. Quello che vedrebbe l'occhio, senza foschia.", sensor: "s2" },
  { id: "infrarosso", label: "Infrarosso", note: "Il vicino infrarosso in rosso: la vegetazione sana brilla, l'acqua è nera, il costruito è azzurro.", sensor: "s2" },
  { id: "swir", label: "Infrarosso corto", note: "Suoli, umidità, incendi recenti e nudità del terreno. Vede oltre una foschia sottile.", sensor: "s2" },
  { id: "ndvi", label: "Vigore (NDVI)", note: "Quanta clorofilla attiva c'è in ogni pixel di 10 m.", sensor: "s2" },
  { id: "ndwi", label: "Acqua (NDWI)", note: "Separa specchi e suoli saturi dal resto.", sensor: "s2" },
  { id: "nbr", label: "Bruciato (NBR)", note: "Valori bassi indicano superficie bruciata o spoglia.", sensor: "s2" },
  { id: "suolo", label: "Suolo nudo (BSI)", note: "Mette in risalto scavi, cave, terreno arato e aree spoglie.", sensor: "s2" },
  { id: "radar", label: "Radar (Sentinel-1)", note: "Vede di notte e attraverso le nubi. Gli edifici riflettono forte, l'acqua liscia è nera.", sensor: "s1" },
  { id: "anomalia", label: "Anomalie della vegetazione", note: "Mediana dell'NDVI su un'intera stagione: l'ingresso del filtro per i segni nelle colture.", sensor: "s2", composite: true },
];

const EVAL: Record<string, string> = {
  vero: OPTICAL(["B02", "B03", "B04"], "return [2.6*s.B04,2.6*s.B03,2.6*s.B02];"),
  infrarosso: OPTICAL(["B03", "B04", "B08"], "return [2.2*s.B08,2.6*s.B04,2.6*s.B03];"),
  swir: OPTICAL(["B04", "B08", "B12"], "return [2.4*s.B12,2*s.B08,2.6*s.B04];"),
  ndvi: OPTICAL(["B04", "B08"], `return ramp((s.B08-s.B04)/(s.B08+s.B04+1e-6),${VEG});`),
  ndwi: OPTICAL(["B03", "B08"], `return ramp((s.B03-s.B08)/(s.B03+s.B08+1e-6),${WET});`),
  nbr: OPTICAL(["B08", "B12"], `return ramp((s.B08-s.B12)/(s.B08+s.B12+1e-6),${VEG});`),
  suolo: OPTICAL(["B02", "B04", "B08", "B11"], "const v=((s.B11+s.B04)-(s.B08+s.B02))/((s.B11+s.B04)+(s.B08+s.B02)+1e-6);const a=Math.max(0,Math.min(1,(v+0.25)/0.6));return [a,0.75*a*a,0.3*(1-a)];"),
};

const RADAR = `//VERSION=3
function setup(){return{input:[{bands:["VV","VH","dataMask"]}],output:{bands:4,sampleType:"AUTO"}}}
function evaluatePixel(s){return [1.6*Math.sqrt(s.VV),2.6*Math.sqrt(s.VH),1.6*Math.sqrt(s.VV)*0.8+0.8*Math.sqrt(s.VH),s.dataMask];}`;

// One band per pixel, NDVI 0..1 mapped to 0..255: the client takes the local difference, which only it can do cheaply.
const ANOMALY = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","SCL","dataMask"]}],output:{bands:4,sampleType:"AUTO"},mosaicking:"ORBIT"}}
function evaluatePixel(samples){const v=[];for(const s of samples){if(!s.dataMask||[3,8,9,10,11].includes(s.SCL))continue;v.push((s.B08-s.B04)/(s.B08+s.B04+1e-6));}
if(!v.length)return [0,0,0,0];v.sort((a,b)=>a-b);const m=(v[v.length>>1]+1)/2;return [m,m,m,1];}`;

const SPECTRUM = `//VERSION=3
function setup(){return{input:[{bands:["B02","B03","B04","B05","B08","B11","B12","dataMask"]}],output:{bands:8,sampleType:"FLOAT32"}}}
function evaluatePixel(s){return [s.B02,s.B03,s.B04,s.B05,s.B08,s.B11,s.B12,s.dataMask];}`;

async function processRequest(body: unknown, accept: string) {
  const token = await cdseToken();
  const res = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(scrub(`Copernicus risponde ${res.status}: ${(await res.text()).slice(0, 240)}`));
  return Buffer.from(await res.arrayBuffer());
}

const bounds = (box: Box) => ({ bbox: [box.w, box.s, box.e, box.n], properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } });

const dayRange = (date: string) => ({ from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` });

/** A rendered Sentinel product for this box: stays on disk, so the free monthly quota is spent once per view. */
export async function sentinelImage(box: Box, product: string, from: string, to: string | null, width: number, height: number) {
  const size = { width: Math.max(16, Math.min(2500, Math.round(width))), height: Math.max(16, Math.min(2500, Math.round(height))) };
  const key = { box, product, from, to, ...size };
  const file = join(CACHE, `${hash(key)}.png`);
  if (existsSync(file)) return readFileSync(file);
  const png = { responses: [{ identifier: "default", format: { type: "image/png" } }] };
  let body: unknown;
  if (product === "radar") {
    const range = to ? { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` } : dayRange(from);
    body = {
      input: { bounds: bounds(box), data: [{ type: "sentinel-1-grd", dataFilter: { timeRange: range, acquisitionMode: "IW", polarization: "DV", mosaickingOrder: "mostRecent" }, processing: { orthorectify: true, backCoeff: "GAMMA0_TERRAIN" } }] },
      output: { ...size, ...png },
      evalscript: RADAR,
    };
  } else if (product === "anomalia") {
    body = {
      input: { bounds: bounds(box), data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: `${from}T00:00:00Z`, to: `${to ?? from}T23:59:59Z` }, maxCloudCoverage: 60 } }] },
      output: { ...size, ...png },
      evalscript: ANOMALY,
    };
  } else {
    const script = EVAL[product];
    if (!script) throw new Error(`Prodotto sconosciuto: ${product}`);
    const range = to ? { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` } : dayRange(from);
    body = {
      input: { bounds: bounds(box), data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: range, mosaickingOrder: "leastCC" } }] },
      output: { ...size, ...png },
      evalscript: script,
    };
  }
  const image = await processRequest(body, "image/png");
  writeFileSync(file, image);
  return image;
}

/** Seven real reflectance bands for the whole box, read in the field by the spectroradiometer. */
export async function sentinelSpectrum(box: Box, from: string, to: string, width: number, height: number) {
  const size = { width: Math.max(8, Math.min(640, Math.round(width))), height: Math.max(8, Math.min(640, Math.round(height))) };
  const key = { spectrum: box, from, to, ...size };
  const file = join(CACHE, `${hash(key)}.tif`);
  if (existsSync(file)) return readFileSync(file);
  const image = await processRequest(
    {
      input: { bounds: bounds(box), data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` }, maxCloudCoverage: 25, mosaickingOrder: "leastCC" } }] },
      output: { ...size, responses: [{ identifier: "default", format: { type: "image/tiff" } }] },
      evalscript: SPECTRUM,
    },
    "image/tiff",
  );
  writeFileSync(file, image);
  return image;
}

export type Scene = { id: string; date: string; time: string; cloud: number };

/** The catalogue needs no key: Earth Search for Sentinel-2. */
export function sentinelScenes(box: Box, from: string, to: string, maxCloud: number) {
  return diskJson({ scenes: box, from, to, maxCloud }, 6 * 3_600_000, async () => {
    const scenes = new Map<string, Scene>();
    const reply = await getJson<{ features?: { id: string; properties: Record<string, number | string> }[] }>("https://earth-search.aws.element84.com/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collections: ["sentinel-2-l2a"],
        bbox: [box.w, box.s, box.e, box.n],
        datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
        limit: 250,
        query: { "eo:cloud_cover": { lte: maxCloud } },
        sortby: [{ field: "properties.datetime", direction: "desc" }],
      }),
    });
    for (const row of reply.features ?? []) {
      const time = String(row.properties.datetime);
      const date = time.slice(0, 10);
      const cloud = Number(row.properties["eo:cloud_cover"]);
      const seen = scenes.get(date);
      if (!seen || cloud < seen.cloud) scenes.set(date, { id: row.id, date, time, cloud });
    }
    return [...scenes.values()];
  });
}

export type SeriesRow = { from: string; to: string; mean: number; stDev: number; min: number; max: number; samples: number };

/** Mean NDVI through time over the box, computed by the service on the real bands. */
export function ndviSeries(box: Box, from: string, to: string, days: number) {
  return diskJson({ ndvi: box, from, to, days }, 7 * 86_400_000, async () => {
    const token = await cdseToken();
    const reply = await getJson<{ data?: { interval: { from: string; to: string }; outputs: { ndvi: { bands: { B0: { stats: Record<string, number> } } } } }[] }>(
      "https://sh.dataspace.copernicus.eu/api/v1/statistics",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { bounds: bounds(box), data: [{ type: "sentinel-2-l2a", dataFilter: { maxCloudCoverage: 40 } }] },
          aggregation: {
            timeRange: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` },
            aggregationInterval: { of: `P${days}D` },
            width: 128,
            height: 128,
            evalscript: `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","SCL","dataMask"]}],output:[{id:"ndvi",bands:1},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){const bad=[3,8,9,10,11].includes(s.SCL);return{ndvi:[(s.B08-s.B04)/(s.B08+s.B04+1e-6)],dataMask:[bad?0:s.dataMask]};}`,
          },
        }),
      },
      90_000,
    );
    const rows = (reply.data ?? []).map((row): SeriesRow => {
      const stats = row.outputs.ndvi.bands.B0.stats;
      return { from: row.interval.from.slice(0, 10), to: row.interval.to.slice(0, 10), mean: stats.mean!, stDev: stats.stDev!, min: stats.min!, max: stats.max!, samples: stats.sampleCount! - stats.noDataCount! };
    });
    // A month whose only clear pixels are a scrap of the box says nothing about the box.
    const most = Math.max(1, ...rows.map((row) => row.samples));
    return rows.filter((row) => Number.isFinite(row.mean) && row.samples >= most * 0.4);
  });
}

// --- Copernicus DEM, public bucket: no key ---

const cogName = (lat: number, lon: number) => {
  const ns = `${lat >= 0 ? "N" : "S"}${String(Math.abs(lat)).padStart(2, "0")}`;
  const ew = `${lon >= 0 ? "E" : "W"}${String(Math.abs(lon)).padStart(3, "0")}`;
  return `Copernicus_DSM_COG_10_${ns}_00_${ew}_00_DEM`;
};

/** Bilinear samples of GLO-30 on a regular lat/lon grid: little-endian Float32, row 0 at the north edge. NaN where the sea has no tile. */
export async function copernicusDem(box: Box, cols: number, rows: number) {
  const key = { cop: box, cols, rows };
  const file = join(CACHE, `${hash(key)}.f32`);
  if (existsSync(file)) return readFileSync(file);
  const out = new Float32Array(cols * rows).fill(Number.NaN);
  for (let lat = Math.floor(box.s); lat <= Math.floor(box.n - 1e-9); lat++) {
    for (let lon = Math.floor(box.w); lon <= Math.floor(box.e - 1e-9); lon++) {
      const name = cogName(lat, lon);
      const url = `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
      const tiff = await fromUrl(url).catch(() => null);
      if (!tiff) continue;
      const image = await tiff.getImage();
      const width = image.getWidth();
      const height = image.getHeight();
      const [x0, y0, x1, y1] = image.getBoundingBox();
      const toPx = (v: number, a: number, b: number, size: number) => ((v - a) / (b - a)) * size;
      const wx0 = Math.max(0, Math.floor(toPx(Math.max(box.w, x0!), x0!, x1!, width)) - 2);
      const wx1 = Math.min(width, Math.ceil(toPx(Math.min(box.e, x1!), x0!, x1!, width)) + 2);
      const wy0 = Math.max(0, Math.floor(toPx(Math.min(box.n, y1!), y1!, y0!, height)) - 2);
      const wy1 = Math.min(height, Math.ceil(toPx(Math.max(box.s, y0!), y1!, y0!, height)) + 2);
      const [raster] = (await image.readRasters({ window: [wx0, wy0, wx1, wy1] })) as unknown as [Float32Array];
      const ww = wx1 - wx0;
      const wh = wy1 - wy0;
      for (let j = 0; j < rows; j++) {
        const la = box.n - ((j + 0.5) / rows) * (box.n - box.s);
        if (la < y0! || la >= y1!) continue;
        for (let i = 0; i < cols; i++) {
          const lo = box.w + ((i + 0.5) / cols) * (box.e - box.w);
          if (lo < x0! || lo >= x1!) continue;
          const px = toPx(lo, x0!, x1!, width) - wx0 - 0.5;
          const py = toPx(la, y1!, y0!, height) - wy0 - 0.5;
          const ix = Math.max(0, Math.min(ww - 2, Math.floor(px)));
          const iy = Math.max(0, Math.min(wh - 2, Math.floor(py)));
          const fx = Math.max(0, Math.min(1, px - ix));
          const fy = Math.max(0, Math.min(1, py - iy));
          const at = (a: number, b: number) => raster[b * ww + a]!;
          out[j * cols + i] = at(ix, iy) * (1 - fx) * (1 - fy) + at(ix + 1, iy) * fx * (1 - fy) + at(ix, iy + 1) * (1 - fx) * fy + at(ix + 1, iy + 1) * fx * fy;
        }
      }
    }
  }
  const bytes = Buffer.from(out.buffer);
  writeFileSync(file, bytes);
  return bytes;
}

// --- NASA FIRMS ---

export type Fire = { lat: number; lon: number; date: string; time: string; sensor: string; satellite: string; confidence: string; brightness: number; frp: number; night: boolean };

const FIRMS_NOW = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"];
const FIRMS_PAST = ["VIIRS_SNPP_SP", "MODIS_SP"];

function parseCsv(text: string) {
  const [head, ...rows] = text.trim().split("\n");
  const keys = (head ?? "").split(",");
  return rows.filter(Boolean).map((row) => Object.fromEntries(row.split(",").map((value, index) => [keys[index]!, value])));
}

/** Thermal anomalies seen from orbit. Past days use the science-quality archives, back to 2000 for MODIS. */
export function fires(box: Box, days: number, date: string | null) {
  const span = Math.max(1, Math.min(10, Math.round(days)));
  return diskJson({ fires: box, span, date }, date ? 30 * 86_400_000 : 30 * 60_000, async () => {
    const key = secret("NASA_FIRMS_MAP_KEY");
    if (!key) throw new Error("Chiave FIRMS assente: va nel file .env.");
    const out: Fire[] = [];
    const seen = new Set<string>();
    // The service takes at most five days per request: longer windows are asked for in pieces.
    const first = Date.parse(date ?? new Date().toISOString().slice(0, 10)) - (date ? 0 : (span - 1) * 86_400_000);
    const pieces: { from: string; days: number }[] = [];
    for (let offset = 0; offset < span; offset += 5) pieces.push({ from: new Date(first + offset * 86_400_000).toISOString().slice(0, 10), days: Math.min(5, span - offset) });
    const requests = (date ? FIRMS_PAST : FIRMS_NOW).flatMap((product) =>
      pieces.map(async ({ from, days }) => {
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${product}/${box.w.toFixed(4)},${box.s.toFixed(4)},${box.e.toFixed(4)},${box.n.toFixed(4)}/${days}/${from}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": UA } });
        const text = await res.text();
        // A refusal must never read as "no fires": an empty answer is a scientific statement.
        if (!res.ok || !/^latitude/.test(text)) throw new Error(scrub(`FIRMS ${product}: ${res.status} ${text.slice(0, 120)}`));
        return text;
      }),
    );
    const replies = await Promise.allSettled(requests);
    if (!replies.some((row) => row.status === "fulfilled")) throw new Error((replies[0] as PromiseRejectedResult).reason?.message ?? "FIRMS non risponde.");
    for (const reply of replies) {
      if (reply.status !== "fulfilled") continue;
      for (const row of parseCsv(reply.value)) {
        const id = `${row.latitude}:${row.longitude}:${row.acq_date}:${row.acq_time}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          lat: Number(row.latitude),
          lon: Number(row.longitude),
          date: row.acq_date!,
          time: `${row.acq_time!.padStart(4, "0").slice(0, 2)}:${row.acq_time!.padStart(4, "0").slice(2)}`,
          sensor: row.instrument!,
          satellite: row.satellite!,
          confidence: row.confidence!,
          brightness: Number(row.bright_ti4 ?? row.brightness),
          frp: Number(row.frp),
          night: row.daynight === "N",
        });
      }
    }
    return out.sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));
  });
}

// --- OpenWeather: second opinion, air, forecast, map layers ---

export type AirReading = { aqi: number; pm25: number; pm10: number; o3: number; no2: number; so2: number; co: number; nh3: number; at: string };

export function openWeather(lat: number, lon: number) {
  const key = secret("OPENWEATHER_API_KEY");
  if (!key) throw new Error("Chiave OpenWeather assente: va nel file .env.");
  const at = `lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&appid=${key}`;
  return diskJson({ owm: [lat.toFixed(3), lon.toFixed(3)] }, 10 * 60_000, async () => {
    const [now, air, forecast] = await Promise.all([
      getJson<{ name: string; dt: number; weather: { description: string }[]; main: { temp: number; humidity: number; pressure: number; feels_like: number }; wind: { speed: number; deg: number; gust?: number }; clouds: { all: number }; visibility?: number }>(`https://api.openweathermap.org/data/2.5/weather?${at}&units=metric&lang=it`),
      getJson<{ list: { dt: number; main: { aqi: number }; components: Record<string, number> }[] }>(`https://api.openweathermap.org/data/2.5/air_pollution?${at}`),
      getJson<{ list: { dt: number; main: { temp: number; pressure: number; humidity: number }; weather: { description: string }[]; wind: { speed: number; deg: number }; clouds: { all: number }; pop: number; rain?: { "3h": number }; snow?: { "3h": number } }[] }>(`https://api.openweathermap.org/data/2.5/forecast?${at}&units=metric&lang=it`),
    ]);
    const a = air.list[0];
    return {
      station: now.name,
      at: new Date(now.dt * 1000).toISOString(),
      description: now.weather[0]?.description ?? "",
      temp: now.main.temp,
      feels: now.main.feels_like,
      humidity: now.main.humidity,
      pressure: now.main.pressure,
      wind: now.wind.speed,
      windDir: now.wind.deg,
      gust: now.wind.gust ?? null,
      cloud: now.clouds.all,
      visibility: now.visibility ?? null,
      air: a
        ? ({ aqi: a.main.aqi, pm25: a.components.pm2_5!, pm10: a.components.pm10!, o3: a.components.o3!, no2: a.components.no2!, so2: a.components.so2!, co: a.components.co!, nh3: a.components.nh3!, at: new Date(a.dt * 1000).toISOString() } satisfies AirReading)
        : null,
      forecast: forecast.list.map((row) => ({
        at: new Date(row.dt * 1000).toISOString(),
        temp: row.main.temp,
        pressure: row.main.pressure,
        humidity: row.main.humidity,
        wind: row.wind.speed,
        windDir: row.wind.deg,
        cloud: row.clouds.all,
        pop: row.pop,
        rain: row.rain?.["3h"] ?? 0,
        snow: row.snow?.["3h"] ?? 0,
        description: row.weather[0]?.description ?? "",
      })),
    };
  });
}

const OWM_LAYERS = new Set(["clouds_new", "precipitation_new", "pressure_new", "wind_new", "temp_new"]);

export async function owmTile(layer: string, z: number, x: number, y: number) {
  const key = secret("OPENWEATHER_API_KEY");
  if (!key || !OWM_LAYERS.has(layer)) return null;
  const res = await fetch(`https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${key}`, { signal: AbortSignal.timeout(20_000) });
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}

// --- NASA GIBS: no key, decades of daily and annual imagery ---

export type DeepLayer = { id: string; label: string; note: string; layer: string; matrix: string; ext: string; maxZoom: number; times: string[] };

const GIBS_LAYERS = [
  { id: "landsat", label: "Landsat, mosaico annuale", note: "30 m per pixel: il territorio prima dei satelliti ad alta risoluzione.", layer: "Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual" },
  { id: "landsat-swir", label: "Landsat, bande 7-4-3", note: "Falso colore annuale: suoli e vegetazione nel passato remoto.", layer: "Landsat_WELD_CorrectedReflectance_Bands743_Global_Annual" },
  { id: "landsat-ndvi", label: "Landsat, NDVI annuale", note: "Vigore della vegetazione anno per anno.", layer: "Landsat_WELD_NDVI_Global_Annual" },
  { id: "notte", label: "Luci notturne", note: "VIIRS Black Marble: 500 m per pixel. Mostra l'estensione dell'abitato.", layer: "VIIRS_Black_Marble" },
];

/** Reads the service's own catalogue: dates change as new years are published, so none is hard-coded. */
export function deepLayers() {
  return diskJson({ gibs: 2 }, 7 * 86_400_000, async () => {
    const res = await fetch("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml", { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GIBS risponde ${res.status}`);
    const xml = await res.text();
    return GIBS_LAYERS.flatMap((item): DeepLayer[] => {
      const start = xml.indexOf(`<ows:Identifier>${item.layer}</ows:Identifier>`);
      if (start < 0) return [];
      const block = xml.slice(start, xml.indexOf("</Layer>", start));
      const matrix = /<TileMatrixSet>([^<]+)/.exec(block)?.[1];
      if (!matrix) return [];
      const times = [...block.matchAll(/<Value>([^<]+)<\/Value>/g)].flatMap((match) => {
        const [a, b, step] = match[1]!.split("/");
        if (!a || !b || step !== "P1Y") return a ? [a] : [];
        const rows: string[] = [];
        for (let year = Number(a.slice(0, 4)); year <= Number(b.slice(0, 4)); year++) rows.push(`${year}${a.slice(4)}`);
        return rows;
      });
      return [{ ...item, matrix, ext: /image\/png/.test(block) ? "png" : "jpg", maxZoom: Number(/Level(\d+)/.exec(matrix)?.[1] ?? 9), times }];
    });
  });
}

export async function gibsTile(layer: string, time: string, z: number, x: number, y: number) {
  const list = await deepLayers();
  const row = list.find((item) => item.id === layer);
  if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(time) || z > row.maxZoom) return null;
  const file = join(CACHE, "gibs", row.id, time, String(z), `${x}_${y}.${row.ext}`);
  if (existsSync(file)) return { body: readFileSync(file), ext: row.ext };
  const res = await fetch(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${row.layer}/default/${time}/${row.matrix}/${z}/${y}/${x}.${row.ext}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const body = Buffer.from(await res.arrayBuffer());
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
  return { body, ext: row.ext };
}

// --- NASA CMR: what exists over the box. Search is open; only downloads need the Earthdata token ---

const CATALOG = [
  { id: "GEDI02_A", label: "GEDI L2A", note: "Altezza di chiome ed edifici misurata da un laser sulla Stazione Spaziale." },
  { id: "ATL08", label: "ICESat-2 ATL08", note: "Profili laser di terreno e vegetazione." },
  { id: "NASADEM_HGT", label: "NASADEM", note: "SRTM rielaborato: rilievo del 2000." },
  { id: "ASTGTM", label: "ASTER GDEM", note: "Rilievo stereo a 30 m." },
  { id: "HLSS30", label: "HLS Sentinel", note: "Riflettanza armonizzata a 30 m." },
  { id: "HLSL30", label: "HLS Landsat", note: "Riflettanza armonizzata a 30 m." },
];

export function nasaCatalog(box: Box) {
  return diskJson({ cmr: box }, 7 * 86_400_000, async () =>
    Promise.all(
      CATALOG.map(async (item) => {
        const box4 = `${box.w},${box.s},${box.e},${box.n}`;
        const res = await fetch(`https://cmr.earthdata.nasa.gov/search/granules.json?short_name=${item.id}&bounding_box=${box4}&page_size=1&sort_key=-start_date`, { signal: AbortSignal.timeout(25_000) });
        if (!res.ok) return { ...item, count: null, newest: null };
        const reply = (await res.json()) as { feed?: { entry?: { time_start?: string }[] } };
        return { ...item, count: Number(res.headers.get("cmr-hits") ?? 0), newest: reply.feed?.entry?.[0]?.time_start?.slice(0, 10) ?? null };
      }),
    ),
  );
}

// --- Photographs and written sources of a place ---

export type PlacePhoto = {
  id: string;
  source: "panoramax" | "commons";
  title: string;
  lat: number;
  lon: number;
  date: string | null;
  heading: number | null;
  fov: number | null;
  pano: boolean;
  thumb: string;
  full: string;
  author: string;
  license: string;
  link: string;
};

export type PlaceArticle = { id: string; title: string; lat: number; lon: number; text: string; link: string; lang: string };

/** Only addresses that a catalogue really returned may pass through the image proxy. */
const known = new Set<string>();

export function isKnownImage(url: string) {
  return known.has(url);
}

const strip = (value: unknown) => String(value ?? "").replace(/<[^>]+>/g, "").trim();

/** Wikimedia answers 200 with an error body when its search is busy: that is a retry, never an empty result worth caching. */
async function wikimedia<T extends { error?: { code?: string; info?: string } }>(url: string): Promise<T> {
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
    const reply = await getJson<T>(url).catch((error: Error) => ({ error: { code: "rete", info: error.message } }) as T);
    if (!reply.error) return reply;
    last = reply.error.info ?? reply.error.code ?? "errore";
  }
  throw new Error(`Wikimedia: ${last}`);
}

async function panoramaxPhotos(box: Box): Promise<PlacePhoto[]> {
  type Feature = { id: string; geometry: { coordinates: [number, number] }; properties: Record<string, unknown>; assets: Record<string, { href: string }>; collection?: string };
  const reply = await getJson<{ features?: Feature[] }>(`https://api.panoramax.xyz/api/search?bbox=${box.w},${box.s},${box.e},${box.n}&limit=200`);
  return (reply.features ?? []).map((row) => {
    const props = row.properties;
    const inner = props["pers:interior_orientation"] as { field_of_view?: number } | undefined;
    const exif = props.exif as Record<string, string> | undefined;
    const pano = exif?.["Xmp.GPano.ProjectionType"] === "equirectangular" || inner?.field_of_view === 360;
    return {
      id: `pmx-${row.id}`,
      source: "panoramax",
      title: "Foto a livello strada",
      lat: row.geometry.coordinates[1],
      lon: row.geometry.coordinates[0],
      date: String(props.datetime ?? "").slice(0, 10) || null,
      heading: typeof props["view:azimuth"] === "number" ? (props["view:azimuth"] as number) : null,
      fov: inner?.field_of_view ?? null,
      pano,
      thumb: row.assets.thumb?.href ?? row.assets.sd?.href ?? "",
      full: row.assets.hd?.href ?? row.assets.sd?.href ?? "",
      author: String(props["geovisio:producer"] ?? "Panoramax"),
      license: String(props.license ?? "CC-BY-SA"),
      link: `https://api.panoramax.xyz/?focus=pic&pic=${row.id}`,
    } satisfies PlacePhoto;
  });
}

async function commonsPhotos(lat: number, lon: number, radius: number): Promise<PlacePhoto[]> {
  const base = "https://commons.wikimedia.org/w/api.php?format=json&origin=*";
  const list = await wikimedia<{ error?: { code?: string; info?: string }; query?: { geosearch?: { pageid: number; lat: number; lon: number }[] } }>(`${base}&action=query&list=geosearch&gsnamespace=6&gslimit=50&gsradius=${Math.min(10000, Math.round(radius))}&gscoord=${lat}%7C${lon}`);
  const rows = list.query?.geosearch ?? [];
  if (!rows.length) return [];
  const where = new Map(rows.map((row) => [row.pageid, row]));
  const info = await wikimedia<{ error?: { code?: string; info?: string }; query?: { pages?: Record<string, { pageid: number; title: string; imageinfo?: { url: string; thumburl?: string; descriptionurl: string; mime: string; extmetadata?: Record<string, { value: string }> }[] }> } }>(
    `${base}&action=query&prop=imageinfo&iiprop=url%7Cextmetadata%7Cmime&iiurlwidth=1600&pageids=${rows.map((row) => row.pageid).join("%7C")}`,
  );
  return Object.values(info.query?.pages ?? {}).flatMap((page): PlacePhoto[] => {
    const image = page.imageinfo?.[0];
    const at = where.get(page.pageid);
    if (!image || !at || !/^image\/(jpeg|png|webp)/.test(image.mime)) return [];
    const meta = image.extmetadata ?? {};
    const taken = strip(meta.DateTimeOriginal?.value);
    return [
      {
        id: `com-${page.pageid}`,
        source: "commons",
        title: page.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""),
        lat: at.lat,
        lon: at.lon,
        date: /\d{4}/.exec(taken)?.[0] ? taken.slice(0, 10) : null,
        heading: null,
        fov: null,
        pano: false,
        thumb: image.thumburl ?? image.url,
        full: image.thumburl ?? image.url,
        author: strip(meta.Artist?.value) || "Wikimedia Commons",
        license: strip(meta.LicenseShortName?.value) || "vedi la pagina",
        link: image.descriptionurl,
      },
    ];
  });
}

export async function placePhotos(box: Box, only: "panoramax" | "commons" | null = null) {
  const lat = (box.s + box.n) / 2;
  const lon = (box.w + box.e) / 2;
  const radius = Math.hypot((box.n - box.s) * 111320, (box.e - box.w) * 111320 * Math.cos((lat * Math.PI) / 180)) / 2;
  // Cached one source at a time: a catalogue that is busy today must not leave a hole on disk for a week.
  const [a, b] = await Promise.allSettled([
    only === "commons" ? Promise.resolve<PlacePhoto[]>([]) : diskJson({ panoramax: box }, 7 * 86_400_000, () => panoramaxPhotos(box)),
    only === "panoramax" ? Promise.resolve<PlacePhoto[]>([]) : diskJson({ commons: box }, 7 * 86_400_000, () => commonsPhotos(lat, lon, radius)),
  ]);
  if (a.status === "rejected" && b.status === "rejected") throw new Error("Né Panoramax né Commons rispondono.");
  const photos = [...(a.status === "fulfilled" ? a.value : []), ...(b.status === "fulfilled" ? b.value : [])];
  for (const photo of photos) {
    if (photo.thumb) known.add(photo.thumb);
    if (photo.full) known.add(photo.full);
  }
  return photos;
}

export async function proxiedImage(url: string) {
  if (!known.has(url)) return null;
  const file = join(CACHE, "foto", `${hash(url)}.bin`);
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(url, { signal: AbortSignal.timeout(40_000), headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const body = Buffer.from(await res.arrayBuffer());
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
  return body;
}

export async function placeArticles(lat: number, lon: number, radius: number) {
  const langs = await Promise.allSettled(
    ["it", "en"].map((lang) =>
      diskJson({ wiki: lang, at: [lat.toFixed(4), lon.toFixed(4), Math.round(radius)] }, 7 * 86_400_000, async () => {
        const reply = await wikimedia<{ error?: { code?: string; info?: string }; query?: { pages?: Record<string, { pageid: number; title: string; extract?: string; fullurl: string; coordinates?: { lat: number; lon: number }[] }> } }>(
          `https://${lang}.wikipedia.org/w/api.php?format=json&origin=*&action=query&generator=geosearch&ggscoord=${lat}%7C${lon}&ggsradius=${Math.min(10000, Math.max(100, Math.round(radius)))}&ggslimit=20&prop=extracts%7Ccoordinates%7Cinfo&exintro=1&explaintext=1&exsentences=3&exlimit=20&inprop=url`,
        );
        return Object.values(reply.query?.pages ?? {}).flatMap((page): PlaceArticle[] => {
          const at = page.coordinates?.[0];
          return at && page.extract ? [{ id: `${lang}-${page.pageid}`, title: page.title, lat: at.lat, lon: at.lon, text: page.extract, link: page.fullurl, lang }] : [];
        });
      }),
    ),
  );
  return langs.flatMap((row) => (row.status === "fulfilled" ? row.value : []));
}

// --- What each key unlocks, stated plainly ---

export async function servicesStatus() {
  const earthdata = secret("NASA_EARTHDATA_TOKEN");
  const expiry = jwtExpiry(earthdata);
  const expired = expiry ? Date.parse(expiry) < Date.now() : false;
  return [
    { id: "copernicus", label: "Copernicus Data Space", state: secret("COPERNICUS_CLIENT_ID") && secret("COPERNICUS_CLIENT_SECRET") ? "pronta" : "assente", detail: "Sentinel-1 e Sentinel-2 su misura, serie di NDVI, firma spettrale." },
    { id: "firms", label: "NASA FIRMS", state: secret("NASA_FIRMS_MAP_KEY") ? "pronta" : "assente", detail: "Fuochi attivi degli ultimi giorni e archivio dal 2000." },
    { id: "openweather", label: "OpenWeather", state: secret("OPENWEATHER_API_KEY") ? "pronta" : "assente", detail: "Seconda stazione, qualità dell'aria, previsioni a 5 giorni, carte meteo." },
    { id: "earthdata", label: "NASA Earthdata", state: !earthdata ? "assente" : expired ? "scaduta" : "pronta", detail: expired ? `Token scaduto il ${expiry!.slice(0, 10)}: rigeneralo su urs.earthdata.nasa.gov. Catalogo e mosaici GIBS funzionano lo stesso, laser GEDI e NASADEM no.` : `Laser GEDI e rilievo NASADEM. Il token scade il ${expiry?.slice(0, 10) ?? "?"}.` },
    { id: "libere", label: "Fonti senza chiave", state: "pronta", detail: "Earth Search, Copernicus DEM, NASA GIBS e CMR, Panoramax, Wikimedia, Wikipedia, Open-Meteo, OSM." },
  ];
}
