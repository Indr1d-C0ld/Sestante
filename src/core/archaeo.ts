/** Horizon astronomy and building axes for any epoch. Declinations change slowly enough to reach back several millennia. */
const D2R = Math.PI / 180;

/** Mean obliquity of the ecliptic in degrees, Laskar 1986: valid across ±10 000 years. */
export function obliquity(year: number) {
  const t = (year - 2000) / 10000;
  const seconds = 84381.448 - 4680.93 * t - 1.55 * t ** 2 + 1999.25 * t ** 3 - 51.38 * t ** 4 - 249.67 * t ** 5 - 39.05 * t ** 6 + 7.12 * t ** 7 + 27.87 * t ** 8 + 5.79 * t ** 9 + 2.45 * t ** 10;
  return seconds / 3600;
}

/** Azimuth of rising, from north clockwise, for a body at this declination crossing this apparent horizon. Null if it never does. */
export function riseAzimuth(latDeg: number, declDeg: number, horizonDeg: number) {
  const phi = latDeg * D2R;
  const delta = declDeg * D2R;
  const h = horizonDeg * D2R;
  const cos = (Math.sin(delta) - Math.sin(phi) * Math.sin(h)) / (Math.cos(phi) * Math.cos(h));
  if (cos < -1 || cos > 1) return null;
  return Math.acos(cos) / D2R;
}

export type AstroEvent = { id: string; label: string; body: "sole" | "luna"; declination: number; rise: number; set: number };

/** Sun's upper limb with refraction, and the moon's with its parallax, on a flat horizon raised by `horizon` degrees. */
export function astroEvents(latDeg: number, year: number, horizon = 0): AstroEvent[] {
  const eps = obliquity(year);
  const lunar = 5.145;
  const rows: { id: string; label: string; body: "sole" | "luna"; declination: number }[] = [
    { id: "sol-estate", label: "Solstizio d'estate", body: "sole", declination: eps },
    { id: "equinozio", label: "Equinozi", body: "sole", declination: 0 },
    { id: "sol-inverno", label: "Solstizio d'inverno", body: "sole", declination: -eps },
    { id: "croce-est", label: "Festività di mezzo (mag, ago)", body: "sole", declination: eps * 0.716 },
    { id: "croce-inv", label: "Festività di mezzo (nov, feb)", body: "sole", declination: -eps * 0.716 },
    { id: "luna-max-n", label: "Lunistizio maggiore nord", body: "luna", declination: eps + lunar },
    { id: "luna-min-n", label: "Lunistizio minore nord", body: "luna", declination: eps - lunar },
    { id: "luna-min-s", label: "Lunistizio minore sud", body: "luna", declination: -eps + lunar },
    { id: "luna-max-s", label: "Lunistizio maggiore sud", body: "luna", declination: -eps - lunar },
  ];
  return rows.flatMap((row) => {
    const limb = row.body === "sole" ? -0.833 : 0.125;
    const rise = riseAzimuth(latDeg, row.declination, horizon + limb);
    return rise == null ? [] : [{ ...row, rise, set: 360 - rise }];
  });
}

/** Raises the horizon where the land really does: the same solstice rises further south behind a ridge. */
export function horizonAltitude(azimuthDeg: number, x: number, z: number, eyeY: number, heightAt: (x: number, z: number) => number, reach = 12000) {
  const sin = Math.sin(azimuthDeg * D2R);
  const cos = Math.cos(azimuthDeg * D2R);
  let best = -90;
  for (let d = 30; d < reach; d *= 1.08) {
    const y = heightAt(x + sin * d, z - cos * d) - (d * d) / (2 * 6371000 * 1.17);
    best = Math.max(best, Math.atan2(y - eyeY, d) / D2R);
  }
  return Math.max(0, best);
}

export type Alignment = { event: AstroEvent; kind: "levata" | "tramonto"; azimuth: number; delta: number };

const angleGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** An axis has two ends, so both directions are matched. Sorted by how close they come. */
export function alignments(bearing: number, events: AstroEvent[]) {
  const out: Alignment[] = [];
  for (const end of [bearing, (bearing + 180) % 360]) {
    for (const event of events) {
      out.push({ event, kind: "levata", azimuth: event.rise, delta: angleGap(end, event.rise) });
      out.push({ event, kind: "tramonto", azimuth: event.set, delta: angleGap(end, event.set) });
    }
  }
  return out.sort((a, b) => a.delta - b.delta);
}

/** Long axis of a plan as a bearing in 0–180°, plus how elongated it is: a square has no axis worth reading. */
export function planAxis(ring: number[]) {
  const n = ring.length / 2;
  let cx = 0;
  let cz = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = Math.hypot(ring[j * 2]! - ring[i * 2]!, ring[j * 2 + 1]! - ring[i * 2 + 1]!);
    cx += ((ring[i * 2]! + ring[j * 2]!) / 2) * len;
    cz += ((ring[i * 2 + 1]! + ring[j * 2 + 1]!) / 2) * len;
    total += len;
  }
  cx /= total || 1;
  cz /= total || 1;
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = Math.hypot(ring[j * 2]! - ring[i * 2]!, ring[j * 2 + 1]! - ring[i * 2 + 1]!);
    const dx = (ring[i * 2]! + ring[j * 2]!) / 2 - cx;
    const dz = (ring[i * 2 + 1]! + ring[j * 2 + 1]!) / 2 - cz;
    xx += dx * dx * len;
    zz += dz * dz * len;
    xz += dx * dz * len;
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  // +x east, +z south: bearing from north clockwise is atan2(east, north) with north = −z.
  const bearing = ((Math.atan2(Math.cos(angle), -Math.sin(angle)) / D2R) % 180 + 180) % 180;
  const spread = Math.sqrt(((xx - zz) ** 2 + 4 * xz * xz)) / Math.max(1e-6, xx + zz);
  return { bearing, elongation: spread };
}
