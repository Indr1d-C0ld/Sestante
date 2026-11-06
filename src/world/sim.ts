import type { LiveWeather } from "../field/load.ts";
import { zoneOffsetMinutes } from "../core/solar.ts";

export type TimeMode = "live" | "custom";

export class SimClock {
  mode: TimeMode = "live";
  rate = 1;
  paused = false;
  t = Date.now();
  timezone = "UTC";

  tick(realDt: number) {
    if (this.mode === "live") {
      this.t = Date.now();
      return;
    }
    if (!this.paused) this.t += realDt * 1000 * this.rate;
  }

  backToLive() {
    this.mode = "live";
    this.rate = 1;
    this.paused = false;
    this.t = Date.now();
  }

  setCustom(t: number, rate = this.rate) {
    this.mode = "custom";
    this.t = t;
    this.rate = rate;
  }

  get date() {
    return new Date(this.t);
  }

  offsetMinutes(date = this.date) {
    return zoneOffsetMinutes(this.timezone, date);
  }

  /** The instant formatted in the place's own civil time. */
  civil(options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" }, date = this.date) {
    try {
      return new Intl.DateTimeFormat("it-IT", { timeZone: this.timezone, ...options }).format(date);
    } catch {
      return date.toISOString();
    }
  }
}

export type WeatherValues = {
  cloud: number;
  rain: number;
  snow: number;
  visibility: number;
  wind: number;
  windDir: number;
  gust: number;
  temp: number;
  humidity: number;
  pressureMsl: number;
  thunder: number;
};

export const WEATHER_PRESETS: Record<string, Partial<WeatherValues>> = {
  Sereno: { cloud: 0.05, rain: 0, snow: 0, visibility: 40000, thunder: 0, wind: 2 },
  "Velature": { cloud: 0.32, rain: 0, snow: 0, visibility: 30000, thunder: 0, wind: 3 },
  Nuvoloso: { cloud: 0.72, rain: 0, snow: 0, visibility: 22000, thunder: 0, wind: 5 },
  Coperto: { cloud: 0.97, rain: 0, snow: 0, visibility: 16000, thunder: 0, wind: 5 },
  Pioggia: { cloud: 0.95, rain: 3.5, snow: 0, visibility: 7000, thunder: 0, wind: 7 },
  Temporale: { cloud: 1, rain: 14, snow: 0, visibility: 2800, thunder: 1, wind: 14 },
  Nebbia: { cloud: 0.8, rain: 0, snow: 0, visibility: 180, thunder: 0, wind: 1 },
  Foschia: { cloud: 0.45, rain: 0, snow: 0, visibility: 2500, thunder: 0, wind: 1.5 },
  Neve: { cloud: 0.96, rain: 0, snow: 2.2, visibility: 2200, thunder: 0, wind: 3, temp: -2 },
  Tempesta: { cloud: 0.95, rain: 2, snow: 0, visibility: 4500, thunder: 0, wind: 21 },
};

export const describeWmo = (code: number) => {
  if (code === 0) return "sereno";
  if (code <= 2) return "poco nuvoloso";
  if (code === 3) return "coperto";
  if (code === 45 || code === 48) return "nebbia";
  if (code >= 51 && code <= 57) return "pioviggine";
  if (code >= 61 && code <= 67) return "pioggia";
  if (code >= 71 && code <= 77) return "neve";
  if (code >= 80 && code <= 82) return "rovesci";
  if (code >= 85 && code <= 86) return "rovesci di neve";
  if (code >= 95) return "temporale";
  return "variabile";
};

export const describeState = (w: WeatherValues) => {
  if (w.thunder > 0.5) return "temporale";
  if (w.snow > 0.05) return "neve";
  if (w.rain > 4) return "pioggia forte";
  if (w.rain > 0.05) return "pioggia";
  if (w.visibility < 1000) return "nebbia";
  if (w.visibility < 5000) return "foschia";
  if (w.cloud > 0.88) return "coperto";
  if (w.cloud > 0.55) return "nuvoloso";
  if (w.cloud > 0.18) return "poco nuvoloso";
  return "sereno";
};

/** Barometric formula: local pressure from sea-level pressure at a given altitude and temperature. */
export const pressureAt = (msl: number, altitude: number, tempC: number) => msl * Math.pow(1 - (0.0065 * altitude) / (tempC + 0.0065 * altitude + 273.15), 5.257);
export const altitudeFromPressure = (qnh: number, hpa: number) => 44330 * (1 - Math.pow(hpa / qnh, 0.1903));
export function dewPoint(tempC: number, rh: number) {
  const a = 17.625;
  const b = 243.04;
  const alpha = Math.log(Math.max(rh, 1) / 100) + (a * tempC) / (b + tempC);
  return (b * alpha) / (a - alpha);
}
export const beaufort = (ms: number) => [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7].findIndex((limit) => ms < limit) === -1 ? 12 : [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7].findIndex((limit) => ms < limit);

const DEFAULT_W: WeatherValues = { cloud: 0.25, rain: 0, snow: 0, visibility: 25000, wind: 2.5, windDir: 240, gust: 4, temp: 16, humidity: 60, pressureMsl: 1015, thunder: 0 };

export class WeatherModel {
  mode: "live" | "manual" = "live";
  target: WeatherValues = { ...DEFAULT_W };
  now: WeatherValues = { ...DEFAULT_W };
  station: LiveWeather | null = null;
  label = "in attesa della stazione";
  history: { t: number; p: number }[] = [];
  private flash = 0;
  private nextBolt = 8;
  lightning = 0;
  /** Set when a bolt fires; the engine plays thunder with distance delay. */
  onBolt: ((distance: number) => void) | null = null;

  setStation(station: LiveWeather | null) {
    this.station = station;
  }

  fromStationAt(t: number): WeatherValues | null {
    const station = this.station;
    if (!station) return null;
    const c = station.current;
    const hourly = station.hourly;
    const number = (key: string) => Number(c[key] ?? 0);
    const base: WeatherValues = {
      cloud: number("cloud_cover") / 100,
      rain: Math.max(number("rain"), number("precipitation") - number("snowfall") * 0.7),
      snow: number("snowfall"),
      visibility: number("visibility") || 25000,
      wind: number("wind_speed_10m") / 3.6,
      windDir: number("wind_direction_10m"),
      gust: number("wind_gusts_10m") / 3.6,
      temp: number("temperature_2m"),
      humidity: number("relative_humidity_2m"),
      pressureMsl: number("pressure_msl") || 1013,
      thunder: number("weather_code") >= 95 ? 1 : 0,
    };
    const times = hourly?.time as string[] | undefined;
    if (!times || Math.abs(t - Date.now()) < 45 * 60000) return base;
    // Away from now, follow the station's hourly series while it lasts.
    const offset = station.utc_offset_seconds * 1000;
    const stamps = times.map((row) => Date.parse(`${row}Z`) - offset);
    if (t < stamps[0]! || t > stamps[stamps.length - 1]!) return null;
    let index = stamps.findIndex((stamp) => stamp > t);
    if (index <= 0) index = stamps.length - 1;
    const f = (t - stamps[index - 1]!) / (stamps[index]! - stamps[index - 1]!);
    const mix = (key: string) => {
      const row = hourly[key] as number[] | undefined;
      if (!row) return null;
      return row[index - 1]! + (row[index]! - row[index - 1]!) * f;
    };
    const code = Number((hourly.weather_code as number[] | undefined)?.[index] ?? 0);
    return {
      ...base,
      cloud: (mix("cloud_cover") ?? number("cloud_cover")) / 100,
      rain: (code >= 71 && code <= 77) || code === 85 || code === 86 ? 0 : (mix("precipitation") ?? 0),
      snow: (code >= 71 && code <= 77) || code === 85 || code === 86 ? (mix("precipitation") ?? 0) * 0.7 : 0,
      visibility: mix("visibility") ?? base.visibility,
      wind: (mix("wind_speed_10m") ?? base.wind * 3.6) / 3.6,
      windDir: mix("wind_direction_10m") ?? base.windDir,
      temp: mix("temperature_2m") ?? base.temp,
      humidity: mix("relative_humidity_2m") ?? base.humidity,
      thunder: code >= 95 ? 1 : 0,
    };
  }

  update(dt: number, t: number) {
    if (this.mode === "live") {
      const read = this.fromStationAt(t);
      if (read) this.target = read;
    }
    const k = 1 - Math.exp(-dt * 0.35);
    const n = this.now;
    const g = this.target;
    // One bad value from an upstream service must not poison the whole sky.
    for (const key of Object.keys(g) as (keyof WeatherValues)[]) if (!Number.isFinite(g[key])) g[key] = n[key];
    n.cloud += (g.cloud - n.cloud) * k;
    n.rain += (g.rain - n.rain) * k;
    n.snow += (g.snow - n.snow) * k;
    n.visibility += (g.visibility - n.visibility) * k;
    n.wind += (g.wind - n.wind) * k;
    n.gust += (g.gust - n.gust) * k;
    let d = ((g.windDir - n.windDir + 540) % 360) - 180;
    if (Math.abs(d) < 0.01) d = 0;
    n.windDir = (n.windDir + d * k + 360) % 360;
    n.temp += (g.temp - n.temp) * k;
    n.humidity += (g.humidity - n.humidity) * k;
    n.pressureMsl += (g.pressureMsl - n.pressureMsl) * k;
    n.thunder = g.thunder;

    this.flash = Math.max(0, this.flash - dt * 6);
    this.lightning = this.flash * (0.6 + 0.4 * Math.sin(this.flash * 60));
    if (n.thunder > 0.5) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.nextBolt = 6 + Math.random() * 22;
        this.flash = 1;
        this.onBolt?.(600 + Math.random() * 6000);
      }
    }
    const last = this.history[this.history.length - 1];
    if (!last || t - last.t > 600000 || t < last.t) {
      this.history.push({ t, p: n.pressureMsl });
      if (this.history.length > 40) this.history.shift();
    }
    this.label = describeState(n);
  }

  pressureTrend() {
    const h = this.history;
    if (h.length < 2) return 0;
    const a = h[0]!;
    const b = h[h.length - 1]!;
    return b.t > a.t ? ((b.p - a.p) / (b.t - a.t)) * 3600000 * 3 : 0;
  }
}
