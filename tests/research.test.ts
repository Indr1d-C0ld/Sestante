import assert from "node:assert/strict";
import { test } from "node:test";
import { alignments, astroEvents, horizonAltitude, obliquity, planAxis, riseAzimuth } from "../src/core/archaeo.ts";
import { adjustTraverse, fitAffine, floodStats, measureLeg, sectionAlong, SURVEY_CLASSES, viewshed } from "../src/core/fieldwork.ts";
import { bestHeight, predictShadow, scoreShadow, verdict, type ShadowPlate } from "../src/vision/shadowTest.ts";
import { absentOn, buildingPresence, combineHeights, type StratumRead } from "../src/vision/timeline.ts";

const sun = { sunAzimuth: 2.8, altitude: 0.7, confidence: 0.9, method: "ombre+data" as const };
const read = (date: string, id: string, h: number | null, confidence: number, evidence?: { edge: number; veg: number }, resolution: number | null = 0.5): StratumRead => ({
  key: date,
  date,
  resolution,
  sun,
  heights: { [id]: { h, confidence, rays: 20 } },
  evidence: evidence ? { [id]: evidence } : {},
});

test("più date danno un'altezza robusta anche con una lettura sbagliata", () => {
  const reads = [read("2024-06-01", "a", 20.2, 0.8), read("2022-07-01", "a", 19.6, 0.7), read("2020-05-01", "a", 20.5, 0.6), read("2018-08-01", "a", 21, 0.5), read("2016-06-01", "a", 58, 0.5)];
  const row = combineHeights(reads)["a"]!;
  assert.ok(Math.abs(row.h - 20.3) < 0.8, `h ${row.h}`);
  assert.equal(row.n, 4);
  assert.ok(row.high - row.low < 2.5);
  assert.equal(row.samples.length, 5);
});

test("una lastra senza sole credibile non vota", () => {
  const bad: StratumRead = { ...read("2024-01-01", "a", 90, 0.9), sun: { ...sun, method: "stima" } };
  assert.equal(combineHeights([bad])["a"], undefined);
});

test("la comparsa di un edificio si data fra due riprese", () => {
  const seen = { edge: 0.14, veg: 0.05 };
  const gone = { edge: 0.02, veg: 0.7 };
  const presence = buildingPresence([read("2024-06-01", "a", 10, 0.5, seen), read("2020-06-01", "a", 10, 0.5, seen), read("2017-06-01", "a", 10, 0.5, seen), read("2014-06-01", "a", 10, 0.5, gone), read("2011-06-01", "a", 10, 0.5, gone)])["a"]!;
  assert.equal(presence.firstSeen, "2017-06-01");
  assert.equal(presence.lastAbsent, "2014-06-01");
  assert.ok(absentOn(presence, "2011-06-01"));
  assert.ok(absentOn(presence, "2014-06-01"));
  assert.ok(!absentOn(presence, "2017-06-01"));
});

test("un fotogramma scadente non inventa una data di costruzione", () => {
  const seen = { edge: 0.14, veg: 0.05 };
  const presence = buildingPresence([read("2024-06-01", "a", 10, 0.5, seen), read("2020-06-01", "a", 10, 0.5, seen), read("2018-06-01", "a", 10, 0.5, { edge: 0.02, veg: 0.6 }), read("2014-06-01", "a", 10, 0.5, seen)])["a"]!;
  assert.equal(presence.lastAbsent, null);
});

test("una ripresa grossolana non basta per dire che un edificio manca", () => {
  const seen = { edge: 0.14, veg: 0.05 };
  const presence = buildingPresence([read("2024-06-01", "a", 10, 0.5, seen), read("2020-06-01", "a", 10, 0.5, seen), read("2001-01-01", "a", 10, 0.5, { edge: 0.01, veg: 0.9 }, 15), read("2000-01-01", "a", 10, 0.5, { edge: 0.01, veg: 0.9 }, 15)])["a"]!;
  assert.equal(presence.lastAbsent, null);
});

function scene(heightM: number, azimuth = 2.9, altitude = 0.75) {
  const w = 300;
  const h = 300;
  const mpp = 0.5;
  const rings = [[120, 120, 170, 120, 170, 170, 120, 170]];
  const plate: ShadowPlate = { date: "2024-06-01", width: w, height: h, mpp, sunAzimuth: azimuth, altitude, confidence: 0.9, alpha: new Uint8Array(w * h) };
  plate.alpha = predictShadow(rings, heightM, plate).mask.map((v) => v * 255);
  return { rings, plate };
}

test("il banco delle ombre ritrova l'altezza vera", () => {
  const { rings, plate } = scene(18);
  const best = bestHeight(rings, plate);
  assert.ok(Math.abs(best.h - 18) <= 1, `h ${best.h}`);
  assert.ok(best.f1 > 0.9);
  const right = scoreShadow(rings, 18, plate);
  assert.ok(right.covered > 0.95);
  assert.ok(verdict([right]).label.startsWith("compatibile"));
});

test("un volume troppo alto o dal sole sbagliato perde compatibilità", () => {
  const { rings, plate } = scene(10);
  assert.ok(scoreShadow(rings, 40, plate).covered < 0.5);
  const elsewhere = { ...plate, sunAzimuth: plate.sunAzimuth + Math.PI };
  assert.ok(verdict([scoreShadow(rings, 10, elsewhere)]).meanLift < 0.2);
});

test("l'obliquità è quella nota oggi e nell'antichità", () => {
  assert.ok(Math.abs(obliquity(2000) - 23.4393) < 0.001);
  // Tolomeo e Ipparco misuravano circa 23°41′–23°51′: intorno al −150 il valore teorico è ≈ 23,72°.
  assert.ok(Math.abs(obliquity(-150) - 23.72) < 0.05);
});

test("gli azimut di levata tornano con il caso sferico", () => {
  assert.ok(Math.abs(riseAzimuth(0, 23.44, 0)! - 66.56) < 0.01);
  assert.ok(Math.abs(riseAzimuth(45, 0, 0)! - 90) < 0.01);
  // Roma, solstizio d'estate: circa 58° a nord-est, con rifrazione.
  const summer = astroEvents(41.89, 2026).find((row) => row.id === "sol-estate")!;
  assert.ok(Math.abs(summer.rise - 58) < 2, `az ${summer.rise}`);
  assert.ok(Math.abs(summer.rise + summer.set - 360) < 1e-9);
  // Oltre il circolo polare il sole di mezza estate non tramonta: l'evento sparisce.
  assert.equal(astroEvents(75, 2026).find((row) => row.id === "sol-estate"), undefined);
});

test("un'asse punta a entrambi i capi e la più vicina vince", () => {
  const events = astroEvents(41.89, 2026);
  const summer = events.find((row) => row.id === "sol-estate")!;
  const first = alignments((summer.rise + 180) % 360, events)[0]!;
  assert.equal(first.event.id, "sol-estate");
  assert.ok(first.delta < 0.01);
});

test("l'asse di una pianta è leggibile e la colonna quadrata no", () => {
  const eastWest = planAxis([-50, -5, 50, -5, 50, 5, -50, 5]);
  assert.ok(Math.abs(eastWest.bearing - 90) < 1e-6);
  assert.ok(eastWest.elongation > 0.8);
  const northSouth = planAxis([-5, -50, 5, -50, 5, 50, -5, 50]);
  assert.ok(northSouth.bearing < 1e-6 || Math.abs(northSouth.bearing - 180) < 1e-6);
  assert.ok(planAxis([-5, -5, 5, -5, 5, 5, -5, 5]).elongation < 0.05);
});

test("l'orizzonte si alza dietro un monte", () => {
  const ground = (x: number, z: number) => (z < -2000 ? 1000 : 0);
  assert.ok(horizonAltitude(0, 0, 0, 2, ground) > 15);
  assert.equal(horizonAltitude(180, 0, 0, 2, ground), 0);
});

test("il georiferimento ritrova una trasformazione nota e segnala l'errore", () => {
  const truth = (u: number, v: number) => ({ x: 2 * u + 0.3 * v - 40, z: -0.3 * u + 2 * v + 12 });
  const pts = [[0, 0], [100, 0], [0, 100], [100, 100], [50, 25]].map(([u, v]) => ({ u: u!, v: v!, ...truth(u!, v!) }));
  const fit = fitAffine(pts)!;
  assert.ok(Math.abs(fit.a - 2) < 1e-6 && Math.abs(fit.f - 12) < 1e-6);
  assert.ok(fit.rms < 1e-6);
  const wrong = fitAffine([...pts.slice(0, 4), { ...pts[4]!, x: pts[4]!.x + 10 }])!;
  assert.ok(wrong.rms > 1);
  assert.equal(fitAffine(pts.slice(0, 2)), null);
});

test("la poligonale chiusa senza errori chiude esatta", () => {
  const legs = [{ azimuth: 90, distance: 100, dz: 2 }, { azimuth: 180, distance: 100, dz: 0 }, { azimuth: 270, distance: 100, dz: -2 }, { azimuth: 0, distance: 100, dz: 0 }];
  const result = adjustTraverse({ x: 0, y: 0, z: 0 }, legs, true);
  assert.ok(result.misclosure.linear < 1e-9);
  assert.equal(result.length, 400);
});

test("la compensazione distribuisce l'errore e riporta l'ultimo vertice al primo", () => {
  const legs = [{ azimuth: 90, distance: 100, dz: 0 }, { azimuth: 180, distance: 100, dz: 0 }, { azimuth: 270, distance: 100, dz: 0 }, { azimuth: 1, distance: 101, dz: 0.3 }];
  const result = adjustTraverse({ x: 5, y: 7, z: 9 }, legs, true);
  assert.ok(result.misclosure.linear > 0.5);
  const last = result.adjusted[result.adjusted.length - 1]!;
  assert.ok(Math.hypot(last.x - 5, last.z - 9, last.y - 7) < 1e-9);
  assert.ok(result.misclosure.ratio > 100 && Number.isFinite(result.misclosure.ratio));
});

test("la bussola sbaglia molto più della stazione totale", () => {
  let seed = 7;
  const gauss = () => {
    seed = (seed * 16807) % 2147483647;
    const a = seed / 2147483647;
    seed = (seed * 16807) % 2147483647;
    const b = seed / 2147483647;
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  };
  const corners = [{ x: 0, y: 0, z: 0 }, { x: 120, y: 3, z: 0 }, { x: 120, y: 5, z: 90 }, { x: 0, y: 1, z: 90 }, { x: 0, y: 0, z: 0 }];
  const run = (index: number) => {
    let total = 0;
    for (let trial = 0; trial < 40; trial++) {
      const legs = corners.slice(1).map((to, i) => measureLeg(corners[i]!, to, SURVEY_CLASSES[index]!, gauss));
      total += adjustTraverse(corners[0]!, legs, true).misclosure.linear;
    }
    return total / 40;
  };
  assert.ok(run(0) < 0.03, `stazione ${run(0)}`);
  assert.ok(run(1) > 0.5, `bussola ${run(1)}`);
});

test("la sezione misura dislivelli e vede i muri sopra il suolo", () => {
  const ground = (x: number) => x * 0.1;
  const wall = (x: number) => (x > 40 && x < 60 ? x * 0.1 + 12 : -Infinity);
  const section = sectionAlong([{ x: 0, z: 0 }, { x: 100, z: 0 }], ground, wall, 101);
  assert.ok(Math.abs(section.length - 100) < 1e-9);
  assert.ok(Math.abs(section.gain - 10) < 0.5);
  assert.ok(Math.abs(section.max - 17.9) < 0.3, `max ${section.max}`);
  assert.equal(section.loss, 0);
});

test("la visibilità si ferma dietro un muro e continua altrove", () => {
  const surface = (x: number, z: number) => (z < -50 && z > -60 && Math.abs(x) < 400 ? 30 : 0);
  const v = viewshed(0, 0, 1.7, 300, surface, 201);
  const at = (x: number, z: number) => v.visible[Math.round(100 + z / v.cell) * v.size + Math.round(100 + x / v.cell)];
  assert.equal(at(0, -200), 0, "dietro il muro");
  assert.equal(at(0, 200), 1, "a sud, campo aperto");
  assert.equal(at(0, -40), 1, "davanti al muro");
  assert.ok(v.share > 0.3 && v.share < 0.95);
});

test("il livello dell'acqua allaga ciò che sta sotto", () => {
  const heights = new Float32Array([0, 1, 2, 3]);
  const stats = floodStats(heights, 10, 1.5);
  assert.equal(stats.area, 200);
  assert.equal(stats.deepest, 1.5);
  assert.equal(stats.volume, (1.5 + 0.5) * 100);
});
