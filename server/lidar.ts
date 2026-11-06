import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromArrayBuffer, fromUrl } from "geotiff";
// @ts-expect-error proj4 ships without types here.
import proj4Module from "proj4";
import { DATA, UA } from "./sources.ts";

/**
 * National airborne laser surveys open to anyone, without a key. Each one was tried on a real place before going in the
 * table. Italy has no entry on purpose: its national portal serves the 1 m model for viewing only, and for download only
 * the 20 m one. Denmark and New Zealand need a personal key.
 */
const proj4 = proj4Module as (from: string, to: string) => { forward: (point: [number, number]) => [number, number] };

const CACHE = join(DATA, "cache", "lidar");
mkdirSync(CACHE, { recursive: true });

type Box = { s: number; w: number; n: number; e: number };
export type LidarKind = "dtm" | "dsm";

const CRS: Record<string, string> = {
  "EPSG:28992": "+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs",
  "EPSG:27700": "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs",
  "EPSG:2056": "+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs",
  "EPSG:25832": "+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs",
  "EPSG:31370": "+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs",
  "EPSG:2180": "+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +units=m +no_defs",
};

type Raster = { values: ArrayLike<number>; width: number; height: number; x0: number; y0: number; dx: number; dy: number; crs: string | null; nodata: number | null };

type Fetcher = (kind: LidarKind, box: Box, cols: number, rows: number) => Promise<Raster[]>;

export type LidarProvider = {
  id: string;
  name: string;
  country: string;
  resolution: number;
  surface: boolean;
  license: string;
  url: string;
  bounds: Box;
  fetch: Fetcher;
};

async function getBytes(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${new URL(url).host}: errore ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const bytes = await res.arrayBuffer();
  // These services answer a request outside their coverage, or a malformed one, with a 200 and an XML page.
  if (/xml|html|json/.test(type) && !/bil|tiff|multipart/.test(type)) throw new Error(`${new URL(url).host}: risposta non raster`);
  return bytes;
}

async function readTiff(bytes: ArrayBuffer, crs: string | null): Promise<Raster> {
  const tiff = await fromArrayBuffer(bytes);
  const image = await tiff.getImage();
  const [x0, y0, x1, y1] = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();
  const [values] = (await image.readRasters({ interleave: false })) as unknown as [ArrayLike<number>];
  return { values, width, height, x0: x0!, y0: y1!, dx: (x1! - x0!) / width, dy: (y1! - y0!) / height, crs, nodata: image.getGDALNoData() };
}

/** Some WCS wrap the file in a multipart answer with its description: the raster starts at the TIFF signature. */
function tiffPart(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  if ((view[0] === 0x49 && view[1] === 0x49) || (view[0] === 0x4d && view[1] === 0x4d)) return bytes;
  for (let i = 0; i < Math.min(view.length - 4, 65536); i++) {
    if (view[i] === 0x49 && view[i + 1] === 0x49 && view[i + 2] === 0x2a && view[i + 3] === 0) return bytes.slice(i);
    if (view[i] === 0x4d && view[i + 1] === 0x4d && view[i + 2] === 0 && view[i + 3] === 0x2a) return bytes.slice(i);
  }
  throw new Error("il servizio non ha restituito un raster");
}

function nativeBox(box: Box, crs: string) {
  const forward = proj4("WGS84", CRS[crs]!).forward;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const lat of [box.s, (box.s + box.n) / 2, box.n]) {
    for (const lon of [box.w, (box.w + box.e) / 2, box.e]) {
      const [x, y] = forward([lon, lat]) as [number, number];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX: minX - 3, maxX: maxX + 3, minY: minY - 3, maxY: maxY + 3 };
}

/** WCS 2.0.1 in the service's own grid: resampling on its side would blur exactly the traces worth looking at. */
function wcs(endpoint: string, coverage: Record<LidarKind, string | null>, crs: string, axes: [string, string], step: number): Fetcher {
  return async (kind, box, cols, rows) => {
    const id = coverage[kind];
    if (!id) return [];
    const b = nativeBox(box, crs);
    const code = crs.split(":")[1];
    const params = [`SERVICE=WCS`, `VERSION=2.0.1`, `REQUEST=GetCoverage`, `COVERAGEID=${encodeURIComponent(id)}`, `FORMAT=image/tiff`, `SUBSET=${axes[0]}(${b.minX.toFixed(1)},${b.maxX.toFixed(1)})`, `SUBSET=${axes[1]}(${b.minY.toFixed(1)},${b.maxY.toFixed(1)})`];
    if (crs === "EPSG:27700" || crs === "EPSG:28992") params.push(`SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/${code}`);
    // Big boxes come scaled down to what the output grid can show.
    const wantX = Math.min(4096, Math.ceil(Math.max((b.maxX - b.minX) / step, 1)));
    const wantY = Math.min(4096, Math.ceil(Math.max((b.maxY - b.minY) / step, 1)));
    const over = Math.max(1, Math.max(cols, rows) * 1.5);
    if (Math.max(wantX, wantY) > over) params.push(`SCALEFACTOR=${(over / Math.max(wantX, wantY)).toFixed(4)}`);
    const glue = endpoint.includes("?") ? "&" : "?";
    const bytes = await getBytes(`${endpoint}${glue}${params.join("&")}`);
    return [await readTiff(tiffPart(bytes), crs)];
  };
}

const usa: Fetcher = async (kind, box, cols, rows) => {
  if (kind === "dsm") return [];
  const url = `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=${box.w},${box.s},${box.e},${box.n}&bboxSR=4326&imageSR=4326&size=${Math.min(4000, cols)},${Math.min(4000, rows)}&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image`;
  return [await readTiff(await getBytes(url), null)];
};

/** France's WMS-R serves raw 32-bit floats: no reprojection on our side, and asked exactly at the output grid. */
const france: Fetcher = async (kind, box, cols, rows) => {
  const layer = kind === "dtm" ? "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93" : "IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93";
  const width = Math.min(4096, cols);
  const height = Math.min(4096, rows);
  const url = `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:4326&BBOX=${box.s},${box.w},${box.n},${box.e}&WIDTH=${width}&HEIGHT=${height}&FORMAT=image/x-bil;bits=32`;
  const bytes = await getBytes(url);
  if (bytes.byteLength !== width * height * 4) throw new Error("data.geopf.fr: griglia inattesa");
  return [{ values: new Float32Array(bytes), width, height, x0: box.w, y0: box.n, dx: (box.e - box.w) / width, dy: (box.n - box.s) / height, crs: null, nodata: -99999 }];
};

/** Switzerland publishes 1 km tiles as cloud-optimised files, found through its catalogue. */
function swiss(): Fetcher {
  return async (kind, box) => {
    const collection = kind === "dtm" ? "ch.swisstopo.swissalti3d" : "ch.swisstopo.swisssurface3d-raster";
    const url = `https://data.geo.admin.ch/api/stac/v0.9/collections/${collection}/items?bbox=${box.w},${box.s},${box.e},${box.n}&limit=100`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`data.geo.admin.ch: errore ${res.status}`);
    const items = (await res.json()) as { features: { id: string; assets: Record<string, { href: string }> }[] };
    // A tile can exist for several survey years: the newest wins.
    const newest = new Map<string, { year: string; href: string }>();
    for (const feature of items.features) {
      const match = /_(\d{4})_(\d{4}-\d{4})$/.exec(feature.id);
      const asset = Object.values(feature.assets).find((row) => /_0\.5_2056_5728\.tif$/.test(row.href));
      if (!match || !asset) continue;
      const known = newest.get(match[2]!);
      if (!known || known.year < match[1]!) newest.set(match[2]!, { year: match[1]!, href: asset.href });
    }
    const b = nativeBox(box, "EPSG:2056");
    const out: Raster[] = [];
    for (const { href } of newest.values()) {
      const tiff = await fromUrl(href);
      const image = await tiff.getImage();
      const [x0, y0, x1, y1] = image.getBoundingBox();
      const width = image.getWidth();
      const height = image.getHeight();
      const dx = (x1! - x0!) / width;
      const dy = (y1! - y0!) / height;
      const left = Math.max(0, Math.floor((b.minX - x0!) / dx));
      const right = Math.min(width, Math.ceil((b.maxX - x0!) / dx));
      const top = Math.max(0, Math.floor((y1! - b.maxY) / dy));
      const bottom = Math.min(height, Math.ceil((y1! - b.minY) / dy));
      if (right <= left || bottom <= top) continue;
      const [values] = (await image.readRasters({ window: [left, top, right, bottom], interleave: false })) as unknown as [ArrayLike<number>];
      out.push({ values, width: right - left, height: bottom - top, x0: x0! + left * dx, y0: y1! - top * dy, dx, dy, crs: "EPSG:2056", nodata: image.getGDALNoData() });
    }
    return out;
  };
}

export const LIDAR_PROVIDERS: LidarProvider[] = [
  {
    id: "ahn",
    name: "AHN, Actueel Hoogtebestand Nederland",
    country: "Paesi Bassi",
    resolution: 0.5,
    surface: true,
    license: "CC0",
    url: "https://www.ahn.nl",
    bounds: { s: 50.7, w: 3.2, n: 53.6, e: 7.3 },
    fetch: wcs("https://service.pdok.nl/rws/ahn/wcs/v1_0", { dtm: "dtm_05m", dsm: "dsm_05m" }, "EPSG:28992", ["x", "y"], 0.5),
  },
  {
    id: "ign",
    name: "IGN LiDAR HD",
    country: "Francia",
    resolution: 1,
    surface: true,
    license: "Licence Ouverte 2.0",
    url: "https://geoservices.ign.fr/lidarhd",
    bounds: { s: 41.3, w: -5.2, n: 51.1, e: 9.6 },
    fetch: france,
  },
  {
    id: "ea",
    name: "Environment Agency LIDAR Composite",
    country: "Inghilterra",
    resolution: 1,
    surface: true,
    license: "Open Government Licence",
    url: "https://environment.data.gov.uk/survey",
    bounds: { s: 49.9, w: -6.5, n: 55.9, e: 1.9 },
    fetch: async (kind, box, cols, rows) =>
      kind === "dtm"
        ? wcs("https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs", { dtm: "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m", dsm: null }, "EPSG:27700", ["E", "N"], 1)(kind, box, cols, rows)
        : wcs("https://environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-first-return-dsm-1m/wcs", { dtm: null, dsm: "df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m" }, "EPSG:27700", ["E", "N"], 1)(kind, box, cols, rows),
  },
  {
    id: "swisstopo",
    name: "swissALTI3D e swissSURFACE3D",
    country: "Svizzera",
    resolution: 0.5,
    surface: true,
    license: "Open Government Data, citare swisstopo",
    url: "https://www.swisstopo.admin.ch/it/modello-altimetrico-swissalti3d",
    bounds: { s: 45.8, w: 5.9, n: 47.85, e: 10.5 },
    fetch: swiss(),
  },
  {
    id: "dhmv",
    name: "DHM Vlaanderen II",
    country: "Belgio, Fiandre",
    resolution: 1,
    surface: true,
    license: "Gratuito, licenza aperta Vlaanderen",
    url: "https://www.vlaanderen.be/datavindplaats",
    bounds: { s: 50.65, w: 2.5, n: 51.55, e: 5.95 },
    fetch: wcs("https://geo.api.vlaanderen.be/DHMV/wcs", { dtm: "DHMVII_DTM_1m", dsm: "DHMVII_DSM_1m" }, "EPSG:31370", ["x", "y"], 1),
  },
  {
    id: "nrw",
    name: "DGM1 Nordrhein-Westfalen",
    country: "Germania, Renania Settentrionale-Vestfalia",
    resolution: 1,
    surface: false,
    license: "dl-de/zero-2-0",
    url: "https://www.opengeodata.nrw.de",
    bounds: { s: 50.3, w: 5.85, n: 52.55, e: 9.5 },
    fetch: wcs("https://www.wcs.nrw.de/geobasis/wcs_nw_dgm", { dtm: "nw_dgm", dsm: null }, "EPSG:25832", ["x", "y"], 1),
  },
  {
    id: "gugik",
    name: "NMT GUGiK",
    country: "Polonia",
    resolution: 1,
    surface: false,
    license: "Gratuito, legge polacca sui dati geodetici",
    url: "https://www.geoportal.gov.pl",
    bounds: { s: 49, w: 14.1, n: 54.9, e: 24.2 },
    fetch: wcs("https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WCS/DigitalTerrainModelFormatTIFF", { dtm: "DTM_PL-KRON86-NH_TIFF", dsm: null }, "EPSG:2180", ["x", "y"], 1),
  },
  {
    id: "3dep",
    name: "USGS 3DEP",
    country: "Stati Uniti",
    resolution: 1,
    surface: false,
    license: "Pubblico dominio",
    url: "https://www.usgs.gov/3d-elevation-program",
    bounds: { s: 18, w: -180, n: 72, e: -64 },
    fetch: usa,
  },
];

const inside = (box: Box, b: Box) => box.n <= b.n && box.s >= b.s && box.e <= b.e && box.w >= b.w;

/** Fills a lat/lon grid, row 0 north, from whichever rasters cover each cell. NaN where none does. */
function resample(rasters: Raster[], box: Box, cols: number, rows: number) {
  const out = new Float32Array(cols * rows).fill(Number.NaN);
  for (const raster of rasters) {
    const forward = raster.crs ? proj4("WGS84", CRS[raster.crs]!).forward : null;
    const { width, height, values, nodata } = raster;
    const valid = (v: number) => Number.isFinite(v) && v > -1000 && v < 9000 && (nodata == null || v !== nodata);
    for (let j = 0; j < rows; j++) {
      const lat = box.n - ((j + 0.5) / rows) * (box.n - box.s);
      for (let i = 0; i < cols; i++) {
        if (!Number.isNaN(out[j * cols + i]!)) continue;
        const lon = box.w + ((i + 0.5) / cols) * (box.e - box.w);
        const [x, y] = forward ? (forward([lon, lat]) as [number, number]) : [lon, lat];
        const px = (x - raster.x0) / raster.dx - 0.5;
        const py = (raster.y0 - y) / raster.dy - 0.5;
        if (px < -0.5 || py < -0.5 || px > width - 0.5 || py > height - 0.5) continue;
        const ix = Math.max(0, Math.min(width - 2, Math.floor(px)));
        const iy = Math.max(0, Math.min(height - 2, Math.floor(py)));
        const fx = Math.max(0, Math.min(1, px - ix));
        const fy = Math.max(0, Math.min(1, py - iy));
        const a = values[iy * width + ix]!;
        const b = values[iy * width + ix + 1]!;
        const c = values[(iy + 1) * width + ix]!;
        const d = values[(iy + 1) * width + ix + 1]!;
        if (valid(a) && valid(b) && valid(c) && valid(d)) out[j * cols + i] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
        else if (valid(a)) out[j * cols + i] = a;
      }
    }
  }
  return out;
}

export async function lidarGrid(id: string, kind: LidarKind, box: Box, cols: number, rows: number) {
  const provider = LIDAR_PROVIDERS.find((row) => row.id === id);
  if (!provider) throw new Error("rilievo sconosciuto");
  const file = join(CACHE, `${createHash("md5").update(JSON.stringify({ id, kind, box, cols, rows })).digest("hex")}.f32`);
  if (existsSync(file)) return readFileSync(file);
  const grid = resample(await provider.fetch(kind, box, cols, rows), box, cols, rows);
  const bytes = Buffer.from(grid.buffer);
  writeFileSync(file, bytes);
  return bytes;
}

export type LidarCoverage = { id: string; name: string; country: string; resolution: number; surface: boolean; license: string; url: string; share: number; error: string | null };

/** The bounds are only rough: real coverage comes from asking for a small grid and counting what returns. */
export async function lidarCoverage(box: Box): Promise<LidarCoverage[]> {
  const near = LIDAR_PROVIDERS.filter((row) => inside(box, row.bounds));
  return Promise.all(
    near.map(async ({ id, name, country, resolution, surface, license, url }) => {
      try {
        // Only the middle, at full detail: cheap for the service. Bare-ground models have holes under buildings, so a surface model counts better.
        const middle = { lat: (box.s + box.n) / 2, lon: (box.w + box.e) / 2 };
        const dLat = 40 / 111320;
        const dLon = 40 / (111320 * Math.cos((middle.lat * Math.PI) / 180));
        const bytes = await lidarGrid(id, surface ? "dsm" : "dtm", { s: middle.lat - dLat, n: middle.lat + dLat, w: middle.lon - dLon, e: middle.lon + dLon }, 40, 40);
        const grid = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        let valid = 0;
        for (const v of grid) if (!Number.isNaN(v)) valid++;
        return { id, name, country, resolution, surface, license, url, share: valid / grid.length, error: null };
      } catch (e) {
        return { id, name, country, resolution, surface, license, url, share: 0, error: (e as Error).message };
      }
    }),
  );
}
