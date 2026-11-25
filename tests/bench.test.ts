import assert from "node:assert/strict";
import { test } from "node:test";
import { castShadows, fitSunAltitude, maskScore, resampleMask, type SurfaceGrid } from "../src/vision/bench.ts";
import { describeLean, leanFrom, leanFromSurface } from "../src/vision/lean.ts";
import { distanceToRings, insideRings, nearRectangle, presumePitched, roofSurfaceAt, surveyedRoof } from "../src/core/roofs.ts";
import { aboveLevels, storeyHeight } from "../src/core/storeys.ts";
import { analyzePlate, asphaltShadowLevel, fillRing, greenCast, leafOn, shadowHeights, type Footprint } from "../src/vision/analyze.ts";

/** Flat ground with one block: 10 m tall, 10 cells wide, on a 1 m grid. */
function block(size = 80, tall = 10): SurfaceGrid {
  const surface = new Float32Array(size * size);
  for (let j = 30; j < 40; j++) for (let i = 30; i < 40; i++) surface[j * size + i] = tall;
  return { surface, ground: new Float32Array(size * size), cols: size, rows: size, cellX: 1, cellZ: 1 };
}

test("un blocco getta l'ombra dalla parte opposta al sole, lunga quanto vuole la geometria", () => {
  const grid = block();
  // Sun in the south at 45°: the shadow runs north for about the block's height.
  const south = castShadows(grid, Math.PI, Math.PI / 4);
  const at = (i: number, j: number) => south[j * grid.cols + i];
  assert.equal(at(35, 25), 1, "5 m a nord");
  assert.equal(at(35, 17), 0, "13 m a nord");
  assert.equal(at(35, 45), 0, "a sud, verso il sole");
  assert.equal(at(20, 25), 0, "di fianco");
  // A lower sun in the west throws it east, and further.
  const west = castShadows(grid, (3 * Math.PI) / 2, Math.atan(0.5));
  assert.equal(west[35 * grid.cols + 55], 1, "15 m a est");
  assert.equal(west[35 * grid.cols + 62], 0, "22 m a est");
  assert.equal(west[35 * grid.cols + 25], 0, "a ovest");
});

test("il punteggio di una maschera conta solo le celle valide", () => {
  const found = [1, 1, 0, 0, 1, 1];
  const expected = [1, 0, 1, 0, 1, 0];
  const score = maskScore(found, expected, [1, 1, 1, 1, 0, 0]);
  assert.equal(score.cells, 4);
  assert.equal(score.precision, 0.5);
  assert.equal(score.recall, 0.5);
  assert.ok(Math.abs(score.iou - 1 / 3) < 1e-9);
  assert.equal(maskScore([0, 0], [0, 0], [1, 1]).iou, 0);
});

test("una maschera si rilegge su una griglia più rada", () => {
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 2; y++) for (let x = 2; x < 4; x++) rgba[(y * 4 + x) * 4 + 3] = 255;
  assert.deepEqual([...resampleMask(rgba, 4, 4, 2, 2, 3, 4, 127)], [0, 1, 0, 0]);
});

test("l'altezza del sole si ritrova dalle ombre di forme note", () => {
  const grid = block(120, 14);
  const truth = 0.62;
  const found = castShadows(grid, 2.6, truth);
  const open = Uint8Array.from(grid.surface, (v) => (v > 0 ? 0 : 1));
  const fit = fitSunAltitude(grid, 2.6, found, open);
  assert.ok(Math.abs(fit.altitude - truth) < 0.04, `trovata ${fit.altitude}`);
  assert.ok(fit.iou > 0.9);
});

test("un'ombra più larga dei suoi dintorni viene riconosciuta sotto un edificio noto", () => {
  // A 60 m tall slab throws a shadow far wider than the 28 m neighbourhood the first mask compares against.
  const size = 400;
  const mpp = 0.5;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const sunAz = Math.PI;
  const alt = Math.atan(60 / 70);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = (y * size + x) * 4;
      const roof = x >= 60 && x < 340 && y >= 300 && y < 340;
      const shaded = x >= 60 && x < 340 && y >= 160 && y < 300;
      const tone = roof ? 200 : shaded ? 42 : 150 + ((x * 7 + y * 13) % 9);
      rgba[k] = tone;
      rgba[k + 1] = tone;
      rgba[k + 2] = shaded ? tone + 10 : tone;
      rgba[k + 3] = 255;
    }
  }
  const result = analyzePlate({
    rgba, width: size, height: size, mpp, lat: 45, lon: 9, captureDate: null, manualSun: { azimuth: sunAz, altitude: alt },
    footprints: [{ id: "a", rings: [[60, 300, 340, 300, 340, 340, 60, 340]], tagHeight: 60 }],
    roads: [], water: [], osmTrees: [], register: false,
  });
  let inside = 0;
  let total = 0;
  for (let y = 175; y < 285; y += 3) for (let x = 80; x < 320; x += 3) {
    total++;
    if (result.gainMap[(y * size + x) * 4 + 3]! > 200) inside++;
  }
  assert.ok(inside / total > 0.95, `riconosciuto ${(inside / total * 100).toFixed(0)}%`);
  // Sunlit ground far from the shadow stays untouched.
  assert.equal(result.gainMap[(60 * size + 200) * 4 + 3], 0);
});

/** A 20 m square house on a 1 m raster, with its shadow painted northwards for `length` metres. */
function houseWithShadow(length: number) {
  const w = 120;
  const grid = { w, h: w };
  const shadow = new Uint8Array(w * w);
  const built = new Uint8Array(w * w);
  const house: Footprint = { id: "casa", rings: [[50, 80, 70, 80, 70, 100, 50, 100]] };
  fillRing(built, grid, house.rings);
  for (let y = 80 - length; y < 80; y++) for (let x = 50; x < 70; x++) shadow[y * w + x] = 1;
  return { w, grid, shadow, built, house };
}

test("una lunghezza d'ombra non si ferma a un'auto al sole né al tetto inclinato sulla strada", () => {
  const { w, grid, shadow, built, house } = houseWithShadow(30);
  // The plate's lean lays three metres of lit roof over the foot of the shadow, and a pale van stands in the middle of it.
  for (let y = 77; y < 80; y++) for (let x = 50; x < 70; x++) shadow[y * w + x] = 0;
  for (let y = 62; y < 64; y++) for (let x = 50; x < 70; x++) shadow[y * w + x] = 0;
  const run = shadowHeights(shadow, built, grid, [house], 0, 1).casa!;
  assert.ok(Math.abs(run.length - 30) <= 1, `lunghezza ${run.length}`);
  assert.equal(run.floor, 0);
});

test("un'ombra che arriva al palazzo di fronte dà un minimo, non una misura", () => {
  const { grid, shadow, built, house } = houseWithShadow(14);
  const opposite: Footprint = { id: "fronte", rings: [[40, 46, 80, 46, 80, 66, 40, 66]] };
  fillRing(built, grid, opposite.rings);
  const run = shadowHeights(shadow, built, grid, [house, opposite], 0, 1).casa!;
  assert.equal(run.length, 0);
  assert.ok(Math.abs(run.floor - 14) <= 1, `minimo ${run.floor}`);
});

test("l'acqua scura non allunga un'ombra", () => {
  const { w, grid, shadow, built, house } = houseWithShadow(40);
  const water = new Uint8Array(w * w);
  for (let y = 0; y < 60; y++) for (let x = 0; x < w; x++) water[y * w + x] = 1;
  assert.equal(shadowHeights(shadow, built, grid, [house], 0, 1, water).casa, undefined);
});

test("la dominante verde di una ripresa si misura su strade e tetti e non aggiunge mai verde", () => {
  const n = 40_000;
  const lum = new Float32Array(n).fill(0.4);
  const exg = new Float32Array(n).fill(0.14);
  const neutral = new Uint8Array(n).fill(1);
  const cast = greenCast(lum, exg, neutral);
  assert.ok(Math.abs(cast[3]! - 0.118) < 0.002, `dominante ${cast[3]}`);
  assert.ok(greenCast(lum, new Float32Array(n).fill(0.01), neutral).every((v) => v === 0));
  assert.ok(greenCast(lum, exg, undefined).every((v) => v === 0));
});

test("l'asfalto dà la sua soglia d'ombra solo se mostra due popolazioni", () => {
  const n = 20_000;
  const roads = new Uint8Array(n).fill(1);
  const two = new Float32Array(n);
  for (let k = 0; k < n; k++) two[k] = (k % 2 ? 0.08 : 0.24) + ((k * 7919) % 100) / 2500;
  const read = asphaltShadowLevel(two, roads);
  assert.ok(read.level != null && read.level > 0.12 && read.level < 0.24, `soglia ${read.level}`);
  const one = new Float32Array(n);
  for (let k = 0; k < n; k++) one[k] = 0.05 + ((k * 7919) % 1000) / 8000;
  assert.deepEqual(asphaltShadowLevel(one, roads), { level: null, enough: true });
  assert.equal(asphaltShadowLevel(two, undefined).enough, false);
});

test("un sole trovato al limite della ricerca è dichiarato tale", () => {
  const grid = block();
  const open = new Uint8Array(grid.cols * grid.rows).fill(1);
  const inside = fitSunAltitude(grid, Math.PI, castShadows(grid, Math.PI, 0.6), open);
  assert.equal(inside.atEdge, false);
  // A mask that calls everything shadow is best matched by the lowest sun there is.
  assert.equal(fitSunAltitude(grid, Math.PI, new Uint8Array(open), open).atEdge, true);
});

test("le chiome sono in foglia da maggio a settembre a nord, da novembre a marzo a sud, e senza data non si sa", () => {
  assert.equal(leafOn("2025-08-06", 51.5), true);
  assert.equal(leafOn("2025-04-25", 53.5), false);
  assert.equal(leafOn("2025-01-13", -33.9), true);
  assert.equal(leafOn("2025-07-01", -33.9), false);
  assert.equal(leafOn("2025-07-01", 10), false);
  assert.equal(leafOn(null, 45), false);
});

test("la rete aggiunge chiome e ne toglie sull'asfalto solo se la ripresa è in foglia", () => {
  const w = 60;
  const h = 60;
  const rgba = new Uint8ClampedArray(w * h * 4);
  // Grey ground with a green, rough patch the rules call canopy, and a tree only the network sees.
  for (let k = 0; k < w * h; k++) {
    const x = k % w;
    const y = Math.floor(k / w);
    const crown = x >= 10 && x < 25 && y >= 10 && y < 25;
    const noise = ((x * 7 + y * 13) % 5) * 9;
    rgba.set(crown ? [40 + noise, 110 + noise, 40] : [150, 150, 150], k * 4);
    rgba[k * 4 + 3] = 255;
  }
  const classes = new Uint8Array(w * h).fill(2);
  for (let y = 35; y < 50; y++) for (let x = 35; x < 50; x++) classes[y * w + x] = 6;
  const base = { rgba, width: w, height: h, mpp: 1, lat: 45, lon: 7, footprints: [], roads: [], water: [], osmTrees: [], register: false };
  const canopy = (date: string) => {
    const r = analyzePlate({ ...base, rgba: new Uint8ClampedArray(rgba), captureDate: date, landcover: { classes, provider: "test", ms: 0 } });
    return { patch: r.classMap[(17 * w + 17) * 4]!, network: r.classMap[(42 * w + 42) * 4]! };
  };
  assert.deepEqual(canopy("2025-01-10"), { patch: 255, network: 255 });
  assert.deepEqual(canopy("2025-07-10"), { patch: 0, network: 255 });
});

test("l'altezza del piano si tara sugli edifici con altezza e piani, e con pochi resta vicina a 3,2 m", () => {
  const rows = (n: number, storey: number) => Array.from({ length: n }, (_, i) => ({ height: (3 + (i % 3)) * storey + 3, levels: 3 + (i % 3), roof: 3 }));
  assert.deepEqual(storeyHeight(rows(4, 4)), { metres: 3.2, samples: 4 });
  const ten = storeyHeight(rows(10, 4));
  assert.ok(Math.abs(ten.metres - 3.6) < 1e-9, `${ten.metres}`);
  assert.ok(storeyHeight(rows(200, 4)).metres > 3.95);
  // A tower mapped with its floors wrong does not count.
  assert.equal(storeyHeight([...rows(10, 4), { height: 120, levels: 3, roof: 3 }]).samples, 10);
});

test("sopra i piani contati: 3 m fino a cinque piani, meno sopra, 1 m sui tetti piani", () => {
  assert.equal(aboveLevels(4), 3);
  assert.equal(aboveLevels(6), 2);
  assert.equal(aboveLevels(9), 1);
  assert.equal(aboveLevels(4, "flat"), 1);
  assert.equal(aboveLevels(4, "gabled", true), 2);
});

test("l'inclinazione di una ripresa si ritrova proiettando il rilievo sui bordi della foto", () => {
  const n = 200;
  const heights = new Float32Array(n * n);
  // Blocks of different heights, as a survey would see them.
  const blocks = [[20, 20, 30, 18], [70, 30, 25, 30], [130, 40, 30, 12], [40, 110, 35, 24], [110, 120, 30, 40], [160, 150, 25, 16]] as const;
  for (const [x0, y0, size, h] of blocks) for (let j = y0; j < y0 + size; j++) for (let i = x0; i < x0 + size; i++) heights[j * n + i] = h;
  // The plate: ground grey, roofs bright, each roof drawn where a satellite leaning east by 0.2 and south by 0.1 sees it.
  const lum = new Float32Array(n * n).fill(0.3);
  for (const [x0, y0, size, h] of blocks) {
    const dx = Math.round(0.2 * h);
    const dy = Math.round(0.1 * h);
    for (let j = y0 + dy; j < y0 + dy + size; j++) for (let i = x0 + dx; i < x0 + dx + size; i++) if (i < n && j < n) lum[j * n + i] = 0.8;
  }
  const lean = leanFromSurface(lum, { heights, cols: n, rows: n, cell: 1 })!;
  assert.ok(Math.abs(lean.x - 0.2) <= 0.02 && Math.abs(lean.z - 0.1) <= 0.02, `${lean.x} ${lean.z}`);
  assert.ok(lean.gain > 1.2);
  const said = describeLean(leanFrom(10, 97));
  assert.ok(Math.abs(said.tilt - 10) < 1e-9 && Math.abs(said.toward - 97) < 1e-9);
});

test("un tetto che sale dai bordi resta dentro la pianta e arriva al colmo nel punto più interno", () => {
  // An L: two arms of 10 m.
  const L = [[0, 0, 30, 0, 30, 10, 10, 10, 10, 30, 0, 30]];
  assert.equal(roofSurfaceAt(0, 15, L, 10, 3, 5), 10);
  assert.equal(roofSurfaceAt(5, 20, L, 10, 3, 5), 13);
  assert.ok(Math.abs(roofSurfaceAt(5, 17.5, L, 10, 3, 5) - 13) < 1e-9);
  assert.ok(Math.abs(distanceToRings(20, 5, L) - 5) < 1e-9);
  assert.equal(nearRectangle([0, 0, 20, 0, 20, 10, 0, 10], 200), true);
  assert.equal(nearRectangle(L[0]!, 500), false);
  assert.equal(presumePitched(12, 300, false, false), true);
  assert.equal(presumePitched(6, 300, false, false), false);
  assert.equal(presumePitched(12, 3000, false, false), false);
  assert.equal(presumePitched(12, 300, true, false), false);
});

test("il tetto dal rilievo sta dentro la pianta, ne copre l'area e prende le quote del rilievo", () => {
  // An L with a ridge running along x at z = 5 in the first arm.
  const L = [[0, 0, 30, 0, 30, 10, 10, 10, 10, 30, 0, 30]];
  const cols = 32;
  const heights = new Float32Array(cols * cols);
  for (let j = 0; j < cols; j++) for (let i = 0; i < cols; i++) heights[j * cols + i] = 12 + 3 * Math.max(0, 1 - Math.abs(j - 5) / 5);
  const grid = { x0: 0, z0: 0, cell: 1, cols, rows: cols, heights };
  const roof = surveyedRoof(L, grid, 12, 15);
  let area = 0;
  for (const [a, b, c] of roof.tris) {
    area += Math.abs((roof.xs[b]! - roof.xs[a]!) * (roof.zs[c]! - roof.zs[a]!) - (roof.xs[c]! - roof.xs[a]!) * (roof.zs[b]! - roof.zs[a]!)) / 2;
    assert.ok(insideRings((roof.xs[a]! + roof.xs[b]! + roof.xs[c]!) / 3, (roof.zs[a]! + roof.zs[b]! + roof.zs[c]!) / 3, L));
  }
  assert.ok(Math.abs(area - 500) < 15, `area ${area}`);
  const ridge = roof.ys.filter((_, k) => Math.abs(roof.zs[k]! - 5) < 0.8 && roof.xs[k]! > 12 && roof.xs[k]! < 28);
  assert.ok(ridge.length > 3 && ridge.every((y) => y > 14), JSON.stringify(ridge));
  assert.ok(roof.ys.every((y) => y >= 12 && y <= 15));
});
