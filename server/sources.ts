import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..");
export const DATA = process.env.SESTANTE_DATA ?? join(ROOT, "data");
export const UA = "Sestante/2.0 (strumento locale di ricerca geografica)";

export type TileSource = {
  id: string;
  label: string;
  group: "ripresa" | "carta" | "storico" | "quota" | "tuo";
  template: string;
  maxZoom: number;
  ext: string;
  attribution: string;
  note?: string;
  /** Upper bound of tiles for a single bulk job, when the provider's policy asks for restraint. */
  bulkLimit?: number;
};

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

const BUILT_IN: TileSource[] = [
  {
    id: "esri",
    label: "Esri World Imagery (corrente)",
    group: "ripresa",
    template: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    maxZoom: 19,
    ext: "jpg",
    attribution: "Esri, Maxar, Earthstar Geographics",
  },
  ...[2023, 2022, 2021, 2020, 2019, 2018, 2016].map(
    (year): TileSource => ({
      id: `s2-${year}`,
      label: `Sentinel-2 cloudless ${year}`,
      group: "storico",
      template: `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/g/{z}/{y}/{x}.jpg`,
      maxZoom: 15,
      ext: "jpg",
      attribution: `Sentinel-2 cloudless ${year} by EOX, dati Copernicus`,
      note: "Mosaico annuale a 10 m/px: poco dettaglio, ottimo per osservare il cambiamento del territorio.",
    }),
  ),
  {
    id: "topo",
    label: "Esri World Topo",
    group: "carta",
    template: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`,
    maxZoom: 19,
    ext: "jpg",
    attribution: "Esri, HERE, Garmin, USGS, NOAA",
  },
  {
    id: "grigia",
    label: "Esri grigio chiaro",
    group: "carta",
    template: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    maxZoom: 16,
    ext: "jpg",
    attribution: "Esri, HERE, Garmin, © OpenStreetMap",
  },
  {
    id: "osm",
    label: "OpenStreetMap",
    group: "carta",
    template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    ext: "png",
    attribution: "© collaboratori OpenStreetMap",
    note: "La policy di OSM vieta gli scarichi di massa: i lavori sono limitati a riquadri piccoli.",
    bulkLimit: 250,
  },
  {
    id: "dem",
    label: "Quote Terrarium (Mapzen/AWS)",
    group: "quota",
    template: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    maxZoom: 15,
    ext: "png",
    attribution: "Mapzen Terrain Tiles: SRTM, GMTED, NED, ETOPO1",
  },
];

const CUSTOM_FILE = join(DATA, "sources.json");

/** The file can be edited by hand, so it is checked: a typo must not pass for "no sources". */
export function parseCustomSources(text: string): TileSource[] {
  const list = JSON.parse(text) as unknown;
  if (!Array.isArray(list)) throw new Error("deve contenere un elenco di fonti");
  list.forEach((row: Partial<TileSource> | null, i) => {
    if (typeof row?.id !== "string" || typeof row.template !== "string") throw new Error(`alla fonte ${i + 1} manca id o template`);
  });
  return list as TileSource[];
}

let lastProblem: string | null = null;

function readCustomSources(): { list: TileSource[]; problem: string | null } {
  let out: { list: TileSource[]; problem: string | null } = { list: [], problem: null };
  if (existsSync(CUSTOM_FILE)) {
    try {
      out.list = parseCustomSources(readFileSync(CUSTOM_FILE, "utf8"));
    } catch (error) {
      out = { list: [], problem: `${CUSTOM_FILE} non è valido: ${(error as Error).message}. Le fonti personali sono sospese finché non lo correggi.` };
    }
  }
  // Read for every tile: once in the log is enough.
  if (out.problem && out.problem !== lastProblem) console.error(out.problem);
  lastProblem = out.problem;
  return out;
}

export const customSources = () => readCustomSources().list;
export const customSourcesProblem = () => readCustomSources().problem;

export function saveCustomSources(list: TileSource[]) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(CUSTOM_FILE, JSON.stringify(list, null, 1));
}

export function allSources(): TileSource[] {
  return [...BUILT_IN, ...customSources()];
}

export type WaybackRelease = { release: number; date: string; title: string; metaUrl: string };

let releases: WaybackRelease[] | null = null;

export async function waybackReleases(): Promise<WaybackRelease[]> {
  if (releases) return releases;
  const cache = join(DATA, "wayback.json");
  type RawConfig = Record<string, { itemTitle: string; metadataLayerUrl: string }>;
  let raw: RawConfig | null = null;
  try {
    const res = await fetch("https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json", {
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      raw = (await res.json()) as RawConfig;
      mkdirSync(DATA, { recursive: true });
      writeFileSync(cache, JSON.stringify(raw));
    }
  } catch {
    /* the disk copy below keeps the archive usable offline */
  }
  if (!raw && existsSync(cache)) raw = JSON.parse(readFileSync(cache, "utf8")) as RawConfig;
  if (!raw) throw new Error("Archivio Wayback non raggiungibile.");
  releases = Object.entries(raw)
    .map(([key, value]) => ({
      release: Number(key),
      title: value.itemTitle,
      date: /(\d{4}-\d{2}-\d{2})/.exec(value.itemTitle)?.[1] ?? "",
      metaUrl: value.metadataLayerUrl,
    }))
    .filter((row) => row.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  return releases;
}

export function quadKey(z: number, x: number, y: number) {
  let key = "";
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    key += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return key;
}

/** Same placeholders as MapTilesDownloader: {x} {y} {z} {quad}, plus {-y} for TMS servers and {s} for host rotation. */
export function expandTemplate(template: string, z: number, x: number, y: number) {
  return template
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y))
    .replaceAll("{-y}", String(2 ** z - 1 - y))
    .replaceAll("{z}", String(z))
    .replaceAll("{quad}", quadKey(z, x, y))
    .replaceAll("{s}", "abc"[(x + y) % 3]!);
}

export async function resolveSource(id: string): Promise<TileSource | null> {
  const match = /^wb-(\d+)$/.exec(id);
  if (match) {
    const list = await waybackReleases();
    const row = list.find((item) => item.release === Number(match[1]));
    if (!row) return null;
    return {
      id,
      label: `Wayback ${row.date}`,
      group: "storico",
      template: `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${row.release}/{z}/{y}/{x}`,
      maxZoom: 19,
      ext: "jpg",
      attribution: `Esri World Imagery Wayback ${row.date}`,
    };
  }
  return allSources().find((source) => source.id === id) ?? null;
}
