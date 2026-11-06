import { mxToLon, myToLat, type Bbox } from "../core/geo.ts";

export async function readManualPlate(file: File): Promise<{ canvas: HTMLCanvasElement; bbox: Bbox | null; date: string | null; note: string }> {
  if (/\.tiff?$/i.test(file.name) || file.type === "image/tiff") return readGeoTiff(file);
  const bitmap = await createImageBitmap(file);
  const limit = Math.min(1, 8192 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * limit);
  canvas.height = Math.round(bitmap.height * limit);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const date = /(20\d{2}|19\d{2})[-_]?(\d{2})[-_]?(\d{2})/.exec(file.name);
  return {
    canvas,
    bbox: null,
    date: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
    note: `${bitmap.width}×${bitmap.height} px. Nessuna georeferenza nel file: sistema il riquadro sulla mappa o inserisci gli angoli.`,
  };
}

async function readGeoTiff(file: File) {
  const { fromBlob } = await import("geotiff");
  const tiff = await fromBlob(file);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const scale = Math.min(1, 8192 / Math.max(width, height));
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);
  const raster = (await image.readRasters({ width: outW, height: outH, interleave: true })) as unknown as ArrayLike<number> & { length: number };
  const bands = image.getSamplesPerPixel();
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d")!;
  const out = ctx.createImageData(outW, outH);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < raster.length; i += Math.max(1, Math.floor(raster.length / 100000))) {
    const v = raster[i]!;
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  // 8-bit data passes through; anything deeper (16-bit reflectance) is stretched to the visible range.
  const eightBit = lo >= 0 && hi <= 255;
  const norm = (v: number) => (eightBit ? v : ((v - lo) / Math.max(1e-6, hi - lo)) * 255);
  for (let i = 0; i < outW * outH; i++) {
    const r = raster[i * bands]!;
    const g = bands >= 3 ? raster[i * bands + 1]! : r;
    const b = bands >= 3 ? raster[i * bands + 2]! : r;
    out.data[i * 4] = norm(r);
    out.data[i * 4 + 1] = norm(g);
    out.data[i * 4 + 2] = norm(b);
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);

  let bbox: Bbox | null = null;
  let note = `GeoTIFF ${width}×${height} px, ${bands} bande.`;
  try {
    const [x0, y0, x1, y1] = image.getBoundingBox() as [number, number, number, number];
    const keys = image.getGeoKeys() as { ProjectedCSTypeGeoKey?: number; GeographicTypeGeoKey?: number; GTModelTypeGeoKey?: number };
    const projected = keys.ProjectedCSTypeGeoKey;
    if (projected === 3857 || projected === 900913 || projected === 3785) {
      bbox = { w: mxToLon(x0), e: mxToLon(x1), s: myToLat(y0), n: myToLat(y1) };
      note += " Collocato da EPSG:3857.";
    } else if (!projected && (keys.GeographicTypeGeoKey === 4326 || keys.GTModelTypeGeoKey === 2)) {
      bbox = { w: x0, s: y0, e: x1, n: y1 };
      note += " Collocato da EPSG:4326.";
    } else {
      note += ` Proiezione EPSG:${projected ?? "?"} non convertita: inserisci gli angoli a mano.`;
    }
  } catch {
    note += " Georeferenza assente: inserisci gli angoli.";
  }
  const raw = image.getFileDirectory() as unknown as Record<string, unknown>;
  const stamp = String(raw.DateTime ?? "");
  const date = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(stamp);
  return { canvas, bbox, date: date ? `${date[1]}-${date[2]}-${date[3]}` : null, note };
}
