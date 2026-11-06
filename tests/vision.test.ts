import assert from "node:assert/strict";
import { test } from "node:test";
import { solveShotInstant, sunPosition, sunEvents } from "../src/core/solar.ts";
import { parseCoordinates as parseLocation } from "../src/core/coords.ts";
import { Projection, parseKmlBbox, toUtm } from "../src/core/geo.ts";
import { analyzePlate, type Footprint } from "../src/vision/analyze.ts";

const SIZE = 800;
const MPP = 0.5;

/** Paints a scene whose truth is known: boxes with exact heights, shadows thrown by a known sun. */
function scene(az: number, alt: number, boxes: { x: number; y: number; w: number; d: number; h: number }[], trees: { x: number; y: number; r: number; h: number }[] = []) {
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  const fill = (k: number, r: number, g: number, b: number) => {
    rgba[k * 4] = r;
    rgba[k * 4 + 1] = g;
    rgba[k * 4 + 2] = b;
    rgba[k * 4 + 3] = 255;
  };
  for (let k = 0; k < SIZE * SIZE; k++) {
    const noise = ((k * 2654435761) >>> 24) % 14;
    fill(k, 150 + noise, 145 + noise, 135 + noise);
  }
  const sdx = Math.sin(az + Math.PI);
  const sdy = -Math.cos(az + Math.PI);
  const cot = 1 / Math.tan(alt);
  const dark = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const k = Math.round(y) * SIZE + Math.round(x);
    fill(k, 42, 46, 58);
  };
  for (const b of boxes) {
    const len = (b.h * cot) / MPP;
    for (let s = 0; s <= len; s += 0.5) for (let i = 0; i < b.w; i += 0.5) for (let j = 0; j < b.d; j += 0.5) dark(b.x + i + sdx * s, b.y + j + sdy * s);
  }
  for (const t of trees) {
    const len = (t.h * cot) / MPP;
    const r = t.r / MPP;
    for (let s = 0; s <= len; s += 1) for (let i = -r; i <= r; i += 1) for (let j = -r; j <= r; j += 1) if (i * i + j * j <= r * r) dark(t.x + i + sdx * s, t.y + j + sdy * s);
  }
  for (const b of boxes) {
    for (let j = 0; j < b.d; j++) for (let i = 0; i < b.w; i++) fill(Math.round(b.y + j) * SIZE + Math.round(b.x + i), 190, 110, 90);
  }
  for (const t of trees) {
    const r = t.r / MPP;
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (i * i + j * j > r * r) continue;
        const v = 20 + (Math.abs((i * 7 + j * 13) % 11) * 4);
        fill(Math.round(t.y + j) * SIZE + Math.round(t.x + i), 40 + v * 0.4, 90 + v, 34 + v * 0.3);
      }
    }
  }
  return rgba;
}

const footprintOf = (id: string, b: { x: number; y: number; w: number; d: number }, tagHeight?: number): Footprint => ({
  id,
  tagHeight,
  rings: [[b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.d, b.x, b.y + b.d]],
});

const BOXES = [
  { x: 120, y: 140, w: 70, d: 50, h: 12 },
  { x: 420, y: 120, w: 60, d: 80, h: 20 },
  { x: 180, y: 480, w: 90, d: 60, h: 9 },
  { x: 560, y: 500, w: 50, d: 50, h: 26 },
  { x: 340, y: 340, w: 40, d: 70, h: 15 },
  { x: 640, y: 240, w: 50, d: 40, h: 7 },
];

// Rome, 2022-11-27, 10:15 solar time: an honest winter Maxar pass.
const LAT = 41.89;
const LON = 12.49;
const DAY = "2022-11-27";
const WHEN = new Date(Date.parse(`${DAY}T10:15:00Z`) - (LON / 15) * 3_600_000);
const TRUTH = sunPosition(WHEN, LAT, LON);

const baseInput = (rgba: Uint8ClampedArray) => ({
  rgba,
  width: SIZE,
  height: SIZE,
  mpp: MPP,
  lat: LAT,
  lon: LON,
  captureDate: DAY,
  roads: [],
  water: [],
  osmTrees: [],
});

test("solar geometry matches published values", () => {
  // Rome, June solstice noon: altitude ≈ 90 − 41.89 + 23.44 = 71.55°.
  const noon = sunPosition(new Date(Date.UTC(2024, 5, 20, 12 - LON / 15, 2)), LAT, LON);
  assert.ok(Math.abs((noon.altitude * 180) / Math.PI - 71.55) < 0.6, `altitude ${(noon.altitude * 180) / Math.PI}`);
  const events = sunEvents(new Date(Date.UTC(2024, 2, 20, 11)), LAT, LON);
  assert.ok(events.rise && events.set);
  const day = (events.set!.valueOf() - events.rise!.valueOf()) / 3_600_000;
  assert.ok(Math.abs(day - 12.1) < 0.3, `equinox day ${day}`);
});

test("the instant of the shot comes back from azimuth and date", () => {
  const shot = solveShotInstant(DAY, LAT, LON, TRUTH.azimuth)!;
  assert.ok(Math.abs(shot.date.valueOf() - WHEN.valueOf()) < 120_000);
});

test("sun azimuth is read from shadows alone", () => {
  const rgba = scene(TRUTH.azimuth, TRUTH.altitude, BOXES);
  const result = analyzePlate({ ...baseInput(rgba), footprints: BOXES.map((b, i) => footprintOf(`b${i}`, b)), register: false });
  const err = Math.abs(((result.sun.sunAzimuth - TRUTH.azimuth + Math.PI) % (2 * Math.PI)) - Math.PI);
  assert.equal(result.sun.method, "ombre+data");
  assert.ok((err * 180) / Math.PI < 8, `azimuth off by ${(err * 180) / Math.PI}°`);
  assert.ok(Math.abs(result.sun.altitude - TRUTH.altitude) < 0.07, "altitude from date and azimuth");
});

test("building heights come back from shadow length", () => {
  const rgba = scene(TRUTH.azimuth, TRUTH.altitude, BOXES);
  const result = analyzePlate({ ...baseInput(rgba), footprints: BOXES.map((b, i) => footprintOf(`b${i}`, b)), register: false });
  let checked = 0;
  BOXES.forEach((b, i) => {
    const reading = result.heights[`b${i}`]!;
    if (reading.h == null) return;
    checked++;
    assert.ok(Math.abs(reading.h - b.h) / b.h < 0.3, `building ${i}: true ${b.h} m, read ${reading.h.toFixed(1)} m`);
  });
  assert.ok(checked >= 4, `only ${checked} buildings read`);
});

test("a misaligned map is co-registered with the plate", () => {
  const rgba = scene(TRUTH.azimuth, TRUTH.altitude, BOXES);
  const shifted = BOXES.map((b, i) => footprintOf(`b${i}`, { ...b, x: b.x + 8, y: b.y - 6 }));
  const result = analyzePlate({ ...baseInput(rgba), footprints: shifted });
  assert.equal(result.registration.applied, true);
  assert.ok(Math.abs(result.registration.dx / MPP + 8) <= 2, `dx ${result.registration.dx / MPP}`);
  assert.ok(Math.abs(result.registration.dy / MPP - 6) <= 2, `dy ${result.registration.dy / MPP}`);
});

test("tree crowns are found, sized and measured", () => {
  const trees = [
    { x: 300, y: 300, r: 4, h: 12 },
    { x: 500, y: 650, r: 3, h: 9 },
    { x: 120, y: 650, r: 5, h: 15 },
  ];
  const rgba = scene(TRUTH.azimuth, TRUTH.altitude, [], trees);
  const result = analyzePlate({ ...baseInput(rgba), footprints: [], register: false });
  for (const truth of trees) {
    const near = result.trees.find((t) => Math.hypot(t.x / MPP - truth.x, t.y / MPP - truth.y) < 8);
    assert.ok(near, `tree at ${truth.x},${truth.y} not found among ${result.trees.length}`);
    assert.ok(Math.abs(near.r - truth.r) < 2.2, `radius true ${truth.r}, read ${near.r}`);
    assert.ok(Math.abs(near.h - truth.h) / truth.h < 0.5, `height true ${truth.h}, read ${near.h}`);
  }
});

test("unmapped buildings are deduced from roof and shadow", () => {
  const rgba = scene(TRUTH.azimuth, TRUTH.altitude, BOXES);
  const result = analyzePlate({ ...baseInput(rgba), footprints: [], register: false });
  assert.ok(result.masses.length >= 3, `found ${result.masses.length} masses`);
});

test("locations are parsed from pasted links and KML", () => {
  const linked = parseLocation("https://www.google.com/maps/@41.8902,12.4922,500m/data=!3m1!1e3")!;
  assert.equal(linked.lat, 41.8902);
  assert.equal(linked.lon, 12.4922);
  assert.equal(parseLocation("https://www.google.com/maps/@41.8902,12.4922,17z")!.zoom, 17);
  assert.equal(parseLocation("41.89, 12.49")!.lon, 12.49);
  assert.equal(parseLocation("https://www.openstreetmap.org/#map=16/41.8/12.4")!.zoom, 16);
  const kml = parseKmlBbox("<kml><GroundOverlay><name>a</name><LatLonBox><north>42</north><south>41</south><east>13</east><west>12</west></LatLonBox></GroundOverlay></kml>");
  assert.deepEqual(kml!.bbox, { s: 41, w: 12, n: 42, e: 13 });
});

test("projection round-trips and UTM is right", () => {
  const p = new Projection({ s: 41.88, w: 12.48, n: 41.9, e: 12.5 });
  const { x, z } = p.toLocal(41.893, 12.487);
  const back = p.toLatLon(x, z);
  assert.ok(Math.abs(back.lat - 41.893) < 1e-9 && Math.abs(back.lon - 12.487) < 1e-9);
  // 2.22 km of latitude span ought to be close to true ground size.
  assert.ok(Math.abs(p.halfZ * 2 - 2225) < 15, `span ${p.halfZ * 2}`);
  const utm = toUtm(41.8902, 12.4922);
  assert.equal(utm.zone, 33);
  assert.ok(Math.abs(utm.east - 291_000) < 1500 && Math.abs(utm.north - 4_640_500) < 1500, utm.text);
});
