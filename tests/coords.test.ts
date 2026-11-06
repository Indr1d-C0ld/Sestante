import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCoordinates, precisionWords, toMgrs } from "../src/core/coords.ts";
import { boxAround, Projection, toUtm } from "../src/core/geo.ts";

const LAT = 41.8902;
const LON = 12.4922;

const near = (text: string, lat = LAT, lon = LON, tolerance = 0.002) => {
  const row = parseCoordinates(text);
  assert.ok(row, `non riconosciuto: ${text}`);
  assert.ok(Math.abs(row.lat - lat) < tolerance && Math.abs(row.lon - lon) < tolerance, `${text} → ${row.lat}, ${row.lon} (${row.format})`);
  return row;
};

test("gradi decimali in ogni grafia", () => {
  for (const text of [
    "41.8902, 12.4922",
    "41.8902 12.4922",
    "41.8902;12.4922",
    "41.8902,12.4922",
    "41,8902 12,4922",
    "41,8902, 12,4922",
    "41,8902; 12,4922",
    "41,8902,12,4922",
    "41.8902N 12.4922E",
    "N41.8902 E12.4922",
    "N 41.8902, E 12.4922",
    "41.8902° N, 12.4922° E",
    "41.8902º 12.4922º",
    "12.4922E 41.8902N",
    "E 12.4922 N 41.8902",
    "lat 41.8902 lon 12.4922",
    "lat=41.8902&lng=12.4922",
    "lon: 12.4922, lat: 41.8902",
    "latitudine 41.8902 longitudine 12.4922",
    '{"lat": 41.8902, "lng": 12.4922}',
    "x=12.4922 y=41.8902",
    "41.8902 Nord 12.4922 Est",
    "41.8902, 12.4922, 25",
    "(41.8902, 12.4922)",
    "WGS84 41.8902 12.4922",
  ]) near(text);
});

test("emisferi e segni", () => {
  near("33.8688 S 151.2093 E", -33.8688, 151.2093);
  near("-33.8688, 151.2093", -33.8688, 151.2093);
  near("−33.8688, 151.2093", -33.8688, 151.2093);
  near("40.7128N 74.0060W", 40.7128, -74.006);
  near("40.7128 N 74.0060 O", 40.7128, -74.006);
  near("40.7128 Nord 74.0060 Ovest", 40.7128, -74.006);
  near("34°36′S 58°22′W", -34.6, -58.3667);
});

test("gradi, primi e secondi in ogni grafia", () => {
  for (const text of [
    `41°53'24.7"N 12°29'32.0"E`,
    `41°53′24.7″N 12°29′32″E`,
    `41° 53' 24.7" N, 12° 29' 32" E`,
    `N 41° 53' 24.7" E 12° 29' 32"`,
    `41º53'24.7''N 12º29'32''E`,
    "41 53 24.7 N 12 29 32 E",
    "N 41 53 24.7 E 12 29 32",
    "41d53m24.7s N 12d29m32s E",
    "41d 53m 24.7s, 12d 29m 32s",
    "41 53 24.7 12 29 32",
    "41:53:24.7 12:29:32",
    "41 gradi 53 primi 24 secondi N 12 gradi 29 primi 32 secondi E",
    `12°29'32"E 41°53'24.7"N`,
    "415325N 0122932E",
    "N415325 E0122932",
  ]) near(text);
  const row = near(`41°53'24.7"N 12°29'32.0"E`);
  assert.equal(row.format, "gradi, primi e secondi");
});

test("gradi e primi decimali", () => {
  for (const text of [`41°53.41'N 12°29.53'E`, "N 41 53.41 E 12 29.53", "41 53.41 12 29.53", "4153N 01230E", "41 53,41 N 12 29,53 E"]) near(text, LAT, LON, 0.01);
});

test("UTM con e senza banda", () => {
  const utm = toUtm(LAT, LON);
  const e = utm.east.toFixed(0);
  const n = utm.north.toFixed(0);
  for (const text of [`33T ${e} ${n}`, `33 T ${e} ${n}`, `33T ${e}E ${n}N`, `33T ${e} E ${n} N`, `UTM 33T ${e} ${n}`, `33T, ${e}, ${n}`, `33 ${e} ${n}`, utm.text]) {
    const row = near(text, LAT, LON, 0.0001);
    assert.equal(row.format, "UTM");
  }
  // Sydney, UTM 56H, by an independent table value.
  const sydney = toUtm(-33.8688, 151.2093);
  near(`56H ${sydney.east.toFixed(0)} ${sydney.north.toFixed(0)}`, -33.8688, 151.2093, 0.0001);
  near(`56S ${sydney.east.toFixed(0)} ${sydney.north.toFixed(0)}`, -33.8688, 151.2093, 0.0001);
});

test("MGRS, con il valore pubblicato del Washington Monument", () => {
  near("18S UJ 23480 06479", 38.8895, -77.0353, 0.0002);
  near("18SUJ2348006479", 38.8895, -77.0353, 0.0002);
  assert.equal(parseCoordinates("18S UJ 234 065")!.precision, 50);
  const mine = toMgrs(LAT, LON);
  assert.equal(near(mine, LAT, LON, 0.0001).format, "MGRS");
  assert.equal(near(toMgrs(-33.8688, 151.2093), -33.8688, 151.2093, 0.0001).format, "MGRS");
});

test("Plus Code, Geohash, Maidenhead", () => {
  near("8FVC9G8F+6X", 47.3656, 8.5248, 0.001);
  const full = parseCoordinates("8FVC9G8F+6X Zurigo")!;
  assert.equal(full.format, "Plus Code");
  const short = parseCoordinates("9G8F+6X", { lat: 47.4, lon: 8.5 })!;
  assert.ok(Math.abs(short.lat - full.lat) < 1e-9 && Math.abs(short.lon - full.lon) < 1e-9);
  assert.equal(parseCoordinates("9G8F+6X"), null);
  near("ezs42", 42.6, -5.6, 0.05);
  near("sr2yk3h", 41.89, 12.49, 0.05);
  near("JN61fv", 41.896, 12.46, 0.05);
});

test("collegamenti delle mappe", () => {
  assert.equal(near("https://www.google.com/maps/@41.8902,12.4922,17z").zoom, 17);
  assert.equal(near("https://www.google.com/maps/place/Colosseo/@41.89,12.48,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d41.8902!4d12.4922").format, "Google Maps");
  near(`https://www.google.com/maps/place/41%C2%B053'24.7%22N+12%C2%B029'32.0%22E/`);
  near("https://maps.google.com/?q=41.8902,12.4922");
  near("https://www.google.com/maps/search/?api=1&query=41.8902%2C12.4922");
  near("https://www.google.com/maps/dir/?api=1&destination=41.8902,12.4922");
  assert.equal(near("https://www.openstreetmap.org/#map=16/41.8902/12.4922").zoom, 16);
  near("https://www.openstreetmap.org/?mlat=41.8902&mlon=12.4922#map=17/41.80/12.40");
  near("https://www.bing.com/maps?cp=41.8902~12.4922&lvl=16");
  near("https://maps.apple.com/?ll=41.8902,12.4922&z=15");
  near("https://yandex.com/maps/?ll=12.4922%2C41.8902&z=16");
  near("https://geohack.toolforge.org/geohack.php?params=41_53_24.7_N_12_29_32_E");
  near("www.google.com/maps/@41.8902,12.4922,17z");
  near("https://example.org/mappa?lat=41.8902&lon=12.4922");
  assert.equal(near("geo:41.8902,12.4922").format, "URI geo:");
});

test("formati dati, che scrivono prima la longitudine", () => {
  near('{"type":"Point","coordinates":[12.4922,41.8902]}');
  near("POINT(12.4922 41.8902)");
  near("<coordinates>12.4922,41.8902,0</coordinates>");
});

test("l'ordine si inverte quando i numeri lo impongono, e si segnala quando è dubbio", () => {
  const forced = near("151.2093, -33.8688", -33.8688, 151.2093);
  assert.match(forced.note!, /invertito/);
  const doubtful = parseCoordinates("12.4922, 41.8902")!;
  assert.equal(doubtful.lat, 12.4922);
  assert.deepEqual(doubtful.swapped, { lat: 41.8902, lon: 12.4922 });
  assert.equal(parseCoordinates("41.8902N 12.4922E")!.swapped, null);
  assert.equal(parseCoordinates("lat 41.8902 lon 12.4922")!.swapped, null);
});

test("i nomi di luogo restano nomi", () => {
  for (const text of ["Colosseo", "Piramidi di Giza", "Via Roma 12", "Roma 00184", "Zermatt", "Piazza Navona 41", "New York", "Monte Bianco", "Sant'Angelo", "1 Maggio", "Corso Italia 12 41", "Hotel 41", "Est", "Nord", "2024", "12 Ottobre 1492"]) assert.equal(parseCoordinates(text), null, text);
});

test("i valori impossibili vengono rifiutati", () => {
  for (const text of ["95.2, 200.1", "41 75 00 N 12 00 00 E", `41°53'75"N 12°29'32"E`, "91N 12E", "41.89N 190E", "41.5 30 12.5 20", "41.89N 12.49N"]) assert.equal(parseCoordinates(text), null, text);
});

test("la precisione dichiarata viene dalla scrittura", () => {
  const coarse = parseCoordinates("41.89, 12.49")!;
  assert.ok(coarse.precision! > 500 && coarse.precision! < 600);
  assert.ok(parseCoordinates("41.890213, 12.492231")!.precision! < 0.1);
  assert.ok(Math.abs(parseCoordinates(`41°53'24"N 12°29'32"E`)!.precision! - 15.5) < 0.5);
  assert.match(precisionWords(coarse), /±557 m/);
  assert.equal(precisionWords(parseCoordinates("41.890213, 12.492231")!), "precisione sotto il metro");
});

test("il punto cade esattamente al centro del riquadro, a qualunque scala e latitudine", () => {
  for (const [lat, lon] of [[41.8902, 12.4922], [69.65, 18.95], [-33.8688, 151.2093], [0.0001, -0.0001]] as const) {
    for (const size of [100, 800, 6000]) {
      const projection = new Projection(boxAround(lat, lon, size, size));
      const at = projection.toLocal(lat, lon);
      assert.ok(Math.hypot(at.x, at.z) < 1e-6, `centro a ${at.x}, ${at.z}`);
      assert.ok(Math.abs(projection.halfX * 2 - size) < 1e-6, `largo ${projection.halfX * 2}`);
      assert.ok(Math.abs(projection.halfZ * 2 - size) < 1e-6, `alto ${projection.halfZ * 2}`);
      const back = projection.toLatLon(0, 0);
      assert.ok(Math.abs(back.lat - lat) < 1e-10 && Math.abs(back.lon - lon) < 1e-10);
    }
  }
});
