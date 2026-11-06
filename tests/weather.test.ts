import assert from "node:assert/strict";
import { test } from "node:test";
import { altitudeFromPressure, beaufort, dewPoint, pressureAt, WeatherModel } from "../src/world/sim.ts";

const station = {
  timezone: "Europe/Rome",
  utc_offset_seconds: 3600,
  current: { temperature_2m: 18, relative_humidity_2m: 60, weather_code: 3, wind_speed_10m: 18, wind_direction_10m: 200, wind_gusts_10m: 30, cloud_cover: 80, precipitation: 0, rain: 0, snowfall: 0, pressure_msl: 1015, visibility: 20000 },
  hourly: {
    time: ["2026-11-05T10:00", "2026-11-05T11:00", "2026-11-05T12:00"],
    temperature_2m: [10, 12, 14],
    relative_humidity_2m: [70, 60, 50],
    weather_code: [0, 61, 61],
    wind_speed_10m: [36, 36, 36],
    wind_direction_10m: [100, 100, 100],
    cloud_cover: [0, 50, 100],
    precipitation: [0, 2, 4],
    visibility: [30000, 20000, 10000],
  },
};

test("the hourly series is read in the station's own time", () => {
  const model = new WeatherModel();
  model.setStation(station);
  // 11:30 in Rome is 10:30 UTC: halfway between the 11:00 and 12:00 rows.
  const read = model.fromStationAt(Date.parse("2026-11-05T10:30:00Z"))!;
  assert.ok(Math.abs(read.temp - 13) < 1e-6, `temp ${read.temp}`);
  assert.ok(Math.abs(read.cloud - 0.75) < 1e-6);
  assert.ok(Math.abs(read.rain - 3) < 1e-6);
  assert.equal(read.wind, 10);
});

test("outside the series nothing is invented", () => {
  const model = new WeatherModel();
  model.setStation(station);
  assert.equal(model.fromStationAt(Date.parse("2020-01-01T00:00:00Z")), null);
});

test("a bad upstream value never reaches the sky", () => {
  const model = new WeatherModel();
  model.mode = "manual";
  model.target.temp = Number.NaN;
  model.update(0.1, Date.now());
  assert.ok(Number.isFinite(model.now.temp));
});

test("barometric formulas invert each other and match the standard atmosphere", () => {
  assert.ok(Math.abs(pressureAt(1013.25, 1000, 15) - 898.7) < 6);
  const p = pressureAt(1020, 350, 12);
  assert.ok(Math.abs(altitudeFromPressure(1020, p) - 350) < 12);
  assert.ok(Math.abs(dewPoint(20, 50) - 9.3) < 0.3);
  assert.equal(beaufort(0.1), 0);
  assert.equal(beaufort(10), 5);
  assert.equal(beaufort(40), 12);
});
