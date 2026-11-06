/** Sun and moon geometry after Meeus, in the compact form used by suncalc. Azimuth: radians from north, clockwise. */
const PI = Math.PI;
const RAD = PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;
const OBLIQUITY = RAD * 23.4397;

const toDays = (date: Date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
const rightAscension = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
const siderealTime = (d: number, lw: number) => RAD * (280.16 + 360.9856235 * d) - lw;

function sunCoords(d: number) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0), M, L };
}

function horizontal(H: number, phi: number, dec: number) {
  const azFromSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  return { azimuth: (azFromSouth + PI + 2 * PI) % (2 * PI), altitude };
}

export function sunPosition(date: Date, lat: number, lon: number) {
  const lw = RAD * -lon;
  const d = toDays(date);
  const c = sunCoords(d);
  return { ...horizontal(siderealTime(d, lw) - c.ra, RAD * lat, c.dec), declination: c.dec };
}

export function moonPosition(date: Date, lat: number, lon: number) {
  const lw = RAD * -lon;
  const d = toDays(date);
  const L = RAD * (218.316 + 13.176396 * d);
  const M = RAD * (134.963 + 13.064993 * d);
  const F = RAD * (93.272 + 13.22935 * d);
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  const dec = declination(l, b);
  const ra = rightAscension(l, b);
  const sun = sunCoords(d);
  const phi = Math.acos(Math.sin(sun.dec) * Math.sin(dec) + Math.cos(sun.dec) * Math.cos(dec) * Math.cos(sun.ra - ra));
  const elong = Math.atan2(149598000 * Math.sin(phi), 385001 - 149598000 * Math.cos(phi));
  return {
    ...horizontal(siderealTime(d, lw) - ra, RAD * lat, dec),
    illumination: (1 + Math.cos(elong)) / 2,
  };
}

/** Direction from the ground toward the body: +x east, +y up, −z north. */
export function dirVector(azimuth: number, altitude: number) {
  const c = Math.cos(altitude);
  return { x: Math.sin(azimuth) * c, y: Math.sin(altitude), z: -Math.cos(azimuth) * c };
}

export function equationOfTime(date: Date) {
  const n = toDays(date);
  const g = RAD * (357.528 + 0.9856003 * n);
  const q = 280.46 + 0.9856474 * n;
  const lam = RAD * (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const ra = Math.atan2(Math.cos(OBLIQUITY) * Math.sin(lam), Math.cos(lam)) / RAD;
  let diff = ((q - ra + 180) % 360) - 180;
  if (diff < -180) diff += 360;
  return diff * 4;
}

export function trueSolarHour(date: Date, lon: number) {
  const utc = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  return (((utc + lon / 15 + equationOfTime(date) / 60) % 24) + 24) % 24;
}

export function sunEvents(date: Date, lat: number, lon: number) {
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - (lon / 15) * 3_600_000;
  let rise: Date | null = null;
  let set: Date | null = null;
  let transit = new Date(start);
  let best = -Infinity;
  let prev = sunPosition(new Date(start), lat, lon).altitude;
  const horizon = -0.833 * RAD;
  for (let m = 2; m <= 1440; m += 2) {
    const when = new Date(start + m * 60000);
    const alt = sunPosition(when, lat, lon).altitude;
    if (alt > best) {
      best = alt;
      transit = when;
    }
    if (prev < horizon && alt >= horizon && !rise) rise = when;
    if (prev >= horizon && alt < horizon && !set) set = when;
    prev = alt;
  }
  return { rise, set, transit, maxAltitude: best };
}

/** Given the day and the azimuth read from shadows on the plate, finds the instant of the shot. */
export function solveShotInstant(dayIso: string, lat: number, lon: number, sunAzimuth: number) {
  const noon = Date.parse(`${dayIso}T12:00:00Z`) - (lon / 15) * 3_600_000;
  let best: { date: Date; altitude: number; error: number } | null = null;
  for (let m = -420; m <= 420; m += 1) {
    const when = new Date(noon + m * 60000);
    const pos = sunPosition(when, lat, lon);
    if (pos.altitude < 0.05) continue;
    let diff = Math.abs(pos.azimuth - sunAzimuth) % (2 * PI);
    if (diff > PI) diff = 2 * PI - diff;
    if (!best || diff < best.error) best = { date: when, altitude: pos.altitude, error: diff };
  }
  return best;
}

/** Offset in minutes of an IANA zone at a given instant. */
export function zoneOffsetMinutes(timeZone: string, date: Date) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return (local - Math.floor(date.valueOf() / 1000) * 1000) / 60000;
  } catch {
    return 0;
  }
}
