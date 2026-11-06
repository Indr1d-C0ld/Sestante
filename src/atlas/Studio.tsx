import { newExpedition } from "../core/types.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, imageCanvas, stitchPlate, type DeepLayer, type EarthScene } from "../core/api.ts";
import { bestZoom, formatLatLon, metersPerPixel, Projection, type Bbox } from "../core/geo.ts";
import type { Capture, FieldSpec, PlateRef, PlateVersion } from "../core/types.ts";
import { applyFilter, changeOverlay, detectChanges, FILTERS, isBlank, type ChangeCluster, type PlateFilter } from "../vision/filters.ts";

type Props = {
  spec: FieldSpec;
  initialCanvas?: HTMLCanvasElement;
  onBack: () => void;
  onDescend: (spec: FieldSpec, canvas: HTMLCanvasElement, findings: { title: string; text: string }[]) => void;
};

type View = { x: number; y: number; scale: number };
type CropBox = { x: number; y: number; w: number; h: number };
type Compare = { canvas: HTMLCanvasElement; label: string; mode: "tenda" | "alterna" | "differenza"; split: number; overlay: HTMLCanvasElement | null };

const CAPTURE_ROWS: [keyof Capture, string, (v: unknown) => string][] = [
  ["date", "Data di scatto", String],
  ["sensor", "Sensore", String],
  ["provider", "Fornitore", String],
  ["product", "Prodotto", String],
  ["resolution", "Risoluzione", (v) => `${v} m/px`],
  ["accuracy", "Accuratezza", (v) => `±${v} m`],
  ["block", "Blocco", String],
];

export function Studio({ spec: initialSpec, initialCanvas, onBack, onDescend }: Props) {
  const [spec, setSpec] = useState(initialSpec);
  const [plate, setPlate] = useState<HTMLCanvasElement | null>(initialCanvas ?? null);
  const [busy, setBusy] = useState("");
  const [versions, setVersions] = useState<PlateVersion[]>([]);
  const [listing, setListing] = useState(false);
  const [filter, setFilter] = useState<PlateFilter>("natural");
  const [filtered, setFiltered] = useState<HTMLCanvasElement | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [crop, setCrop] = useState<CropBox | null>(null);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [changes, setChanges] = useState<ChangeCluster[]>([]);
  const [findings, setFindings] = useState<{ title: string; text: string }[]>([]);
  const [saved, setSaved] = useState<"" | "busy" | "done" | "failed">("");
  const [read, setRead] = useState("");
  const [tab, setTab] = useState<"scheda" | "tempo" | "lettura">("scheda");
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [blink, setBlink] = useState(false);
  const [focus, setFocus] = useState<ChangeCluster | null>(null);
  const [deep, setDeep] = useState<DeepLayer[]>([]);
  const [sentinel, setSentinel] = useState<EarthScene[]>([]);

  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projection = useMemo(() => new Projection(spec.bbox), [spec.bbox]);
  const mpp = (projection.halfX * 2) / (plate?.width ?? 1);

  const fit = useCallback((source: HTMLCanvasElement) => {
    const box = host.current?.getBoundingClientRect();
    if (!box) return;
    const scale = Math.min(box.width / source.width, box.height / source.height) * 0.96;
    setView({ scale, x: (box.width - source.width * scale) / 2, y: (box.height - source.height * scale) / 2 });
  }, []);

  const develop = useCallback(
    async (next: FieldSpec, ref: PlateRef) => {
      if (ref.kind === "upload") return;
      const source = ref.kind === "wayback" ? `wb-${ref.release}` : ref.source;
      setBusy("Sviluppo la lastra…");
      const { canvas } = await stitchPlate(next.bbox, source, next.zoom, (done, total) => setBusy(`Sviluppo la lastra: ${done}/${total}`));
      setBusy("");
      return canvas;
    },
    [],
  );

  // The plate is developed at once; what the archive holds for this place arrives on its own time.
  useEffect(() => {
    let live = true;
    const lat = projection.lat0;
    const lon = projection.lon0;
    setListing(true);
    api
      .versions(lat, lon, Math.min(17, initialSpec.zoom))
      .then((rows) => {
        if (!live) return;
        setVersions(rows);
        // The archive names the real shot behind the newest edition: adopt it unless another was picked meanwhile.
        setSpec((current) => {
          const newest = rows[0];
          if (!newest || current.plate.kind !== "wayback" || current.plate.capture) return current;
          return { ...current, plate: { ...current.plate, capture: newest.capture } };
        });
      })
      .catch(() => undefined)
      .finally(() => live && setListing(false));
    (async () => {
      if (initialSpec.plate.kind === "upload") {
        if (initialCanvas) fit(initialCanvas);
        return;
      }
      let ref = initialSpec.plate;
      if (ref.kind === "wayback" && ref.release === 0) {
        const newest = await api.newestRelease().catch(() => null);
        ref = newest
          ? { kind: "wayback", release: newest.release, published: newest.date, capture: null }
          : { kind: "tiles", source: "esri", label: "Esri World Imagery", attribution: "Esri, Maxar, Earthstar Geographics" };
      }
      if (ref.kind === "wayback") {
        const deep = await api.capture(ref.release, lat, lon, initialSpec.zoom).catch(() => null);
        if (deep) ref = { ...ref, capture: deep };
      }
      const next = { ...initialSpec, plate: ref };
      if (!live) return;
      setSpec(next);
      if (!initialCanvas) {
        const canvas = await develop(next, ref);
        if (live && canvas) {
          setPlate(canvas);
          fit(canvas);
        }
      }
    })().catch((error: Error) => setBusy(error.message));
    return () => {
      live = false;
    };
  }, []);

  // What lies beyond the sharp archive: decades of Landsat and the last year of Sentinel-2. Compared by eye, since pixels this coarse would flood a change detector.
  useEffect(() => {
    if (tab !== "tempo" || deep.length) return;
    api.deepLayers().then((rows) => setDeep(rows.filter((row) => row.id === "landsat"))).catch(() => undefined);
    const now = Date.now();
    api.earthScenes(spec.bbox, new Date(now - 365 * 86_400_000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10), 15).then((rows) => setSentinel(rows.slice(0, 12))).catch(() => undefined);
  }, [tab]);

  useEffect(() => {
    if (!plate) return;
    if (filter === "natural") return setFiltered(null);
    setFiltered(applyFilter(plate, filter));
  }, [plate, filter]);

  // Painting.
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = host.current?.getBoundingClientRect();
    if (!canvas || !box || !plate) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = box.width * dpr;
    canvas.height = box.height * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.imageSmoothingEnabled = view.scale < 2.5;
    const dw = plate.width * view.scale;
    const dh = plate.height * view.scale;
    const main = filtered ?? plate;
    const showOther = compare && (compare.mode === "alterna" ? blink : false);
    ctx.drawImage(showOther ? compare.canvas : main, view.x, view.y, dw, dh);
    if (compare?.mode === "tenda") {
      const split = view.x + dw * compare.split;
      ctx.save();
      ctx.beginPath();
      ctx.rect(view.x, view.y, Math.max(0, split - view.x), dh);
      ctx.clip();
      ctx.drawImage(compare.canvas, view.x, view.y, dw, dh);
      ctx.restore();
      ctx.fillStyle = "#cf7c3f";
      ctx.fillRect(split - 1, view.y, 2, dh);
      ctx.fillRect(split - 11, view.y + dh / 2 - 11, 22, 22);
    }
    if (compare?.mode === "differenza" && compare.overlay) ctx.drawImage(compare.overlay, view.x, view.y, dw, dh);
    if (compare?.mode === "differenza") {
      ctx.lineWidth = 1.5;
      for (const cluster of changes) {
        ctx.strokeStyle = cluster === focus ? "#fff" : "rgba(240,190,120,.85)";
        ctx.strokeRect(view.x + cluster.x * dw, view.y + cluster.y * dh, cluster.w * dw, cluster.h * dh);
      }
    }
    if (spec.focus) {
      const at = projection.toLocal(spec.focus.lat, spec.focus.lon);
      const { u, v } = projection.toUv(at.x, at.z);
      const fx = view.x + u * dw;
      const fy = view.y + v * dh;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(10,12,10,.85)";
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        ctx.moveTo(fx - 13, fy);
        ctx.lineTo(fx - 4, fy);
        ctx.moveTo(fx + 4, fy);
        ctx.lineTo(fx + 13, fy);
        ctx.moveTo(fx, fy - 13);
        ctx.lineTo(fx, fy - 4);
        ctx.moveTo(fx, fy + 4);
        ctx.lineTo(fx, fy + 13);
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#ffd27a";
      }
    }
    if (crop) {
      const cx = view.x + crop.x * dw;
      const cy = view.y + crop.y * dh;
      const cw = crop.w * dw;
      const ch = crop.h * dh;
      ctx.fillStyle = "rgba(8,10,8,.58)";
      ctx.fillRect(view.x, view.y, dw, cy - view.y);
      ctx.fillRect(view.x, cy + ch, dw, view.y + dh - cy - ch);
      ctx.fillRect(view.x, cy, cx - view.x, ch);
      ctx.fillRect(cx + cw, cy, view.x + dw - cx - cw, ch);
      ctx.strokeStyle = "#cf7c3f";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx, cy, cw, ch);
      ctx.fillStyle = "#eae2cf";
      for (const [hx, hy] of [
        [cx, cy],
        [cx + cw, cy],
        [cx, cy + ch],
        [cx + cw, cy + ch],
      ]) ctx.fillRect(hx! - 5, hy! - 5, 10, 10);
    }
  }, [plate, filtered, view, crop, compare, changes, blink, focus, spec.focus, projection]);

  useEffect(() => {
    if (compare?.mode !== "alterna") return;
    const timer = window.setInterval(() => setBlink((v) => !v), 650);
    return () => window.clearInterval(timer);
  }, [compare?.mode]);

  useEffect(() => {
    const onResize = () => setView((v) => ({ ...v }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const toPlate = (clientX: number, clientY: number) => {
    const box = host.current!.getBoundingClientRect();
    return { x: (clientX - box.left - view.x) / (plate!.width * view.scale), y: (clientY - box.top - view.y) / (plate!.height * view.scale) };
  };

  const onWheel = (event: React.WheelEvent) => {
    if (!plate) return;
    const box = host.current!.getBoundingClientRect();
    const mx = event.clientX - box.left;
    const my = event.clientY - box.top;
    const factor = Math.exp(-event.deltaY * 0.0014);
    setView((v) => {
      const scale = Math.max(0.05, Math.min(16, v.scale * factor));
      return { scale, x: mx - ((mx - v.x) / v.scale) * scale, y: my - ((my - v.y) / v.scale) * scale };
    });
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (!plate) return;
    const start = { px: event.clientX, py: event.clientY, view: { ...view } };
    const at = toPlate(event.clientX, event.clientY);
    let mode: "pan" | "new" | "move" | "corner" | "split" = "pan";
    let anchor = { x: at.x, y: at.y };
    const origin = crop ? { ...crop } : null;
    if (compare?.mode === "tenda" && Math.abs(at.x - compare.split) * plate.width * view.scale < 14) mode = "split";
    else if (cropMode) {
      mode = "new";
      if (crop) {
        const margin = 12 / (plate.width * view.scale);
        const corners = [
          [crop.x, crop.y, crop.x + crop.w, crop.y + crop.h],
          [crop.x + crop.w, crop.y, crop.x, crop.y + crop.h],
          [crop.x, crop.y + crop.h, crop.x + crop.w, crop.y],
          [crop.x + crop.w, crop.y + crop.h, crop.x, crop.y],
        ];
        const hit = corners.find((c) => Math.abs(c[0]! - at.x) < margin && Math.abs(c[1]! - at.y) < margin * (plate.width / plate.height));
        if (hit) {
          mode = "corner";
          anchor = { x: hit[2]!, y: hit[3]! };
        } else if (at.x > crop.x && at.x < crop.x + crop.w && at.y > crop.y && at.y < crop.y + crop.h) mode = "move";
      }
    }
    const move = (e: PointerEvent) => {
      if (mode === "pan") {
        setView({ ...start.view, x: start.view.x + e.clientX - start.px, y: start.view.y + e.clientY - start.py });
        return;
      }
      const now = toPlate(e.clientX, e.clientY);
      const clamp = (v: number) => Math.max(0, Math.min(1, v));
      if (mode === "split") setCompare((c) => (c ? { ...c, split: clamp(now.x) } : c));
      else if (mode === "move" && origin) {
        setCrop({
          ...origin,
          x: Math.max(0, Math.min(1 - origin.w, origin.x + now.x - at.x)),
          y: Math.max(0, Math.min(1 - origin.h, origin.y + now.y - at.y)),
        });
      } else {
        const x0 = clamp(Math.min(anchor.x, now.x));
        const x1 = clamp(Math.max(anchor.x, now.x));
        const y0 = clamp(Math.min(anchor.y, now.y));
        const y1 = clamp(Math.max(anchor.y, now.y));
        setCrop({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onHover = (event: React.PointerEvent) => {
    if (!plate) return;
    const at = toPlate(event.clientX, event.clientY);
    if (at.x < 0 || at.y < 0 || at.x > 1 || at.y > 1) return setRead("");
    const { lat, lon } = projection.toLatLon(at.x * projection.halfX * 2 - projection.halfX, at.y * projection.halfZ * 2 - projection.halfZ);
    setRead(formatLatLon(lat, lon));
  };

  const applyCrop = async () => {
    if (!crop || !plate || crop.w * plate.width < 32 || crop.h * plate.height < 32) return;
    const toLatLon = (u: number, v: number) => projection.toLatLon(u * projection.halfX * 2 - projection.halfX, v * projection.halfZ * 2 - projection.halfZ);
    const a = toLatLon(crop.x, crop.y);
    const b = toLatLon(crop.x + crop.w, crop.y + crop.h);
    const box: Bbox = { n: a.lat, w: a.lon, s: b.lat, e: b.lon };
    setCrop(null);
    setCropMode(false);
    setCompare(null);
    setChanges([]);
    if (spec.plate.kind === "upload") {
      const sx = Math.round(crop.x * plate.width);
      const sy = Math.round(crop.y * plate.height);
      const sw = Math.round(crop.w * plate.width);
      const sh = Math.round(crop.h * plate.height);
      const cut = document.createElement("canvas");
      cut.width = sw;
      cut.height = sh;
      cut.getContext("2d")!.drawImage(plate, sx, sy, sw, sh, 0, 0, sw, sh);
      setSpec({ ...spec, bbox: box });
      setPlate(cut);
      fit(cut);
      return;
    }
    // A tighter box can afford a deeper zoom: the crop is redeveloped, not just cut.
    const next = { ...spec, bbox: box, zoom: bestZoom(box, 6144, 19) };
    setSpec(next);
    const canvas = await develop(next, next.plate);
    if (canvas) {
      setPlate(canvas);
      fit(canvas);
    }
  };

  const chooseVersion = async (row: PlateVersion) => {
    const ref: PlateRef = { kind: "wayback", release: row.release, published: row.published, capture: row.capture };
    const next = { ...spec, plate: ref };
    setSpec(next);
    setCompare(null);
    setChanges([]);
    const canvas = await develop(next, ref);
    if (canvas) setPlate(canvas);
    const deep = await api.capture(row.release, projection.lat0, projection.lon0, spec.zoom).catch(() => null);
    if (deep) setSpec({ ...next, plate: { ...ref, capture: deep } });
  };

  const startCompare = async (row: PlateVersion, mode: Compare["mode"]) => {
    if (!plate) return;
    const { canvas } = await stitchPlate(spec.bbox, `wb-${row.release}`, spec.zoom, (done, total) => setBusy(`Sviluppo il confronto: ${done}/${total}`));
    setBusy("");
    const result = detectChanges(plate, canvas, mpp);
    setChanges(result.clusters);
    setCompare({ canvas, label: row.capture?.date ?? row.published, mode, split: 0.5, overlay: changeOverlay(result) });
  };

  const compareCoarse = async (label: string, load: () => Promise<HTMLCanvasElement>) => {
    setBusy(`Sviluppo ${label}…`);
    try {
      const canvas = await load();
      if (isBlank(canvas)) throw new Error(`${label} non copre questo luogo: prova un'altra data.`);
      setChanges([]);
      setCompare({ canvas, label, mode: "tenda", split: 0.5, overlay: null });
      setBusy("");
    } catch (error) {
      setBusy((error as Error).message);
      window.setTimeout(() => setBusy(""), 5000);
    }
  };

  const compareLandsat = (layer: DeepLayer, time: string) =>
    compareCoarse(`Landsat ${time.slice(0, 4)}`, async () => (await stitchPlate(spec.bbox, `gibs/${layer.id}/${time}`, Math.min(layer.maxZoom, bestZoom(spec.bbox, 2048, layer.maxZoom)))).canvas);

  const compareSentinel = (scene: EarthScene) => {
    const k = Math.min(1, 1600 / ((Math.max(projection.halfX, projection.halfZ) * 2) / 10));
    return compareCoarse(`Sentinel-2 ${scene.date}`, () => imageCanvas(api.earthImageUrl(spec.bbox, "vero", scene.date, null, Math.max(96, (projection.halfX * 2 * k) / 10), Math.max(96, (projection.halfZ * 2 * k) / 10))));
  };

  const noteChange = (cluster: ChangeCluster) => {
    const { lat, lon } = projection.toLatLon((cluster.x + cluster.w / 2) * projection.halfX * 2 - projection.halfX, (cluster.y + cluster.h / 2) * projection.halfZ * 2 - projection.halfZ);
    setFindings((rows) => [
      ...rows,
      {
        title: `Variazione: ${cluster.kind}`,
        text: `${cluster.area.toFixed(0)} m² fra ${compare?.label ?? "la lastra di confronto"} e la lastra in uso, presso ${formatLatLon(lat, lon)}.`,
      },
    ]);
  };

  const zoomTo = (cluster: ChangeCluster) => {
    if (!plate) return;
    setFocus(cluster);
    const box = host.current!.getBoundingClientRect();
    const scale = Math.min(10, Math.min(box.width / (cluster.w * plate.width), box.height / (cluster.h * plate.height)) * 0.45);
    setView({
      scale,
      x: box.width / 2 - (cluster.x + cluster.w / 2) * plate.width * scale,
      y: box.height / 2 - (cluster.y + cluster.h / 2) * plate.height * scale,
    });
  };

  const capture = spec.plate.kind === "tiles" ? null : spec.plate.capture;
  const scalePx = 90;
  const groundPerPx = mpp / Math.max(view.scale, 1e-4);
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((m) => m / groundPerPx >= scalePx * 0.6) ?? 5000;
  const activeHash = spec.plate.kind === "wayback" ? spec.plate.capture?.date ?? spec.plate.release : -1;
  const isActive = (row: PlateVersion) => (spec.plate.kind === "wayback" ? row.release === spec.plate.release || (row.capture?.date != null && row.capture.date === activeHash) : false);

  return (
    <div className="studio">
      <div className="viewer" ref={host} onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onHover} style={{ cursor: cropMode ? "crosshair" : "grab" }}>
        <canvas ref={canvasRef} />
        <div className="viewer-tools" onPointerDown={(e) => e.stopPropagation()}>
          <button className="btn tiny" onClick={onBack}>
            ← Atlante
          </button>
          <button className="btn tiny" onClick={() => plate && fit(plate)}>
            Adatta
          </button>
          <button className="btn tiny" onClick={() => setView((v) => ({ ...v, scale: 1, x: v.x, y: v.y }))}>
            1:1
          </button>
          <button
            className={`btn tiny ${cropMode ? "on" : ""}`}
            onClick={() => {
              setCropMode((v) => !v);
              if (cropMode) setCrop(null);
            }}
          >
            Ritaglia
          </button>
          {crop && (
            <button className="btn tiny primary" onClick={() => void applyCrop()}>
              Applica ritaglio ({(crop.w * projection.halfX * 2).toFixed(0)} × {(crop.h * projection.halfZ * 2).toFixed(0)} m)
            </button>
          )}
          {compare && (
            <>
              <span className="btn tiny ghost">Confronto: {compare.label}</span>
              {(["tenda", "alterna", "differenza"] as const).map((mode) => (
                <button key={mode} className={`btn tiny ${compare.mode === mode ? "on" : ""}`} onClick={() => setCompare({ ...compare, mode })}>
                  {mode}
                </button>
              ))}
              <button className="btn tiny" onClick={() => setCompare(null)}>
                Chiudi
              </button>
            </>
          )}
        </div>
        <div className="viewer-read mono">
          <span className="scale" style={{ width: nice / groundPerPx }} />
          {nice >= 1000 ? `${nice / 1000} km` : `${nice} m`} · {(view.scale * 100).toFixed(0)}% {read && `· ${read}`}
        </div>
        {busy && (
          <div className="viewer-read" style={{ left: "50%", bottom: "auto", top: "50%", transform: "translate(-50%,-50%)" }}>
            {busy}
          </div>
        )}
      </div>
      <aside className="studio-side">
        <header className="studio-head">
          <h2>{spec.name}</h2>
          <div className="muted small mono">
            {(projection.halfX * 2).toFixed(0)} × {(projection.halfZ * 2).toFixed(0)} m · z{spec.zoom} · {metersPerPixel(projection.lat0, spec.zoom).toFixed(2)} m/px
          </div>
        </header>
        <div className="tabs">
          {(
            [
              ["scheda", "Scheda"],
              ["tempo", `Tempo${versions.length ? ` (${versions.length})` : ""}`],
              ["lettura", "Fotolettura"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="side-body">
          {tab === "scheda" && (
            <>
              <div>
                <div className="section-title">Metadati dello scatto</div>
                {capture ? (
                  <dl className="kv">
                    {CAPTURE_ROWS.map(([key, label, format]) =>
                      capture[key] != null ? (
                        <div key={key} style={{ display: "contents" }}>
                          <dt>{label}</dt>
                          <dd>{format(capture[key])}</dd>
                        </div>
                      ) : null,
                    )}
                  </dl>
                ) : (
                  <p className="hint">Questa fonte non pubblica metadati per pixel. Il sole sarà letto solo dalle ombre.</p>
                )}
              </div>
              <div>
                <div className="section-title">Riquadro</div>
                <dl className="kv">
                  {spec.focus && (
                    <>
                      <dt>Punto scelto</dt>
                      <dd>
                        {formatLatLon(spec.focus.lat, spec.focus.lon)} · {spec.focus.format}
                        {spec.focus.precision != null && spec.focus.precision >= 1 ? ` · ±${spec.focus.precision < 10 ? spec.focus.precision.toFixed(1) : Math.round(spec.focus.precision)} m` : ""}
                      </dd>
                    </>
                  )}
                  <dt>Nord-ovest</dt>
                  <dd>{formatLatLon(spec.bbox.n, spec.bbox.w)}</dd>
                  <dt>Sud-est</dt>
                  <dd>{formatLatLon(spec.bbox.s, spec.bbox.e)}</dd>
                  <dt>Lastra</dt>
                  <dd>
                    {plate ? `${plate.width} × ${plate.height} px` : "…"} · {mpp.toFixed(2)} m/px
                  </dd>
                </dl>
              </div>
              <p className="hint">Rotella per lo zoom, trascina per spostarti. "Ritaglia" stringe il campo al riquadro che disegni: la lastra viene risviluppata più in profondità se l'archivio lo permette.</p>
              {findings.length > 0 && (
                <div>
                  <div className="section-title">Da portare nel registro</div>
                  {findings.map((row, index) => (
                    <p key={index} className="small" style={{ margin: "3px 0" }}>
                      {row.title}: {row.text}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
          {tab === "tempo" && (
            <>
              <p className="hint">L'archivio Wayback di Esri ha 198 edizioni, ma molte ripubblicano la stessa foto. Qui sono elencate solo le riprese davvero diverse per questo punto, con la data reale dello scatto.</p>
              {versions.length === 0 && <p className="hint">{listing ? "Chiedo all'archivio quante riprese esistono di questo luogo…" : "Nessuna ripresa storica trovata."}</p>}
              <div>
                {versions.map((row) => (
                  <div key={row.release} className={`version ${isActive(row) ? "on" : ""}`}>
                    <div>
                      <b>{row.capture?.date ?? `pubbl. ${row.published}`}</b>
                      <div className="small">
                        {row.capture?.sensor ?? "sensore ignoto"}
                        {row.capture?.resolution ? ` · ${row.capture.resolution} m/px` : ""} · {row.count} ed.
                      </div>
                    </div>
                    <div className="row" style={{ gridRow: "1 / span 2", gridColumn: 2 }}>
                      <button className="btn tiny" disabled={isActive(row)} onClick={() => void chooseVersion(row)}>
                        Usa
                      </button>
                      <button className="btn tiny" disabled={isActive(row)} onClick={() => void startCompare(row, "tenda")}>
                        Confronta
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {deep.map((layer) => (
                <div key={layer.id}>
                  <div className="section-title">Passato remoto: {layer.label}</div>
                  <p className="hint">{layer.note} Il confronto a tenda mostra com'era prima dell'alta risoluzione.</p>
                  <div className="chips">
                    {layer.times.map((time) => (
                      <button key={time} className="btn tiny" disabled={!plate || !!busy} onClick={() => void compareLandsat(layer, time)}>
                        {time.slice(0, 4)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {sentinel.length > 0 && (
                <div>
                  <div className="section-title">Ultimo anno: Sentinel-2</div>
                  <p className="hint">10 m per pixel, poche nubi. Qui si vede la stagione, non il dettaglio.</p>
                  <div className="chips">
                    {sentinel.map((scene) => (
                      <button key={scene.date} className="btn tiny" disabled={!plate || !!busy} onClick={() => void compareSentinel(scene)}>
                        {scene.date}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {changes.length > 0 && (
                <div>
                  <div className="section-title">{changes.length} variazioni rilevate</div>
                  <p className="hint">Differenze dopo aver normalizzato luce e colore. Le ombre dei due scatti cadono diverse: controlla ogni voce a occhio.</p>
                  {changes.slice(0, 16).map((cluster, index) => (
                    <div key={index} className="row">
                      <button className="change grow" onClick={() => zoomTo(cluster)}>
                        {cluster.kind} <span className="muted small mono">{cluster.area.toFixed(0)} m²</span>
                      </button>
                      <button className="btn tiny" onClick={() => noteChange(cluster)}>
                        Annota
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {tab === "lettura" && (
            <>
              <div className="chips">
                {FILTERS.map((item) => (
                  <button key={item.id} className={`btn tiny ${filter === item.id ? "on" : ""}`} onClick={() => setFilter(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="hint">{FILTERS.find((item) => item.id === filter)?.note}</p>
            </>
          )}
        </div>
        <footer className="studio-foot">
          <button
            className="btn"
            disabled={saved === "busy"}
            onClick={() => {
              setSaved("busy");
              // Never over an existing investigation: only what the Studio adds joins it.
              void api
                .expedition(spec.id)
                .catch(() => newExpedition(spec))
                .then((value) => api.saveExpedition({ ...value, studioFindings: [...(value.studioFindings ?? []).filter((row) => !findings.some((item) => item.title === row.title)), ...findings] }))
                .then(() => setSaved("done"))
                .catch(() => setSaved("failed"));
            }}
          >
            {saved === "done" ? "Salvata nell'archivio" : saved === "failed" ? "Salvataggio non riuscito" : "Salva nell'archivio"}
          </button>
          <button className="btn primary grow" disabled={!plate || !!busy} onClick={() => plate && onDescend(spec, plate, findings)}>
            Scendi sul campo
          </button>
        </footer>
      </aside>
    </div>
  );
}
