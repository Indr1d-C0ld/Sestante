import { useEffect, useRef, useState } from "react";
import { stitchPlate } from "../core/api.ts";
import type { Hypothesis, Pin, Sheet, SheetStroke } from "../core/types.ts";
import type { Projection } from "../core/geo.ts";
import { applyFilter, FILTERS, type PlateFilter } from "../vision/filters.ts";
import type { Building } from "./load.ts";
import type { Drape } from "./LayersPanel.tsx";

type Tool = "sposta" | "penna" | "testo" | "misura" | "vai";
const COLORS = ["#d9442a", "#f0a02e", "#efe6c8", "#3fb0a8", "#141714"];

export function SheetPanel({
  drape,
  hypotheses,
  section,
  laser,
  plate,
  projection,
  sheet,
  pins,
  track,
  self,
  heading,
  buildings,
  bboxZoom,
  bbox,
  onChange,
  onTeleport,
  onSnapshot,
  onClose,
}: {
  drape: Drape | null;
  hypotheses: Hypothesis[];
  section: { x: number; z: number }[];
  laser: { x: number; z: number; good: boolean }[];
  plate: HTMLCanvasElement;
  projection: Projection;
  sheet: Sheet;
  pins: Pin[];
  track: number[];
  self: { x: number; z: number };
  heading: number;
  buildings: Building[];
  bboxZoom: number;
  bbox: { s: number; w: number; n: number; e: number };
  onChange: (sheet: Sheet) => void;
  onTeleport: (x: number, z: number) => void;
  onSnapshot: (canvas: HTMLCanvasElement) => void;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("sposta");
  const [color, setColor] = useState(COLORS[0]!);
  const [layer, setLayer] = useState<"lastra" | "topo" | "osm">("lastra");
  const [filter, setFilter] = useState<PlateFilter>("natural");
  const [base, setBase] = useState<HTMLCanvasElement>(plate);
  const [opacity, setOpacity] = useState(1);
  const [showFootprints, setShowFootprints] = useState(false);
  const [showDrape, setShowDrape] = useState(!!drape);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [draft, setDraft] = useState<SheetStroke | null>(null);
  const [measure, setMeasure] = useState<number[]>([]);
  const [hover, setHover] = useState("");
  const mapsCache = useRef(new Map<string, HTMLCanvasElement>());

  const W = plate.width;
  const H = plate.height;
  const toPx = (x: number, z: number) => ({ px: ((x + projection.halfX) / (2 * projection.halfX)) * W, py: ((z + projection.halfZ) / (2 * projection.halfZ)) * H });
  const toWorld = (px: number, py: number) => ({ x: (px / W) * 2 * projection.halfX - projection.halfX, z: (py / H) * 2 * projection.halfZ - projection.halfZ });

  useEffect(() => {
    const box = host.current!.getBoundingClientRect();
    const scale = Math.min(box.width / W, box.height / H) * 0.96;
    const p = toPx(self.x, self.z);
    setView({ scale, x: box.width / 2 - (Math.abs(scale * W) > box.width ? p.px * scale : (W * scale) / 2), y: box.height / 2 - (H * scale) / 2 });
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      let source = plate;
      if (layer !== "lastra") {
        const key = layer;
        let map = mapsCache.current.get(key);
        if (!map) {
          map = (await stitchPlate(bbox, layer === "topo" ? "topo" : "osm", Math.min(bboxZoom, layer === "topo" ? 18 : 17))).canvas;
          mapsCache.current.set(key, map);
        }
        source = map;
      }
      const shown = filter === "natural" || layer !== "lastra" ? source : applyFilter(source, filter);
      if (live) setBase(shown);
    })();
    return () => {
      live = false;
    };
  }, [layer, filter, plate]);

  const paint = (target: HTMLCanvasElement, width: number, height: number, v: typeof view, dpr: number, withSelf: boolean) => {
    const ctx = target.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0d100d";
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.scale, v.scale);
    ctx.globalAlpha = opacity;
    ctx.imageSmoothingEnabled = v.scale < 3;
    ctx.drawImage(base, 0, 0, W, H);
    ctx.globalAlpha = 1;
    if (drape && showDrape) {
      ctx.globalAlpha = 0.8;
      ctx.drawImage(drape.canvas, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    for (const item of hypotheses) {
      ctx.strokeStyle = item.color;
      ctx.fillStyle = "rgba(255,181,74,.2)";
      ctx.lineWidth = 2 / v.scale;
      ctx.beginPath();
      for (let i = 0; i < item.ring.length; i += 2) {
        const p = toPx(item.ring[i]!, item.ring[i + 1]!);
        if (i === 0) ctx.moveTo(p.px, p.py);
        else ctx.lineTo(p.px, p.py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    for (const shot of laser) {
      const p = toPx(shot.x, shot.z);
      ctx.strokeStyle = shot.good ? "#7fb4ff" : "rgba(170,170,165,.6)";
      ctx.lineWidth = 1.6 / v.scale;
      ctx.beginPath();
      ctx.arc(p.px, p.py, (12.5 / (2 * projection.halfX)) * W, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (section.length > 1) {
      ctx.strokeStyle = "#d95926";
      ctx.lineWidth = 2.4 / v.scale;
      ctx.beginPath();
      section.forEach((point, index) => {
        const p = toPx(point.x, point.z);
        if (index === 0) ctx.moveTo(p.px, p.py);
        else ctx.lineTo(p.px, p.py);
      });
      ctx.stroke();
    }
    if (showFootprints) {
      ctx.strokeStyle = "rgba(255,190,110,.85)";
      ctx.lineWidth = 1.1 / v.scale;
      for (const building of buildings) {
        if (building.hidden) continue;
        const ring = building.rings[0]!;
        ctx.beginPath();
        for (let i = 0; i < ring.length; i += 2) {
          const p = toPx(ring[i]!, ring[i + 1]!);
          if (i === 0) ctx.moveTo(p.px, p.py);
          else ctx.lineTo(p.px, p.py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
    if (track.length > 2) {
      ctx.strokeStyle = "rgba(255,255,255,.75)";
      ctx.setLineDash([5 / v.scale, 4 / v.scale]);
      ctx.lineWidth = 1.6 / v.scale;
      ctx.beginPath();
      for (let i = 0; i < track.length; i += 2) {
        const p = toPx(track[i]!, track[i + 1]!);
        if (i === 0) ctx.moveTo(p.px, p.py);
        else ctx.lineTo(p.px, p.py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const strokes = draft ? [...sheet.strokes, draft] : sheet.strokes;
    for (const stroke of strokes) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width / v.scale;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i < stroke.pts.length; i += 2) {
        const p = toPx(stroke.pts[i]!, stroke.pts[i + 1]!);
        if (i === 0) ctx.moveTo(p.px, p.py);
        else ctx.lineTo(p.px, p.py);
      }
      ctx.stroke();
    }
    ctx.textBaseline = "middle";
    for (const label of sheet.labels) {
      const p = toPx(label.x, label.z);
      ctx.font = `600 ${14 / v.scale}px "IBM Plex Sans", sans-serif`;
      const w = ctx.measureText(label.text).width;
      ctx.fillStyle = "rgba(14,16,14,.74)";
      ctx.fillRect(p.px - 3 / v.scale, p.py - 11 / v.scale, w + 6 / v.scale, 22 / v.scale);
      ctx.fillStyle = label.color;
      ctx.fillText(label.text, p.px, p.py);
    }
    for (const pin of pins) {
      const p = toPx(pin.x, pin.z);
      ctx.fillStyle = pin.color;
      ctx.beginPath();
      ctx.arc(p.px, p.py, 5 / v.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `${12 / v.scale}px "IBM Plex Sans", sans-serif`;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 2.4 / v.scale;
      ctx.strokeText(pin.label, p.px + 8 / v.scale, p.py);
      ctx.fillText(pin.label, p.px + 8 / v.scale, p.py);
    }
    if (measure.length >= 2) {
      ctx.strokeStyle = "#ffd27a";
      ctx.lineWidth = 2 / v.scale;
      ctx.beginPath();
      for (let i = 0; i < measure.length; i += 2) {
        const p = toPx(measure[i]!, measure[i + 1]!);
        if (i === 0) ctx.moveTo(p.px, p.py);
        else ctx.lineTo(p.px, p.py);
      }
      ctx.stroke();
    }
    if (withSelf) {
      const p = toPx(self.x, self.z);
      ctx.translate(p.px, p.py);
      ctx.rotate((heading * Math.PI) / 180);
      ctx.fillStyle = "#ff5a2a";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.6 / v.scale;
      const r = 12 / v.scale;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.62, r * 0.75);
      ctx.lineTo(0, r * 0.3);
      ctx.lineTo(-r * 0.62, r * 0.75);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  };

  useEffect(() => {
    const target = canvas.current!;
    const box = host.current!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    target.width = box.width * dpr;
    target.height = box.height * dpr;
    paint(target, box.width, box.height, view, dpr, true);
    const ctx = target.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // North arrow and scale bar stay on the glass, not on the paper.
    ctx.fillStyle = "#eae2cf";
    ctx.strokeStyle = "#141714";
    ctx.font = "600 13px 'IBM Plex Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.strokeText("N", box.width - 24, 30);
    ctx.fillText("N", box.width - 24, 30);
    ctx.beginPath();
    ctx.moveTo(box.width - 24, 40);
    ctx.lineTo(box.width - 18, 58);
    ctx.lineTo(box.width - 30, 58);
    ctx.closePath();
    ctx.fill();
    const mPerPx = (2 * projection.halfX) / W / view.scale;
    const nice = [5, 10, 20, 50, 100, 200, 500, 1000, 2000].find((m) => m / mPerPx >= 70) ?? 2000;
    ctx.fillRect(16, box.height - 22, nice / mPerPx, 4);
    ctx.textAlign = "left";
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 16, box.height - 32);
    ctx.textAlign = "start";
  }, [base, view, sheet, pins, track, draft, measure, showFootprints, opacity, self.x, self.z, heading, showDrape]);

  const worldAt = (e: React.PointerEvent | PointerEvent) => {
    const box = host.current!.getBoundingClientRect();
    return toWorld((e.clientX - box.left - view.x) / view.scale, (e.clientY - box.top - view.y) / view.scale);
  };

  const onDown = (event: React.PointerEvent) => {
    const start = { x: event.clientX, y: event.clientY, view: { ...view } };
    const w0 = worldAt(event);
    if (tool === "testo") {
      const text = window.prompt("Testo sulla carta:");
      if (text) onChange({ ...sheet, labels: [...sheet.labels, { x: w0.x, z: w0.z, text, color }] });
      return;
    }
    if (tool === "vai") {
      onTeleport(w0.x, w0.z);
      return;
    }
    if (tool === "misura") {
      setMeasure((m) => [...m, w0.x, w0.z]);
      return;
    }
    let stroke: SheetStroke | null = tool === "penna" ? { color, width: 2.6, pts: [w0.x, w0.z] } : null;
    if (stroke) setDraft(stroke);
    const move = (e: PointerEvent) => {
      if (stroke) {
        const w = worldAt(e);
        stroke = { ...stroke, pts: [...stroke.pts, w.x, w.z] };
        setDraft(stroke);
      } else setView({ ...start.view, x: start.view.x + e.clientX - start.x, y: start.view.y + e.clientY - start.y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (stroke && stroke.pts.length >= 4) onChange({ ...sheet, strokes: [...sheet.strokes, stroke] });
      setDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const measureLength = () => {
    let sum = 0;
    for (let i = 2; i < measure.length; i += 2) sum += Math.hypot(measure[i]! - measure[i - 2]!, measure[i + 1]! - measure[i - 1]!);
    return sum;
  };

  const snapshot = () => {
    const out = document.createElement("canvas");
    const scale = Math.min(1, 2048 / Math.max(W, H));
    out.width = W * scale;
    out.height = H * scale;
    paint(out, out.width, out.height, { x: 0, y: 0, scale }, 1, true);
    onSnapshot(out);
  };

  return (
    <div className="panel" style={{ width: "100%" }} onClick={(e) => e.stopPropagation()}>
      <header className="panel-head">
        <h2 className="grow">Carta e lastra</h2>
        <button className="btn tiny" onClick={snapshot}>
          Allega al registro
        </button>
        <button className="btn tiny" onClick={onClose}>
          Chiudi (M)
        </button>
      </header>
      <div className="sheet" style={{ flex: 1, minHeight: 0 }}>
        <div
          className="sheet-view"
          ref={host}
          style={{ cursor: tool === "sposta" ? "grab" : "crosshair" }}
          onPointerDown={onDown}
          onPointerMove={(e) => {
            const w = worldAt(e);
            const { lat, lon } = projection.toLatLon(w.x, w.z);
            setHover(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
          }}
          onWheel={(e) => {
            const box = host.current!.getBoundingClientRect();
            const mx = e.clientX - box.left;
            const my = e.clientY - box.top;
            const factor = Math.exp(-e.deltaY * 0.0014);
            setView((v) => {
              const scale = Math.max(0.05, Math.min(14, v.scale * factor));
              return { scale, x: mx - ((mx - v.x) / v.scale) * scale, y: my - ((my - v.y) / v.scale) * scale };
            });
          }}
        >
          <canvas ref={canvas} />
        </div>
        <aside className="sheet-tools">
          <div className="stack">
            <b className="small">Strumento</b>
            <div className="row wrap">
              {(["sposta", "penna", "testo", "misura", "vai"] as Tool[]).map((name) => (
                <button key={name} className={`btn tiny ${tool === name ? "on" : ""}`} onClick={() => setTool(name)}>
                  {name}
                </button>
              ))}
            </div>
            <div className="row">
              {COLORS.map((c) => (
                <button key={c} aria-label={`colore ${c}`} className={`swatch ${color === c ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
              ))}
            </div>
            <div className="row">
              <button className="btn tiny" disabled={!sheet.strokes.length} onClick={() => onChange({ ...sheet, strokes: sheet.strokes.slice(0, -1) })}>
                Annulla tratto
              </button>
              <button className="btn tiny" disabled={!sheet.labels.length} onClick={() => onChange({ ...sheet, labels: sheet.labels.slice(0, -1) })}>
                −testo
              </button>
            </div>
          </div>
          {tool === "misura" && (
            <div className="stack">
              <span className="mono small">{measureLength().toFixed(1)} m</span>
              <button className="btn tiny" onClick={() => setMeasure([])}>
                Azzera
              </button>
            </div>
          )}
          <div className="stack">
            <b className="small">Fondo</b>
            <select value={layer} onChange={(e) => setLayer(e.target.value as typeof layer)}>
              <option value="lastra">Lastra in uso</option>
              <option value="topo">Carta topografica</option>
              <option value="osm">Carta OSM</option>
            </select>
            {layer === "lastra" && (
              <select value={filter} onChange={(e) => setFilter(e.target.value as PlateFilter)}>
                {FILTERS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
            <label className="field">
              Opacità
              <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
            </label>
            <label className="row small">
              <input type="checkbox" checked={showFootprints} onChange={(e) => setShowFootprints(e.target.checked)} />
              Sagome degli edifici
            </label>
            {drape && (
              <label className="row small">
                <input type="checkbox" checked={showDrape} onChange={(e) => setShowDrape(e.target.checked)} />
                {drape.label}
              </label>
            )}
          </div>
          <div className="mono small muted">{hover}</div>
          <p className="hint">Il segno rosso sei tu, la traccia tratteggiata è il tuo percorso. "vai" ti sposta dove clicchi.</p>
        </aside>
      </div>
    </div>
  );
}
