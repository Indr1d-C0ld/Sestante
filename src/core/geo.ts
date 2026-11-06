export type Bbox = { s: number; w: number; n: number; e: number };

export const EARTH_R = 6378137;
const RAD = Math.PI / 180;

export const lonToMx = (lon: number) => EARTH_R * lon * RAD;
export const latToMy = (lat: number) => EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
export const mxToLon = (mx: number) => mx / EARTH_R / RAD;
export const myToLat = (my: number) => (2 * Math.atan(Math.exp(my / EARTH_R)) - Math.PI / 2) / RAD;

/** Local tangent frame of an expedition: +x east, +z south, metres. It is linear in Web Mercator, so the plate maps onto it with no warping. */
export class Projection {
  readonly lat0: number;
  readonly lon0: number;
  readonly k: number;
  readonly mx0: number;
  readonly my0: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly bbox: Bbox;

  constructor(bbox: Bbox) {
    this.bbox = bbox;
    this.mx0 = (lonToMx(bbox.w) + lonToMx(bbox.e)) / 2;
    this.my0 = (latToMy(bbox.s) + latToMy(bbox.n)) / 2;
    this.lat0 = myToLat(this.my0);
    this.lon0 = mxToLon(this.mx0);
    this.k = Math.cos(this.lat0 * RAD);
    this.halfX = ((lonToMx(bbox.e) - lonToMx(bbox.w)) / 2) * this.k;
    this.halfZ = ((latToMy(bbox.n) - latToMy(bbox.s)) / 2) * this.k;
  }

  toLocal(lat: number, lon: number) {
    return { x: (lonToMx(lon) - this.mx0) * this.k, z: -(latToMy(lat) - this.my0) * this.k };
  }

  toLatLon(x: number, z: number) {
    return { lat: myToLat(this.my0 - z / this.k), lon: mxToLon(this.mx0 + x / this.k) };
  }

  /** Plate fractions: u east, v south. */
  toUv(x: number, z: number) {
    return { u: (x + this.halfX) / (2 * this.halfX), v: (z + this.halfZ) / (2 * this.halfZ) };
  }
}

/** The box whose exact centre is this point, in the Mercator frame the plate lives in: a box in plain degrees sits a little off, by half a metre at 6 km. */
export function boxAround(lat: number, lon: number, width: number, height: number): Bbox {
  // The projection's scale comes from the centre, which is this very point: no iteration needed.
  const k = Math.cos(lat * RAD);
  const mx = lonToMx(lon);
  const my = latToMy(lat);
  const dx = width / 2 / k;
  const dy = height / 2 / k;
  return { s: myToLat(my - dy), n: myToLat(my + dy), w: mxToLon(mx - dx), e: mxToLon(mx + dx) };
}

export function bboxSizeMeters(bbox: Bbox) {
  const p = new Projection(bbox);
  return { width: p.halfX * 2, height: p.halfZ * 2 };
}

export function tileXY(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  const rad = lat * RAD;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

/** Ground metres per pixel of a 256 px tile at this latitude and zoom. */
export const metersPerPixel = (lat: number, z: number) => (156543.03392 * Math.cos(lat * RAD)) / 2 ** z;

/** Whether a frame on screen leaves too little map around it to grab: then the view has to belong to the map, not to the frame. */
export function frameFillsView(frame: { left: number; top: number; width: number; height: number }, viewWidth: number, viewHeight: number, share = 0.8) {
  const width = Math.min(frame.left + frame.width, viewWidth) - Math.max(frame.left, 0);
  const height = Math.min(frame.top + frame.height, viewHeight) - Math.max(frame.top, 0);
  return width > 0 && height > 0 && width * height >= share * viewWidth * viewHeight;
}

export function bestZoom(bbox: Bbox, maxSide: number, maxZoom: number) {
  for (let z = maxZoom; z > 1; z--) {
    const a = tileXY(bbox.n, bbox.w, z);
    const b = tileXY(bbox.s, bbox.e, z);
    if (Math.max(b.x - a.x, b.y - a.y) * 256 <= maxSide) return z;
  }
  return 2;
}

export function dms(value: number, pos: string, neg: string) {
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  return `${d}°${String(m).padStart(2, "0")}′${s.toFixed(1).padStart(4, "0")}″${value >= 0 ? pos : neg}`;
}

export const formatLatLon = (lat: number, lon: number) => `${dms(lat, "N", "S")} ${dms(lon, "E", "O")}`;

export function toUtm(lat: number, lon: number) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * RAD;
  const phi = lat * RAD;
  const lam = lon * RAD;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lam - lon0);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const east = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let north =
    k0 *
    (M +
      N *
        Math.tan(phi) *
        (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 + ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) north += 10000000;
  const band = "CDEFGHJKLMNPQRSTUVWX"[Math.min(19, Math.floor((lat + 80) / 8))] ?? "X";
  return { zone, band, east, north, text: `${zone}${band} ${east.toFixed(0)} E ${north.toFixed(0)} N` };
}

export function pointInRing(x: number, z: number, ring: ArrayLike<number>) {
  let hit = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2]!;
    const zi = ring[i * 2 + 1]!;
    const xj = ring[j * 2]!;
    const zj = ring[j * 2 + 1]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

export function ringArea(ring: ArrayLike<number>) {
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) sum += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!;
  return sum / 2;
}

export const compassName = (deg: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"][Math.round(((deg % 360) + 360) / 22.5) % 16]!;

/** Extracts the first box from Google Earth KML: a GroundOverlay's LatLonBox or the extent of any coordinates. */
export function parseKmlBbox(kml: string): { bbox: Bbox; name?: string; image?: string } | null {
  const name = /<name>([^<]+)<\/name>/.exec(kml)?.[1];
  const tag = (key: string) => {
    const m = new RegExp(`<${key}>\\s*(-?[\\d.]+)\\s*</${key}>`).exec(kml);
    return m ? Number(m[1]) : Number.NaN;
  };
  const n = tag("north");
  const s = tag("south");
  const e = tag("east");
  const w = tag("west");
  if ([n, s, e, w].every(Number.isFinite)) return { bbox: { s, w, n, e }, name, image: /<href>([^<]+)<\/href>/.exec(kml)?.[1] };
  const lat: number[] = [];
  const lon: number[] = [];
  for (const block of kml.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)) {
    for (const row of block[1]!.trim().split(/\s+/)) {
      const [a, b] = row.split(",").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        lon.push(a!);
        lat.push(b!);
      }
    }
  }
  if (lat.length < 2) return null;
  return { bbox: { s: Math.min(...lat), n: Math.max(...lat), w: Math.min(...lon), e: Math.max(...lon) }, name };
}
