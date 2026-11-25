import assert from "node:assert/strict";
import { test } from "node:test";
import { castShadows, fitSunAltitude, maskScore, resampleMask, type SurfaceGrid } from "../src/vision/bench.ts";
import { analyzePlate, asphaltShadowLevel, fillRing, greenCast, shadowHeights, type Footprint } from "../src/vision/analyze.ts";

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
