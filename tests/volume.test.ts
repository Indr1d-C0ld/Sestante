import assert from "node:assert/strict";
import { test } from "node:test";
import { changeVolume, complexRange, crownVolume, formatRange, formatVolume, massVolume, planMeasures, roofFactor, solidRange, solidVolume, sumRange } from "../src/vision/volume.ts";

const square = (side: number, x = 0, z = 0) => [x, z, x + side, z, x + side, z + side, x, z + side];
const close = (a: number, b: number, tolerance: number, label = "") => assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} contro ${b}`);

test("un cortile si toglie dalla pianta e allunga il perimetro", () => {
  const row = planMeasures([square(100), square(20, 40, 40)]);
  assert.equal(row.area, 100 * 100 - 20 * 20);
  assert.equal(row.perimeter, 400 + 80);
});

test("un parallelepipedo vale base per altezza", () => {
  assert.equal(solidVolume({ rings: [square(10)], height: 20 }).volume, 2000);
});

test("una piramide vale un terzo: Cheope oggi, con i valori geometrici", () => {
  const cheope = solidVolume({ rings: [square(230)], height: 138.5, roofHeight: 138.5, roofShape: "pyramidal" });
  close(cheope.volume, (230 * 230 * 138.5) / 3, 1e-6);
  assert.equal(roofFactor("pyramidal"), 1 / 3);
});

test("un tetto a falde aggiunge metà del suo cassone, e un edificio sospeso parte da dove parte", () => {
  assert.equal(solidVolume({ rings: [square(10)], height: 12, roofHeight: 4, roofShape: "gabled" }).volume, 100 * (8 + 2));
  assert.equal(solidVolume({ rings: [square(10)], height: 12, minHeight: 2 }).volume, 100 * 10);
  // A flat roof with a stated rise has no slope to discount.
  assert.equal(solidVolume({ rings: [square(10)], height: 12, roofHeight: 4, roofShape: "flat" }).volume, 1200);
});

test("l'intervallo cresce con l'errore in altezza ed è simmetrico attorno al valore", () => {
  const sure = solidRange({ rings: [square(20)], height: 20 }, 1);
  const doubtful = solidRange({ rings: [square(20)], height: 20 }, 5);
  assert.equal(sure.value, 8000);
  assert.ok(doubtful.high - doubtful.low > (sure.high - sure.low) * 1.5);
  close(doubtful.high - doubtful.value, doubtful.value - doubtful.low, 1e-6);
  // ±5 m typical on 20 m is ±25%, doubled for the interval, with the plan's own term on top.
  assert.ok(doubtful.high / doubtful.value > 1.5 && doubtful.high / doubtful.value < 1.6, `${doubtful.high / doubtful.value}`);
});

test("l'intervallo non scende sotto zero", () => {
  assert.equal(solidRange({ rings: [square(10)], height: 3 }, 8).low, 0);
});

test("parti sovrapposte non si contano due volte", () => {
  const low = { rings: [square(10)], height: 10, heightError: 1 };
  const tall = { rings: [square(10, 5, 0)], height: 20, heightError: 1 };
  const row = complexRange([low, tall]);
  // Five metres by ten at 10 m, ten by ten at 20 m: the overlap belongs to the taller part only.
  close(row.value, 50 * 10 + 100 * 20, 40, "volume");
  close(row.area, 150, 3, "area");
  assert.ok(row.value < 100 * 10 + 100 * 20 - 200);
});

test("il cortile resta vuoto anche in un complesso", () => {
  const row = complexRange([{ rings: [square(100), square(40, 30, 30)], height: 10, heightError: 1 }]);
  close(row.value, (10000 - 1600) * 10, 900, "volume");
});

test("i muri fra le parti di un complesso non allargano l'intervallo", () => {
  const whole = complexRange([{ rings: [square(100)], height: 20, heightError: 2 }]);
  const parts = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) parts.push({ rings: [square(20, i * 20, j * 20)], height: 20, heightError: 2 });
  const split = complexRange(parts);
  close(split.value, whole.value, whole.value * 0.02, "volume");
  close(split.high - split.value, whole.high - whole.value, (whole.high - whole.value) * 0.05, "intervallo");
  // The single part gives the same answer as the plain solid.
  const solid = solidRange({ rings: [square(100)], height: 20 }, 2);
  close(whole.high - whole.value, solid.high - solid.value, (solid.high - solid.value) * 0.05, "come il solido");
});

test("in un totale gli errori propri si compensano, lo scarto comune no", () => {
  const items = Array.from({ length: 100 }, () => ({ value: 1000, low: 500, high: 1500, area: 100 }));
  const free = sumRange(items, 0);
  assert.equal(free.value, 100000);
  close(free.high - free.value, 500 * 10, 1e-6);
  const biased = sumRange(items, 1);
  close(biased.high - biased.value, 500 * 10 + 1 * 100 * 100 * 2, 1e-6);
  assert.equal(sumRange(items, 10).low, 0);
});

/** A grid in metres with a function for the land and a circle for the outline. */
function field(radius: number, land: (x: number, z: number) => number, size = 121, cell = 10) {
  const heights = new Float32Array(size * size);
  const inside = new Uint8Array(size * size);
  const middle = ((size - 1) * cell) / 2;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = i * cell - middle;
      const z = j * cell - middle;
      heights[j * size + i] = land(x, z);
      inside[j * size + i] = Math.hypot(x, z) < radius ? 1 : 0;
    }
  }
  return { heights, inside, cols: size, rows: size, cellX: cell, cellZ: cell };
}

test("un cono su terreno piano torna al suo volume", () => {
  const radius = 300;
  const height = 40;
  const grid = field(radius, (x, z) => 100 + Math.max(0, height * (1 - Math.hypot(x, z) / radius)));
  const row = massVolume(grid)!;
  close(row.fill.value, (Math.PI * radius * radius * height) / 3, ((Math.PI * radius * radius * height) / 3) * 0.03, "cono");
  close(row.cut.value, 0, 10);
  close(row.peak, height, 1.5);
  assert.ok(row.fill.low < row.fill.value && row.fill.value < row.fill.high);
});

test("su un versante la base segue la pendenza e il pendio non diventa volume", () => {
  const radius = 300;
  const height = 40;
  const slope = (x: number, z: number) => 100 + x * 0.1 + z * 0.05;
  const onSlope = massVolume(field(radius, (x, z) => slope(x, z) + Math.max(0, height * (1 - Math.hypot(x, z) / radius))))!;
  close(onSlope.fill.value, (Math.PI * radius * radius * height) / 3, ((Math.PI * radius * radius * height) / 3) * 0.04, "cono su versante");
  const bare = massVolume(field(radius, slope))!;
  // Under 2 cm over 28 hectares: only the outline's staircase on the grid.
  assert.ok(bare.fill.value / bare.area < 0.02 && bare.cut.value / bare.area < 0.02, `versante nudo: ${bare.fill.value} ${bare.cut.value}`);
});

test("una cava conta come scavo", () => {
  const radius = 200;
  const row = massVolume(field(radius, (x, z) => 50 - Math.max(0, 25 * (1 - (Math.hypot(x, z) / radius) ** 2))))!;
  close(row.cut.value, (Math.PI * radius * radius * 25) / 2, ((Math.PI * radius * radius * 25) / 2) * 0.03, "scavo");
  assert.ok(row.net < 0);
  close(row.pit, -25, 1);
});

test("un bordo irregolare allarga l'intervallo", () => {
  const smooth = massVolume(field(300, () => 100))!;
  const rough = massVolume(field(300, (x, z) => 100 + 6 * Math.sin(x / 30) * Math.cos(z / 40)))!;
  assert.ok(rough.rimRoughness > smooth.rimRoughness + 1);
  assert.ok(rough.fill.high - rough.fill.low > (smooth.fill.high - smooth.fill.low) * 1.3);
});

test("senza quote sul bordo non si inventa nulla", () => {
  const grid = field(300, () => 100);
  grid.heights.fill(Number.NaN);
  assert.equal(massVolume(grid), null);
});

test("il confronto fra epoche toglie lo scarto fra sensori misurato fuori dal contorno", () => {
  const grid = field(200, () => 100);
  const newer = grid.heights.map((h, k) => h + 3 + (grid.inside[k] ? 10 : 0));
  const row = changeVolume(grid.heights, new Float32Array(newer), grid)!;
  assert.equal(row.bias, 3);
  const inner = grid.inside.reduce((sum, v) => sum + v, 0) * 100;
  close(row.net, inner * 10, 1, "guadagno");
  assert.equal(row.significant, true);
  const same = changeVolume(grid.heights, new Float32Array(grid.heights.map((h) => h + 3)), grid)!;
  assert.equal(same.net, 0);
});

test("il rumore fuori dal contorno decide se un cambiamento è reale", () => {
  const grid = field(200, () => 100);
  let seed = 5;
  const noisy = grid.heights.map((h) => {
    seed = (seed * 16807) % 2147483647;
    return h + (seed / 2147483647 - 0.5) * 12;
  });
  const row = changeVolume(grid.heights, new Float32Array(noisy), grid)!;
  assert.equal(row.significant, false);
});

test("la chioma ha un intervallo largo, perché la sua altezza è la lettura più debole", () => {
  const row = crownVolume(5, 15);
  assert.ok(row.value > 300 && row.value < 800);
  assert.ok(row.high / row.low > 4);
});

test("i volumi si leggono come li direbbe una persona", () => {
  assert.equal(formatVolume(840), "840 m³");
  assert.equal(formatVolume(125430), "125 400 m³");
  assert.equal(formatVolume(2442000), "2.44 milioni di m³");
  assert.equal(formatVolume(48000000), "48.0 milioni di m³");
  assert.equal(formatRange({ value: 2.4e6, low: 2.33e6, high: 2.51e6 }), "2.33 – 2.51 milioni di m³");
  assert.equal(formatRange({ value: 4e5, low: 225700, high: 523600 }), "225 700 – 523 600 m³");
  assert.equal(formatRange({ value: 9e5, low: 500000, high: 1500000 }), "500 000 m³ – 1.50 milioni di m³");
});
