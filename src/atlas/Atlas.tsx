import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GeocodeHit } from "../core/api.ts";
import { parseCoordinates, precisionWords, type ParsedPoint } from "../core/coords.ts";
import { bboxSizeMeters, bestZoom, boxAround, formatLatLon, frameFillsView, latToMy, lonToMx, metersPerPixel, parseKmlBbox, Projection, type Bbox } from "../core/geo.ts";
import type { DownloadJob, FieldSpec, FocusPoint, TileSourceInfo } from "../core/types.ts";
import { Archive } from "./Archive.tsx";
import { readManualPlate } from "./manual.ts";

maplibregl.setWorkerUrl(workerUrl);

type Props = { onOpen: (spec: FieldSpec, plate?: HTMLCanvasElement) => void; onResume: (id: string, study?: string) => void; initial?: Bbox };

const START: Bbox = { s: 41.8876, w: 12.4877, n: 41.8930, e: 12.4967 };

const newId = () => `sp-${Date.now().toString(36)}`;

const boxBounds = (box: Bbox): [[number, number], [number, number]] => [
  [box.w, box.s],
  [box.e, box.n],
];

function rasterStyle(source: string, maxzoom: number): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      base: { type: "raster", tiles: [`${location.origin}/api/tile/${source}/{z}/{x}/{y}`], tileSize: 256, maxzoom, attribution: "" },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  };
}

export function Atlas({ onOpen, onResume, initial }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const selRef = useRef<HTMLDivElement>(null);
  const [bbox, setBbox] = useState<Bbox>(initial ?? START);
  const bboxRef = useRef(bbox);
  bboxRef.current = bbox;
  const [frame, setFrame] = useState({ left: 0, top: 0, width: 0, height: 0, fills: false });
  const [tab, setTab] = useState<"luogo" | "archivio" | "manuale" | "scarichi">(new URLSearchParams(location.search).has("archivio") ? "archivio" : "luogo");
  const [sources, setSources] = useState<TileSourceInfo[]>([]);
  const [sourcesProblem, setSourcesProblem] = useState<string | null>(null);
  const [viewSource, setViewSource] = useState("esri");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [status, setStatus] = useState("");
  const [name, setName] = useState("Colosseo, Roma");
  const [trips, setTrips] = useState<Awaited<ReturnType<typeof api.expeditions>>>([]);
  const [focus, setFocus] = useState<FocusPoint | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const size = useMemo(() => bboxSizeMeters(bbox), [bbox]);
  // The true centre in the plate's own frame, not the middle of the degrees.
  const { lat0: lat, lon0: lon } = useMemo(() => new Projection(bbox), [bbox]);
  const recognised = useMemo(() => parseCoordinates(query, { lat, lon }), [query, lat, lon]);
  const zoom = bestZoom(bbox, 6144, 19);
  const mpp = metersPerPixel(lat, zoom);
  const tooBig = size.width > 6000 || size.height > 6000;

  const loadSources = () => {
    api.sources().then(setSources).catch(() => undefined);
    api.sourcesProblem().then((row) => setSourcesProblem(row.problem)).catch(() => undefined);
  };

  const syncFrame = () => {
    const map = mapRef.current;
    if (!map) return;
    const a = map.project([bboxRef.current.w, bboxRef.current.n]);
    const b = map.project([bboxRef.current.e, bboxRef.current.s]);
    const box = { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
    const view = map.getContainer();
    setFrame({ ...box, fills: frameFillsView(box, view.clientWidth, view.clientHeight) });
  };

  useEffect(() => {
    if (!host.current) return;
    const map = new maplibregl.Map({
      container: host.current,
      style: rasterStyle("esri", 19),
      bounds: [
        [bbox.w, bbox.s],
        [bbox.e, bbox.n],
      ],
      fitBoundsOptions: { padding: 140 },
      maxPitch: 0,
      dragRotate: false,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    map.on("move", syncFrame);
    map.on("resize", syncFrame);
    map.on("load", syncFrame);
    mapRef.current = map;
    // The frame lies above the map: zooming over it must still reach the map, or a zoomed-in view has no way back.
    const sel = selRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      map.getCanvasContainer().dispatchEvent(new WheelEvent("wheel", e));
    };
    const onDoubleClick = (e: MouseEvent) => map.getCanvasContainer().dispatchEvent(new MouseEvent("dblclick", e));
    sel.addEventListener("wheel", onWheel, { passive: false });
    sel.addEventListener("dblclick", onDoubleClick);
    loadSources();
    // The list of sources can be edited by hand, in another window.
    window.addEventListener("focus", loadSources);
    api.expeditions().then(setTrips).catch(() => undefined);
    return () => {
      window.removeEventListener("focus", loadSources);
      sel.removeEventListener("wheel", onWheel);
      sel.removeEventListener("dblclick", onDoubleClick);
      map.remove();
    };
  }, []);

  useEffect(syncFrame, [bbox]);

  const changeSource = (id: string) => {
    setViewSource(id);
    const source = sources.find((item) => item.id === id);
    mapRef.current?.setStyle(rasterStyle(id, source?.maxZoom ?? 19));
  };

  const place = (latitude: number, longitude: number, meters = 800, label?: string) => {
    const box = boxAround(latitude, longitude, meters, meters);
    setBbox(box);
    if (label) setName(label);
    mapRef.current?.fitBounds(
      [
        [box.w, box.s],
        [box.e, box.n],
      ],
      { padding: 140, duration: 900 },
    );
  };

  /** A point becomes the exact centre of the shot. Its side survives from whatever box was there, unless a map link says its own scale. */
  const centerOn = (row: ParsedPoint) => {
    const meters = row.zoom ? Math.min(3000, Math.max(250, 1500 * 2 ** (16 - row.zoom))) : Math.round(Math.max(size.width, size.height));
    place(row.lat, row.lon, meters, `Punto ${row.lat.toFixed(5)}, ${row.lon.toFixed(5)}`);
    setFocus({ lat: row.lat, lon: row.lon, format: row.format, precision: row.precision });
    setStatus("");
    setHits([]);
  };

  /** Resizes around the centre, so that a chosen point stays exactly in the middle. */
  const setSide = (meters: number) => {
    const c = focus ?? { lat, lon };
    setBbox(boxAround(c.lat, c.lon, meters, meters));
    if (meters > Math.max(size.width, size.height) * 1.2 || meters < Math.max(size.width, size.height) * 0.8) {
      mapRef.current?.fitBounds(boxBounds(boxAround(c.lat, c.lon, meters, meters)), { padding: 140, duration: 500 });
    }
  };

  const search = async () => {
    const text = query.trim();
    if (!text) return;
    if (recognised) return centerOn(recognised);
    setFocus(null);
    setStatus("Cerco…");
    try {
      const rows = await api.geocode(text);
      setHits(rows);
      setStatus(rows.length ? "" : "Nessun luogo trovato.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  };

  // Rectangle editing: the map stays pannable outside the frame.
  const beginDrag = (mode: "move" | "nw" | "ne" | "sw" | "se", event: React.PointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const map = mapRef.current!;
    const rect = map.getContainer().getBoundingClientRect();
    const start = map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
    const origin = { ...bboxRef.current };
    const move = (e: PointerEvent) => {
      if (mode === "move" && focusRef.current) setFocus(null);
      const at = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
      // With a chosen point the corners grow the box around it, so it stays the exact centre.
      const pinned = focusRef.current;
      if (pinned && mode !== "move") {
        const k = Math.cos((pinned.lat * Math.PI) / 180);
        const width = Math.max(60, Math.abs(lonToMx(at.lng) - lonToMx(pinned.lon)) * k * 2);
        const height = Math.max(60, Math.abs(latToMy(at.lat) - latToMy(pinned.lat)) * k * 2);
        setBbox(boxAround(pinned.lat, pinned.lon, width, height));
        return;
      }
      const dLat = at.lat - start.lat;
      const dLon = at.lng - start.lng;
      const box = { ...origin };
      if (mode === "move") {
        box.s += dLat;
        box.n += dLat;
        box.w += dLon;
        box.e += dLon;
      } else {
        if (mode[0] === "n") box.n = Math.max(origin.s + 0.0004, origin.n + dLat);
        if (mode[0] === "s") box.s = Math.min(origin.n - 0.0004, origin.s + dLat);
        if (mode[1] === "w") box.w = Math.min(origin.e - 0.0004, origin.w + dLon);
        if (mode[1] === "e") box.e = Math.max(origin.w + 0.0004, origin.e + dLon);
      }
      setBbox(box);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const frameToView = () => {
    const bounds = mapRef.current?.getBounds();
    if (!bounds) return;
    const dLat = (bounds.getNorth() - bounds.getSouth()) * 0.26;
    const dLon = (bounds.getEast() - bounds.getWest()) * 0.26;
    const c = bounds.getCenter();
    setFocus(null);
    setBbox({ s: c.lat - dLat, n: c.lat + dLat, w: c.lng - dLon, e: c.lng + dLon });
  };

  const onKml = async (file: File) => {
    const parsed = parseKmlBbox(await file.text());
    if (!parsed) return setStatus("Il KML non contiene coordinate leggibili.");
    setBbox(parsed.bbox);
    if (parsed.name) setName(parsed.name);
    setFocus(null);
    mapRef.current?.fitBounds(
      [
        [parsed.bbox.w, parsed.bbox.s],
        [parsed.bbox.e, parsed.bbox.n],
      ],
      { padding: 140 },
    );
    setStatus("Riquadro preso dal KML.");
  };

  const open = () => {
    const source = sources.find((item) => item.id === viewSource);
    const isArchive = viewSource === "esri" || !source || source.group === "carta" || source.group === "quota";
    onOpen({
      id: newId(),
      name: name.trim() || `Riquadro ${lat.toFixed(3)}, ${lon.toFixed(3)}`,
      bbox,
      zoom,
      ...(focus ? { focus } : {}),
      plate: isArchive
        ? { kind: "wayback", release: 0, published: "", capture: null }
        : { kind: "tiles", source: source.id, label: source.label, attribution: source.attribution },
    });
  };

  return (
    <div className="atlas">
      <aside className="atlas-side">
        <header className="atlas-head">
          <h1>Sestante</h1>
          <p>Scegli un riquadro di Terra. Lo si ricostruisce dalla sua ripresa e ci si cammina dentro.</p>
        </header>
        <div className="tabs">
          {(
            [
              ["luogo", "Riquadro"],
              ["archivio", "Archivio"],
              ["manuale", "Ripresa manuale"],
              ["scarichi", "Scarichi"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="atlas-body">
          {sourcesProblem && <p className="hint" style={{ color: "var(--danger)" }}>{sourcesProblem}</p>}
          {tab === "luogo" && (
            <>
              <div>
                <div className="section-title">Dove</div>
                <div className="row">
                  <input
                    type="text"
                    placeholder="Luogo, coordinate in qualsiasi formato, link di una mappa"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void search()}
                  />
                  <button className="btn" onClick={() => void search()}>
                    {recognised ? "Centra qui" : "Cerca"}
                  </button>
                </div>
                {recognised && (
                  <div className="recognised" aria-live="polite">
                    <b>{formatLatLon(recognised.lat, recognised.lon)}</b>
                    <span className="mono small">
                      {recognised.lat.toFixed(6)}, {recognised.lon.toFixed(6)}
                    </span>
                    <span className="small muted">
                      {recognised.format}
                      {precisionWords(recognised) && ` · ${precisionWords(recognised)}`}
                    </span>
                    {recognised.note && <span className="small">{recognised.note}</span>}
                    {recognised.precision != null && recognised.precision > Math.max(size.width, size.height) / 8 && <span className="small warn">Il dato è grossolano rispetto al riquadro: il centro non sarà preciso quanto sembra.</span>}
                    {recognised.swapped && (
                      <button className="btn tiny" onClick={() => setQuery(`${recognised.swapped!.lat} N ${recognised.swapped!.lon >= 0 ? recognised.swapped!.lon : -recognised.swapped!.lon} ${recognised.swapped!.lon >= 0 ? "E" : "W"}`)}>
                        Era longitudine, latitudine: inverti
                      </button>
                    )}
                  </div>
                )}
                {status && <p className="hint">{status}</p>}
                {hits.map((hit) => (
                  <button
                    key={`${hit.lat},${hit.lon}`}
                    className="hit"
                    onClick={() => {
                      place(hit.lat, hit.lon, 800, hit.name.split(",").slice(0, 2).join(",").trim());
                      setHits([]);
                    }}
                  >
                    {hit.name}
                  </button>
                ))}
                <p className="hint">
                  Da Google Maps o Earth incolla il link della vista: leggo posizione e zoom dall'URL. Da Earth puoi anche caricare un KML:
                  <input type="file" accept=".kml" style={{ marginTop: 4 }} onChange={(e) => e.target.files?.[0] && void onKml(e.target.files[0])} />
                </p>
              </div>
              <div>
                <div className="section-title">Vista della mappa</div>
                <select value={viewSource} onChange={(e) => changeSource(e.target.value)}>
                  {sources
                    .filter((item) => item.group !== "quota")
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <div className="section-title">Riquadro</div>
                <label className="field">
                  Nome della spedizione
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <dl className="kv" style={{ marginTop: 8 }}>
                  <dt>Dimensioni</dt>
                  <dd>
                    {size.width.toFixed(0)} × {size.height.toFixed(0)} m
                  </dd>
                  <dt>{focus ? "Punto al centro" : "Centro"}</dt>
                  <dd>
                    {lat.toFixed(6)}, {lon.toFixed(6)}
                    {focus && <span className="muted"> · {focus.format}</span>}
                  </dd>
                  <dt>Lastra</dt>
                  <dd>
                    z{zoom} · {mpp.toFixed(2)} m/px
                  </dd>
                </dl>
                <div className="row wrap" style={{ marginTop: 8 }}>
                  <span className="small muted">Lato</span>
                  {[200, 400, 800, 1500, 3000].map((meters) => (
                    <button key={meters} className={`btn tiny ${Math.abs(size.width - meters) < 1 && Math.abs(size.height - meters) < 1 ? "on" : ""}`} onClick={() => setSide(meters)}>
                      {meters >= 1000 ? `${meters / 1000} km` : `${meters} m`}
                    </button>
                  ))}
                </div>
                {focus && <p className="hint">Il punto è il centro esatto: gli angoli allargano il riquadro attorno a lui. Trascinare tutto il riquadro lo scioglie dal punto.</p>}
                <button className="btn tiny" style={{ marginTop: 8 }} onClick={frameToView}>
                  Riquadra la vista attuale
                </button>
                {tooBig && <p className="hint" style={{ color: "var(--danger)" }}>Oltre 6 km di lato il dettaglio si perde: restringi il riquadro.</p>}
              </div>
              {trips.length > 0 && (
                <div>
                  <div className="section-title">Ultime indagini</div>
                  {trips.slice(0, 3).map((trip) => (
                    <button key={trip.id} className="hit" onClick={() => onResume(trip.id)}>
                      {trip.name} <span className="muted small">· {trip.notes} annotazioni · {trip.updated.slice(0, 10)}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {tab === "archivio" && <Archive onResume={onResume} onStudio={(spec) => onOpen(spec)} />}
          {tab === "manuale" && (
            <ManualPlate
              bbox={bbox}
              name={name}
              onBbox={(box) => {
                setBbox(box);
                mapRef.current?.fitBounds(
                  [
                    [box.w, box.s],
                    [box.e, box.n],
                  ],
                  { padding: 140 },
                );
              }}
              onOpen={(spec, canvas) => onOpen({ ...spec, id: newId() }, canvas)}
            />
          )}
          {tab === "scarichi" && <Downloads bbox={bbox} name={name} sources={sources} reload={loadSources} />}
        </div>
      </aside>
      <main className="atlas-map">
        <div ref={host} className="map" />
        <div ref={selRef} className={`sel ${frame.fills ? "fills" : ""}`} style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }} onPointerDown={(e) => beginDrag("move", e)}>
          <span className="tag">
            {(size.width / 1000).toFixed(2)} × {(size.height / 1000).toFixed(2)} km
          </span>
          {focus && <span className="center-cross" aria-label="Punto scelto, al centro del riquadro" />}
          {(["nw", "ne", "sw", "se"] as const).map((corner) => (
            <span key={corner} className={`h ${corner}`} onPointerDown={(e) => beginDrag(corner, e)} />
          ))}
        </div>
        <div className="go-bar">
          <button className="btn primary" disabled={tooBig} onClick={open}>
            Apri la ripresa nello Studio
          </button>
        </div>
      </main>
    </div>
  );
}

function ManualPlate({ bbox, name, onBbox, onOpen }: { bbox: Bbox; name: string; onBbox: (box: Bbox) => void; onOpen: (spec: Omit<FieldSpec, "id">, canvas: HTMLCanvasElement) => void }) {
  const [file, setFile] = useState<{ canvas: HTMLCanvasElement; url: string; label: string } | null>(null);
  const [form, setForm] = useState({ date: "", sensor: "", provider: "", resolution: "", sunAz: "", sunAlt: "" });
  const [corners, setCorners] = useState({ n: String(bbox.n), s: String(bbox.s), e: String(bbox.e), w: String(bbox.w) });
  const [message, setMessage] = useState("");

  useEffect(() => setCorners({ n: bbox.n.toFixed(6), s: bbox.s.toFixed(6), e: bbox.e.toFixed(6), w: bbox.w.toFixed(6) }), [bbox]);

  const load = async (picked: File) => {
    setMessage("Leggo l'immagine…");
    try {
      const read = await readManualPlate(picked);
      setFile({ canvas: read.canvas, url: URL.createObjectURL(picked), label: picked.name });
      if (read.bbox) onBbox(read.bbox);
      if (read.date) setForm((f) => ({ ...f, date: read.date! }));
      setMessage(read.note);
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  const apply = () => {
    const box = { n: Number(corners.n), s: Number(corners.s), e: Number(corners.e), w: Number(corners.w) };
    if ([box.n, box.s, box.e, box.w].every(Number.isFinite) && box.n > box.s && box.e > box.w) onBbox(box);
    else setMessage("Controlla gli angoli: nord > sud, est > ovest.");
  };

  const go = () => {
    if (!file) return;
    const az = Number.parseFloat(form.sunAz);
    const alt = Number.parseFloat(form.sunAlt);
    onOpen(
      {
        name: name || file.label,
        bbox,
        zoom: bestZoom(bbox, 6144, 19),
        plate: {
          kind: "upload",
          url: "",
          label: file.label,
          capture: {
            date: form.date || null,
            sensor: form.sensor || null,
            provider: form.provider || null,
            product: "Ripresa caricata",
            resolution: Number.parseFloat(form.resolution) || null,
            accuracy: null,
            block: null,
          },
          manualSun: Number.isFinite(az) && Number.isFinite(alt) ? { azimuth: (az * Math.PI) / 180, altitude: (alt * Math.PI) / 180 } : null,
        },
      },
      file.canvas,
    );
  };

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <>
      <div>
        <div className="section-title">La tua ripresa</div>
        <p className="hint">JPG, PNG o GeoTIFF nord in alto. Un GeoTIFF in EPSG:4326 o 3857 si colloca da solo; le altre immagini vanno sugli angoli qui sotto.</p>
        <input type="file" accept="image/*,.tif,.tiff" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
        {message && <p className="hint">{message}</p>}
      </div>
      <div>
        <div className="section-title">Angoli</div>
        <div className="row">
          {(["n", "s", "e", "w"] as const).map((key) => (
            <label key={key} className="field grow">
              {{ n: "Nord", s: "Sud", e: "Est", w: "Ovest" }[key]}
              <input type="text" className="mono small" value={corners[key]} onChange={(e) => setCorners((c) => ({ ...c, [key]: e.target.value }))} />
            </label>
          ))}
        </div>
        <button className="btn tiny" style={{ marginTop: 6 }} onClick={apply}>
          Applica al riquadro
        </button>
      </div>
      <div className="stack">
        <div className="section-title">Metadati dello scatto</div>
        <label className="field">
          Data di acquisizione
          <input type="date" value={form.date} onChange={set("date")} />
        </label>
        <div className="row">
          <label className="field grow">
            Sensore
            <input type="text" placeholder="WV03, Pléiades…" value={form.sensor} onChange={set("sensor")} />
          </label>
          <label className="field grow">
            Fornitore
            <input type="text" value={form.provider} onChange={set("provider")} />
          </label>
        </div>
        <label className="field">
          Risoluzione (m/px)
          <input type="text" value={form.resolution} onChange={set("resolution")} />
        </label>
        <div className="row">
          <label className="field grow">
            Azimut sole (°)
            <input type="text" value={form.sunAz} onChange={set("sunAz")} />
          </label>
          <label className="field grow">
            Elevazione sole (°)
            <input type="text" value={form.sunAlt} onChange={set("sunAlt")} />
          </label>
        </div>
        <p className="hint">Con azimut ed elevazione dei metadati le altezze si misurano direttamente. Senza, il sole si ricava dalle ombre e dalla data.</p>
      </div>
      <button className="btn primary" disabled={!file} onClick={go}>
        Apri nello Studio
      </button>
    </>
  );
}

function Downloads({ bbox, name, sources, reload }: { bbox: Bbox; name: string; sources: TileSourceInfo[]; reload: () => void }) {
  const [source, setSource] = useState("esri");
  const [zMin, setZMin] = useState(15);
  const [zMax, setZMax] = useState(18);
  const [format, setFormat] = useState<"directory" | "mbtiles" | "stitched">("mbtiles");
  const [count, setCount] = useState<number | null>(null);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState({ label: "", template: "", maxZoom: "19", attribution: "" });

  useEffect(() => {
    let live = true;
    api.countTiles(bbox, zMin, zMax).then((row) => live && setCount(row.total)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bbox, zMin, zMax]);

  useEffect(() => {
    const tick = () => api.jobs().then(setJobs).catch(() => undefined);
    void tick();
    const timer = window.setInterval(tick, 1200);
    return () => window.clearInterval(timer);
  }, []);

  const start = async () => {
    setError("");
    try {
      await api.startJob({ name, source, bbox, zMin, zMax, format });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const add = async () => {
    setError("");
    try {
      const row = await api.addSource({ ...custom, maxZoom: Number(custom.maxZoom) });
      reload();
      setSource(row.id);
      setCustom({ label: "", template: "", maxZoom: "19", attribution: "" });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const selected = sources.find((row) => row.id === source);
  return (
    <>
      <div className="stack">
        <div className="section-title">Scarica il riquadro</div>
        <p className="hint">Le funzioni di MapTilesDownloader, dentro Sestante: il riquadro è quello sulla mappa. Ogni tessera resta anche nella cache di campo.</p>
        <label className="field">
          Fonte
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {sources.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
              </option>
            ))}
          </select>
        </label>
        {selected?.note && <p className="hint">{selected.note}</p>}
        <div className="row">
          <label className="field grow">
            Zoom da
            <input type="number" min={0} max={23} value={zMin} onChange={(e) => setZMin(Number(e.target.value))} />
          </label>
          <label className="field grow">
            a
            <input type="number" min={0} max={23} value={zMax} onChange={(e) => setZMax(Number(e.target.value))} />
          </label>
        </div>
        <label className="field">
          Formato
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <option value="mbtiles">MBTiles (un solo file)</option>
            <option value="directory">Cartella z/x/y</option>
            <option value="stitched">Mosaico PNG con world file (GIS)</option>
          </select>
        </label>
        <div className="row">
          <span className="mono small grow">{count != null ? `${count} tessere` : ""}</span>
          <button className="btn primary" onClick={() => void start()}>
            Avvia
          </button>
        </div>
        {error && <p className="hint" style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
      {jobs.length > 0 && (
        <div className="stack">
          <div className="section-title">Lavori</div>
          {jobs.map((job) => (
            <div key={job.id} className="job small">
              <div className="row">
                <b className="grow">{job.name}</b>
                <span className="mono">
                  {job.done}/{job.total}
                </span>
                {job.state === "running" && (
                  <button className="btn tiny" onClick={() => void api.cancelJob(job.id)}>
                    Annulla
                  </button>
                )}
              </div>
              <div className="bar">
                <i style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }} />
              </div>
              <div className="muted">{job.message}</div>
              {job.state !== "running" && <div className="mono muted" style={{ wordBreak: "break-all", fontSize: 11 }}>{job.output}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="stack">
        <div className="section-title">Aggiungi una fonte</div>
        <p className="hint">Un modello URL con {"{x} {y} {z}"} oppure {"{quad}"}, come in MapTilesDownloader. Verifica che i termini del servizio permettano lo scarico: Google e Bing, ad esempio, non lo consentono fuori dalle loro API.</p>
        <input type="text" placeholder="Nome" value={custom.label} onChange={(e) => setCustom((c) => ({ ...c, label: e.target.value }))} />
        <input type="text" className="mono small" placeholder="https://…/{z}/{x}/{y}.png" value={custom.template} onChange={(e) => setCustom((c) => ({ ...c, template: e.target.value }))} />
        <input type="text" placeholder="Attribuzione" value={custom.attribution} onChange={(e) => setCustom((c) => ({ ...c, attribution: e.target.value }))} />
        <button className="btn" disabled={!custom.template} onClick={() => void add()}>
          Aggiungi
        </button>
      </div>
    </>
  );
}
