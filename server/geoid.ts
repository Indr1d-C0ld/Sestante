import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromArrayBuffer } from "geotiff";
import { DATA, UA } from "./sources.ts";

/**
 * The geoid: how far mean sea level stands above the WGS84 ellipsoid. GEDI gives heights on the ellipsoid, maps and
 * terrain models on the geoid, so this is the reference between them. EGM96 on a 15' grid, published by the NGA (public
 * domain) and served by the PROJ project; 2.7 MB, downloaded once and kept in the cache.
 */
const DIR = join(DATA, "cache", "geoid");
const FILE = join(DIR, "us_nga_egm96_15.tif");
const URL = "https://cdn.proj.org/us_nga_egm96_15.tif";

type Grid = { w: number; h: number; ox: number; oy: number; rx: number; ry: number; data: ArrayLike<number> };
let grid: Promise<Grid> | null = null;

async function load(): Promise<Grid> {
  if (!existsSync(FILE)) {
    const res = await fetch(URL, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`PROJ risponde ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 1_000_000) throw new Error("Griglia del geoide incompleta");
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, bytes);
  }
  const bytes = readFileSync(FILE);
  const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin() as [number, number];
  const [rx, ry] = image.getResolution() as [number, number];
  const data = (await image.readRasters())[0] as ArrayLike<number>;
  return { w: image.getWidth(), h: image.getHeight(), ox, oy, rx, ry, data };
}

/** Geoid height above the ellipsoid at a point, metres; null when the grid cannot be had. */
export async function geoidAt(lat: number, lon: number): Promise<number | null> {
  grid ??= load().catch((error) => {
    grid = null;
    throw error;
  });
  const g = await grid.catch(() => null);
  if (!g) return null;
  // Grid points sit on whole quarter degrees from 180 W and 90 N; longitude wraps around.
  const fx = (lon - g.ox) / g.rx;
  const fy = Math.max(0, Math.min(g.h - 1.000001, (lat - g.oy) / g.ry));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const at = (a: number, b: number) => g.data[Math.min(g.h - 1, b) * g.w + (((a % g.w) + g.w) % g.w)]!;
  return at(i, j) * (1 - tx) * (1 - ty) + at(i + 1, j) * tx * (1 - ty) + at(i, j + 1) * (1 - tx) * ty + at(i + 1, j + 1) * tx * ty;
}
