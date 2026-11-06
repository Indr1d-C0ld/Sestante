import assert from "node:assert/strict";
import { test } from "node:test";
import { fovFromFocal35, parseExifDate, readExif } from "../src/core/exif.ts";
import { leastCostRoute, secondsPerMetre, sightLines, simplify, travelTimes } from "../src/core/routes.ts";
import { sunPosition } from "../src/core/solar.ts";
import { blobsAbove, rankPlaces, robustSpread, type Clue } from "../src/vision/anomalies.ts";
import { extractSkyline, fitProfile, horizonProfile, matchSun, PROFILE_RAYS, searchPhoto, skylineAngles, sunFromShadow, type HeightField, type Skyline } from "../src/vision/horizon.ts";
import { fillGaps, hillshade, localRelief, standingHeight } from "../src/vision/lidar.ts";

const close = (a: number, b: number, tolerance: number, label = "") => assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} contro ${b}`);

test("i buchi del modello si chiudono ai bordi, e i valori noti non si toccano", () => {
  const size = 64;
  const h = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) h[j * size + i] = 100 + i * 0.5 + j * 0.25;
  const truth = new Float32Array(h);
  for (let j = 20; j < 34; j++) for (let i = 22; i < 40; i++) h[j * size + i] = Number.NaN;
  const out = fillGaps(h, size, size);
  assert.equal(out.filled, 14 * 18);
  for (let k = 0; k < h.length; k++) {
    if (Number.isFinite(h[k]!)) assert.equal(out.heights[k], truth[k]);
    else close(out.heights[k]!, truth[k]!, 3, "riempito");
  }
});

test("il rilievo locale toglie la pendenza e tiene il terrapieno", () => {
  const size = 200;
  const h = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) h[j * size + i] = 50 + i * 0.2 + j * 0.1 + (Math.abs(i - 100) < 3 ? 1.2 : 0);
  const relief = localRelief({ heights: h, cols: size, rows: size, cellX: 1, cellZ: 1 }, 15);
  close(relief[100 * size + 30]!, 0, 0.02, "pendio");
  assert.ok(relief[100 * size + 100]! > 0.7, "terrapieno");
  const shade = hillshade({ heights: h, cols: size, rows: size, cellX: 1, cellZ: 1 });
  assert.notEqual(shade[100 * size + 97], shade[100 * size + 103], "i due lati del terrapieno hanno luce diversa");
});

test("l'altezza dal LiDAR ignora il picco isolato e rifiuta poche celle", () => {
  const cells = Array.from({ length: 100 }, (_, i) => i);
  const dsm = cells.map((i) => (i === 3 ? 80 : 120));
  const ground = cells.map(() => 100);
  const row = standingHeight(dsm, ground, cells)!;
  assert.equal(row.height, 20);
  assert.equal(standingHeight(dsm, ground, [1, 2, 3]), null);
  const tower = cells.map((i) => (i < 10 ? 212 : 115));
  assert.equal(standingHeight(tower, ground, cells)!.height, 112);
});

test("Tobler: 6 km/h sulla lieve discesa, 5 km/h in piano", () => {
  close(3.6 / secondsPerMetre(-0.05, "piedi"), 6, 1e-9);
  close(3.6 / secondsPerMetre(0, "piedi"), 5.04, 0.01);
  assert.ok(secondsPerMetre(0.3, "piedi") > secondsPerMetre(-0.3, "piedi"), "salire costa più che scendere");
  assert.equal(secondsPerMetre(0.1, "carico"), secondsPerMetre(-0.1, "carico"));
});

/** A valley floor with a steep ridge across it, broken by a low col at a known place. */
function ridge(colAt: number, size = 121, spacing = 20) {
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const col = Math.exp(-(((i - colAt) / 8) ** 2));
      heights[j * size + i] = 1000 + 320 * Math.exp(-(((j - 60) / 5) ** 2)) * (1 - 0.9 * col);
    }
  }
  return { heights, size, spacing };
}

test("la via passa dal valico anche se non è sulla retta, e il corridoio è stretto lì", () => {
  const grid = ridge(95);
  const route = leastCostRoute(grid, { x: 600, z: 200 }, { x: 600, z: 2200 }, { x: 0, z: 0 }, "piedi")!;
  const crossing = route.points.reduce((a, b) => (Math.abs(b.z - 1200) < Math.abs(a.z - 1200) ? b : a));
  close(crossing.x, 95 * 20, 160, "attraversamento");
  assert.ok(route.seconds < route.straightSeconds!, "conviene deviare");
  assert.ok(route.length > route.straight);
  let across = 0;
  for (let i = 0; i < 121; i++) across += route.corridor[60 * 121 + i]!;
  assert.ok(across < 45, `corridoio sulla cresta: ${across} celle`);
});

test("il tempo all'indietro è quello dell'andata fatta davvero, non del ritorno", () => {
  const size = 40;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) heights[j * size + i] = i * 3;
  const grid = { heights, size, spacing: 10 };
  const a = 20 * size;
  const b = 20 * size + 30;
  const forward = travelTimes(grid, a, "piedi").times[b]!;
  const reverse = travelTimes(grid, b, "piedi", true).times[a]!;
  close(forward, reverse, 1e-6);
  const down = travelTimes(grid, b, "piedi").times[a]!;
  assert.ok(down < forward, "in discesa si va più veloci");
});

test("un fiume invalicabile impone il ponte", () => {
  const size = 60;
  const heights = new Float32Array(size * size).fill(100);
  const barrier = new Float32Array(size * size);
  for (let i = 0; i < size; i++) if (i !== 50) barrier[30 * size + i] = Infinity;
  const route = leastCostRoute({ heights, size, spacing: 10, barrier }, { x: 100, z: 100 }, { x: 100, z: 500 }, { x: 0, z: 0 }, "piedi")!;
  assert.ok(route.points.some((p) => Math.abs(p.x - 500) <= 20), "passa dal ponte");
  assert.equal(route.straightSeconds, null);
  for (let i = 0; i < size; i++) barrier[30 * size + i] = Infinity;
  assert.equal(leastCostRoute({ heights, size, spacing: 10, barrier }, { x: 100, z: 100 }, { x: 100, z: 500 }, { x: 0, z: 0 }, "piedi"), null);
});

test("semplificare toglie i gradini e tiene le svolte", () => {
  const line = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, z: i % 2 }));
  assert.equal(simplify(line, 2).length, 2);
  const corner = [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 50 }, { x: 100, z: 100 }];
  assert.equal(simplify(corner, 1).length, 3);
});

test("la visibilità sente la collina in mezzo e la curvatura", () => {
  const hill = (x: number) => 10 * 0 + 80 * Math.exp(-(((x - 500) / 60) ** 2));
  const sites = [{ id: "a", name: "A", x: 0, z: 0 }, { id: "b", name: "B", x: 1000, z: 0 }, { id: "c", name: "C", x: 500, z: 0 }];
  const lines = sightLines(sites, (x) => hill(x));
  assert.equal(lines.find((row) => row.a === "a" && row.b === "b")!.visible, false);
  assert.equal(lines.find((row) => row.a === "a" && row.b === "c")!.visible, true);
  // Two people on flat ground 20 km apart do not see each other: the Earth is in the way.
  const far = sightLines([{ id: "p", name: "P", x: 0, z: 0 }, { id: "q", name: "Q", x: 20000, z: 0 }], () => 0, 1.6, 100);
  assert.equal(far[0]!.visible, false);
  const near = sightLines([{ id: "p", name: "P", x: 0, z: 0 }, { id: "q", name: "Q", x: 3000, z: 0 }], () => 0, 1.6, 100);
  assert.equal(near[0]!.visible, true);
});

test("le macchie si separano e quelle piccole cadono", () => {
  const w = 20;
  const v = new Float32Array(w * w);
  for (let j = 2; j < 6; j++) for (let i = 2; i < 6; i++) v[j * w + i] = 1;
  v[15 * w + 15] = 1;
  const rows = blobsAbove(v, w, w, 0.5, 4);
  assert.equal(rows.length, 1);
  close(rows[0]!.x, 3.5, 1e-9);
  assert.equal(rows[0]!.cells, 16);
  assert.equal(robustSpread(new Float32Array([1, 1, 1, 1, 9])).median, 1);
});

test("due indizi indipendenti sullo stesso punto battono un indizio forte da solo", () => {
  const clue = (kind: Clue["kind"], x: number, strength: number): Clue => ({ kind, x, z: 0, radius: 10, strength, text: kind });
  const rows = rankPlaces([clue("laser", 0, 1), clue("cambiamento", 500, 0.6), clue("ombra", 505, 0.6), clue("vegetazione", 1000, 0.5)]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0]!.kinds.sort(), ["cambiamento", "ombra"]);
  assert.equal(rows[1]!.kinds[0], "laser");
  // Many clues of one kind in the same spot do not pile up: they are the same evidence.
  const same = rankPlaces([clue("cambiamento", 0, 0.6), clue("cambiamento", 5, 0.6), clue("cambiamento", 10, 0.6)]);
  close(same[0]!.score, 0.6 * 0.7, 1e-9);
});

/** Ridges in a ring around a basin, irregular so that one spot looks unlike another. */
function mountains(size = 241, spacing = 100): HeightField {
  const heights = new Float32Array(size * size);
  const peaks = Array.from({ length: 40 }, (_, n) => ({ x: ((n * 73) % 241) * spacing, z: ((n * 151) % 241) * spacing, h: 500 + ((n * 97) % 1500), r: 900 + ((n * 37) % 1800) }));
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let h = 800;
      for (const p of peaks) h += p.h * Math.exp(-(((i * spacing - p.x) ** 2 + (j * spacing - p.z) ** 2) / (p.r * p.r)));
      heights[j * size + i] = h;
    }
  }
  return { heights, size, spacing, originX: 0, originZ: 0 };
}

/** What a pinhole camera would see of a horizon profile: the skyline a real photo would give, without its noise. */
function fakeSkyline(profile: Float32Array, azimuth: number, hfov: number, pitch: number, width = 800, height = 500, noisePx = 0): Skyline {
  const f = width / 2 / Math.tan((hfov * Math.PI) / 360);
  const y = new Float32Array(width);
  const confidence = new Float32Array(width).fill(1);
  let seed = 7;
  for (let i = 0; i < width; i++) {
    const px = i + 0.5 - width / 2;
    const bearing = (Math.atan2(px, f) * 180) / Math.PI;
    const r = (Math.round(((azimuth + bearing + 720) % 360) * (PROFILE_RAYS / 360))) % PROFILE_RAYS;
    seed = (seed * 16807) % 2147483647;
    y[i] = height / 2 - (Math.tan(((profile[r]! - pitch) * Math.PI) / 180) * f) / Math.cos(Math.atan2(px, f)) + (seed / 2147483647 - 0.5) * 2 * noisePx;
  }
  return { y, confidence, width, height, quality: 1 };
}

test("il profilo dell'orizzonte: l'angolo giusto su un cono noto", () => {
  const size = 201;
  const spacing = 50;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) heights[j * size + i] = Math.max(0, 1000 - Math.hypot(i - 180, j - 100) * spacing * 0.5);
  const field = { heights, size, spacing, originX: 0, originZ: 0 };
  const profile = horizonProfile(field, 100 * spacing, 100 * spacing, 0);
  // The peak is due east, 4 km away and 1 km high.
  close(profile[180]!, (Math.atan2(1000, 4000) * 180) / Math.PI, 0.3, "verso est");
  assert.ok(profile[540]! < 0.5, "verso ovest è piatto");
});

test("ritrova luogo, direzione e obiettivo di una foto simulata, anche con il rumore", async () => {
  const field = mountains();
  const truth = { x: 11200, z: 13600 };
  const profile = horizonProfile(field, truth.x, truth.z);
  const skyline = fakeSkyline(profile, 137, 60, 2, 800, 500, 2);
  const result = await searchPhoto(field, skyline, { minX: 8000, maxX: 16000, minZ: 10000, maxZ: 18000 }, 400, [45, 60, 75]);
  assert.equal(result.verdict, "plausibile", `esito ${result.verdict}, ${JSON.stringify({ u: result.uniqueness, r: result.relief, reg: result.region, spots: result.spots.slice(0, 4).map((row) => [row.x, row.z, +row.rmse.toFixed(2), row.azimuth, row.hfov, +row.pitch.toFixed(1)]) })}`);
  const best = result.spots[0]!;
  assert.ok(Math.hypot(best.x - truth.x, best.z - truth.z) < result.region + 400, `a ${Math.hypot(best.x - truth.x, best.z - truth.z)} m con regione ${result.region}`);
  close(best.azimuth, 137, 3, "azimut");
  assert.equal(best.hfov, 60);
  close(best.pitch, 2, 1, "beccheggio");
});

test("un orizzonte piatto non basta, e lo dice", async () => {
  const field = mountains();
  const flat: Skyline = { y: new Float32Array(800).fill(250), confidence: new Float32Array(800).fill(1), width: 800, height: 500, quality: 1 };
  const result = await searchPhoto(field, flat, { minX: 8000, maxX: 9000, minZ: 8000, maxZ: 9000 }, 500, [60]);
  assert.equal(result.verdict, "impossibile");
  assert.equal(result.spots.length, 0);
});

test("una nuvola sopra la montagna non diventa la linea", () => {
  const width = 200;
  const height = 150;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const ridge = 80 + 25 * Math.abs(Math.sin(i / 30));
      const cloud = j > 20 && j < 45 && i > 30 && i < 170;
      const k = (j * width + i) * 4;
      const grain = ((i * 7 + j * 13) % 11) * 2.2;
      const [r, g, b] = j > ridge ? [70 + grain, 85 + grain, 60 + grain] : cloud ? [238, 240, 242] : [90, 140, 210];
      rgba[k] = r!;
      rgba[k + 1] = g!;
      rgba[k + 2] = b!;
      rgba[k + 3] = 255;
    }
  }
  const line = extractSkyline(rgba, width, height);
  for (const i of [20, 60, 100, 140, 180]) close(line.y[i]!, 80 + 25 * Math.abs(Math.sin(i / 30)), 6, `colonna ${i}`);
});

test("un orizzonte che non c'è nell'area resta ambiguo", async () => {
  const field = mountains();
  const other = mountains(241, 37);
  const skyline = fakeSkyline(horizonProfile(other, 4000, 5000), 20, 60, 0);
  const result = await searchPhoto(field, skyline, { minX: 8000, maxX: 12000, minZ: 8000, maxZ: 12000 }, 500, [60]);
  assert.notEqual(result.verdict, "plausibile", JSON.stringify({ u: result.uniqueness, r: result.relief, reg: result.region, top: result.spots[0] }));
});

test("fitProfile vale anche da solo, e la linea si legge dai pixel", () => {
  const profile = new Float32Array(PROFILE_RAYS);
  for (let r = 0; r < PROFILE_RAYS; r++) profile[r] = 3 * Math.sin((r / PROFILE_RAYS) * 6.283 * 3) + Math.sin((r / PROFILE_RAYS) * 6.283 * 11);
  const line = fakeSkyline(profile, 40, 50, 1);
  const fit = fitProfile(profile, skylineAngles(line, 50), 50);
  close(fit.azimuth, 40, 1.5);
  // A dark land under a bright sky with a cloud above: the line is the land.
  const width = 40;
  const height = 100;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const land = j > 60 + (i % 10 < 5 ? 0 : 3);
      const k = (j * width + i) * 4;
      rgba[k] = land ? 60 : 150;
      rgba[k + 1] = land ? 70 : 190;
      rgba[k + 2] = land ? 50 : 235;
      rgba[k + 3] = 255;
    }
  }
  const skyline = extractSkyline(rgba, width, height);
  close(skyline.y[20]!, 61, 4, "linea del cielo");
  assert.ok(skyline.quality > 0.5);
});

test("dall'ombra di un palo si torna al Sole, e dal Sole all'ora", () => {
  // A camera 1 unit up, looking north and level, a pole 2 units tall 10 ahead, shadow pointing north-east.
  const width = 1000;
  const height = 800;
  const hfov = 60;
  const f = width / 2 / Math.tan((hfov * Math.PI) / 360);
  const project = (side: number, up: number, ahead: number) => ({ u: width / 2 + (side / ahead) * f, v: height / 2 - (up / ahead) * f });
  const altitude = 40;
  const azimuthTowardSun = 225;
  const length = 2 / Math.tan((altitude * Math.PI) / 180);
  const shadowDir = ((azimuthTowardSun + 180) * Math.PI) / 180;
  const foot = project(0, -1, 10);
  const top = project(0, 1, 10);
  const tip = project(Math.sin(shadowDir) * length, -1, 10 + Math.cos(shadowDir) * length);
  const sun = sunFromShadow(foot, top, tip, width, height, hfov, 0, 0)!;
  close(sun.altitude, altitude, 0.5, "altezza");
  close(sun.azimuth, azimuthTowardSun, 0.5, "azimut");
  const when = new Date(Date.UTC(2024, 5, 21, 15, 0));
  const real = sunPosition(when, 41.9, 12.5);
  const alt = (real.altitude * 180) / Math.PI;
  const az = (real.azimuth * 180) / Math.PI;
  const onDay = matchSun(alt, az, 41.9, 12.5, 2024, when);
  assert.equal(onDay.length, 1);
  assert.ok(Math.abs(onDay[0]!.date.getTime() - when.getTime()) < 10 * 60000);
  const anyDay = matchSun(alt, az, 41.9, 12.5, 2024);
  assert.ok(anyDay.length >= 2, "lo stesso Sole torna: più date possibili");
});

test("EXIF: focale, data e GPS da un JPEG costruito a mano", () => {
  const ifd = (tags: [number, number, number, number[]][], at: number) => {
    const head: number[] = [tags.length & 255, tags.length >> 8];
    const extra: number[] = [];
    const base = at + 2 + tags.length * 12 + 4;
    for (const [tag, type, count, bytes] of tags) {
      head.push(tag & 255, tag >> 8, type & 255, type >> 8, count & 255, (count >> 8) & 255, 0, 0);
      if (bytes.length <= 4) head.push(...bytes, ...new Array(4 - bytes.length).fill(0));
      else {
        const off = base + extra.length;
        head.push(off & 255, (off >> 8) & 255, 0, 0);
        extra.push(...bytes);
      }
    }
    return [...head, 0, 0, 0, 0, ...extra];
  };
  const rat = (n: number, d = 1) => [n & 255, (n >> 8) & 255, 0, 0, d & 255, (d >> 8) & 255, 0, 0];
  const str = (text: string) => [...text].map((c) => c.charCodeAt(0)).concat(0);
  const mainAt = 8;
  const mainSize = 2 + 2 * 12 + 4;
  const subAt = mainAt + mainSize;
  const sub = ifd([[0x9003, 2, 20, str("2024:06:21 15:04:05")], [0xa405, 3, 1, [35, 0]]], subAt);
  const gpsAt = subAt + sub.length;
  const gps = ifd([[1, 2, 2, str("N")], [2, 5, 3, [...rat(41), ...rat(30), ...rat(0)]], [3, 2, 2, str("W")], [4, 5, 3, [...rat(12), ...rat(15), ...rat(0)]]], gpsAt);
  const main = ifd([[0x8769, 4, 1, [subAt & 255, subAt >> 8, 0, 0]], [0x8825, 4, 1, [gpsAt & 255, gpsAt >> 8, 0, 0]]], mainAt);
  const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, ...main, ...sub, ...gps];
  const app = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (app.length + 2) >> 8, (app.length + 2) & 255, ...app, 0xff, 0xd9]);
  const row = readExif(jpeg.buffer);
  assert.equal(row.focal35, 35);
  assert.equal(row.taken, "2024:06:21 15:04:05");
  close(row.lat!, 41.5, 1e-9);
  close(row.lon!, -12.25, 1e-9);
  assert.equal(parseExifDate(row.taken)!.toISOString(), "2024-06-21T15:04:00.000Z");
  close(fovFromFocal35(35), 54.4, 0.1);
  assert.equal(readExif(new Uint8Array([1, 2, 3, 4]).buffer).focal35, null);
});
