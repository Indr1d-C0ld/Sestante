import { compassName, dms, formatLatLon, toUtm } from "../core/geo.ts";
import { equationOfTime, sunEvents, sunPosition, trueSolarHour } from "../core/solar.ts";
import { alignments, astroEvents } from "../core/archaeo.ts";
import { toMgrs } from "../core/coords.ts";
import { adjustTraverse, SURVEY_CLASSES, type TraverseLeg } from "../core/fieldwork.ts";
import type { FireRow, OwmNow } from "../core/api.ts";
import type { Engine, Snapshot } from "../world/engine.ts";
import { BANDS, heightErrorsFrom, sampleSpectrum, volumeOfBuilding, type HeightError, type Spectrum } from "./research.ts";
import { crownVolume, formatRange, formatVolume, planMeasures } from "../vision/volume.ts";
import type { LaserAssessment } from "../vision/laser.ts";
import { altitudeFromPressure, beaufort, describeState, dewPoint, pressureAt } from "../world/sim.ts";
import geomagnetism from "geomagnetism";

export type ToolId =
  | "mano" | "orologio" | "bussola" | "contapassi" | "altimetro" | "barometro" | "termoigrometro" | "anemometro" | "luxmetro"
  | "clinometro" | "telemetro" | "rotella" | "gps" | "picchetti" | "binocolo" | "monocolo" | "fotocamera" | "torcia"
  | "drone" | "carta" | "gnomone" | "sestante" | "geologo" | "campionatore" | "scala" | "cronologia"
  | "altego" | "volumetro" | "laser" | "stazione" | "ipotesi" | "sezione" | "spettroradiometro" | "aria" | "termico" | "astrolabio" | "strati" | "fonti" | "laboratorio";

export type Reading = { rows: [string, string][]; big?: [string, string]; note?: string };

export type Note = { title: string; text: string; values: Record<string, string> };

export type InstrumentState = {
  qnhRef: number;
  stopwatch: { running: boolean; start: number; elapsed: number; laps: number[] };
  survey: { x: number; y: number; z: number }[];
  gnomon: { x: number; y: number; z: number; h: number } | null;
  magnetic: boolean;
  pedometerZero: { steps: number; distance: number };
  focal: number;
  filter: number;
  traverse: { cls: number; start: { x: number; y: number; z: number } | null; last: { x: number; y: number; z: number } | null; legs: TraverseLeg[] };
  hypothesisDraft: { x: number; z: number }[];
  section: { x: number; z: number }[];
  owm: OwmNow | null;
  fires: { rows: FireRow[]; radius: number } | null;
  spectrum: Spectrum | null;
  remoteError: string;
  astroYear: number;
  laser: LaserAssessment | null;
  volumeDraft: { x: number; z: number }[];
  volumeErrors: Record<string, HeightError> | null;
};

export type Ctx = { engine: Engine; snap: Snapshot; state: InstrumentState };

export type ToolDef = {
  id: ToolId;
  name: string;
  group: "Orientarsi" | "Misurare" | "Osservare" | "Segnare e raggiungere" | "Ricerca";
  blurb: string;
  icon: string;
  dial?: "bussola" | "orologio" | "altimetro" | "barometro";
  actionLabel?: string;
  read: (ctx: Ctx) => Reading;
  /** Reading that goes to the register on F. */
  note?: (ctx: Ctx) => Note | null;
};

const fmt = (value: number, digits = 1) => value.toFixed(digits);
const deg = (rad: number) => (rad * 180) / Math.PI;

const model = geomagnetism.model(new Date());

export function magneticInfo(lat: number, lon: number, elevation: number) {
  const point = model.point([lat, lon, elevation / 1000]);
  return { declination: point.decl as number, inclination: point.incl as number, total: (point.f as number) / 1000, version: "WMM 2025" };
}

export const localPressure = (ctx: Ctx) => {
  const w = ctx.engine.weather.now;
  return pressureAt(w.pressureMsl, ctx.snap.y + (ctx.snap.drone ? 0 : 1), w.temp);
};

export function localTemperature(ctx: Ctx) {
  const w = ctx.engine.weather.now;
  // Open-Meteo's value holds for the cell's mean height: apply the lapse rate from the station, then a little radiation error in full sun.
  const station = Number(ctx.engine.data.terrain.min);
  const sunlit = ctx.snap.sunAlt > 0.05 && !ctx.snap.shaded ? Math.sin(ctx.snap.sunAlt) * (1 - w.cloud) * 1.6 : 0;
  return w.temp - ((ctx.snap.y - station) * 6.5) / 1000 + sunlit;
}

export function localWind(ctx: Ctx) {
  const w = ctx.engine.weather.now;
  const height = Math.max(1.5, ctx.snap.y - ctx.snap.ground + 1.5);
  // Log profile from the 10 m reference over rough ground.
  const factor = Math.log(height / 0.3) / Math.log(10 / 0.3);
  const t = ctx.engine.clock.t / 1000;
  const fluct = 1 + 0.22 * Math.sin(t * 0.73) * Math.sin(t * 0.31) + 0.11 * Math.sin(t * 2.1);
  const gustRange = Math.max(0, w.gust - w.wind);
  return { speed: Math.max(0, w.wind * factor * fluct + gustRange * 0.3 * Math.max(0, Math.sin(t * 0.17))), dir: w.windDir };
}

export function localLight(ctx: Ctx) {
  const w = ctx.engine.weather.now;
  const alt = ctx.snap.sunAlt;
  const sin = Math.max(0, Math.sin(alt));
  const transmittance = Math.pow(0.7, 1 / Math.max(0.04, sin));
  const direct = alt > 0 ? 128000 * sin * transmittance * (1 - w.cloud * 0.92) : 0;
  const diffuse = alt > -0.1 ? (alt > 0 ? 17000 * Math.pow(sin, 0.9) * (1 - w.cloud * 0.55) + 120 : Math.max(0, 400 * (1 + alt * 10))) : 0;
  const moon = ctx.snap.moonAlt > 0 ? 0.28 * ctx.snap.moonIllum * Math.sin(ctx.snap.moonAlt) * (1 - w.cloud * 0.8) : 0;
  const lux = (ctx.snap.shaded ? 0 : direct) + diffuse + moon + 0.002;
  const uv = Number(ctx.engine.data.weather?.current?.uv_index ?? 0);
  return { lux, direct, diffuse, moon, uv: ctx.engine.clock.mode === "live" ? uv : Math.max(0, 11 * Math.pow(sin, 1.6) * (1 - w.cloud * 0.6)) };
}

function coords(ctx: Ctx) {
  return formatLatLon(ctx.snap.lat, ctx.snap.lon);
}

function polygonArea(points: { x: number; z: number }[]) {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) sum += points[j]!.x * points[i]!.z - points[i]!.x * points[j]!.z;
  return Math.abs(sum) / 2;
}

export function surveyStats(points: { x: number; y: number; z: number }[]) {
  let length = 0;
  let plan = 0;
  let climb = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const h = Math.hypot(b.x - a.x, b.z - a.z);
    plan += h;
    length += Math.hypot(h, b.y - a.y);
    climb += Math.max(0, b.y - a.y);
  }
  const area = points.length >= 3 ? polygonArea(points) : 0;
  return { length, plan, climb, area };
}

const hmsDuration = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};

export const swElapsed = (s: InstrumentState) => s.stopwatch.elapsed + (s.stopwatch.running ? performance.now() - s.stopwatch.start : 0);

export const ICONS: Record<ToolId, string> = {
  mano: "M8 13V5a1.5 1.5 0 0 1 3 0v6m0-1V3.5a1.5 1.5 0 0 1 3 0V10m0-.5V5a1.5 1.5 0 0 1 3 0v8c0 4.5-2.5 7-6 7s-4.5-1.5-6-4.5L3.5 12a1.5 1.5 0 0 1 2.4-1.7L8 13",
  orologio: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0 3v4l2.5 1.5M9 5l.5-3h5l.5 3M9 19l.5 3h5l.5-3",
  bussola: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm3.5 5.5-2.2 5-4.8 2 2.2-5z",
  contapassi: "M9 4c1.6 0 2.5 1.5 2.5 3.5S10.5 12 9 12s-2.5-2.5-2.5-4.5S7.4 4 9 4zM7 14h4v2a2 2 0 0 1-4 0zM16 8c1.6 0 2.5 1.5 2.5 3.5S17.500 16 16 16s-2.500-2.500-2.500-4.500S14.400 8 16 8zM14 18h4v.5a2 2 0 0 1-4 0z",
  altimetro: "M3 20 9 9l4 6 3-4 5 9zM9 5V2M7 4l2-2 2 2",
  barometro: "M12 4a9 9 0 0 0-9 9v3h18v-3a9 9 0 0 0-9-9zm0 9 4-4M7 13h.01M17 13h.01",
  termoigrometro: "M10 4a2 2 0 0 1 4 0v10a4 4 0 1 1-4 0zM12 9v9M19 5s2 2.500 2 4a2 2 0 0 1-4 0c0-1.500 2-4 2-4z",
  anemometro: "M3 9h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 17h7a2.500 2.500 0 1 1-2.500 2.500",
  luxmetro: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
  clinometro: "M3 19h18M3 19 19 7M8 19a6 6 0 0 0-1-4",
  telemetro: "M3 8h12v8H3zM15 10l6-2v8l-6-2M7 12h.01M11 12h.01",
  rotella: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM20 12h3v8h-9v-1",
  gps: "M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 4.500a2.500 2.500 0 1 1 0 5 2.500 2.500 0 0 1 0-5z",
  picchetti: "M6 22V3l12 4-12 5",
  binocolo: "M7 5h3v5h4V5h3l3 9v3a3 3 0 0 1-6 0v-5h-4v5a3 3 0 0 1-6 0v-3z",
  monocolo: "M7 9h10l3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5zM9 9V5h6v4M12 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  fotocamera: "M4 8h4l2-3h4l2 3h4v11H4zM12 10a3.500 3.500 0 1 0 0 7 3.500 3.500 0 0 0 0-7z",
  torcia: "M6 3h12l-2 6v12H8V9zM8 9h8M12 13v3",
  drone: "M9 9h6v6H9zM5 5l4 4M19 5l-4 4M5 19l4-4M19 19l-4-4M2 5h6M16 5h6M2 19h6M16 19h6",
  carta: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",
  gnomone: "M12 3v15M3 21h18M12 18l7 3M8 3h8",
  sestante: "M12 3 5 18h14zM6 16a8 8 0 0 0 12 0M12 3v9M12 12l4 4",
  geologo: "M4 19l7-14 2 3 7 11zM8 19l3-5 2 2",
  campionatore: "M14 3l7 7-11 11H3v-7zM11 6l7 7M6 21c0-2 1-3 2.500-3",
  scala: "M8 2v20M16 2v20M8 6h8M8 11h8M8 16h8",
  cronologia: "M3 12a9 9 0 1 0 3-6.700M3 4v5h5M12 7v5l3 2",
  stazione: "M12 3v5M9 8h6v4H9zM12 12l-6 9M12 12l6 9M12 12v9",
  laser: "M12 2v9M8 22a4 4 0 0 1 8 0M12 11a7 3 0 1 0 0 6 7 3 0 0 0 0-6zM5 5l3 3M19 5l-3 3",
  altego: "M12 3a2.500 2.500 0 1 0 0 5 2.500 2.500 0 0 0 0-5zM8 21l1-7-2-1 1-4h8l1 4-2 1 1 7M12 14v7",
  volumetro: "M12 3l8 4.500v9L12 21l-8-4.500v-9zM12 12l8-4.500M12 12v9M12 12 4 7.500",
  ipotesi: "M4 19V9l8-5 8 5v10zM4 9l8 5 8-5M12 14v5",
  sezione: "M3 17l5-7 4 4 3-5 6 8M3 21h18",
  spettroradiometro: "M3 18c3-12 5-12 7-4s4 8 6 0 3-8 5-6M3 21h18",
  aria: "M4 8h9a2.500 2.500 0 1 0-2.500-2.500M4 12h14a3 3 0 1 1-3 3M4 16h6",
  termico: "M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 0-6 1-9z",
  astrolabio: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  strati: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  fonti: "M5 4h10l4 4v12H5zM8 12h8M8 16h8M15 4v4h4",
  laboratorio: "M9 3h6M10 3v6l-5 10a1.500 1.500 0 0 0 1.400 2h11.200a1.500 1.500 0 0 0 1.400-2L14 9V3M8 15h8",
};

const AIR_WORDS = ["", "buona", "discreta", "moderata", "scarsa", "pessima"];

const aimed = (ctx: Ctx) => {
  const look = ctx.snap.look;
  return look && look.kind !== "cielo" ? look : null;
};

/** Closes or finishes the traverse in progress. A closed one comes back to its first station. */
export function finishTraverse(state: InstrumentState, closed: boolean) {
  const { start, legs } = state.traverse;
  if (!start || !legs.length) return null;
  return adjustTraverse(start, legs, closed);
}

const nearestFires = (rows: FireRow[], snap: Snapshot) =>
  rows
    .map((row) => {
      const y = (row.lat - snap.lat) * 111.32;
      const x = (row.lon - snap.lon) * 111.32 * Math.cos((snap.lat * Math.PI) / 180);
      return { row, km: Math.hypot(x, y), bearing: ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 };
    })
    .sort((a, b) => a.km - b.km);

/** The one astronomical event closest to where the eye points: only the front of the sightline counts here. */
const nearestEvent = (heading: number, lat: number, year: number) => {
  const gap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  return alignments(heading, astroEvents(lat, year))
    .map((row) => ({ ...row, delta: gap(row.azimuth, heading) }))
    .sort((a, b) => a.delta - b.delta)[0];
};

const nearestShot = (ctx: Ctx) => {
  const look = aimed(ctx);
  const x = look?.x ?? ctx.snap.x;
  const z = look?.z ?? ctx.snap.z;
  let best: { reading: LaserAssessment["readings"][number]; d: number } | null = null;
  for (const reading of ctx.state.laser?.readings ?? []) {
    const d = Math.hypot(reading.shot.x - x, reading.shot.z - z);
    if (!best || d < best.d) best = { reading, d };
  }
  return best;
};

const errorsFor = (ctx: Ctx) => ctx.state.volumeErrors ?? heightErrorsFrom(ctx.state.laser);

export const TOOLS: ToolDef[] = [
  {
    id: "altego",
    name: "Alter-ego",
    group: "Misurare",
    blurb: "Te stesso come metro: quante volte la tua altezza è ciò che inquadri, quanti passi dista. F lascia lì una tua copia, con le tue misure, per vedere la scala a colpo d'occhio.",
    icon: ICONS.altego,
    actionLabel: "Posa qui una figura",
    read: (ctx) => {
      const s = ctx.engine.settings;
      const look = aimed(ctx);
      const steps = look ? look.dist / s.stride : 0;
      const you = ["Tu", `${fmt(s.altEgoHeight, 2)} m`] as [string, string];
      if (look?.building) {
        const b = look.building;
        const ring = b.rings[0]!;
        let minX = Infinity;
        let maxX = -Infinity;
        for (let i = 0; i < ring.length; i += 2) {
          minX = Math.min(minX, ring[i]!);
          maxX = Math.max(maxX, ring[i]!);
        }
        return { big: ["Rispetto a te", `${fmt(b.height / s.altEgoHeight)} volte`], rows: [you, ["Bersaglio", `${fmt(b.height)} m`], ["Fino lì", `${Math.round(steps)} passi`], ["Largo come", `${Math.round((maxX - minX) / s.altEgoShoulders)} persone di fianco`]], note: "Altezza e larghezza confrontate con le tue misure." };
      }
      if (look?.tree) return { big: ["Rispetto a te", `${fmt(look.tree.h / s.altEgoHeight)} volte`], rows: [you, ["Albero", `${fmt(look.tree.h)} m`], ["Fino lì", `${Math.round(steps)} passi`]], note: "L'altezza del singolo albero è la lettura più debole." };
      return { rows: [you, ["Spalle", `${(s.altEgoShoulders * 100).toFixed(0)} cm`], ["Falcata", `${fmt(s.stride, 2)} m`], ["Fino lì", look ? `${Math.round(steps)} passi` : "—"]], note: "Misure modificabili in Regola, Esploratore. Tasto X per guardarti da fuori." };
    },
  },
  {
    id: "volumetro",
    name: "Volumetro",
    group: "Ricerca",
    blurb: "Mira un edificio per il suo volume con l'intervallo d'errore. Su terreno, F traccia il contorno di una massa, un cumulo o una cava, misurata sui modelli del rilievo.",
    icon: ICONS.volumetro,
    actionLabel: "Misura",
    read: (ctx) => {
      const draft = ctx.state.volumeDraft;
      if (draft.length) {
        const area = draft.length >= 3 ? planMeasures([draft.flatMap((p) => [p.x, p.z])]).area : 0;
        return { big: ["Contorno", `${draft.length} punti`], rows: [["Area finora", `${fmt(area / 10000, 2)} ha`]], note: "F aggiunge un punto. Mirando di nuovo il primo punto il contorno si chiude e si misura." };
      }
      const look = aimed(ctx);
      if (look?.building) {
        const row = volumeOfBuilding(look.building, ctx.engine.data.buildings, errorsFor(ctx));
        const main = row.complex ?? row.own;
        return {
          big: [row.complex ? row.complex.name : "Volume", formatVolume(main.value)],
          rows: [
            ["Intervallo", formatRange(main)],
            ...(row.complex ? ([["Parte inquadrata", formatVolume(row.own.value)], ["Parti", String(row.complex.parts)]] as [string, string][]) : []),
            ["Pianta", `${fmt(row.complex?.area ?? row.area, 0)} m²`],
            ["Altezza media", `${fmt(row.complex ? row.complex.value / row.complex.area : row.meanHeight)} m`],
            ["Errore d'altezza", `±${fmt(row.error.typical)} m`],
          ],
          note: `Errore tipico ${row.error.basis}. L'intervallo vale circa 8 volte su 10. Interni, piani interrati e vuoti non si vedono.`,
        };
      }
      if (look?.tree) {
        const row = crownVolume(look.tree.r, look.tree.h);
        return { big: ["Chioma", formatVolume(row.value)], rows: [["Intervallo", formatRange(row)], ["Raggio", `${fmt(look.tree.r)} m`], ["Altezza", `${fmt(look.tree.h)} m`]], note: "Solo un ordine di grandezza: forma presunta, e l'altezza di un singolo albero non è nota." };
      }
      return { rows: [["Bersaglio", look ? "terreno" : "—"]], note: "Mira un edificio o un albero. Su terreno, F comincia il contorno di una massa: dal drone si vede meglio." };
    },
    note: (ctx) => {
      const look = aimed(ctx);
      if (look?.building) {
        const row = volumeOfBuilding(look.building, ctx.engine.data.buildings, errorsFor(ctx));
        const main = row.complex ?? row.own;
        const name = row.complex?.name ?? look.building.tags.name ?? "Edificio";
        const values: Record<string, string> = { intervallo: formatRange(main), pianta: `${fmt(row.complex?.area ?? row.area, 0)} m²`, "altezza media": `${fmt(row.complex ? row.complex.value / row.complex.area : row.meanHeight)} m`, fonte: look.building.source };
        return { title: `\u2068${name}\u2069: ${formatVolume(main.value)}`, text: `Da pianta e altezza, senza interni né interrati. Errore d'altezza ±${fmt(row.error.typical)} m, ${row.error.basis}.`, values };
      }
      if (look?.tree) {
        const row = crownVolume(look.tree.r, look.tree.h);
        return { title: `Chioma: ${formatVolume(row.value)}`, text: "Ordine di grandezza: forma presunta.", values: { intervallo: formatRange(row) } };
      }
      return null;
    },
  },
  {
    id: "laser",
    name: "Laser spaziale GEDI",
    group: "Ricerca",
    blurb: "L'impronta più vicina al punto mirato: un laser NASA ha misurato da 400 km cima e suolo in un disco di 25 m. È il controllo indipendente delle altezze.",
    icon: ICONS.laser,
    actionLabel: "Annota impronta",
    read: (ctx) => {
      if (!ctx.state.laser) return { rows: [["Stato", "impronte non ancora chieste"]], note: "Le chiedi a NASA da Laboratorio, scheda Laser. Ci vogliono alcuni minuti, poi restano sul disco." };
      const near = nearestShot(ctx);
      if (!near) return { rows: [["Impronte", "nessuna qui"]], note: "GEDI passa a strisce: non copre ogni metro." };
      const { reading, d } = near;
      return {
        big: ["Altezza misurata", `${fmt(reading.measured)} m`],
        rows: [
          ["Sopra", reading.kind + (reading.building ? ` · ${reading.building.name}` : "")],
          ["Il mondo dice", reading.model == null ? "—" : `${fmt(reading.model)} m`],
          ["Impronta a", `${fmt(d, 0)} m`],
          ["Data", reading.shot.date],
          ["Sensibilità", fmt(reading.shot.sensitivity, 2)],
          ["Qualità", reading.shot.good ? "buona" : "bassa"],
        ],
        note: reading.shot.good ? "La cima può venire da un vicino dentro il disco di 25 m." : "Il segnale non basta a garantire il suolo: trattala come indizio.",
      };
    },
    note: (ctx) => {
      const near = nearestShot(ctx);
      if (!near) return null;
      const { reading, d } = near;
      return { title: `Laser: ${fmt(reading.measured)} m su ${reading.kind}`, text: `Impronta GEDI del ${reading.shot.date}, a ${fmt(d, 0)} m dal punto mirato, qualità ${reading.shot.good ? "buona" : "bassa"}.`, values: { misurata: `${fmt(reading.measured)} m`, ...(reading.model != null ? { mondo: `${fmt(reading.model)} m` } : {}), sensibilità: fmt(reading.shot.sensitivity, 2) } };
    },
  },
  {
    id: "stazione",
    name: "Stazione topografica",
    group: "Misurare",
    blurb: "Poligonale vera: ogni battuta porta l'errore del suo strumento. Chiudendo sul punto di partenza vedi quanto hai sbagliato, e lo compensi.",
    icon: ICONS.stazione,
    actionLabel: "Battuta",
    read: ({ state, snap }) => {
      const t = state.traverse;
      const cls = SURVEY_CLASSES[t.cls]!;
      const length = t.legs.reduce((sum, leg) => sum + leg.distance, 0);
      const look = snap.look && snap.look.kind !== "cielo" ? snap.look : null;
      return {
        big: ["Battute", String(t.legs.length)],
        rows: [
          ["Strumento", cls.label],
          ["Sviluppo", `${fmt(length, 2)} m`],
          ["Punto mirato", look ? `${fmt(look.dist, 1)} m` : "—"],
          ["Stato", t.start ? "poligonale aperta" : "manca la partenza"],
        ],
        note: "Mira un punto e premi F: la prima battuta fissa la partenza, le altre aggiungono un lato.",
      };
    },
  },
  {
    id: "ipotesi",
    name: "Ipotesi di volume",
    group: "Ricerca",
    blurb: "Disegna a terra un edificio che forse c'era. Il banco delle ombre controlla se le riprese lo confermano.",
    icon: ICONS.ipotesi,
    actionLabel: "Fissa vertice",
    read: ({ state }) => ({ big: ["Vertici", String(state.hypothesisDraft.length)], rows: [["Serve", "almeno 3 vertici"]], note: "Mira il suolo e premi F per ogni angolo, poi chiudi il volume." }),
  },
  {
    id: "sezione",
    name: "Sezione del terreno",
    group: "Ricerca",
    blurb: "Fissa i punti di un tracciato e leggi il profilo di suolo ed edifici nel Laboratorio.",
    icon: ICONS.sezione,
    actionLabel: "Fissa punto",
    read: ({ state }) => ({ big: ["Punti", String(state.section.length)], rows: [], note: "Mira e premi F per ogni punto, poi apri la sezione." }),
  },
  {
    id: "spettroradiometro",
    name: "Spettroradiometro",
    group: "Ricerca",
    blurb: "Firma spettrale reale del punto mirato: sette bande di Sentinel-2, dal blu all'infrarosso corto, a 10–20 m per pixel.",
    icon: ICONS.spettroradiometro,
    actionLabel: "Registra firma",
    read: (ctx) => {
      if (ctx.state.remoteError) return { rows: [["Stato", "non raggiunto"]], note: ctx.state.remoteError };
      if (!ctx.state.spectrum) return { rows: [["Stato", "scarico le bande…"]] };
      const look = aimed(ctx);
      const read = look ? sampleSpectrum(ctx.state.spectrum, look.x, look.z, ctx.engine.data.projection) : null;
      if (!read) return { rows: [["Punto", "fuori dal riquadro o senza dati"]], note: `Scene dal ${ctx.state.spectrum.from} al ${ctx.state.spectrum.to}.` };
      return {
        big: ["Superficie", read.kind],
        rows: [["NDVI", fmt(read.ndvi, 2)], ["NDWI", fmt(read.ndwi, 2)], ["NBR", fmt(read.nbr, 2)], ["BSI", fmt(read.bsi, 2)], ...BANDS.map((band, index): [string, string] => [`${band.name} ${band.nm} nm`, `${fmt(read.values[index]! * 100, 1)} %`])],
        note: `Riflettanza a terra, scene dal ${ctx.state.spectrum.from} al ${ctx.state.spectrum.to}. La classe è un'indicazione, non un'analisi.`,
      };
    },
    note: (ctx) => {
      const look = aimed(ctx);
      const read = look && ctx.state.spectrum ? sampleSpectrum(ctx.state.spectrum, look.x, look.z, ctx.engine.data.projection) : null;
      if (!read) return null;
      return { title: `Firma: ${read.kind}`, text: `NDVI ${fmt(read.ndvi, 2)}, NDWI ${fmt(read.ndwi, 2)}. Sentinel-2, scene dal ${ctx.state.spectrum!.from} al ${ctx.state.spectrum!.to}.`, values: Object.fromEntries(BANDS.map((band, index) => [band.id, `${fmt(read.values[index]! * 100, 1)} %`])) };
    },
  },
  {
    id: "aria",
    name: "Campionatore d'aria",
    group: "Misurare",
    blurb: "Polveri sottili e gas stimati per questo luogo dal modello OpenWeather. Dato del presente: il tempo simulato non lo cambia.",
    icon: ICONS.aria,
    actionLabel: "Annota",
    read: ({ state }) => {
      if (state.remoteError) return { rows: [["Stato", "non raggiunto"]], note: state.remoteError };
      const air = state.owm?.air;
      if (!air) return { rows: [["Stato", "chiedo al modello…"]] };
      return {
        big: ["Qualità", `${AIR_WORDS[air.aqi] ?? "—"} (${air.aqi}/5)`],
        rows: [["PM2,5", `${fmt(air.pm25)} µg/m³`], ["PM10", `${fmt(air.pm10)} µg/m³`], ["Ozono", `${fmt(air.o3, 0)} µg/m³`], ["NO₂", `${fmt(air.no2)} µg/m³`], ["SO₂", `${fmt(air.so2)} µg/m³`], ["CO", `${fmt(air.co, 0)} µg/m³`]],
        note: "Valori di modello per quest'area, non una misura al punto in cui sei.",
      };
    },
    note: ({ state }) => {
      const air = state.owm?.air;
      return air ? { title: `Aria ${AIR_WORDS[air.aqi]}`, text: "Modello OpenWeather, non misura al punto.", values: { "PM2,5": `${fmt(air.pm25)} µg/m³`, PM10: `${fmt(air.pm10)} µg/m³`, O3: `${fmt(air.o3, 0)} µg/m³`, NO2: `${fmt(air.no2)} µg/m³` } } : null;
    },
  },
  {
    id: "termico",
    name: "Allarme termico",
    group: "Osservare",
    blurb: "Anomalie di calore viste dai satelliti NASA entro 100 km negli ultimi giorni. La lista completa e l'archivio sono negli Strati.",
    icon: ICONS.termico,
    actionLabel: "Annota la più vicina",
    read: ({ state, snap }) => {
      if (state.remoteError) return { rows: [["Stato", "non raggiunto"]], note: state.remoteError };
      if (!state.fires) return { rows: [["Stato", "chiedo a FIRMS…"]] };
      const rows = nearestFires(state.fires.rows, snap).filter((row) => row.km <= state.fires!.radius);
      const first = rows[0];
      if (!first) return { big: ["Anomalie", "0"], rows: [["Raggio", `${state.fires.radius} km`]] };
      return {
        big: ["Più vicina", `${fmt(first.km)} km`],
        rows: [["Direzione", `${fmt(first.bearing, 0)}° ${compassName(first.bearing)}`], ["Quando", `${first.row.date} ${first.row.time} UTC`], ["Potenza", `${fmt(first.row.frp)} MW`], ["Sensore", first.row.sensor], ["In totale", String(rows.length)]],
        note: "Il satellite vede calore, non la causa.",
      };
    },
    note: ({ state, snap }) => {
      const near = nearestFires(state.fires?.rows ?? [], snap)[0];
      return near ? { title: `Calore a ${fmt(near.km)} km`, text: `${compassName(near.bearing)}, ${near.row.date} ${near.row.time} UTC, NASA FIRMS.`, values: { potenza: `${fmt(near.row.frp)} MW`, sensore: near.row.sensor } } : null;
    },
  },
  {
    id: "astrolabio",
    name: "Astrolabio",
    group: "Orientarsi",
    blurb: "Quanto il tuo sguardo si scosta da solstizi, equinozi e lunistizi, nell'anno che scegli dal Laboratorio.",
    icon: ICONS.astrolabio,
    actionLabel: "Annota traguardo",
    read: ({ snap, state }) => {
      const first = nearestEvent(snap.heading, snap.lat, state.astroYear);
      return {
        big: ["Azimut", `${fmt(snap.heading, 1)}°`],
        rows: first ? [["Evento più vicino", `${first.kind} ${first.event.label}`], ["Azimut evento", `${fmt(first.azimuth, 1)}°`], ["Scarto", `${fmt(first.delta, 1)}°`], ["Anno", String(state.astroYear)]] : [["Anno", String(state.astroYear)]],
        note: "Orizzonte piatto. Il profilo reale del rilievo è nel Laboratorio, scheda Cielo.",
      };
    },
    note: ({ snap, state }) => {
      const first = nearestEvent(snap.heading, snap.lat, state.astroYear);
      return first ? { title: `Traguardo a ${fmt(snap.heading, 1)}°`, text: `Più vicino a ${first.kind} ${first.event.label}, scarto ${fmt(first.delta, 1)}°.`, values: { anno: String(state.astroYear) } } : null;
    },
  },
  {
    id: "strati",
    name: "Strati della Terra",
    group: "Ricerca",
    blurb: "Sentinel-1 e 2, Landsat dal 1983, luci notturne, anomalie della vegetazione, fuochi, aria e carte storiche da stendere sul suolo.",
    icon: ICONS.strati,
    read: () => ({ rows: [] }),
  },
  {
    id: "fonti",
    name: "Fonti del luogo",
    group: "Ricerca",
    blurb: "Fotografie vere scattate qui e voci di Wikipedia: mettiti dove fu presa una foto, sovrapponila o proiettala sui muri.",
    icon: ICONS.fonti,
    read: () => ({ rows: [] }),
  },
  {
    id: "laboratorio",
    name: "Laboratorio",
    group: "Ricerca",
    blurb: "Altezze da più date, banco delle ombre, sezioni, visibilità, archeoastronomia, inondazione, origine dei dati, esportazioni.",
    icon: ICONS.laboratorio,
    read: () => ({ rows: [] }),
  },
  {
    id: "mano",
    name: "Ispezione",
    group: "Segnare e raggiungere",
    blurb: "Guarda un oggetto e apri la sua scheda: fonte, dati e altezza con la loro provenienza.",
    icon: ICONS.mano,
    actionLabel: "Apri scheda",
    read: ({ snap }) => {
      const look = snap.look;
      return {
        rows: look && look.kind !== "cielo" ? [["Bersaglio", look.kind], ["Distanza", `${fmt(look.dist)} m`]] : [["Bersaglio", "cielo"]],
        note: "Inquadra un edificio, un albero, un arredo o il terreno, poi premi F.",
      };
    },
  },
  {
    id: "orologio",
    name: "Orologio da polso",
    group: "Misurare",
    blurb: "Ora civile, solare vera e UTC, effemeridi, cronometro. Da qui si regola anche lo scorrere del tempo.",
    icon: ICONS.orologio,
    dial: "orologio",
    actionLabel: "Annota ora",
    read: (ctx) => {
      const { engine, snap, state } = ctx;
      const date = engine.clock.date;
      const events = sunEvents(date, engine.data.projection.lat0, engine.data.projection.lon0);
      const solar = trueSolarHour(date, engine.data.projection.lon0);
      const h = (d: Date | null) => (d ? engine.clock.civil({ hour: "2-digit", minute: "2-digit" }, d) : "—");
      return {
        big: ["Ora locale", engine.clock.civil({ hour: "2-digit", minute: "2-digit", second: "2-digit" })],
        rows: [
          ["Data", engine.clock.civil({ day: "2-digit", month: "short", year: "numeric" })],
          ["Fuso", engine.clock.timezone],
          ["UTC", date.toISOString().slice(11, 19)],
          ["Solare vera", `${String(Math.floor(solar)).padStart(2, "0")}:${String(Math.floor((solar % 1) * 60)).padStart(2, "0")}`],
          ["Eq. del tempo", `${fmt(equationOfTime(date))} min`],
          ["Alba / tramonto", `${h(events.rise)} / ${h(events.set)}`],
          ["Culminazione", `${h(events.transit)} a ${fmt(deg(events.maxAltitude))}°`],
          ["Sole", `${fmt(deg(snap.sunAlt))}° · az ${fmt(deg(snap.sunAz), 0)}°`],
          ["Cronometro", hmsDuration(swElapsed(state))],
          ["Scorrimento", engine.clock.mode === "live" ? "reale 1:1" : engine.clock.paused ? "fermo" : `×${engine.clock.rate}`],
        ],
      };
    },
    note: ({ engine, snap, state }) => ({
      title: `Ora ${engine.clock.civil({ hour: "2-digit", minute: "2-digit" })}`,
      text: `Ora letta al polso. Sole a ${fmt(deg(snap.sunAlt))}° di altezza, azimut ${fmt(deg(snap.sunAz), 0)}°.`,
      values: { data: engine.clock.civil({ day: "2-digit", month: "short", year: "numeric" }), cronometro: hmsDuration(swElapsed(state)) },
    }),
  },
  {
    id: "bussola",
    name: "Bussola",
    group: "Orientarsi",
    blurb: "Azimut vero e magnetico. La declinazione è calcolata col modello WMM per questo punto e questa data.",
    icon: ICONS.bussola,
    dial: "bussola",
    actionLabel: "Annota rilevamento",
    read: ({ snap }) => {
      const mag = magneticInfo(snap.lat, snap.lon, snap.y);
      const magnetic = (snap.heading - mag.declination + 360) % 360;
      return {
        big: ["Azimut vero", `${fmt(snap.heading, 0)}° ${compassName(snap.heading)}`],
        rows: [
          ["Magnetico", `${fmt(magnetic, 0)}°`],
          ["Declinazione", `${mag.declination >= 0 ? "+" : ""}${fmt(mag.declination)}° (${mag.version})`],
          ["Inclinazione", `${fmt(mag.inclination)}°`],
          ["Campo totale", `${fmt(mag.total)} µT`],
          ["Contro-azimut", `${fmt((snap.heading + 180) % 360, 0)}°`],
        ],
      };
    },
    note: ({ snap }) => {
      const mag = magneticInfo(snap.lat, snap.lon, snap.y);
      return {
        title: `Rilevamento ${fmt(snap.heading, 0)}° ${compassName(snap.heading)}`,
        text: `Azimut preso verso ${snap.look && snap.look.kind !== "cielo" ? `${snap.look.kind} a ${fmt(snap.look.dist, 0)} m` : "l'orizzonte"}.`,
        values: { vero: `${fmt(snap.heading)}°`, magnetico: `${fmt((snap.heading - mag.declination + 360) % 360)}°`, declinazione: `${fmt(mag.declination)}°` },
      };
    },
  },
  {
    id: "contapassi",
    name: "Contapassi",
    group: "Misurare",
    blurb: "Passi, distanza, cadenza e dislivello. Conta davvero: un passo per ogni falcata percorsa a terra.",
    icon: ICONS.contapassi,
    actionLabel: "Annota tappa",
    read: ({ snap, state, engine }) => {
      const steps = snap.steps - state.pedometerZero.steps;
      const distance = snap.distance - state.pedometerZero.distance;
      return {
        big: ["Passi", String(steps)],
        rows: [
          ["Distanza", distance > 1000 ? `${fmt(distance / 1000, 2)} km` : `${fmt(distance, 0)} m`],
          ["Cadenza", `${fmt(snap.cadence, 0)} p/min`],
          ["Velocità", `${fmt(snap.speed * 3.6)} km/h`],
          ["Salita totale", `${fmt(snap.ascent, 0)} m`],
          ["Falcata", `${engine.settings.stride.toFixed(2)} m`],
        ],
      };
    },
    note: ({ snap, state }) => ({
      title: `Tappa: ${snap.steps - state.pedometerZero.steps} passi`,
      text: `Percorsi ${fmt(snap.distance - state.pedometerZero.distance, 0)} m con ${fmt(snap.ascent, 0)} m di salita.`,
      values: { passi: String(snap.steps - state.pedometerZero.steps), distanza: `${fmt(snap.distance - state.pedometerZero.distance, 0)} m` },
    }),
  },
  {
    id: "altimetro",
    name: "Altimetro",
    group: "Misurare",
    blurb: "Barometrico come quelli veri: risente del tempo che cambia e va ricalibrato sulla quota nota.",
    icon: ICONS.altimetro,
    dial: "altimetro",
    actionLabel: "Annota quota",
    read: (ctx) => {
      const p = localPressure(ctx);
      const alt = altitudeFromPressure(ctx.state.qnhRef, p);
      return {
        big: ["Quota barometrica", `${fmt(alt, 0)} m`],
        rows: [
          ["Quota da carta (DEM)", `${fmt(ctx.snap.ground)} m`],
          ["Altezza sul suolo", `${fmt(ctx.snap.y - ctx.snap.ground)} m`],
          ["Scarto", `${fmt(alt - ctx.snap.y)} m`],
          ["QNH impostato", `${fmt(ctx.state.qnhRef)} hPa`],
        ],
      };
    },
    note: (ctx) => {
      const alt = altitudeFromPressure(ctx.state.qnhRef, localPressure(ctx));
      return { title: `Quota ${fmt(alt, 0)} m`, text: "Lettura dell'altimetro barometrico.", values: { barometrica: `${fmt(alt)} m`, DEM: `${fmt(ctx.snap.ground)} m`, QNH: `${fmt(ctx.state.qnhRef)} hPa` } };
    },
  },
  {
    id: "barometro",
    name: "Barometro",
    group: "Misurare",
    blurb: "Pressione locale e al livello del mare, con tendenza calcolata dalla storia della spedizione.",
    icon: ICONS.barometro,
    dial: "barometro",
    actionLabel: "Annota pressione",
    read: (ctx) => {
      const p = localPressure(ctx);
      const trend = ctx.engine.weather.pressureTrend();
      const w = ctx.engine.weather.now;
      return {
        big: ["Pressione locale", `${fmt(p)} hPa`],
        rows: [
          ["Al livello del mare", `${fmt(w.pressureMsl)} hPa`],
          ["Tendenza 3 h", `${trend >= 0 ? "+" : ""}${fmt(trend)} hPa`],
          ["Lettura", trend < -1.5 ? "in calo: peggioramento" : trend > 1.5 ? "in salita: miglioramento" : "stazionaria"],
          ["Condizioni", describeState(w)],
        ],
      };
    },
    note: (ctx) => ({
      title: `Pressione ${fmt(localPressure(ctx))} hPa`,
      text: `Tempo osservato: ${describeState(ctx.engine.weather.now)}.`,
      values: { locale: `${fmt(localPressure(ctx))} hPa`, QFF: `${fmt(ctx.engine.weather.now.pressureMsl)} hPa`, tendenza: `${fmt(ctx.engine.weather.pressureTrend())} hPa/3h` },
    }),
  },
  {
    id: "termoigrometro",
    name: "Termoigrometro",
    group: "Misurare",
    blurb: "Temperatura corretta per quota e irraggiamento, umidità, punto di rugiada.",
    icon: ICONS.termoigrometro,
    actionLabel: "Annota",
    read: (ctx) => {
      const t = localTemperature(ctx);
      const rh = ctx.engine.weather.now.humidity;
      return {
        big: ["Temperatura", `${fmt(t)} °C`],
        rows: [
          ["Umidità relativa", `${fmt(rh, 0)} %`],
          ["Punto di rugiada", `${fmt(dewPoint(t, rh))} °C`],
          ["Esposizione", ctx.snap.shaded ? "in ombra" : "al sole"],
        ],
      };
    },
    note: (ctx) => {
      const t = localTemperature(ctx);
      const rh = ctx.engine.weather.now.humidity;
      return { title: `${fmt(t)} °C, ${fmt(rh, 0)} %`, text: `Rilevati ${ctx.snap.shaded ? "in ombra" : "al sole"}.`, values: { T: `${fmt(t)} °C`, UR: `${fmt(rh, 0)} %`, rugiada: `${fmt(dewPoint(t, rh))} °C` } };
    },
  },
  {
    id: "anemometro",
    name: "Anemometro",
    group: "Misurare",
    blurb: "Vento all'altezza a cui sei: profilo logaritmico dal dato a 10 m, raffiche comprese.",
    icon: ICONS.anemometro,
    actionLabel: "Annota vento",
    read: (ctx) => {
      const wind = localWind(ctx);
      return {
        big: ["Vento", `${fmt(wind.speed)} m/s`],
        rows: [
          ["km/h", fmt(wind.speed * 3.6)],
          ["Beaufort", String(beaufort(wind.speed))],
          ["Da", `${fmt(wind.dir, 0)}° ${compassName(wind.dir)}`],
          ["Raffiche a 10 m", `${fmt(ctx.engine.weather.now.gust)} m/s`],
        ],
      };
    },
    note: (ctx) => {
      const wind = localWind(ctx);
      return { title: `Vento ${fmt(wind.speed)} m/s da ${compassName(wind.dir)}`, text: `Forza ${beaufort(wind.speed)} Beaufort.`, values: { velocità: `${fmt(wind.speed)} m/s`, direzione: `${fmt(wind.dir, 0)}°` } };
    },
  },
  {
    id: "luxmetro",
    name: "Luxmetro",
    group: "Misurare",
    blurb: "Illuminamento e UV stimati da sole, luna, nubi e ombra realmente proiettata su di te.",
    icon: ICONS.luxmetro,
    actionLabel: "Annota luce",
    read: (ctx) => {
      const light = localLight(ctx);
      return {
        big: ["Illuminamento", light.lux > 1000 ? `${fmt(light.lux / 1000)} klx` : `${fmt(light.lux, light.lux < 1 ? 3 : 0)} lx`],
        rows: [
          ["Diretta", `${fmt(light.direct / 1000)} klx`],
          ["Diffusa", `${fmt(light.diffuse / 1000)} klx`],
          ["Luna", `${fmt(light.moon, 3)} lx · fase ${fmt(ctx.snap.moonIllum * 100, 0)}%`],
          ["Indice UV", fmt(light.uv)],
          ["Stato", ctx.snap.shaded ? "in ombra" : "in luce"],
        ],
      };
    },
    note: (ctx) => {
      const light = localLight(ctx);
      return { title: `Luce ${fmt(light.lux, 0)} lx`, text: ctx.snap.shaded ? "Lettura in ombra." : "Lettura in luce diretta.", values: { lux: fmt(light.lux, 0), UV: fmt(light.uv) } };
    },
  },
  {
    id: "clinometro",
    name: "Clinometro",
    group: "Misurare",
    blurb: "Angolo di vista e pendenza. Col telemetro restituisce l'altezza del punto traguardato.",
    icon: ICONS.clinometro,
    actionLabel: "Annota angolo",
    read: ({ snap }) => {
      const look = snap.look;
      const horizontal = look && look.kind !== "cielo" ? look.dist * Math.cos((snap.pitch * Math.PI) / 180) : null;
      return {
        big: ["Angolo di vista", `${snap.pitch >= 0 ? "+" : ""}${fmt(snap.pitch)}°`],
        rows: [
          ["Pendenza", `${fmt(Math.tan((snap.pitch * Math.PI) / 180) * 100, 0)} %`],
          ["Suolo sotto i piedi", `${fmt(snap.slope)}°`],
          ...(horizontal != null ? ([["Quota del punto", `${fmt(look!.y)} m`], ["Sopra il tuo occhio", `${fmt(horizontal * Math.tan((snap.pitch * Math.PI) / 180))} m`]] as [string, string][]) : []),
        ],
      };
    },
    note: ({ snap }) => ({ title: `Inclinazione ${fmt(snap.pitch)}°`, text: snap.look && snap.look.kind !== "cielo" ? `Traguardato: ${snap.look.kind}, quota ${fmt(snap.look.y)} m.` : "Traguardato il cielo.", values: { angolo: `${fmt(snap.pitch)}°` } }),
  },
  {
    id: "telemetro",
    name: "Telemetro laser",
    group: "Misurare",
    blurb: "Distanza inclinata e orizzontale, dislivello e azimut del punto inquadrato. Ogni scatto va nel registro.",
    icon: ICONS.telemetro,
    actionLabel: "Misura",
    read: ({ snap }) => {
      const look = snap.look;
      if (!look || look.kind === "cielo") return { big: ["Distanza", "---"], rows: [["Bersaglio", "fuori portata"]], note: "Portata 4 km." };
      const h = look.dist * Math.cos((snap.pitch * Math.PI) / 180);
      return {
        big: ["Distanza", `${fmt(look.dist, look.dist < 100 ? 2 : 1)} m`],
        rows: [
          ["Orizzontale", `${fmt(h)} m`],
          ["Dislivello", `${fmt(look.y - (snap.y + 1.68))} m`],
          ["Azimut", `${fmt(snap.heading, 0)}° ${compassName(snap.heading)}`],
          ["Bersaglio", look.kind + (look.building?.tags?.name ? ` · ${look.building.tags.name}` : "")],
        ],
      };
    },
    note: ({ snap }) => {
      const look = snap.look;
      if (!look || look.kind === "cielo") return null;
      const h = look.dist * Math.cos((snap.pitch * Math.PI) / 180);
      return {
        title: `${fmt(look.dist)} m su ${look.kind}`,
        text: look.building?.tags?.name ? `Bersaglio: ${look.building.tags.name}.` : `Azimut ${fmt(snap.heading, 0)}° ${compassName(snap.heading)}.`,
        values: { distanza: `${fmt(look.dist, 2)} m`, orizzontale: `${fmt(h)} m`, dislivello: `${fmt(look.y - (snap.y + 1.68))} m`, azimut: `${fmt(snap.heading)}°` },
      };
    },
  },
  {
    id: "rotella",
    name: "Rotella metrica",
    group: "Misurare",
    blurb: "Fissa punti sul terreno: lunghezza, sviluppo in pianta, area chiusa e salita. Il rilievo finisce anche sulla carta.",
    icon: ICONS.rotella,
    actionLabel: "Fissa punto",
    read: ({ state }) => {
      const stats = surveyStats(state.survey);
      return {
        big: ["Lunghezza", stats.length > 1000 ? `${fmt(stats.length / 1000, 3)} km` : `${fmt(stats.length, 2)} m`],
        rows: [
          ["Punti", String(state.survey.length)],
          ["In pianta", `${fmt(stats.plan, 2)} m`],
          ["Salita", `${fmt(stats.climb, 2)} m`],
          ["Area se chiuso", stats.area > 10000 ? `${fmt(stats.area / 10000, 2)} ha` : `${fmt(stats.area)} m²`],
        ],
      };
    },
  },
  {
    id: "gps",
    name: "Ricevitore GPS",
    group: "Orientarsi",
    blurb: "Coordinate geografiche e UTM, quota, punti nave.",
    icon: ICONS.gps,
    actionLabel: "Salva punto",
    read: ({ snap }) => ({
      rows: [
        ["Latitudine", dms(snap.lat, "N", "S")],
        ["Longitudine", dms(snap.lon, "E", "O")],
        ["Decimali", `${snap.lat.toFixed(6)}, ${snap.lon.toFixed(6)}`],
        ["UTM", toUtm(snap.lat, snap.lon).text],
        ["MGRS", toMgrs(snap.lat, snap.lon)],
        ["Quota", `${fmt(snap.y)} m`],
        ["Rotta", `${fmt(snap.heading, 0)}° · ${fmt(snap.speed * 3.6)} km/h`],
      ],
    }),
    note: (ctx) => ({ title: "Punto GPS", text: coords(ctx), values: { UTM: toUtm(ctx.snap.lat, ctx.snap.lon).text, quota: `${fmt(ctx.snap.y)} m` } }),
  },
  {
    id: "picchetti",
    name: "Picchetti",
    group: "Segnare e raggiungere",
    blurb: "Pianta una bandierina con nome dove guardi: resta nel mondo, sulla carta e nel registro.",
    icon: ICONS.picchetti,
    actionLabel: "Pianta",
    read: ({ snap }) => ({ rows: [["Punto mirato", snap.look && snap.look.kind !== "cielo" ? `${fmt(snap.look.dist)} m` : "—"]] }),
  },
  {
    id: "binocolo",
    name: "Binocolo 8×–12×",
    group: "Osservare",
    blurb: "Doppio campo e reticolo a mil per stimare la distanza. Rotella per l'ingrandimento; accovacciato trema meno.",
    icon: ICONS.binocolo,
    actionLabel: "Annota avvistamento",
    read: ({ snap }) => ({
      big: ["Ingrandimento", `${fmt(snap.zoom)}×`],
      rows: [
        ["Azimut", `${fmt(snap.heading, 0)}° ${compassName(snap.heading)}`],
        ["Bersaglio", snap.look && snap.look.kind !== "cielo" ? `${snap.look.kind} ~${fmt(snap.look.dist, 0)} m` : "—"],
      ],
      note: "Una cosa alta 1,8 m che copre 2 mil dista circa 900 m: distanza ≈ altezza × 1000 / mil.",
    }),
    note: ({ snap }) => ({ title: `Avvistamento a ${fmt(snap.heading, 0)}°`, text: snap.look && snap.look.kind !== "cielo" ? `${snap.look.kind} a circa ${fmt(snap.look.dist, 0)} m, con il binocolo a ${fmt(snap.zoom)}×.` : `Orizzonte, ${fmt(snap.zoom)}×.`, values: {} }),
  },
  {
    id: "monocolo",
    name: "Monocolo 20×–40×",
    group: "Osservare",
    blurb: "Più potente, un solo campo. Ferma il respiro accovacciandoti.",
    icon: ICONS.monocolo,
    actionLabel: "Annota avvistamento",
    read: ({ snap }) => ({
      big: ["Ingrandimento", `${fmt(snap.zoom)}×`],
      rows: [["Azimut", `${fmt(snap.heading, 0)}° ${compassName(snap.heading)}`], ["Bersaglio", snap.look && snap.look.kind !== "cielo" ? `${snap.look.kind} ~${fmt(snap.look.dist, 0)} m` : "—"]],
    }),
    note: ({ snap }) => ({ title: `Dettaglio a ${fmt(snap.heading, 0)}°`, text: snap.look && snap.look.kind !== "cielo" ? `${snap.look.kind} a ${fmt(snap.look.dist, 0)} m, ${fmt(snap.zoom)}×.` : `${fmt(snap.zoom)}×.`, values: {} }),
  },
  {
    id: "fotocamera",
    name: "Fotocamera",
    group: "Osservare",
    blurb: "Obiettivo 18–400 mm (rotella). Ogni scatto va nel registro con coordinate, azimut, ora e meteo.",
    icon: ICONS.fotocamera,
    actionLabel: "Scatta",
    read: ({ snap, state }) => ({
      big: ["Focale", `${fmt(state.focal, 0)} mm`],
      rows: [
        ["Campo", `${fmt((2 * Math.atan(18 / state.focal) * 180) / Math.PI, 0)}°`],
        ["Azimut", `${fmt(snap.heading, 0)}°`],
        ["Pellicola", ["colore", "falso colore vegetazione", "bianco e nero"][state.filter] ?? "colore"],
      ],
    }),
  },
  {
    id: "torcia",
    name: "Torcia",
    group: "Osservare",
    blurb: "Fascio stretto per la notte e per le arcate.",
    icon: ICONS.torcia,
    actionLabel: "Accendi / spegni",
    read: ({ engine }) => ({ rows: [["Stato", engine.torchOn ? "accesa" : "spenta"]] }),
  },
  {
    id: "drone",
    name: "Drone da rilievo",
    group: "Osservare",
    blurb: "Stacca la vista dal corpo. Spazio sale, C scende, N vista nadirale: confronta il mondo con la lastra.",
    icon: ICONS.drone,
    actionLabel: "Scatto aereo",
    read: ({ snap, engine }) => ({
      big: ["Quota relativa", `${fmt(snap.y - snap.ground, 0)} m`],
      rows: [
        ["Stato", snap.drone ? "in volo" : "a terra"],
        ["Vista", engine.droneNadir ? "nadirale" : "libera"],
      ],
    }),
  },
  {
    id: "carta",
    name: "Carta e lastra",
    group: "Orientarsi",
    blurb: "La foto della ripresa e la cartografia, da annotare a mano libera, con posizione, traccia e picchetti.",
    icon: ICONS.carta,
    read: () => ({ rows: [] }),
  },
  {
    id: "gnomone",
    name: "Gnomone",
    group: "Misurare",
    blurb: "Un'asta da 1 m a terra: dall'ombra ricavi altezza e azimut del sole, come Eratostene.",
    icon: ICONS.gnomone,
    actionLabel: "Pianta / leggi",
    read: ({ state, snap, engine }) => {
      if (!state.gnomon) return { rows: [["Asta", "non piantata"]], note: "F pianta l'asta a un passo davanti a te." };
      if (snap.sunAlt <= 0.01) return { rows: [["Ombra", "sole sotto l'orizzonte"]] };
      const covered = engine.weather.now.cloud > 0.85;
      const length = state.gnomon.h / Math.tan(snap.sunAlt);
      const az = (deg(snap.sunAz) + 180) % 360;
      return {
        big: ["Ombra", covered ? "indistinta" : `${fmt(length, 2)} m`],
        rows: covered
          ? [["Cielo", "troppo coperto"]]
          : [
              ["Direzione ombra", `${fmt(az, 0)}° ${compassName(az)}`],
              ["Altezza sole dedotta", `${fmt(deg(Math.atan(state.gnomon.h / length)))}°`],
              ["Azimut sole", `${fmt(deg(snap.sunAz), 0)}°`],
            ],
      };
    },
  },
  {
    id: "sestante",
    name: "Sestante",
    group: "Orientarsi",
    blurb: "Traguarda sole o luna: altezza osservata, e a mezzogiorno vero anche la tua latitudine.",
    icon: ICONS.sestante,
    actionLabel: "Prendi altezza",
    read: ({ snap, engine }) => {
      const sunDiff = Math.abs(snap.pitch - deg(snap.sunAlt));
      const onSun = sunDiff < 1.2 && Math.abs(((snap.heading - deg(snap.sunAz) + 540) % 360) - 180) < 2.5 && snap.sunAlt > 0;
      const moonOn = Math.abs(snap.pitch - deg(snap.moonAlt)) < 1.2 && Math.abs(((snap.heading - deg(snap.moonAz) + 540) % 360) - 180) < 2.5 && snap.moonAlt > 0;
      const solar = trueSolarHour(engine.clock.date, engine.data.projection.lon0);
      return {
        big: ["Altezza strumentale", `${fmt(snap.pitch, 2)}°`],
        rows: [
          ["In traguardo", onSun ? "sole" : moonOn ? "luna" : "nulla"],
          ["Sole", `${fmt(deg(snap.sunAlt))}° az ${fmt(deg(snap.sunAz), 0)}°`],
          ["Luna", `${fmt(deg(snap.moonAlt))}° az ${fmt(deg(snap.moonAz), 0)}°`],
          ["Dal mezzogiorno vero", `${fmt((solar - 12) * 60, 0)} min`],
        ],
        note: "Allinea il mirino al disco per una lettura valida.",
      };
    },
    note: ({ snap, engine }) => {
      const onSun = Math.abs(snap.pitch - deg(snap.sunAlt)) < 1.2 && Math.abs(((snap.heading - deg(snap.sunAz) + 540) % 360) - 180) < 2.5 && snap.sunAlt > 0;
      const moonOn = Math.abs(snap.pitch - deg(snap.moonAlt)) < 1.2 && Math.abs(((snap.heading - deg(snap.moonAz) + 540) % 360) - 180) < 2.5 && snap.moonAlt > 0;
      if (!onSun && !moonOn) return null;
      const body = onSun ? "sole" : "luna";
      const values: Record<string, string> = { Ho: `${fmt(snap.pitch, 2)}°` };
      let text = `Altezza del ${body} presa al sestante.`;
      if (onSun) {
        const pos = sunPosition(engine.clock.date, engine.data.projection.lat0, engine.data.projection.lon0);
        const solar = trueSolarHour(engine.clock.date, engine.data.projection.lon0);
        if (Math.abs(solar - 12) < 0.5) {
          const latitude = 90 - snap.pitch + deg(pos.declination);
          values["latitudine dedotta"] = `${fmt(latitude, 2)}°`;
          values["latitudine vera"] = `${fmt(snap.lat, 2)}°`;
          text = "Meridiana: latitudine ricavata da altezza e declinazione.";
        }
      }
      return { title: `Altezza ${body} ${fmt(snap.pitch, 2)}°`, text, values };
    },
  },
  {
    id: "geologo",
    name: "Bussola da geologo",
    group: "Misurare",
    blurb: "Pendenza, esposizione, direzione e immersione del versante sotto i tuoi piedi, dal modello di elevazione.",
    icon: ICONS.geologo,
    actionLabel: "Annota giacitura",
    read: ({ snap }) => {
      const strike = (snap.aspect + 270) % 360;
      return {
        big: ["Inclinazione", `${fmt(snap.slope)}°`],
        rows: [
          ["Immersione", `${fmt(snap.aspect, 0)}° ${compassName(snap.aspect)}`],
          ["Direzione", `${fmt(strike % 180, 0)}°`],
          ["Quota", `${fmt(snap.ground)} m`],
        ],
      };
    },
    note: ({ snap }) => ({ title: `Giacitura ${fmt(snap.aspect, 0)}/${fmt(snap.slope, 0)}`, text: `Versante esposto a ${compassName(snap.aspect)}.`, values: { immersione: `${fmt(snap.aspect, 0)}°`, inclinazione: `${fmt(snap.slope)}°`, quota: `${fmt(snap.ground)} m` } }),
  },
  {
    id: "campionatore",
    name: "Spettrocolorimetro",
    group: "Misurare",
    blurb: "Legge il pixel della lastra sotto il punto mirato: colore, indice di verde, classe assegnata dalla fotolettura.",
    icon: ICONS.campionatore,
    actionLabel: "Preleva",
    read: () => ({ rows: [], note: "Mira il suolo o un tetto e preleva: lettura e campione finiscono nel registro." }),
  },
  {
    id: "scala",
    name: "Scala telescopica",
    group: "Segnare e raggiungere",
    blurb: "A meno di 5 m da un edificio ti porta sul tetto. Di nuovo F per tornare a terra.",
    icon: ICONS.scala,
    actionLabel: "Sali / scendi",
    read: ({ snap }) => ({ rows: [["Posizione", snap.onRoof ? `sul tetto, ${fmt(snap.y - snap.ground)} m` : "a terra"], ["Edificio davanti", snap.look?.kind === "edificio" ? `${fmt(snap.look.dist)} m` : "—"]] }),
  },
  {
    id: "cronologia",
    name: "Cronologia degli scatti",
    group: "Osservare",
    blurb: "Torna a uno scatto più vecchio: suolo, tetti e alberi cambiano. Le differenze si annotano.",
    icon: ICONS.cronologia,
    read: () => ({ rows: [] }),
  },
];

export const HOTBAR: ToolId[] = ["mano", "bussola", "telemetro", "binocolo", "fotocamera", "rotella", "orologio", "carta", "cronologia"];

export const toolById = (id: ToolId) => TOOLS.find((tool) => tool.id === id)!;
