/** The few EXIF fields that help place a photo. Reads a JPEG's APP1 block; other files simply have none. */
export type PhotoExif = { focal35: number | null; focal: number | null; taken: string | null; lat: number | null; lon: number | null; bearing: number | null; camera: string | null; orientation: number };

export function readExif(bytes: ArrayBuffer): PhotoExif {
  const out: PhotoExif = { focal35: null, focal: null, taken: null, lat: null, lon: null, bearing: null, camera: null, orientation: 1 };
  const view = new DataView(bytes);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return out;
  let at = 2;
  while (at + 4 < view.byteLength) {
    const marker = view.getUint16(at);
    const size = view.getUint16(at + 2);
    if (marker === 0xffe1 && view.getUint32(at + 4) === 0x45786966) return { ...out, ...parseTiff(view, at + 10) };
    if ((marker & 0xff00) !== 0xff00) break;
    at += 2 + size;
  }
  return out;
}

function parseTiff(view: DataView, base: number): Partial<PhotoExif> {
  const little = view.getUint16(base) === 0x4949;
  const u16 = (p: number) => view.getUint16(p, little);
  const u32 = (p: number) => view.getUint32(p, little);
  const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const entries = (offset: number) => {
    const rows = new Map<number, { type: number; count: number; at: number }>();
    const start = base + offset;
    if (start + 2 > view.byteLength) return rows;
    const n = u16(start);
    for (let i = 0; i < n; i++) {
      const p = start + 2 + i * 12;
      if (p + 12 > view.byteLength) break;
      const type = u16(p + 2);
      const count = u32(p + 4);
      const bytes = (SIZE[type] ?? 1) * count;
      rows.set(u16(p), { type, count, at: bytes <= 4 ? p + 8 : base + u32(p + 8) });
    }
    return rows;
  };
  const rational = (p: number) => {
    const d = u32(p + 4);
    return d ? u32(p) / d : Number.NaN;
  };
  const number = (row?: { type: number; at: number }) => {
    if (!row) return null;
    if (row.type === 3) return u16(row.at);
    if (row.type === 4) return u32(row.at);
    if (row.type === 5) return rational(row.at);
    return null;
  };
  const text = (row?: { count: number; at: number }) => {
    if (!row) return null;
    let s = "";
    for (let i = 0; i < row.count - 1 && row.at + i < view.byteLength; i++) s += String.fromCharCode(view.getUint8(row.at + i));
    return s.trim() || null;
  };
  const degrees = (row?: { at: number }) => (row ? rational(row.at) + rational(row.at + 8) / 60 + rational(row.at + 16) / 3600 : null);
  const main = entries(u32(base + 4));
  const out: Partial<PhotoExif> = {};
  const make = text(main.get(0x010f));
  const model = text(main.get(0x0110));
  out.camera = [make, model].filter(Boolean).join(" ") || null;
  out.orientation = number(main.get(0x0112)) ?? 1;
  const sub = main.get(0x8769);
  if (sub) {
    const tags = entries(u32(sub.at));
    out.focal35 = number(tags.get(0xa405)) || null;
    out.focal = number(tags.get(0x920a)) || null;
    out.taken = text(tags.get(0x9003)) ?? text(tags.get(0x9004));
  }
  const gps = main.get(0x8825);
  if (gps) {
    const tags = entries(u32(gps.at));
    const lat = degrees(tags.get(2));
    const lon = degrees(tags.get(4));
    const south = text(tags.get(1)) === "S";
    const west = text(tags.get(3)) === "W";
    if (lat != null && Number.isFinite(lat)) out.lat = south ? -lat : lat;
    if (lon != null && Number.isFinite(lon)) out.lon = west ? -lon : lon;
    const bearing = number(tags.get(17));
    if (bearing != null && Number.isFinite(bearing)) out.bearing = bearing;
  }
  return out;
}

/** Horizontal field of view from the 35 mm equivalent focal length, for a landscape frame. */
export const fovFromFocal35 = (focal35: number) => (2 * Math.atan(36 / (2 * focal35)) * 180) / Math.PI;

/** The camera clock as written, read as if it were UTC: EXIF usually has no time zone, and the hour is only as good as the clock. */
export function parseExifDate(text: string | null) {
  const match = text && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(text);
  return match ? new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!)) : null;
}
