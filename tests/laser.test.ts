import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { granuleDate, readZipEntry, sampleHgt } from "../server/nasa.ts";
import { assessLaser, correctedHeight, demDifference, fitTrees, type LaserBuilding, type PlacedShot, type TreePair } from "../src/vision/laser.ts";

const shot = (x: number, z: number, ground: number, top: number, extra: Partial<PlacedShot> = {}): PlacedShot => ({ id: `${x}:${z}`, lat: 0, lon: 0, x, z, ground, top, rh98: top - ground, rh50: 0, srtm: null, sensitivity: 0.98, good: true, date: "2023-05-01", beam: "BEAM0000", solar: -10, cover: null, ...extra });

const GEOID = 47;
const tower: LaserBuilding = { id: "torre", height: 30, top: 50 + 30, source: "ombra", shadowHeight: 26, name: "Torre" };
const world = {
  heightAt: () => 50,
  // A 100 m square block centred on the origin; everything else is open ground.
  buildingAt: (x: number, z: number) => (Math.abs(x) < 50 && Math.abs(z) < 50 ? tower : null),
  trees: [{ x: 300, z: 300, r: 5, h: 14 }],
};

test("la differenza di riferimento si legge dal terreno aperto", () => {
  const a = assessLaser([shot(200, 0, 50 + GEOID, 50 + GEOID), shot(-200, 0, 50 + GEOID + 1, 50 + GEOID + 1), shot(0, 200, 50 + GEOID - 1, 50 + GEOID - 1)], world);
  assert.equal(a.datum, GEOID);
  assert.match(a.datumFrom, /terreno aperto/);
});

test("un'impronta dentro l'edificio misura la sua altezza e l'errore del modello", () => {
  const a = assessLaser([shot(200, 0, 97, 97), shot(-200, 0, 97, 97), shot(0, 200, 97, 97), shot(0, 0, 97, 50 + GEOID + 34)], world);
  const row = a.readings.find((item) => item.kind === "edificio")!;
  assert.equal(row.measured, 34);
  assert.equal(row.error, 30 - 34);
  assert.equal(a.bySource[0]!.label, "ombra");
  assert.equal(a.bySource[0]!.n, 1);
  assert.equal(a.perBuilding.torre!.measured, 34);
  assert.equal(a.shadows!.bias, 26 - 34);
});

test("un'impronta a cavallo del muro non conta per l'edificio", () => {
  const a = assessLaser([shot(50, 0, 97, 130)], world);
  assert.equal(a.readings[0]!.kind, "misto");
  assert.equal(a.readings[0]!.error, null);
  assert.deepEqual(a.perBuilding, {});
});

test("una cima sotto il suolo o fra le nuvole non misura l'edificio", () => {
  const open = [shot(200, 0, 97, 97), shot(-200, 0, 97, 97), shot(0, 200, 97, 97)];
  const low = assessLaser([...open, shot(0, 0, 97, 90)], world);
  assert.equal(low.readings[3]!.kind, "misto");
  assert.equal(low.bySource.length, 0);
  const cloud = assessLaser([...open, shot(0, 0, 97, 4000)], world);
  assert.equal(cloud.readings[3]!.kind, "misto");
  assert.deepEqual(cloud.perBuilding, {});
});

test("un'altezza presa dal laser non conta come conferma del laser", () => {
  const fromLaser = { ...tower, source: "laser GEDI" };
  const a = assessLaser([shot(200, 0, 97, 97), shot(-200, 0, 97, 97), shot(0, 200, 97, 97), shot(0, 0, 97, 127)], { ...world, buildingAt: (x, z) => (world.buildingAt(x, z) ? fromLaser : null) });
  assert.equal(a.bySource.length, 0);
  assert.equal(a.counts.buildings, 1);
});

test("le impronte di cattiva qualità non entrano nell'errore", () => {
  const a = assessLaser([shot(200, 0, 97, 97), shot(-200, 0, 97, 97), shot(0, 200, 97, 97), shot(0, 0, 97, 200, { good: false })], world);
  assert.equal(a.counts.total, 4);
  assert.equal(a.counts.good, 3);
  assert.equal(a.bySource.length, 0);
});

test("gli alberi si confrontano con l'altezza sopra il suolo del laser", () => {
  const a = assessLaser([shot(300, 300, 97, 113)], world);
  const row = a.readings[0]!;
  assert.equal(row.kind, "albero");
  assert.equal(row.measured, 16);
  assert.equal(row.error, 14 - 16);
});

test("la quota SRTM batte il terreno aperto, che sotto un parco ingannerebbe", () => {
  // The terrain model rides on the crowns: true ground is 8 m under it, and the SRTM height is not.
  const park = [200, -200, 300].map((x) => shot(x, 0, 50 - 8 + GEOID, 50 - 8 + GEOID, { srtm: 50 + GEOID }));
  const a = assessLaser(park, world);
  assert.equal(a.datum, GEOID);
  assert.match(a.datumFrom, /SRTM/);
  const blind = assessLaser(park.map((row) => ({ ...row, srtm: null })), world);
  assert.equal(blind.datum, GEOID - 8, "senza SRTM resta l'unica stima, e si dichiara");
  assert.match(blind.datumFrom, /terreno aperto/);
});

test("la differenza fra due rilievi toglie lo scarto fra i sensori", () => {
  const older = new Float32Array([10, 10, 10, 10, 10, Number.NaN]);
  const newer = new Float32Array([12, 12, 12, 12, 32, 12]);
  const d = demDifference(older, newer);
  assert.equal(d.bias, 2);
  assert.equal(d.difference[4], 20);
  assert.equal(d.difference[0], 0);
  assert.ok(Number.isNaN(d.difference[5]));
  assert.equal(d.rose, 0.2);
  assert.equal(d.cells, 5);
});

function tinyZip(name: string, content: Buffer) {
  const packed = deflateRawSync(content);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + packed.length, 16);
  return Buffer.concat([local, nameBytes, packed, central, nameBytes, end]);
}

test("l'archivio NASADEM si apre senza librerie", () => {
  const content = Buffer.from("quote di prova ".repeat(50));
  assert.deepEqual(readZipEntry(tinyZip("n41e012.hgt", content), ".hgt"), content);
  assert.throws(() => readZipEntry(tinyZip("readme.txt", content), ".hgt"));
});

test("le quote HGT partono da nord e interpolano fra i quattro vicini", () => {
  const hgt = Buffer.alloc(3 * 3 * 2);
  const grid = [100, 110, 120, 200, 210, 220, 300, 310, -32768];
  grid.forEach((v, i) => hgt.writeInt16BE(v, i * 2));
  // Corner north-west of the tile: lat 42, lon 12.
  assert.equal(sampleHgt(hgt, 41, 12, 42, 12), 100);
  assert.equal(sampleHgt(hgt, 41, 12, 41.5, 12.5), 210);
  assert.equal(sampleHgt(hgt, 41, 12, 41.75, 12.25), (100 + 110 + 200 + 210) / 4);
  assert.ok(Number.isNaN(sampleHgt(hgt, 41, 12, 41, 13)), "un buco resta un buco");
});

test("la data del granulo viene dal giorno dell'anno", () => {
  assert.equal(granuleDate("GEDI02_A_2019209152911_O03537_02_T00165_02_004_02_V003_subsetted.h5"), "2019-07-28");
  assert.equal(granuleDate("altro.h5"), "");
});

// A repeatable scatter, so that these tests never depend on the run.
function scatter(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function stand(count: number, truth: (x: number) => number, read: (r: () => number) => number, groups = 12, seed = 11): TreePair[] {
  const r = scatter(seed);
  return Array.from({ length: count }, (_, i) => {
    const x = r() * 1000;
    return { x, z: r() * 200, rh98: truth(x) + (r() - 0.5) * 3, group: `g${i % groups}`, crowns: [read(r), read(r) * 0.8] };
  });
}

test("gli alberi sbagliati di un fattore vengono corretti e l'errore si misura su orbite escluse", () => {
  const fit = fitTrees(stand(60, () => 24, (r) => 9 + r() * 6));
  assert.ok(fit.model, fit.reason);
  assert.ok(fit.before.typical > 8, `prima ${fit.before.typical}`);
  assert.ok(fit.after!.typical < 3.5, `dopo ${fit.after!.typical}`);
});

test("due boschi di altezza diversa richiedono il modello locale", () => {
  const fit = fitTrees(stand(120, (x) => (x < 500 ? 28 : 9), (r) => 12 + r() * 4));
  assert.equal(fit.model?.kind, "locale");
  assert.ok(correctedHeight(fit.model!, 100, 100, 14) > correctedHeight(fit.model!, 900, 100, 14) + 8);
});

test("se la lastra è già buona la correzione non viene applicata", () => {
  const fit = fitTrees(stand(60, () => 15, () => 15));
  assert.equal(fit.model, null);
  assert.match(fit.reason, /non migliora/);
});

test("con poche impronte o pochi passaggi non si corregge nulla", () => {
  assert.match(fitTrees(stand(10, () => 24, () => 10)).reason, /Troppo poche/);
  assert.match(fitTrees(stand(60, () => 24, () => 10, 3)).reason, /Troppo poche/);
});

test("la variazione individuale è ridotta ma resta in ordine", () => {
  const model = fitTrees(stand(60, () => 24, (r) => 9 + r() * 6)).model!;
  const small = correctedHeight(model, 0, 0, 8);
  const tall = correctedHeight(model, 0, 0, 16);
  assert.ok(tall > small);
  assert.ok(tall / small < 16 / 8);
});
