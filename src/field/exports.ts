import type { Expedition } from "../core/types.ts";

export function saveFile(name: string, content: string | Blob, type = "application/octet-stream") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const csvCell = (value: unknown) => {
  const text = String(value ?? "");
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function notesCsv(expedition: Expedition) {
  const keys = [...new Set(expedition.notes.flatMap((note) => Object.keys(note.values ?? {})))];
  const head = ["creata", "ora_simulata", "tipo", "strumento", "titolo", "testo", "lat", "lon", "quota_m", "azimut", "lastra", "meteo", ...keys];
  const rows = [...expedition.notes].reverse().map((note) => [note.created, note.simTime, note.kind, note.instrument, note.title, note.text, note.lat, note.lon, note.elev, note.heading, note.plate, note.weather, ...keys.map((key) => note.values?.[key])].map(csvCell).join(","));
  return `${head.map(csvCell).join(",")}\n${rows.join("\n")}\n`;
}

/** Everything that has a shape, as GeoJSON for QGIS: notes, stakes, track, drawn strokes and proposed volumes. */
export function geoJson(expedition: Expedition, toLatLon: (x: number, z: number) => { lat: number; lon: number }) {
  const line = (pts: number[]) => {
    const out: number[][] = [];
    for (let i = 0; i < pts.length; i += 2) {
      const { lat, lon } = toLatLon(pts[i]!, pts[i + 1]!);
      out.push([lon, lat]);
    }
    return out;
  };
  const features: unknown[] = expedition.notes.map((note) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [note.lon, note.lat, note.elev] },
    properties: { kind: note.kind, instrument: note.instrument, title: note.title, text: note.text, time: note.simTime, ...note.values },
  }));
  for (const pin of expedition.pins) {
    const { lat, lon } = toLatLon(pin.x, pin.z);
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat, pin.y] }, properties: { kind: "picchetto", title: pin.label } });
  }
  if (expedition.track.length > 2) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line(expedition.track) }, properties: { kind: "traccia" } });
  for (const stroke of expedition.sheet.strokes) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line(stroke.pts) }, properties: { kind: "segno", color: stroke.color } });
  for (const label of expedition.sheet.labels) {
    const { lat, lon } = toLatLon(label.x, label.z);
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { kind: "scritta", title: label.text } });
  }
  for (const item of expedition.hypotheses ?? []) {
    const ring = line(item.ring);
    features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] }, properties: { kind: "ipotesi", title: item.name, height: item.height, note: item.note, verdict: item.verdict } });
  }
  return JSON.stringify({ type: "FeatureCollection", features }, null, 1);
}

/** ASCII DXF in local metres, x east and y north: opens in any CAD. Origin is the centre of the box, written in the header comment. */
export function dxf(expedition: Expedition, origin: { lat: number; lon: number }) {
  const out: string[] = ["999", `Sestante ${expedition.spec.name}: metri locali, origine ${origin.lat.toFixed(6)} ${origin.lon.toFixed(6)}, X est, Y nord`, "0", "SECTION", "2", "ENTITIES"];
  const poly = (layer: string, pts: number[], closed = false) => {
    out.push("0", "POLYLINE", "8", layer, "66", "1", "70", closed ? "1" : "0");
    for (let i = 0; i < pts.length; i += 2) out.push("0", "VERTEX", "8", layer, "10", pts[i]!.toFixed(3), "20", (-pts[i + 1]!).toFixed(3), "30", "0");
    out.push("0", "SEQEND");
  };
  const text = (layer: string, x: number, z: number, value: string) => out.push("0", "TEXT", "8", layer, "10", x.toFixed(3), "20", (-z).toFixed(3), "30", "0", "40", "1.5", "1", value.replace(/\n/g, " ").slice(0, 200));
  if (expedition.track.length > 2) poly("TRACCIA", expedition.track);
  for (const stroke of expedition.sheet.strokes) poly("SEGNI", stroke.pts);
  for (const label of expedition.sheet.labels) text("SCRITTE", label.x, label.z, label.text);
  for (const pin of expedition.pins) {
    out.push("0", "POINT", "8", "PICCHETTI", "10", pin.x.toFixed(3), "20", (-pin.z).toFixed(3), "30", pin.y.toFixed(3));
    text("PICCHETTI", pin.x + 1, pin.z, pin.label);
  }
  for (const item of expedition.hypotheses ?? []) {
    poly("IPOTESI", item.ring, true);
    text("IPOTESI", item.ring[0]!, item.ring[1]!, `${item.name} h=${item.height.toFixed(1)}`);
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return out.join("\n");
}
