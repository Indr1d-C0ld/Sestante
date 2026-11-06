import { useEffect, useMemo, useRef, useState } from "react";
import { api, canvasBlob, imageCanvas, type DeepLayer, type EarthProduct, type EarthScene, type FireRow, type NdviRow, type OwmNow } from "../core/api.ts";
import { compassName, type Bbox, type Projection } from "../core/geo.ts";
import { fitAffine, type ControlPoint } from "../core/fieldwork.ts";
import type { MapOverlay, Note, NoteKind } from "../core/types.ts";
import { describeWmo } from "../world/sim.ts";
import { U } from "../world/shading.ts";
import type { Engine } from "../world/engine.ts";
import { CHART_COLORS, chartPicture, LineChart } from "./Charts.tsx";
import { isBlank } from "../vision/filters.ts";
import { deepCanvas, vegetationAnomaly, warpOverlay } from "./research.ts";

export type Drape = { label: string; canvas: HTMLCanvasElement; source: string };

type Tab = "satellite" | "passato" | "fenologia" | "fuochi" | "aria" | "carte";

const TABS: [Tab, string][] = [
  ["satellite", "Sentinel"],
  ["passato", "Passato remoto"],
  ["fenologia", "Fenologia"],
  ["fuochi", "Fuochi"],
  ["aria", "Aria e previsioni"],
  ["carte", "Carte storiche"],
];

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const AQI = ["", "buona", "discreta", "moderata", "scarsa", "pessima"];

type AddNote = (kind: NoteKind, title: string, text: string, extra?: Partial<Note>) => void;

type Props = {
  engine: Engine;
  bbox: Bbox;
  projection: Projection;
  drape: Drape | null;
  overlays: MapOverlay[];
  self: { lat: number; lon: number };
  onDrape: (drape: Drape | null) => void;
  onOverlays: (next: MapOverlay[]) => void;
  addNote: AddNote;
  toast: (text: string) => void;
  onClose: () => void;
};

function imageSize(projection: Projection, mPerPx: number) {
  const k = Math.min(1, 1600 / ((Math.max(projection.halfX, projection.halfZ) * 2) / mPerPx));
  return { width: Math.max(96, (projection.halfX * 2 * k) / mPerPx), height: Math.max(96, (projection.halfZ * 2 * k) / mPerPx) };
}

export function LayersPanel(props: Props) {
  const { engine, bbox, drape, onDrape, addNote, onClose } = props;
  const [tab, setTab] = useState<Tab>("satellite");
  const [mix, setMix] = useState(U.uDrapeMix.value || 1);
  const pin = async (title: string, text: string, canvas: HTMLCanvasElement, values?: Record<string, string>) => {
    const url = await api.uploadMedia(engine.data.spec.id, await canvasBlob(canvas), "jpg");
    addNote("confronto", title, text, { photo: url, instrument: "strati", values });
  };
  return (
    <div className="panel wide" onClick={(e) => e.stopPropagation()}>
      <header className="panel-head">
        <h2 className="grow">Strati della Terra</h2>
        {drape && (
          <>
            <span className="small mono muted">{drape.label}</span>
            <input
              type="range"
              aria-label="Opacità dello strato"
              min={0.05}
              max={1}
              step={0.05}
              value={mix}
              onChange={(e) => {
                setMix(Number(e.target.value));
                U.uDrapeMix.value = Number(e.target.value);
              }}
            />
            <button
              className="btn tiny"
              onClick={() => {
                engine.setDrape(null);
                onDrape(null);
              }}
            >
              Togli dal suolo
            </button>
          </>
        )}
        <button className="btn tiny" onClick={onClose}>
          Chiudi (G)
        </button>
      </header>
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="panel-body stack">
        {tab === "satellite" && <Sentinel {...props} mix={mix} pin={pin} />}
        {tab === "passato" && <Deep {...props} mix={mix} pin={pin} />}
        {tab === "fenologia" && <Phenology bbox={bbox} pin={pin} />}
        {tab === "fuochi" && <Fires {...props} />}
        {tab === "aria" && <AirForecast {...props} />}
        {tab === "carte" && <HistoricMaps {...props} mix={mix} />}
      </div>
    </div>
  );
}

type Pin = (title: string, text: string, canvas: HTMLCanvasElement, values?: Record<string, string>) => Promise<void>;

function Preview({ canvas, label }: { canvas: HTMLCanvasElement | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas || !ref.current) return;
    ref.current.width = canvas.width;
    ref.current.height = canvas.height;
    ref.current.getContext("2d")!.drawImage(canvas, 0, 0);
  }, [canvas]);
  return canvas ? <canvas ref={ref} className="preview" aria-label={label} /> : null;
}

function Sentinel({ engine, bbox, projection, onDrape, toast, mix, pin }: Props & { mix: number; pin: Pin }) {
  const [products, setProducts] = useState<EarthProduct[]>([]);
  const [product, setProduct] = useState("vero");
  const now = Date.now();
  const [from, setFrom] = useState(iso(now - 365 * 86_400_000));
  const [to, setTo] = useState(iso(now));
  const [cloud, setCloud] = useState(30);
  const [scenes, setScenes] = useState<EarthScene[]>([]);
  const [scene, setScene] = useState<EarthScene | null>(null);
  const [image, setImage] = useState<HTMLCanvasElement | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [season, setSeason] = useState({ year: new Date(now).getUTCFullYear() - 1, part: "primavera" });

  useEffect(() => {
    api.earthProducts().then(setProducts).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    let live = true;
    setBusy("Chiedo al catalogo Earth Search…");
    api
      .earthScenes(bbox, from, to, cloud)
      .then((rows) => {
        if (!live) return;
        setScenes(rows);
        setError("");
        setScene((current) => current ?? rows[0] ?? null);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setBusy(""));
    return () => {
      live = false;
    };
  }, [from, to, cloud]);

  const size = imageSize(projection, 10);
  useEffect(() => {
    if (product === "anomalia" || !scene) return;
    let live = true;
    setBusy("Chiedo l'immagine a Copernicus…");
    const day = scene.date;
    const before = iso(Date.parse(day) - 12 * 86_400_000);
    imageCanvas(api.earthImageUrl(bbox, product, product === "radar" ? before : day, product === "radar" ? day : null, size.width, size.height))
      .then((canvas) => {
        if (live) {
          setImage(canvas);
          setError("");
        }
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setBusy(""));
    return () => {
      live = false;
    };
  }, [scene, product]);

  const runAnomaly = async () => {
    setBusy("Calcolo la mediana della stagione…");
    setError("");
    const months = season.part === "primavera" ? ["03-15", "06-15"] : season.part === "estate" ? ["06-15", "09-15"] : ["09-15", "12-15"];
    try {
      const raw = await imageCanvas(api.earthImageUrl(bbox, "anomalia", `${season.year}-${months[0]}`, `${season.year}-${months[1]}`, size.width, size.height));
      setImage(vegetationAnomaly(raw, (projection.halfX * 2) / raw.width));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy("");
  };

  const active = products.find((row) => row.id === product);
  const label = product === "anomalia" ? `Anomalie NDVI ${season.part} ${season.year}` : `${active?.label ?? product} ${scene?.date ?? ""}`;
  return (
    <>
      <div className="chips">
        {products.map((row) => (
          <button key={row.id} className={`btn tiny ${product === row.id ? "on" : ""}`} onClick={() => setProduct(row.id)}>
            {row.label}
          </button>
        ))}
      </div>
      <p className="hint">{active?.note}</p>
      <div className="layer-grid">
        <div className="stack">
          {product === "anomalia" ? (
            <>
              <div className="row wrap">
                <label className="field">
                  Anno
                  <input type="number" min={2017} max={new Date(now).getUTCFullYear()} value={season.year} onChange={(e) => setSeason({ ...season, year: Number(e.target.value) })} />
                </label>
                <label className="field">
                  Stagione
                  <select value={season.part} onChange={(e) => setSeason({ ...season, part: e.target.value })}>
                    <option value="primavera">Primavera</option>
                    <option value="estate">Estate</option>
                    <option value="autunno">Autunno</option>
                  </select>
                </label>
              </div>
              <button className="btn primary" disabled={!!busy} onClick={() => void runAnomaly()}>
                Cerca le anomalie
              </button>
              <p className="hint">Verde: più vigoroso dei dintorni, come sopra un fossato. Arancio: meno vigoroso, come sopra un muro sepolto. A 10 m per pixel si vedono solo tracce grandi, e la causa va sempre verificata: drenaggi, colture diverse e confini di campo danno lo stesso segno.</p>
            </>
          ) : (
            <>
              <div className="row wrap">
                <label className="field">
                  Dal
                  <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
                </label>
                <label className="field">
                  Al
                  <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
                </label>
              </div>
              <label className="field">
                Nubi al massimo: {cloud}%
                <input type="range" min={0} max={100} step={5} value={cloud} onChange={(e) => setCloud(Number(e.target.value))} />
              </label>
              <div className="scene-list">
                {scenes.map((row) => (
                  <button key={row.date} className={`version ${scene?.date === row.date ? "on" : ""}`} onClick={() => setScene(row)}>
                    <b>{row.date}</b>
                    <span className="small" style={{ gridRow: 2 }}>
                      nubi {row.cloud.toFixed(0)}% sul quadrante
                    </span>
                  </button>
                ))}
                {!scenes.length && !busy && <p className="hint">Nessuna scena con questi limiti.</p>}
              </div>
              <p className="hint">{product === "radar" ? "Il radar usa il passaggio più recente nei 12 giorni prima della data scelta." : "La percentuale di nubi vale per tutto il quadrante di 110 km, non per il tuo riquadro: controlla l'immagine."}</p>
            </>
          )}
        </div>
        <div className="stack">
          {busy && <p className="mono small">{busy}</p>}
          {error && <p className="small warn">{error}</p>}
          <Preview canvas={image} label={label} />
          {image && (
            <div className="row wrap">
              <button
                className="btn tiny primary"
                onClick={() => {
                  engine.setDrape(image, mix);
                  onDrape({ label, canvas: image, source: "Copernicus Sentinel" });
                  toast(`Sul suolo: ${label}`);
                }}
              >
                Stendi sul suolo
              </button>
              <button className="btn tiny" onClick={() => void pin(label, "Strato Copernicus Sentinel osservato sul riquadro.", image)}>
                Allega al registro
              </button>
            </div>
          )}
          <p className="small muted">Dati Copernicus Sentinel, elaborati da Copernicus Data Space. Le immagini restano in cache: rivederle non consuma la quota mensile.</p>
        </div>
      </div>
    </>
  );
}

function Deep({ engine, bbox, onDrape, toast, mix, pin }: Props & { mix: number; pin: Pin }) {
  const [layers, setLayers] = useState<DeepLayer[]>([]);
  const [image, setImage] = useState<{ canvas: HTMLCanvasElement; label: string; note: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api.deepLayers().then(setLayers).catch((e: Error) => setError(e.message));
  }, []);
  const open = async (layer: DeepLayer, time: string) => {
    setBusy(`Sviluppo ${layer.label} ${time.slice(0, 4)}…`);
    setError("");
    try {
      const canvas = await deepCanvas(bbox, layer.id, time, layer.maxZoom);
      if (isBlank(canvas)) {
        setImage(null);
        setError(`Il mosaico del ${time.slice(0, 4)} non copre questo luogo: prova un altro anno.`);
      } else setImage({ canvas, label: `${layer.label} ${time.slice(0, 4)}`, note: layer.note });
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy("");
  };
  return (
    <div className="layer-grid">
      <div className="stack">
        <p className="hint">Prima di Wayback: mosaici NASA GIBS, senza chiave. I pixel sono grandi, ma raccontano com'era il territorio decenni fa.</p>
        {layers.map((layer) => (
          <div key={layer.id}>
            <div className="section-title">{layer.label}</div>
            <p className="hint">{layer.note}</p>
            <div className="chips">
              {layer.times.map((time) => (
                <button key={time} className="btn tiny" disabled={!!busy} onClick={() => void open(layer, time)}>
                  {time.slice(0, 4)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="stack">
        {busy && <p className="mono small">{busy}</p>}
        {error && <p className="small warn">{error}</p>}
        {image && <b>{image.label}</b>}
        <Preview canvas={image?.canvas ?? null} label={image?.label ?? ""} />
        {image && (
          <div className="row wrap">
            <button
              className="btn tiny primary"
              onClick={() => {
                engine.setDrape(image.canvas, mix);
                onDrape({ label: image.label, canvas: image.canvas, source: "NASA GIBS" });
                toast(`Sul suolo: ${image.label}`);
              }}
            >
              Stendi sul suolo
            </button>
            <button className="btn tiny" onClick={() => void pin(image.label, image.note, image.canvas)}>
              Allega al registro
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

function Phenology({ bbox, pin }: { bbox: Bbox; pin: Pin }) {
  const now = new Date();
  const [start, setStart] = useState(now.getUTCFullYear() - 4);
  const [rows, setRows] = useState<NdviRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setBusy(true);
    api
      .ndvi(bbox, `${start}-01-01`, iso(now.valueOf()), 30)
      .then((data) => {
        if (live) {
          setRows(data);
          setError("");
        }
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [start]);
  const x = rows.map((row) => Date.parse(row.from));
  const series = [{ label: "NDVI medio", color: CHART_COLORS.one, values: rows.map((row) => row.mean) }];
  const text = (v: number) => new Date(v).toISOString().slice(0, 7);
  const months = useMemo(() => {
    const groups: number[][] = Array.from({ length: 12 }, () => []);
    for (const row of rows) groups[Number(row.from.slice(5, 7)) - 1]!.push(row.mean);
    const means = groups.map((list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null));
    const valid = means.flatMap((v, i) => (v == null ? [] : [{ v, i }]));
    return valid.length ? { peak: valid.reduce((a, b) => (b.v > a.v ? b : a)), low: valid.reduce((a, b) => (b.v < a.v ? b : a)) } : null;
  }, [rows]);
  return (
    <>
      <label className="field">
        Dall'anno
        <input type="number" min={2017} max={now.getUTCFullYear()} value={start} onChange={(e) => setStart(Number(e.target.value))} />
      </label>
      {busy && <p className="mono small">Copernicus sta calcolando la serie sulle bande reali…</p>}
      {error && <p className="small warn">{error}</p>}
      <LineChart title="Vigore della vegetazione sul riquadro, ogni 30 giorni" x={x} xLabel={text} series={series} unit="NDVI" yDigits={3} />
      {months && (
        <p>
          Il massimo cade in <b>{MONTHS[months.peak.i]}</b> ({months.peak.v.toFixed(2)}), il minimo in <b>{MONTHS[months.low.i]}</b> ({months.low.v.toFixed(2)}). Nubi e neve sono già escluse dalla classificazione della scena.
        </p>
      )}
      {rows.length > 0 && (
        <button className="btn tiny" onClick={() => void pin("Serie NDVI del riquadro", `${rows.length} periodi di 30 giorni dal ${rows[0]!.from} al ${rows[rows.length - 1]!.to}.`, chartPicture("NDVI medio sul riquadro", x, series, "NDVI", text), { periodi: String(rows.length) })}>
          Allega al registro
        </button>
      )}
    </>
  );
}

function bearingKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const y = (b.lat - a.lat) * 111.32;
  const x = (b.lon - a.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  return { km: Math.hypot(x, y), bearing: ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 };
}

function Fires({ self, addNote }: Props) {
  const [radius, setRadius] = useState(50);
  const [days, setDays] = useState(7);
  const [date, setDate] = useState("");
  const [rows, setRows] = useState<FireRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setRows(null);
    const dLat = radius / 111.32;
    const dLon = dLat / Math.cos((self.lat * Math.PI) / 180);
    api
      .fires({ s: self.lat - dLat, n: self.lat + dLat, w: self.lon - dLon, e: self.lon + dLon }, days, date || null)
      .then((data) => {
        if (live) {
          setRows(data);
          setError("");
        }
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [radius, days, date]);
  const list = (rows ?? [])
    .map((row) => ({ row, ...bearingKm(self, row) }))
    .filter((row) => row.km <= radius)
    .sort((a, b) => a.km - b.km);
  return (
    <>
      <div className="row wrap">
        <label className="field">
          Raggio
          <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
            {[25, 50, 100, 250].map((v) => (
              <option key={v} value={v}>
                {v} km
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Giorni
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 5, 7, 10].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          A partire da (archivio)
          <input type="date" min="2000-11-01" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {date && (
          <button className="btn tiny" onClick={() => setDate("")}>
            Torna ad oggi
          </button>
        )}
      </div>
      {error && <p className="small warn">{error}</p>}
      {!rows && !error && <p className="mono small">Chiedo a NASA FIRMS…</p>}
      {rows && (
        <p>
          <b>{list.length}</b> anomalie termiche entro {radius} km{date ? ` dal ${date}` : " negli ultimi giorni"}. Il satellite vede calore, non la causa: anche fornaci e torce industriali entrano nell'elenco.
        </p>
      )}
      {list.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th>Distanza</th>
              <th>Direzione</th>
              <th>Quando (UTC)</th>
              <th>Sensore</th>
              <th>Potenza</th>
              <th>Fiducia</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.slice(0, 40).map(({ row, km, bearing }, index) => (
              <tr key={index}>
                <td>{km.toFixed(1)} km</td>
                <td>
                  {bearing.toFixed(0)}° {compassName(bearing)}
                </td>
                <td>
                  {row.date} {row.time}
                </td>
                <td>
                  {row.sensor} {row.satellite}
                </td>
                <td>{row.frp.toFixed(1)} MW</td>
                <td>{row.confidence}</td>
                <td>
                  <button className="btn tiny" onClick={() => addNote("strumento", `Fuoco a ${km.toFixed(1)} km`, `${compassName(bearing)}, ${row.date} ${row.time} UTC.`, { instrument: "NASA FIRMS", values: { potenza: `${row.frp.toFixed(1)} MW`, sensore: row.sensor, azimut: `${bearing.toFixed(0)}°` } })}>
                    Annota
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const MAP_LAYERS = [
  ["clouds_new", "Nubi"],
  ["precipitation_new", "Precipitazioni"],
  ["pressure_new", "Pressione"],
  ["wind_new", "Vento"],
  ["temp_new", "Temperatura"],
] as const;

function WeatherMap({ lat, lon }: { lat: number; lon: number }) {
  const [layer, setLayer] = useState<string>("clouds_new");
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    const z = 6;
    const n = 2 ** z;
    const rad = (lat * Math.PI) / 180;
    const fx = ((lon + 180) / 360) * n;
    const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    const canvas = ref.current!;
    canvas.width = canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    (async () => {
      const load = async (url: string) => {
        const res = await fetch(url).catch(() => null);
        return res?.ok ? createImageBitmap(await res.blob()) : null;
      };
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      // Whole pixels: a fractional offset blurs every tile edge into a visible seam.
      const ox = Math.round(256 - (fx - cx) * 256);
      const oy = Math.round(256 - (fy - cy) * 256);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = (cx + dx + n) % n;
          const y = cy + dy;
          if (y < 0 || y >= n) continue;
          const [base, over] = await Promise.all([load(`/api/tile/grigia/${z}/${x}/${y}`), load(`/api/earth/owm-tile/${layer}/${z}/${x}/${y}`)]);
          if (!live) return;
          if (base) ctx.drawImage(base, ox + dx * 256, oy + dy * 256);
          if (over) ctx.drawImage(over, ox + dx * 256, oy + dy * 256);
        }
      }
      ctx.strokeStyle = "#d95926";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(256, 256, 7, 0, Math.PI * 2);
      ctx.stroke();
    })();
    return () => {
      live = false;
    };
  }, [layer, lat, lon]);
  return (
    <div className="stack">
      <div className="chips">
        {MAP_LAYERS.map(([id, label]) => (
          <button key={id} className={`btn tiny ${layer === id ? "on" : ""}`} onClick={() => setLayer(id)}>
            {label}
          </button>
        ))}
      </div>
      <canvas ref={ref} className="preview" aria-label="Carta meteo attorno al luogo" />
    </div>
  );
}

function AirForecast({ engine, self, addNote, toast }: Props) {
  const [data, setData] = useState<OwmNow | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.owm(self.lat, self.lon).then(setData).catch((e: Error) => setError(e.message));
  }, []);
  const station = engine.data.weather?.current;
  const x = data?.forecast.map((row) => Date.parse(row.at)) ?? [];
  const text = (v: number) => new Date(v).toISOString().slice(5, 13).replace("T", " ");
  const compare = (label: string, a: number | undefined, b: number | undefined, unit: string, digits = 1) => (
    <tr key={label}>
      <td>{label}</td>
      <td>{a == null || !Number.isFinite(a) ? "—" : a.toFixed(digits)}</td>
      <td>{b == null ? "—" : b.toFixed(digits)}</td>
      <td>{a == null || b == null || !Number.isFinite(a) ? "—" : (a - b).toFixed(digits)}</td>
      <td>{unit}</td>
    </tr>
  );
  const applyForecast = (index: number) => {
    const row = data!.forecast[index]!;
    engine.clock.setCustom(Date.parse(row.at), 1);
    engine.clock.paused = true;
    engine.weather.mode = "manual";
    engine.weather.target = { ...engine.weather.target, cloud: row.cloud / 100, rain: row.rain / 3, snow: row.snow / 3, wind: row.wind, windDir: row.windDir, temp: row.temp, humidity: row.humidity, pressureMsl: row.pressure, thunder: 0 };
    toast(`Il mondo è al ${text(Date.parse(row.at))}: ${row.description}.`);
  };
  return (
    <>
      {error && <p className="small warn">{error}</p>}
      {!data && !error && <p className="mono small">Chiedo a OpenWeather…</p>}
      {data && (
        <>
          <div className="layer-grid">
            <div className="stack">
              <div className="section-title">Due stazioni a confronto</div>
              <table className="data">
                <thead>
                  <tr>
                    <th />
                    <th>Open-Meteo</th>
                    <th>OpenWeather</th>
                    <th>Scarto</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {compare("Temperatura", Number(station?.temperature_2m), data.temp, "°C")}
                  {compare("Umidità", Number(station?.relative_humidity_2m), data.humidity, "%", 0)}
                  {compare("Pressione", Number(station?.pressure_msl), data.pressure, "hPa")}
                  {compare("Vento", Number(station?.wind_speed_10m) / 3.6, data.wind, "m/s")}
                  {compare("Nubi", Number(station?.cloud_cover), data.cloud, "%", 0)}
                </tbody>
              </table>
              <p className="small muted">
                Open-Meteo: {station ? describeWmo(Number(station.weather_code)) : "non raggiunta"}. OpenWeather, {data.station}: {data.description}. Due modelli non coincidono mai: lo scarto è una misura onesta di quanto se ne sa.
              </p>
              {data.air && (
                <>
                  <div className="section-title">Aria: {AQI[data.air.aqi]}</div>
                  <table className="data">
                    <tbody>
                      {(
                        [
                          ["PM2,5", data.air.pm25],
                          ["PM10", data.air.pm10],
                          ["Ozono O₃", data.air.o3],
                          ["Biossido di azoto NO₂", data.air.no2],
                          ["Biossido di zolfo SO₂", data.air.so2],
                          ["Monossido di carbonio CO", data.air.co],
                          ["Ammoniaca NH₃", data.air.nh3],
                        ] as [string, number][]
                      ).map(([label, value]) => (
                        <tr key={label}>
                          <td>{label}</td>
                          <td>{value.toFixed(1)} µg/m³</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button
                    className="btn tiny"
                    onClick={() =>
                      addNote("strumento", `Aria ${AQI[data.air!.aqi]}`, `Indice ${data.air!.aqi} su 5, modello OpenWeather.`, {
                        instrument: "campionatore d'aria",
                        values: { "PM2,5": `${data.air!.pm25.toFixed(1)} µg/m³`, PM10: `${data.air!.pm10.toFixed(1)} µg/m³`, O3: `${data.air!.o3.toFixed(0)} µg/m³`, NO2: `${data.air!.no2.toFixed(1)} µg/m³` },
                      })
                    }
                  >
                    Annota l'aria
                  </button>
                </>
              )}
            </div>
            <WeatherMap lat={self.lat} lon={self.lon} />
          </div>
          <LineChart title="Temperatura prevista, 5 giorni" x={x} xLabel={text} series={[{ label: "Temperatura", color: CHART_COLORS.one, values: data.forecast.map((row) => row.temp) }]} unit="°C" height={130} />
          <LineChart title="Pressione prevista, 5 giorni" x={x} xLabel={text} series={[{ label: "Pressione", color: CHART_COLORS.one, values: data.forecast.map((row) => row.pressure) }]} unit="hPa" height={130} />
          <div className="section-title">Porta il mondo a un'ora della previsione</div>
          <div className="scene-list short">
            {data.forecast.map((row, index) => (
              <button key={row.at} className="version" onClick={() => applyForecast(index)}>
                <b>{text(Date.parse(row.at))}</b>
                <span className="small" style={{ gridRow: 2 }}>
                  {row.description}, {row.temp.toFixed(0)}°C, vento {row.wind.toFixed(0)} m/s, pioggia {Math.round(row.pop * 100)}%
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** A pan-and-zoom picture that reports clicks in its own pixels; a drag only moves the view. */
function PickPane({ source, points, label, onPick }: { source: HTMLCanvasElement; points: { u: number; v: number; n: number }[]; label: string; onPick: (u: number, v: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 0 });
  useEffect(() => {
    const canvas = ref.current!;
    const box = canvas.getBoundingClientRect();
    canvas.width = box.width;
    canvas.height = box.height;
    const k = view.k || Math.min(box.width / source.width, box.height / source.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0d100d";
    ctx.fillRect(0, 0, box.width, box.height);
    ctx.imageSmoothingEnabled = k < 3;
    ctx.drawImage(source, view.x, view.y, source.width * k, source.height * k);
    ctx.font = "600 13px sans-serif";
    for (const p of points) {
      const x = view.x + p.u * k;
      const y = view.y + p.v * k;
      ctx.strokeStyle = "#fff";
      ctx.fillStyle = "#d95926";
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.fillText(String(p.n), x + 9, y + 4);
    }
  }, [source, points, view]);
  return (
    <div className="stack" style={{ minWidth: 0 }}>
      <b className="small">{label}</b>
      <canvas
        ref={ref}
        className="pick-pane"
        onWheel={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - box.left;
          const my = e.clientY - box.top;
          const k0 = view.k || Math.min(box.width / source.width, box.height / source.height);
          const k = Math.max(0.02, Math.min(30, k0 * Math.exp(-e.deltaY * 0.0014)));
          setView({ k, x: mx - ((mx - view.x) / k0) * k, y: my - ((my - view.y) / k0) * k });
        }}
        onPointerDown={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const k = view.k || Math.min(box.width / source.width, box.height / source.height);
          const start = { x: e.clientX, y: e.clientY, view: { ...view, k } };
          let moved = false;
          const move = (m: PointerEvent) => {
            if (Math.hypot(m.clientX - start.x, m.clientY - start.y) > 4) moved = true;
            if (moved) setView({ ...start.view, x: start.view.x + m.clientX - start.x, y: start.view.y + m.clientY - start.y });
          };
          const up = (m: PointerEvent) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            if (!moved) onPick((m.clientX - box.left - start.view.x) / k, (m.clientY - box.top - start.view.y) / k);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      />
    </div>
  );
}

function HistoricMaps({ engine, projection, overlays, onOverlays, onDrape, mix, addNote, toast }: Props & { mix: number }) {
  const [image, setImage] = useState<HTMLCanvasElement | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [points, setPoints] = useState<ControlPoint[]>([]);
  const [pending, setPending] = useState<{ u: number; v: number } | null>(null);
  const plate = engine.plate.canvas;
  const fit = useMemo(() => fitAffine(points), [points]);
  const toWorld = (u: number, v: number) => ({ x: (u / plate.width) * 2 * projection.halfX - projection.halfX, z: (v / plate.height) * 2 * projection.halfZ - projection.halfZ });
  const toPlate = (x: number, z: number) => ({ u: ((x + projection.halfX) / (2 * projection.halfX)) * plate.width, v: ((z + projection.halfZ) / (2 * projection.halfZ)) * plate.height });

  const load = async (file: File) => {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    setImage(canvas);
    setName(file.name.replace(/\.[a-z]+$/i, ""));
    setPoints([]);
    setUrl(await api.uploadMedia(engine.data.spec.id, file, file.name.split(".").pop() ?? "jpg"));
  };
  const show = (canvas: HTMLCanvasElement, overlay: Pick<MapOverlay, "name" | "transform">) => {
    const [a, b, c, d, e, f] = overlay.transform;
    const warped = warpOverlay(canvas, { a, b, c, d, e, f }, projection);
    engine.setDrape(warped, mix);
    onDrape({ label: overlay.name, canvas: warped, source: "carta georiferita" });
    toast(`Sul suolo: ${overlay.name}`);
  };
  const reopen = async (overlay: MapOverlay) => {
    const canvas = await imageCanvas(overlay.url);
    show(canvas, overlay);
  };
  const save = () => {
    if (!fit || !image) return;
    const overlay: MapOverlay = { id: Date.now().toString(36), name: name || "Carta storica", url, points, transform: [fit.a, fit.b, fit.c, fit.d, fit.e, fit.f], rms: fit.rms };
    onOverlays([...overlays, overlay]);
    show(image, overlay);
    addNote("confronto", `Carta georiferita: ${overlay.name}`, `${points.length} punti di controllo, errore quadratico medio ${fit.rms.toFixed(1)} m.`, { instrument: "georiferimento", photo: url, values: { punti: String(points.length), "errore RMS": `${fit.rms.toFixed(1)} m` } });
    setImage(null);
    setPoints([]);
  };
  return (
    <>
      <p className="hint">Carica una carta antica, una planimetria di scavo o un disegno. Indica lo stesso punto sull'immagine e sulla lastra, almeno tre volte: con più di tre punti Sestante calcola anche l'errore, in metri. Clic per il punto, trascina per spostarti, rotella per lo zoom.</p>
      <label className="btn">
        Carica un'immagine
        <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
      </label>
      {image && (
        <>
          <label className="field">
            Nome
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="pick-grid">
            <PickPane source={image} label={pending ? "Punto scelto: ora indicalo sulla lastra →" : "1. Punto sulla carta"} points={[...points.map((p, i) => ({ u: p.u, v: p.v, n: i + 1 })), ...(pending ? [{ ...pending, n: points.length + 1 }] : [])]} onPick={(u, v) => setPending({ u, v })} />
            <PickPane
              source={plate}
              label="2. Stesso punto sulla lastra"
              points={points.map((p, i) => ({ ...toPlate(p.x, p.z), n: i + 1 }))}
              onPick={(u, v) => {
                if (!pending) return toast("Prima indica il punto sulla carta.");
                setPoints([...points, { ...pending, ...toWorld(u, v) }]);
                setPending(null);
              }}
            />
          </div>
          <div className="row wrap">
            <span className="mono small">
              {points.length} punti{fit ? ` · errore ${points.length > 3 ? `${fit.rms.toFixed(1)} m` : "non stimabile con 3 punti"}` : ""}
            </span>
            <button className="btn tiny" disabled={!points.length} onClick={() => setPoints(points.slice(0, -1))}>
              Togli l'ultimo
            </button>
            <button className="btn tiny primary" disabled={!fit} onClick={save}>
              Georiferisci e stendi
            </button>
          </div>
          {fit && points.length > 3 && <p className="small muted">Scarti: {fit.residuals.map((r, i) => `${i + 1}: ${r.toFixed(1)} m`).join(" · ")}</p>}
        </>
      )}
      {overlays.length > 0 && (
        <div>
          <div className="section-title">Carte di questa spedizione</div>
          {overlays.map((overlay) => (
            <div key={overlay.id} className="row">
              <button className="change grow" onClick={() => void reopen(overlay)}>
                {overlay.name}{" "}
                <span className="muted small mono">
                  {overlay.points.length} punti, ±{overlay.rms.toFixed(1)} m
                </span>
              </button>
              <button className="btn tiny" onClick={() => onOverlays(overlays.filter((row) => row.id !== overlay.id))}>
                Togli
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
