import { toUtm } from "./geo.ts";

/**
 * Recognises a point however it was written. Each result says what it took the text to be and how precise the text
 * really is: "41.89, 12.49" cannot centre anything better than half a kilometre, whatever the screen shows.
 */
export type ParsedPoint = {
  lat: number;
  lon: number;
  zoom?: number;
  format: string;
  /** Half-width of the uncertainty the writing itself allows, in metres. */
  precision: number | null;
  /** The other reading, when nothing in the text says which number is the latitude. */
  swapped: { lat: number; lon: number } | null;
  note?: string;
};

const METRES_PER_DEGREE = 111320;

const valid = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

const decimalsOf = (raw: string) => raw.split(".")[1]?.length ?? 0;

function point(lat: number, lon: number, format: string, precision: number | null, extra: Partial<ParsedPoint> = {}): ParsedPoint | null {
  return valid(lat, lon) ? { lat, lon, format, precision, swapped: null, ...extra } : null;
}

// --- UTM and MGRS ---

const RAD = Math.PI / 180;

function fromUtm(zone: number, east: number, north: number, south: boolean) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const x = east - 500000;
  const y = south ? north - 10000000 : north;
  const mu = y / k0 / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1);
  const c = Math.cos(phi1);
  const t = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * s * s);
  const T1 = t * t;
  const C1 = ep2 * c * c;
  const R1 = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
  const D = x / (N1 * k0);
  const lat =
    phi1 -
    ((N1 * t) / R1) *
      (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) / c;
  return { lat: lat / RAD, lon: ((zone - 1) * 6 - 180 + 3) + lon / RAD };
}

const BANDS = "CDEFGHJKLMNPQRSTUVWX";
const bandSouth = (letter: string) => -80 + BANDS.indexOf(letter) * 8;
const COLUMN_SETS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
const ROWS = "ABCDEFGHJKLMNPQRSTUV";

function parseUtm(text: string) {
  const match = /^(?:utm\s*:?\s*)?(\d{1,2})\s*([c-hj-np-x])?[\s,;]+(?:e\s*)?(\d{5,7}(?:\.\d+)?)\s*(?:m\b)?\s*(?:e|est\b|east\b)?\s*[\s,;]\s*(?:n\s*)?(\d{5,8}(?:\.\d+)?)\s*(?:m\b)?\s*(?:n|nord\b|north\b)?$/i.exec(text.trim());
  if (!match) return null;
  const zone = Number(match[1]);
  const east = Number(match[3]);
  const north = Number(match[4]);
  if (zone < 1 || zone > 60 || east < 100000 || east > 900000 || north > 10000000) return null;
  const letter = match[2]?.toUpperCase();
  if (!letter) return point(...latLon(fromUtm(zone, east, north, false)), "UTM", 1, { note: "Nessuna banda indicata: ho presunto l'emisfero nord." });
  const northern = fromUtm(zone, east, north, false);
  const south = bandSouth(letter);
  if (letter >= "N" && northern.lat >= south - 0.5 && northern.lat <= south + 12.5) return point(...latLon(northern), "UTM", 1);
  // "33S" is a band in the north for MGRS people and "south" for everyone else: the numbers settle it.
  if (letter === "S") return point(...latLon(fromUtm(zone, east, north, true)), "UTM", 1, { note: "«S» non concorda con la banda: l'ho letta come emisfero sud." });
  if (letter < "N") return point(...latLon(fromUtm(zone, east, north, true)), "UTM", 1);
  return point(...latLon(northern), "UTM", 1, { note: `La banda ${letter} non concorda con le coordinate: controlla il dato.` });
}

const latLon = (row: { lat: number; lon: number }): [number, number] => [row.lat, row.lon];

function parseMgrs(text: string) {
  const match = /^(\d{1,2})\s*([c-hj-np-x])\s*([a-hj-np-z])([a-hj-np-v])\s*(\d*)\s*(\d*)$/i.exec(text.trim());
  if (!match) return null;
  const zone = Number(match[1]);
  if (zone < 1 || zone > 60) return null;
  const band = match[2]!.toUpperCase();
  const digits = `${match[5]}${match[6]}`;
  if (digits.length % 2 || digits.length > 10) return null;
  const set = (zone - 1) % 6;
  const column = COLUMN_SETS[set % 3]!.indexOf(match[3]!.toUpperCase());
  const rowIndex = ROWS.indexOf(match[4]!.toUpperCase());
  if (column < 0 || rowIndex < 0) return null;
  const half = digits.length / 2;
  const cell = half ? 10 ** (5 - half) : 100000;
  const east = (column + 1) * 100000 + (half ? Number(digits.slice(0, half)) * cell : 0) + cell / 2;
  let north = ((rowIndex - (zone % 2 === 0 ? 5 : 0) + 20) % 20) * 100000 + (half ? Number(digits.slice(half)) * cell : 0) + cell / 2;
  // The row letters repeat every 2000 km: the band says which repetition this is.
  const floor = toUtm(bandSouth(band), (zone - 1) * 6 - 180 + 3).north;
  while (north < floor - 100000) north += 2000000;
  const south = band < "N";
  return point(...latLon(fromUtm(zone, east, north, south)), "MGRS", cell / 2);
}

/** Military grid reference at 1 m. */
export function toMgrs(lat: number, lon: number) {
  const utm = toUtm(lat, lon);
  const set = (utm.zone - 1) % 6;
  const column = COLUMN_SETS[set % 3]![Math.floor(utm.east / 100000) - 1];
  const row = ROWS[(Math.floor(utm.north / 100000) + (utm.zone % 2 === 0 ? 5 : 0)) % 20];
  const pad = (v: number) => String(Math.floor(v % 100000)).padStart(5, "0");
  return `${utm.zone}${utm.band} ${column}${row} ${pad(utm.east)} ${pad(utm.north)}`;
}

// --- Plus codes, geohash, Maidenhead ---

const OLC = "23456789CFGHJMPQRVWX";

function decodeOlc(code: string) {
  const clean = code.replace("+", "").replace(/0+$/, "");
  let lat = -90;
  let lon = -180;
  let latSize = 400;
  let lonSize = 400;
  for (let i = 0; i < Math.min(10, clean.length); i += 2) {
    latSize /= 20;
    lonSize /= 20;
    lat += OLC.indexOf(clean[i]!) * latSize;
    lon += OLC.indexOf(clean[i + 1]!) * lonSize;
  }
  for (let i = 10; i < clean.length; i++) {
    const digit = OLC.indexOf(clean[i]!);
    latSize /= 5;
    lonSize /= 4;
    lat += Math.floor(digit / 4) * latSize;
    lon += (digit % 4) * lonSize;
  }
  return { lat: lat + latSize / 2, lon: lon + lonSize / 2, latSize, lonSize };
}

function encodeOlc(lat: number, lon: number) {
  let out = "";
  let la = lat + 90;
  let lo = lon + 180;
  let size = 400;
  for (let i = 0; i < 10; i += 2) {
    size /= 20;
    out += OLC[Math.floor(la / size)]! + OLC[Math.floor(lo / size)]!;
    la %= size;
    lo %= size;
    if (i === 6) out += "+";
  }
  return out;
}

/** The part after the code may name a town: "VFQ4+8X Roma". Short codes then recover from wherever the map is looking. */
function parsePlusCode(text: string, near?: { lat: number; lon: number }) {
  const match = /^([23456789cfghjmpqrvwx0]{2,8})\+([23456789cfghjmpqrvwx]*)(?:[\s,]+.*)?$/i.exec(text.trim());
  if (!match) return null;
  const head = match[1]!.toUpperCase();
  const tail = match[2]!.toUpperCase();
  if (head.length === 8) {
    const row = decodeOlc(head + tail);
    return point(row.lat, row.lon, "Plus Code", (row.latSize * METRES_PER_DEGREE) / 2);
  }
  if (!near || head.length % 2) return null;
  const padding = 8 - head.length;
  const resolution = 20 ** (2 - padding / 2);
  const prefix = encodeOlc(Math.max(-89.9, Math.min(89.9, near.lat)), near.lon).slice(0, padding);
  const row = decodeOlc(prefix + head + tail);
  let { lat, lon } = row;
  if (near.lat + resolution / 2 < lat && lat - resolution >= -90) lat -= resolution;
  else if (near.lat - resolution / 2 > lat && lat + resolution <= 90) lat += resolution;
  if (near.lon + resolution / 2 < lon) lon -= resolution;
  else if (near.lon - resolution / 2 > lon) lon += resolution;
  return point(lat, lon, "Plus Code breve", (row.latSize * METRES_PER_DEGREE) / 2, { note: "Codice breve: completato con la zona che la mappa sta mostrando." });
}

const GEOHASH = "0123456789bcdefghjkmnpqrstuvwxyz";

function parseGeohash(text: string) {
  const code = text.trim().toLowerCase();
  // Letters and digits together, or this would swallow place names.
  if (!/^[0-9b-hjkmnp-z]{5,12}$/.test(code) || !/\d/.test(code) || !/[a-z]/.test(code)) return null;
  let south = -90;
  let north = 90;
  let west = -180;
  let east = 180;
  let even = true;
  for (const char of code) {
    const value = GEOHASH.indexOf(char);
    for (let bit = 4; bit >= 0; bit--) {
      const on = (value >> bit) & 1;
      if (even) {
        const mid = (west + east) / 2;
        if (on) west = mid;
        else east = mid;
      } else {
        const mid = (south + north) / 2;
        if (on) south = mid;
        else north = mid;
      }
      even = !even;
    }
  }
  return point((south + north) / 2, (west + east) / 2, "Geohash", ((north - south) * METRES_PER_DEGREE) / 2);
}

function parseMaidenhead(text: string) {
  const match = /^([a-r]{2})(\d{2})(?:([a-x]{2})(\d{2})?)?$/i.exec(text.trim());
  if (!match) return null;
  const f = match[1]!.toUpperCase();
  let lon = (f.charCodeAt(0) - 65) * 20 - 180 + Number(match[2]![0]) * 2;
  let lat = (f.charCodeAt(1) - 65) * 10 - 90 + Number(match[2]![1]);
  let lonSize = 2;
  let latSize = 1;
  if (match[3]) {
    const s = match[3].toUpperCase();
    lonSize = 2 / 24;
    latSize = 1 / 24;
    lon += (s.charCodeAt(0) - 65) * lonSize;
    lat += (s.charCodeAt(1) - 65) * latSize;
    if (match[4]) {
      lonSize /= 10;
      latSize /= 10;
      lon += Number(match[4][0]) * lonSize;
      lat += Number(match[4][1]) * latSize;
    }
  }
  return point(lat + latSize / 2, lon + lonSize / 2, "Locatore Maidenhead", (latSize * METRES_PER_DEGREE) / 2);
}

// --- Degrees, in all their spellings ---

type Token = { kind: "number"; value: number; raw: string; unit?: "d" | "m" | "s" } | { kind: "hemi"; letter: "N" | "S" | "E" | "W" };

const HEMI: Record<string, "N" | "S" | "E" | "W"> = { n: "N", nord: "N", north: "N", s: "S", sud: "S", south: "S", e: "E", est: "E", east: "E", o: "W", ovest: "W", w: "W", west: "W" };
const DEGREE_WORDS = new Set(["d", "deg", "degs", "degree", "degrees", "grado", "gradi", "gr"]);
const MINUTE_WORDS = new Set(["m", "min", "mins", "minute", "minutes", "minuto", "minuti", "primi", "primo"]);
const SECOND_WORDS = new Set(["sec", "secs", "second", "seconds", "secondo", "secondi"]);
const LAT_WORDS = new Set(["lat", "latitude", "latitudine", "y"]);
const LON_WORDS = new Set(["lon", "long", "lng", "longitude", "longitudine", "x"]);
const NOISE = new Set(["coordinate", "coordinates", "coordinata", "coord", "coords", "punto", "point", "gps", "posizione", "position", "location", "wgs", "decimal", "decimali"]);

function normalise(text: string) {
  return text
    .replace(/[′’‘´`ʹ]/g, "'")
    .replace(/[″”“ʺ]|''/g, '"')
    .replace(/[º˚∘]/g, "°")
    .replace(/[−–—]/g, "-")
    .replace(/\b(?:wgs\s*-?\s*84|epsg\s*:?\s*4326)\b/gi, " ")
    .replace(/"([a-zàèéìòù_]+)"/gi, "$1")
    .replace(/[{}[\]()]/g, " ")
    .trim();
}

/** "41,89 12,49" and "41,8902,12,4922" write decimals with a comma; "41.89,12.49" separates with one. */
function resolveCommas(text: string) {
  if (text.includes(".")) return text;
  const pieces = text.split(/[;\s]+|,\s+/).filter(Boolean);
  const pair = /^-?\d+,\d+$/;
  const spaced = pieces.map((piece) => {
    const core = /^([a-z]*)(-?\d+,\d+)(°?[a-z]*)$/i.exec(piece);
    return core?.[2] && pair.test(core[2]) ? `${core[1]}${core[2].replace(",", ".")}${core[3]}` : piece;
  });
  const tight = /^(-?\d+),(\d+),(-?\d+),(\d+)$/.exec(text.trim());
  if (tight) return `${tight[1]}.${tight[2]} ${tight[3]}.${tight[4]}`;
  // A lone "41,12" is two whole numbers, and the precision note will say what that is worth.
  if (pieces.length === 1 && pair.test(pieces[0]!)) return pieces[0]!.replace(",", " ");
  return spaced.join(" ");
}

function tokenise(text: string) {
  const tokens: Token[] = [];
  const axes: ("lat" | "lon")[] = [];
  const re = /-?\+?\d+(?:\.\d+)?|[a-zàèéìòù]+|°|"|'|[:=,;/_+|&]|\S/gi;
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    if (/^[-+]*\d/.test(raw)) {
      const clean = raw.replace("+", "");
      tokens.push({ kind: "number", value: Number(clean), raw: clean });
      continue;
    }
    const last = tokens[tokens.length - 1];
    const mark = (unit: "d" | "m" | "s") => {
      if (last?.kind !== "number" || last.unit) return false;
      last.unit = unit;
      return true;
    };
    if (raw === "°") {
      if (!mark("d")) return null;
    } else if (raw === "'") {
      if (!mark("m")) return null;
    } else if (raw === '"') {
      if (!mark("s")) return null;
    } else if (/^[:=,;/_+|&]$/.test(raw)) {
      // Pure separators. In "41:53:24" the colon also implies the units, which the count rules recover.
    } else if (/^[a-zàèéìòù]+$/i.test(raw)) {
      const word = raw.toLowerCase();
      const previous = tokens[tokens.length - 2];
      // After minutes, "s" means seconds, not south: 41d53m24s.
      if (word === "s" && last?.kind === "number" && !last.unit && previous?.kind === "number" && previous.unit === "m") last.unit = "s";
      else if (DEGREE_WORDS.has(word)) {
        if (!mark("d")) return null;
      } else if (MINUTE_WORDS.has(word)) {
        if (!mark("m")) return null;
      } else if (SECOND_WORDS.has(word)) {
        if (!mark("s")) return null;
      } else if (HEMI[word]) tokens.push({ kind: "hemi", letter: HEMI[word]! });
      else if (LAT_WORDS.has(word)) axes.push("lat");
      else if (LON_WORDS.has(word)) axes.push("lon");
      else if (!NOISE.has(word)) return null;
    } else return null;
  }
  return { tokens, axes };
}

type Part = { numbers: Extract<Token, { kind: "number" }>[]; hemi?: "N" | "S" | "E" | "W" };

function splitParts(tokens: Token[]): Part[] | null {
  const hemis = tokens.filter((token) => token.kind === "hemi");
  const numbers = tokens.filter((token): token is Part["numbers"][number] => token.kind === "number");
  if (hemis.length > 2 || !numbers.length) return null;
  if (hemis.length === 2) {
    const parts: Part[] = [];
    const prefix = tokens[0]!.kind === "hemi";
    let current: Part = { numbers: [] };
    for (const token of tokens) {
      if (token.kind === "hemi") {
        if (prefix) {
          if (current.numbers.length) parts.push(current);
          current = { numbers: [], hemi: token.letter };
        } else {
          current.hemi = token.letter;
          parts.push(current);
          current = { numbers: [] };
        }
      } else current.numbers.push(token);
    }
    if (prefix && current.numbers.length) parts.push(current);
    return parts.length === 2 ? parts : null;
  }
  let parts: Part[];
  if (numbers.some((row) => row.unit === "d")) {
    parts = [];
    for (const row of numbers) {
      if (row.unit === "d" || !parts.length) parts.push({ numbers: [row] });
      else parts[parts.length - 1]!.numbers.push(row);
    }
  } else if (numbers.length === 2) parts = [{ numbers: [numbers[0]!] }, { numbers: [numbers[1]!] }];
  else if (numbers.length === 3) parts = [{ numbers: [numbers[0]!] }, { numbers: [numbers[1]!] }];
  else if (numbers.length === 4) parts = [{ numbers: numbers.slice(0, 2) }, { numbers: numbers.slice(2) }];
  else if (numbers.length === 6) parts = [{ numbers: numbers.slice(0, 3) }, { numbers: numbers.slice(3) }];
  else return null;
  if (parts.length !== 2) return null;
  // A single letter still says which axis its neighbour belongs to.
  if (hemis.length === 1) {
    const letter = (hemis[0] as Extract<Token, { kind: "hemi" }>).letter;
    const before = tokens.findIndex((token) => token.kind === "hemi");
    const index = before < tokens.length / 2 ? 0 : 1;
    parts[index]!.hemi = letter;
  }
  return parts;
}

function partValue(part: Part, axisDigits: number) {
  const row = part.numbers;
  if (!row.length || row.length > 3) return null;
  // Compact navigation style: 415324N, 0122932E, 4153N.
  if (row.length === 1 && part.hemi && !row[0]!.raw.includes(".") && !row[0]!.unit) {
    const digits = row[0]!.raw.replace("-", "");
    if (digits.length === axisDigits + 2 || digits.length === axisDigits + 4) {
      const d = Number(digits.slice(0, axisDigits));
      const m = Number(digits.slice(axisDigits, axisDigits + 2));
      const s = digits.length === axisDigits + 4 ? Number(digits.slice(axisDigits + 2)) : 0;
      if (m >= 60 || s >= 60) return null;
      return { value: d + m / 60 + s / 3600, kind: digits.length === axisDigits + 4 ? "dms" : "dm", precision: digits.length === axisDigits + 4 ? 15 : 925 };
    }
  }
  const sign = row[0]!.value < 0 || row[0]!.raw.startsWith("-") ? -1 : 1;
  const [d, m, s] = row;
  if (m && (m.value < 0 || m.value >= 60)) return null;
  if (s && (s.value < 0 || s.value >= 60)) return null;
  if (row.slice(0, -1).some((item) => item.raw.includes("."))) return null;
  const value = Math.abs(d!.value) + (m?.value ?? 0) / 60 + (s?.value ?? 0) / 3600;
  const last = row[row.length - 1]!;
  const step = 10 ** -decimalsOf(last.raw) / (row.length === 1 ? 1 : row.length === 2 ? 60 : 3600);
  return { value: sign * value, kind: row.length === 1 ? "dd" : row.length === 2 ? "dm" : "dms", precision: (step * METRES_PER_DEGREE) / 2 };
}

function parseDegrees(input: string): ParsedPoint | null {
  const read = tokenise(resolveCommas(normalise(input)));
  if (!read) return null;
  const parts = splitParts(read.tokens);
  if (!parts) return null;
  const isLat = (part: Part) => part.hemi === "N" || part.hemi === "S";
  const isLon = (part: Part) => part.hemi === "E" || part.hemi === "W";
  let [first, second] = parts as [Part, Part];
  // Two latitudes, or two longitudes, are a typing error rather than a point.
  if ((isLat(first) && isLat(second)) || (isLon(first) && isLon(second))) return null;
  const labelled = read.axes.length > 0;
  const lettered = (first.hemi ? 1 : 0) + (second.hemi ? 1 : 0) > 0;
  if (isLon(first) || isLat(second) || (!lettered && read.axes[0] === "lon")) [first, second] = [second, first];
  const a = partValue(first, 2);
  const b = partValue(second, 3);
  if (!a || !b) return null;
  const apply = (part: Part, value: number) => (part.hemi === "S" || part.hemi === "W" ? -Math.abs(value) : value);
  const lat = apply(first, a.value);
  const lon = apply(second, b.value);
  const label = a.kind === "dms" || b.kind === "dms" ? "gradi, primi e secondi" : a.kind === "dm" || b.kind === "dm" ? "gradi e primi" : "gradi decimali";
  const precision = Math.max(a.precision, b.precision);
  const free = !labelled && !lettered;
  if (!valid(lat, lon)) {
    // Written the other way round, and the numbers prove it.
    if (free && valid(lon, lat)) return point(lon, lat, label, precision, { note: "La prima cifra non può essere una latitudine: ho invertito l'ordine." });
    return null;
  }
  return point(lat, lon, label, precision, free && valid(lon, lat) ? { swapped: { lat: lon, lon: lat } } : {});
}

// --- Links and structured text ---

function readLink(text: string, near?: { lat: number; lon: number }): ParsedPoint | null {
  const num = (value: string | undefined) => (value == null ? Number.NaN : Number(value));
  const ofLink = (name: string, lat: number, lon: number, zoom?: number, raw?: string) => point(lat, lon, name, raw ? (10 ** -decimalsOf(raw) * METRES_PER_DEGREE) / 2 : null, zoom != null ? { zoom } : {});
  const host = /^[a-z+]+:\/\/([^/]+)/i.exec(text)?.[1]?.toLowerCase() ?? "";
  const site = /google|goo\.gl/.test(host) ? "Google Maps" : /openstreetmap/.test(host) ? "OpenStreetMap" : /bing/.test(host) ? "Bing" : /apple/.test(host) ? "Apple Maps" : /yandex/.test(host) ? "Yandex" : /here\.com/.test(host) ? "HERE" : "collegamento";

  // The pin of a place beats the centre of the view it was shared from.
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(text);
  const view = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/.exec(text);
  const viewZoom = view?.[3] ? Number(view[3]) : undefined;
  if (pin) return ofLink(site, num(pin[1]), num(pin[2]), viewZoom, pin[1]);
  if (view) return ofLink(site, num(view[1]), num(view[2]), viewZoom, view[1]);
  const hash = /#(?:map=)?(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(text);
  const params = new URLSearchParams(/\?([^#]*)/.exec(text)?.[1] ?? "");
  const zoomParam = Number(params.get("zoom") ?? params.get("z") ?? Number.NaN);
  const zoom = Number.isFinite(zoomParam) ? zoomParam : undefined;
  if (params.get("mlat") && params.get("mlon")) return ofLink(site, num(params.get("mlat")!), num(params.get("mlon")!), hash ? Number(hash[1]) : zoom, params.get("mlat")!);
  if (hash) return ofLink(site, num(hash[2]), num(hash[3]), Number(hash[1]), hash[2]);
  const lat = params.get("lat") ?? params.get("latitude") ?? params.get("y");
  const lon = params.get("lon") ?? params.get("lng") ?? params.get("long") ?? params.get("longitude") ?? params.get("x");
  if (lat && lon) return ofLink(site, num(lat), num(lon), zoom, lat);
  const cp = /[?&]cp=(-?\d+(?:\.\d+)?)(?:~|%7E)(-?\d+(?:\.\d+)?)/i.exec(text);
  if (cp) return ofLink(site, num(cp[1]), num(cp[2]), zoom ?? (params.get("lvl") ? Number(params.get("lvl")) : undefined), cp[1]);
  const geohack = /params=([\d._]+_[NS]_[\d._]+_[EWO])/i.exec(text);
  if (geohack) {
    const row = parseDegrees(geohack[1]!.replace(/_/g, " "));
    return row ? { ...row, format: "Wikipedia" } : null;
  }
  // Yandex alone writes longitude first.
  const yandex = /yandex/.test(host) ? /[?&]ll=(-?\d+(?:\.\d+)?)(?:,|%2C)(-?\d+(?:\.\d+)?)/i.exec(text) : null;
  if (yandex) return ofLink(site, num(yandex[2]), num(yandex[1]), zoom, yandex[2]);
  for (const key of ["q", "query", "ll", "center", "destination", "daddr", "map", "sll", "loc"]) {
    const value = params.get(key);
    if (!value) continue;
    const row = parseAny(value.replace(/^loc:/, ""), near);
    if (row) return { ...row, format: site, swapped: null, ...(zoom != null ? { zoom } : {}) };
  }
  const place = /\/place\/([^/?]+)/.exec(text);
  if (place) {
    const row = parseDegrees(place[1]!.replace(/\+/g, " "));
    if (row) return { ...row, format: site, swapped: null };
  }
  return null;
}

function parseStructured(text: string) {
  const geojson = /"?coordinates"?\s*[:=]\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (geojson) return point(Number(geojson[2]), Number(geojson[1]), "GeoJSON", (10 ** -decimalsOf(geojson[2]!) * METRES_PER_DEGREE) / 2);
  const wkt = /^\s*point\s*z?\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i.exec(text);
  if (wkt) return point(Number(wkt[2]), Number(wkt[1]), "WKT", (10 ** -decimalsOf(wkt[2]!) * METRES_PER_DEGREE) / 2);
  const kml = /<coordinates>\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (kml) return point(Number(kml[2]), Number(kml[1]), "KML", (10 ** -decimalsOf(kml[2]!) * METRES_PER_DEGREE) / 2);
  const geoUri = /^geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (geoUri) return point(Number(geoUri[1]), Number(geoUri[2]), "URI geo:", (10 ** -decimalsOf(geoUri[1]!) * METRES_PER_DEGREE) / 2);
  return null;
}

function parseAny(text: string, near?: { lat: number; lon: number }): ParsedPoint | null {
  return parseStructured(text) ?? parseMgrs(text) ?? parseUtm(text) ?? parsePlusCode(text, near) ?? parseMaidenhead(text) ?? parseDegrees(text) ?? parseGeohash(text);
}

/** `near` is only used to complete a short Plus Code. Null means the text is not a point, and is probably a place name. */
export function parseCoordinates(input: string, near?: { lat: number; lon: number }): ParsedPoint | null {
  const raw = input.trim();
  if (!raw) return null;
  let text = raw;
  try {
    if (raw.includes("%")) text = decodeURIComponent(raw);
  } catch {
    /* a stray percent sign: read it as written */
  }
  if (/^(?:https?:\/\/|www\.|maps\.|[a-z0-9.-]+\.[a-z]{2,}\/)/i.test(text)) return readLink(text.startsWith("http") ? text : `https://${text}`, near);
  return parseAny(text, near);
}

/** How much a point's writing allows, in words for the status line. */
export function precisionWords(row: ParsedPoint) {
  if (row.precision == null) return "";
  if (row.precision < 1) return "precisione sotto il metro";
  if (row.precision < 1000) return `precisione ±${row.precision < 10 ? row.precision.toFixed(1) : Math.round(row.precision)} m`;
  return `precisione ±${(row.precision / 1000).toFixed(1)} km`;
}
