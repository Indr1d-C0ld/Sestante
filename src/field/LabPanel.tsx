import { useEffect, useMemo, useState } from "react";
import { api, canvasBlob, type GediStatus, type NasaEntry, type ServiceState } from "../core/api.ts";
import { alignments, astroEvents, horizonAltitude, planAxis } from "../core/archaeo.ts";
import { formatLatLon, type Projection } from "../core/geo.ts";
import { floodStats, sectionAlong, viewshed, type Section } from "../core/fieldwork.ts";
import { sunEvents } from "../core/solar.ts";
import type { Expedition, Hypothesis, Note, NoteKind, PlateVersion, StrataSummary, Investigation, LidarReport, PhotoFindRow, PhotoPlacement as PlacedPhoto, SavedRoute, SavedStudy } from "../core/types.ts";
import type { ShadowPlate } from "../vision/shadowTest.ts";
import type { Engine } from "../world/engine.ts";
import { PROVENANCE_LEGEND } from "../world/shading.ts";
import { CHART_COLORS, chartPicture, LineChart } from "./Charts.tsx";
import { dxf, geoJson, notesCsv, saveFile } from "./exports.ts";
import type { Building, interpretPlate } from "./load.ts";
import type { Drape } from "./LayersPanel.tsx";
import { absentIds, applyLaser, applyStrata, assessWorld, correctTrees, cubature, demChangeCanvas, heightErrorsFrom, intervalCoverage, plateDate, treePairs, volumeOfBuilding, readStrata, runBench, shadowPlateOf, viewshedCanvas, type BenchResult } from "./research.ts";
import { formatRange, formatVolume, solidVolume } from "../vision/volume.ts";
import { AncientRoutes, Dossier, Inquiry, LidarTab, Studies } from "./LabExtra.tsx";
import { PhotoFind } from "./PhotoFind.tsx";
import { demDifference, fitTrees, type ErrorStats, type LaserAssessment, type TreeFit, type TreeModel } from "../vision/laser.ts";

export type LabTab = "riprese" | "laser" | "rilievo" | "volumi" | "ipotesi" | "sezione" | "vista" | "cielo" | "acqua" | "origine" | "esporta" | "servizi" | "studi" | "indagine" | "vie" | "lidar" | "foto";

const TABS: [LabTab, string][] = [
  ["indagine", "Indagine"],
  ["studi", "Studi"],
  ["vie", "Vie antiche"],
  ["foto", "Foto"],
  ["lidar", "LiDAR"],
  ["riprese", "Riprese"],
  ["laser", "Laser"],
  ["rilievo", "Rilievo"],
  ["volumi", "Volumi"],
  ["ipotesi", "Ipotesi"],
  ["sezione", "Sezione"],
  ["vista", "Visibilità"],
  ["cielo", "Cielo"],
  ["acqua", "Acqua"],
  ["origine", "Origine"],
  ["esporta", "Esporta"],
  ["servizi", "Servizi"],
];

type AddNote = (kind: NoteKind, title: string, text: string, extra?: Partial<Note>) => void;

export type LabProps = {
  engine: Engine;
  expedition: Expedition;
  projection: Projection;
  versions: PlateVersion[];
  rereadCtx: Parameters<typeof interpretPlate>[2] | null;
  plateCache: Map<string, HTMLCanvasElement>;
  plates: ShadowPlate[];
  sectionPoints: { x: number; z: number }[];
  building: Building | null;
  tab: LabTab;
  flood: number | null;
  provenance: boolean;
  astroYear: number;
  onAstroYear: (year: number) => void;
  laser: LaserAssessment | null;
  laserShown: boolean;
  onLaser: (assessment: LaserAssessment) => void;
  onShowLaser: (assessment: LaserAssessment, visible: boolean) => void;
  onLaserApplied: () => void;
  onTreeModel: (model: TreeModel | null) => void;
  onTab: (tab: LabTab) => void;
  onPlates: (plates: ShadowPlate[]) => void;
  onStrata: (summary: StrataSummary) => void;
  onHypotheses: (list: Hypothesis[]) => void;
  onSection: (points: { x: number; z: number }[]) => void;
  onFlood: (level: number | null) => void;
  onProvenance: (on: boolean) => void;
  onDrape: (drape: Drape | null) => void;
  onSaveStudy: (name?: string) => Promise<unknown> | void;
  onOpenStudy: (study: SavedStudy) => Promise<unknown> | void;
  onStudies: (list: SavedStudy[]) => void;
  onInvestigation: (row: Investigation) => void;
  onRoutes: (list: SavedRoute[]) => void;
  onSights: (list: { a: { x: number; z: number }; b: { x: number; z: number }; visible: boolean }[]) => void;
  onLidarReport: (row: LidarReport) => void;
  onUseLidarTerrain: () => void;
  onPlacement: (row: PlacedPhoto) => Promise<unknown> | void;
  onPhotoFinds: (list: PhotoFindRow[]) => void;
  addNote: AddNote;
  toast: (text: string) => void;
  onClose: () => void;
};

export function LabPanel(props: LabProps) {
  const { tab, onTab, onClose } = props;
  return (
    <div className="panel wide" onClick={(e) => e.stopPropagation()}>
      <header className="panel-head">
        <h2 className="grow">Laboratorio</h2>
        <button className="btn tiny" onClick={onClose}>
          Chiudi (R)
        </button>
      </header>
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => onTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="panel-body stack">
        {tab === "riprese" && <Strata {...props} />}
        {tab === "laser" && <Laser {...props} />}
        {tab === "rilievo" && <Relief {...props} />}
        {tab === "volumi" && <Volumes {...props} />}
        {tab === "ipotesi" && <Hypotheses {...props} />}
        {tab === "sezione" && <SectionTab {...props} />}
        {tab === "vista" && <Sight {...props} />}
        {tab === "cielo" && <Sky {...props} />}
        {tab === "acqua" && <Water {...props} />}
        {tab === "origine" && <Origin {...props} />}
        {tab === "esporta" && <Export {...props} />}
        {tab === "servizi" && <Services {...props} />}
        {tab === "studi" && <Studies {...props} />}
        {tab === "indagine" && <Inquiry {...props} />}
        {tab === "vie" && <AncientRoutes {...props} />}
        {tab === "lidar" && <LidarTab {...props} />}
        {tab === "foto" && <PhotoFind {...props} />}
      </div>
    </div>
  );
}

const pinPicture = async (engine: Engine, canvas: HTMLCanvasElement) => api.uploadMedia(engine.data.spec.id, await canvasBlob(canvas), "jpg");

const buildingName = (b: Building) => b.tags.name ?? (b.tags.building && b.tags.building !== "yes" ? b.tags.building : "edificio");

const centroid = (b: Building) => {
  const ring = b.rings[0]!;
  let x = 0;
  let z = 0;
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i]!;
    z += ring[i + 1]!;
  }
  return { x: x / (ring.length / 2), z: z / (ring.length / 2) };
};

function Strata({ engine, expedition, versions, rereadCtx, plateCache, onPlates, onStrata, addNote, onClose }: LabProps) {
  const [limit, setLimit] = useState(Math.min(12, versions.length || 12));
  const [progress, setProgress] = useState<{ text: string; done: number; total: number } | null>(null);
  const [cancel, setCancel] = useState({ stop: false });
  const [error, setError] = useState("");
  const summary = expedition.strata ?? null;
  const run = async () => {
    if (!rereadCtx || !versions.length) return;
    const flag = { stop: false };
    setCancel(flag);
    setError("");
    try {
      const result = await readStrata(engine, rereadCtx, versions, limit, plateCache, (text, done, total) => setProgress({ text, done, total }), () => flag.stop);
      const improved = applyStrata(engine, result.summary);
      engine.refreshBuildings(absentIds(result.summary, plateDate(engine.plate.ref)));
      onPlates(result.plates);
      onStrata(result.summary);
      const appeared = Object.values(result.summary.presence).filter((row) => row.lastAbsent && row.confidence > 0.35).length;
      addNote("sistema", `Lette ${result.summary.shots.length} riprese`, `${improved} altezze sostituite con la lettura di più date, ${appeared} edifici datati fra due riprese. Le altezze scritte sulla mappa non sono state toccate.`, { instrument: "laboratorio", values: { riprese: String(result.summary.shots.length), "altezze multi-data": String(improved), "edifici datati": String(appeared) } });
    } catch (e) {
      setError((e as Error).message);
    }
    setProgress(null);
  };
  const stats = useMemo(() => {
    if (!summary) return null;
    const rows = engine.data.buildings.filter((b) => !b.isPart && summary.heights[b.id]);
    const disagree = rows
      .filter((b) => b.source === "OSM height" || b.source === "OSM piani")
      .map((b) => ({ b, read: summary.heights[b.id]!, gap: summary.heights[b.id]!.h - b.height }))
      .filter((row) => row.read.n >= 3 && Math.abs(row.gap) > Math.max(4, row.b.height * 0.3))
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
      .slice(0, 8);
    const appeared = engine.data.buildings
      .flatMap((b) => {
        const presence = summary.presence[b.id];
        return presence?.lastAbsent && presence.confidence > 0.35 ? [{ b, presence }] : [];
      })
      .sort((a, b) => (b.presence.lastAbsent ?? "").localeCompare(a.presence.lastAbsent ?? ""));
    const multi = rows.filter((b) => b.source === "ombre multi-data");
    return { read: rows.length, multi: multi.length, disagree, appeared };
  }, [summary]);
  const goTo = (b: Building) => {
    const c = centroid(b);
    engine.teleport(c.x, c.z);
    onClose();
  };
  return (
    <>
      <p className="hint">Ogni ripresa ha il suo sole, quindi ogni ombra è una misura indipendente. Leggendole tutte insieme le altezze ricevono un margine d'errore, e si vede quando un edificio compare. Sui riquadri grandi può richiedere qualche minuto: le tessere restano in cache.</p>
      <div className="row wrap">
        <label className="field">
          Riprese da leggere: {limit} su {versions.length}
          <input type="range" min={2} max={Math.max(2, versions.length)} step={1} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        </label>
        <button className="btn primary" disabled={!!progress || versions.length < 2} onClick={() => void run()}>
          {summary ? "Rileggi le riprese" : "Leggi le riprese"}
        </button>
        {progress && (
          <button className="btn tiny" onClick={() => (cancel.stop = true)}>
            Fermati qui
          </button>
        )}
      </div>
      {error && <p className="small warn">{error}</p>}
      {progress && (
        <div>
          <progress max={progress.total} value={progress.done} style={{ width: "100%" }} />
          <p className="mono small">{progress.text}</p>
        </div>
      )}
      {versions.length < 2 && <p className="hint">Questa fonte non ha più riprese del luogo, o l'archivio sta ancora rispondendo.</p>}
      {summary && stats && (
        <>
          <p>
            <b>{summary.shots.length}</b> riprese lette: <b>{stats.read}</b> edifici hanno almeno un'ombra misurata, <b>{stats.multi}</b> usano ora la lettura multi-data, <b>{stats.appeared.length}</b> risultano datati.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Scatto</th>
                <th>Sensore</th>
                <th>m/px</th>
                <th>Sole az.</th>
                <th>Sole alt.</th>
                <th>Istante UTC</th>
                <th>Metodo</th>
              </tr>
            </thead>
            <tbody>
              {summary.shots.map((shot) => (
                <tr key={`${shot.date}-${shot.sensor}`}>
                  <td>{shot.date}</td>
                  <td>{shot.sensor ?? "—"}</td>
                  <td>{shot.resolution ?? "—"}</td>
                  <td>{((shot.sunAzimuth * 180) / Math.PI).toFixed(0)}°</td>
                  <td>{((shot.altitude * 180) / Math.PI).toFixed(0)}°</td>
                  <td>{shot.instant ? shot.instant.slice(11, 16) : "—"}</td>
                  <td>{shot.method}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stats.appeared.length > 0 && (
            <div>
              <div className="section-title">Edifici datati</div>
              <p className="hint">Assenti fino alla prima data e visibili dalla seconda. Tornando a uno scatto più vecchio questi edifici spariscono dal mondo. Controllali a occhio: alberi e cantieri possono ingannare la lettura.</p>
              {stats.appeared.slice(0, 16).map(({ b, presence }) => (
                <button key={b.id} className="change" onClick={() => goTo(b)}>
                  {buildingName(b)}{" "}
                  <span className="muted small mono">
                    fra {presence.lastAbsent} e {presence.firstSeen ?? "oggi"}, certezza {(presence.confidence * 100).toFixed(0)}%
                  </span>
                </button>
              ))}
            </div>
          )}
          {stats.disagree.length > 0 && (
            <div>
              <div className="section-title">Mappa e ombre non concordano</div>
              {stats.disagree.map(({ b, read, gap }) => (
                <button key={b.id} className="change" onClick={() => goTo(b)}>
                  {buildingName(b)}{" "}
                  <span className="muted small mono">
                    mappa {b.height.toFixed(0)} m, ombre {read.h.toFixed(0)} m ({gap > 0 ? "+" : ""}
                    {gap.toFixed(0)}), {read.n} riprese
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

const SOURCE_NAMES: Record<string, string> = {
  "OSM height": "Altezza scritta nella mappa",
  "OSM piani": "Piani scritti nella mappa",
  "ombre multi-data": "Ombre di più riprese",
  ombra: "Ombra di una ripresa",
  ripresa: "Corpo dedotto",
  quartiere: "Mediana del quartiere",
  "tipo edilizio": "Tipica del tipo edilizio",
};

function StatsRows({ rows }: { rows: ErrorStats[] }) {
  return (
    <>
      {rows.map((row) => (
        <tr key={row.label}>
          <td>{SOURCE_NAMES[row.label] ?? row.label}</td>
          <td>{row.n}</td>
          <td>
            {row.bias > 0 ? "+" : ""}
            {row.bias.toFixed(1)} m
          </td>
          <td>{row.typical.toFixed(1)} m</td>
          <td>{(row.within3 * 100).toFixed(0)}%</td>
        </tr>
      ))}
    </>
  );
}

function TreeSection({ engine, expedition, laser, onTreeModel, addNote, toast }: LabProps) {
  const fit = useMemo<TreeFit | null>(() => (laser ? fitTrees(treePairs(laser, engine.plate.trees)) : null), [laser]);
  const applied = !!expedition.treeModel;
  if (!fit) return null;
  const apply = () => {
    if (!fit.model) return;
    correctTrees(engine.plate.trees, fit.model);
    engine.refreshTrees();
    onTreeModel(fit.model);
    addNote("sistema", "Alberi riportati alla quota del laser", `${fit.model.kind === "locale" ? `Altezza locale entro ${fit.model.radius} m` : "Altezza del luogo"}, da ${fit.n} impronte. Sulle orbite escluse l'errore tipico passa da ${fit.before.typical.toFixed(1)} a ${fit.after!.typical.toFixed(1)} m. Vale per il gruppo di alberi, non per il singolo.`, { instrument: "GEDI", values: { impronte: String(fit.n), prima: `${fit.before.typical.toFixed(1)} m`, dopo: `${fit.after!.typical.toFixed(1)} m` } });
    toast("Alberi corretti: resta la variazione, ridotta.");
  };
  const undo = () => {
    correctTrees(engine.plate.trees, null);
    engine.refreshTrees();
    onTreeModel(null);
  };
  return (
    <div>
      <div className="section-title">Alberi</div>
      <p>
        Il legame fra l'altezza letta per ogni chioma e quella del laser è <b>{Math.abs(fit.correlation) < 0.3 ? "quasi nullo" : Math.abs(fit.correlation) < 0.6 ? "debole" : "discreto"}</b> (correlazione {fit.correlation.toFixed(2)} su {fit.n} impronte). {Math.abs(fit.correlation) < 0.3 ? "Una foto dall'alto non basta a dire quanto è alto il singolo albero: il laser può dire solo quanto sono alti gli alberi di quella zona." : ""}
      </p>
      {fit.after && (
        <table className="data">
          <thead>
            <tr>
              <th>Su orbite escluse dal calcolo</th>
              <th>Errore medio</th>
              <th>Errore tipico</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Come letti dalla lastra</td>
              <td>{fit.before.bias.toFixed(1)} m</td>
              <td>{fit.before.typical.toFixed(1)} m</td>
            </tr>
            <tr>
              <td>Con la correzione</td>
              <td>{fit.after.bias.toFixed(1)} m</td>
              <td>{fit.after.typical.toFixed(1)} m</td>
            </tr>
          </tbody>
        </table>
      )}
      {fit.reason && <p className="hint">{fit.reason}</p>}
      <div className="row wrap">
        {fit.model && !applied && (
          <button className="btn tiny primary" onClick={apply}>
            Riporta gli alberi alla quota del laser
          </button>
        )}
        {applied && (
          <>
            <span className="small">Correzione attiva, anche sulle altre riprese.</span>
            <button className="btn tiny" onClick={undo}>
              Torna alle altezze lette
            </button>
          </>
        )}
      </div>
      <p className="hint">Si applica a tutti gli alberi non mappati del riquadro. Ogni albero conserva una parte ridotta della propria differenza, così il bosco non diventa uniforme: quella differenza è aspetto, non misura.</p>
    </div>
  );
}

function Laser(props: LabProps) {
  const { engine, expedition, laser, laserShown, onLaser, onShowLaser, onLaserApplied, addNote, toast, onClose } = props;
  const box = expedition.spec.bbox;
  const [status, setStatus] = useState<GediStatus | null>(null);
  useEffect(() => {
    let live = true;
    let timer = 0;
    const poll = async () => {
      const row = await api.gedi(box).catch(() => null);
      if (!live || !row) return;
      setStatus(row);
      if (row.state === "pronto" && !laser) onLaser(assessWorld(engine, row.shots));
      if (row.state === "in corso") timer = window.setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [status?.state === "in corso"]);
  const start = async () => {
    setStatus(await api.startGedi(box));
  };
  const a = laser;
  const useIt = () => {
    if (!a) return;
    const changed = applyLaser(engine, a);
    engine.refreshBuildings();
    onLaserApplied();
    if (status) onLaser(assessWorld(engine, status.shots));
    addNote("sistema", `Il laser ha fissato ${changed} altezze`, "Solo edifici senza altezza scritta sulla mappa, con l'impronta quasi tutta dentro la sagoma. La data dello scatto laser può non coincidere con quella della lastra.", { instrument: "GEDI", values: { altezze: String(changed) } });
    toast(`${changed} altezze ora vengono dal laser.`);
  };
  const buildingRows = a?.readings.filter((row) => row.kind === "edificio" && row.shot.good) ?? [];
  const dates = status?.shots.map((row) => row.date).filter(Boolean).sort() ?? [];
  const worst = [...buildingRows].sort((x, y) => Math.abs(y.error!) - Math.abs(x.error!)).slice(0, 8);
  const sorted = [...buildingRows].sort((x, y) => x.measured - y.measured);
  const note = () => {
    if (!a) return;
    const total = a.bySource.reduce((sum, row) => sum + row.n, 0);
    addNote("misura", `Confronto col laser: ${total} impronte su edifici`, `Riferimento locale ${a.datum.toFixed(1)} m, ${a.datumFrom}.`, { instrument: "GEDI", values: Object.fromEntries(a.bySource.map((row) => [SOURCE_NAMES[row.label] ?? row.label, `errore tipico ${row.typical.toFixed(1)} m su ${row.n}`])) });
  };
  return (
    <>
      <p className="hint">GEDI è un laser sulla Stazione Spaziale: misura cima e suolo in dischi di 25 m, senza guardare foto o mappe. È il controllo indipendente di tutto ciò che Sestante deduce. NASA ritaglia per te ogni orbita passata sul riquadro: servono alcuni minuti, poi il risultato resta sul disco.</p>
      {(!status || status.state === "assente" || status.state === "fallito") && (
        <button className="btn primary" onClick={() => void start()}>
          Chiedi le impronte a NASA
        </button>
      )}
      {status?.state === "fallito" && <p className="small warn">{status.message}</p>}
      {status?.state === "in corso" && (
        <div>
          <progress max={100} value={status.progress} style={{ width: "100%" }} />
          <p className="mono small">{status.message}</p>
          <p className="hint">Puoi chiudere il pannello e continuare a camminare: il lavoro prosegue, anche se riavvii Sestante.</p>
        </div>
      )}
      {status?.state === "pronto" && a && (
        <>
          <p>
            <b>{a.counts.total}</b> impronte da {status.granules} orbite{dates.length ? `, dal ${dates[0]} al ${dates[dates.length - 1]}` : ""}. Di buona qualità: <b>{a.counts.good}</b>, di cui {a.counts.buildings} su edifici, {a.counts.trees} su alberi, {a.counts.open} su terreno aperto.
          </p>
          {a.counts.total > 0 && (
            <div className="row wrap">
              <label className="row small">
                <input type="checkbox" checked={laserShown} onChange={(e) => onShowLaser(a, e.target.checked)} />
                Mostra le impronte nel mondo e sulla carta
              </label>
              <button className="btn tiny" onClick={note}>
                Annota il confronto
              </button>
              <button className="btn tiny primary" disabled={!buildingRows.length} onClick={useIt}>
                Usa il laser per le altezze non mappate
              </button>
            </div>
          )}
          {a.counts.total === 0 && <p className="hint">Nessuna impronta cade in questo riquadro: GEDI passa a strisce distanti centinaia di metri. Un riquadro più grande ne prenderà di più.</p>}
          <dl className="kv">
            <dt>Riferimento locale</dt>
            <dd>
              {a.datum.toFixed(1)} m ± {a.datumSpread.toFixed(1)}: GEDI dà la quota sull'ellissoide, stimata da {a.datumFrom}
            </dd>
          </dl>
          <div>
            <div className="section-title">Quanto sbagliano le altezze del mondo</div>
            {buildingRows.length === 0 && <p className="hint">Nessuna impronta buona cade dentro un edificio: per ora non si può misurare l'errore qui.</p>}
            {buildingRows.length > 0 && (
              <table className="data">
                <thead>
                  <tr>
                    <th>Fonte dell'altezza</th>
                    <th>Impronte</th>
                    <th>Errore medio</th>
                    <th>Errore tipico</th>
                    <th>Entro 3 m</th>
                  </tr>
                </thead>
                <tbody>
                  <StatsRows rows={a.bySource} />
                  {a.shadows && <StatsRows rows={[a.shadows]} />}
                </tbody>
              </table>
            )}
            <p className="hint">Errore medio: mediana di mondo meno laser; positivo significa che il mondo è più alto. Errore tipico: mediana dell'errore assoluto. Con poche impronte sono indicazioni, non statistiche. La riga delle ombre vale anche per gli edifici mappati, e va letta dopo aver letto le riprese.</p>
          </div>
          <TreeSection {...props} />
          {sorted.length > 1 && (
            <LineChart
              title="Altezza del mondo contro altezza misurata dal laser"
              x={sorted.map((row) => row.measured)}
              xLabel={(v) => `${v.toFixed(0)} m`}
              series={[
                { label: "Accordo perfetto", color: "#8f8f8c", values: sorted.map((row) => row.measured) },
                { label: "Impronte su edifici", color: CHART_COLORS.one, values: sorted.map((row) => row.model), asDots: true },
              ]}
              unit="m"
              height={220}
            />
          )}
          {worst.length > 0 && (
            <div>
              <div className="section-title">Maggiori disaccordi</div>
              {worst.map((row) => (
                <button
                  key={row.shot.id}
                  className="change"
                  onClick={() => {
                    engine.teleport(row.shot.x, row.shot.z);
                    onClose();
                  }}
                >
                  {row.building!.name}{" "}
                  <span className="muted small mono">
                    mondo {row.model!.toFixed(0)} m, laser {row.measured.toFixed(0)} m, {row.shot.date}, sagoma {(row.share * 100).toFixed(0)}% del disco
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function Volumes({ engine, expedition, laser, projection, addNote, onClose }: LabProps) {
  const errors = useMemo(() => heightErrorsFrom(laser), [laser]);
  const rows = useMemo(() => cubature(engine.data.buildings, engine.plate.masses, errors), [errors, expedition.strata, expedition.laserApplied]);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const half = Math.hypot(...rows.map((row) => row.half));
  const area = projection.halfX * projection.halfZ * 4;
  const coverage = useMemo(() => intervalCoverage(laser, errors), [laser, errors]);
  const biggest = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string; value: number; low: number; high: number; x: number; z: number; source: string }[] = [];
    const rowsByVolume = engine.data.buildings.filter((b) => !b.hidden).map((b) => ({ b, own: volumeOfBuilding({ ...b, isPart: false }, [], errors).own })).sort((a, b) => b.own.value - a.own.value);
    for (const { b } of rowsByVolume.slice(0, 40)) {
      const row = volumeOfBuilding(b, engine.data.buildings, errors);
      const main = row.complex ?? row.own;
      const name = row.complex?.name ?? b.tags.name ?? "edificio";
      const key = row.complex ? `c:${name}` : b.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = centroid(b);
      out.push({ id: key, name, value: main.value, low: main.low, high: main.high, x: c.x, z: c.z, source: b.source });
    }
    return out.sort((a, b) => b.value - a.value).slice(0, 10);
  }, [errors, expedition.strata, expedition.laserApplied]);
  const masses = expedition.masses ?? [];
  const hypotheses = expedition.hypotheses ?? [];
  const csv = () => {
    const lines = ["tipo;nome;fonte;volume_m3;min_m3;max_m3"];
    for (const row of biggest) lines.push(["edificio", row.name, row.source, row.value.toFixed(0), row.low.toFixed(0), row.high.toFixed(0)].join(";"));
    for (const row of masses) lines.push(["massa", row.name, row.sources, row.fill.value.toFixed(0), row.fill.low.toFixed(0), row.fill.high.toFixed(0)].join(";"));
    saveFile(`volumi-${expedition.spec.id}.csv`, `${lines.join("\n")}\n`, "text/csv");
  };
  return (
    <>
      <p className="hint">Ogni volume ha il suo intervallo. Gli edifici si misurano da pianta e altezza, tolti i cortili; le masse sul terreno dal modello del rilievo, a cui si toglie il suolo ricostruito dal bordo. Interni, vuoti e interrati non si vedono, quindi questi sono volumi esterni, non capienze.</p>
      <div>
        <div className="section-title">Cubatura costruita del riquadro</div>
        <p>
          <b>{formatVolume(total)}</b> ({formatRange({ value: total, low: Math.max(0, total - half), high: total + half })}), in media {(total / area).toFixed(1)} m³ per m² di suolo.
        </p>
        <table className="data">
          <thead>
            <tr>
              <th>Fonte dell'altezza</th>
              <th>Edifici</th>
              <th>Volume</th>
              <th>Quota</th>
              <th>Errore d'altezza</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.source}>
                <td>{SOURCE_NAMES[row.source] ?? row.source}</td>
                <td>{row.count}</td>
                <td>{formatVolume(row.value)}</td>
                <td>{((row.value / (total || 1)) * 100).toFixed(0)}%</td>
                <td title={errors[row.source]?.basis}>
                  ±{errors[row.source]?.typical.toFixed(1)} m, {errors[row.source]?.basis.split(":")[0]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">Nel totale gli errori dei singoli edifici in buona parte si compensano. Resta lo scarto comune a ogni fonte: misurato col laser dove c'è, altrimenti presunto pari a metà dell'errore tipico.</p>
        {coverage && (
          <p className="small">
            Verifica col laser: {coverage.hits} impronte su {coverage.total} cadono dentro l'intervallo delle altezze ({(coverage.share * 100).toFixed(0)}%, l'attesa è circa 80%).
            {coverage.total < 15 ? " Sono poche: è solo un indizio." : ""} Dove gli errori sono stati misurati su queste stesse impronte, il controllo è in parte circolare.
          </p>
        )}
      </div>
      <div>
        <div className="section-title">Le strutture più voluminose</div>
        {biggest.map((row) => (
          <div key={row.id} className="row">
            <button
              className="change grow"
              onClick={() => {
                engine.teleport(row.x, row.z);
                onClose();
              }}
            >
              <bdi>{row.name}</bdi> <span className="muted small mono">{formatVolume(row.value)} ({formatRange(row)})</span>
            </button>
            <button className="btn tiny" onClick={() => addNote("misura", `\u2068${row.name}\u2069: ${formatVolume(row.value)}`, "Volume esterno da pianta e altezza.", { instrument: "volumetro", values: { intervallo: formatRange(row), fonte: row.source } })}>
              Annota
            </button>
          </div>
        ))}
      </div>
      <div>
        <div className="section-title">Masse sul terreno</div>
        {!masses.length && (
          <p className="hint">
            Con il <b>Volumetro</b> nella borsa, mira il suolo e premi F per tracciare il contorno di un cumulo, un tumulo, una cava. Dal drone si vede meglio. Tornando a mirare il primo punto il contorno si chiude e si misura. Il modello ha celle da 30 m: sotto un ettaro circa il numero vale poco.
          </p>
        )}
        {masses.map((row) => (
          <article key={row.id} className="entry-dark stack">
            <div className="row">
              <b className="grow">{row.name}</b>
              <span className="small mono muted">
                {(row.area / 10000).toFixed(2)} ha · {row.nativeCells.toFixed(0)} celle da 30 m
              </span>
            </div>
            {row.warning && <p className="small warn">{row.warning}</p>}
            <dl className="kv">
              <dt>Sopra il suolo</dt>
              <dd>
                {formatVolume(row.fill.value)} ({formatRange(row.fill)}), fino a {row.peak.toFixed(1)} m
              </dd>
              <dt>Sotto il suolo</dt>
              <dd>
                {formatVolume(row.cut.value)} ({formatRange(row.cut)}), fino a {row.pit.toFixed(1)} m
              </dd>
              {row.models?.length > 1 && (
                <>
                  <dt>Modello per modello</dt>
                  <dd>{row.models.map((model) => `${model.name}: ${formatVolume(model.fill)}, cima a ${model.peak.toFixed(0)} m`).join("; ")}</dd>
                </>
              )}
              {row.mapVolume > 0 && (
                <>
                  <dt>Edifici sulla carta qui dentro</dt>
                  <dd>{formatVolume(row.mapVolume)}</dd>
                </>
              )}
              <dt>Irregolarità del bordo</dt>
              <dd>{row.rimRoughness.toFixed(1)} m</dd>
              {row.change && (
                <>
                  <dt>Copernicus meno NASADEM</dt>
                  <dd>
                    {row.change.significant ? `${row.change.net > 0 ? "+" : ""}${formatVolume(row.change.net)}: può essere un cambiamento vero fra il 2000 e il 2013, o solo la risposta diversa dei due radar` : "nessuna differenza distinguibile dal rumore"}
                  </dd>
                </>
              )}
              <dt>Fonte</dt>
              <dd>{row.sources}</dd>
            </dl>
          </article>
        ))}
        {masses.length > 0 && <p className="hint">Il rilievo misura anche tetti e chiome: dentro il contorno vengono contati, e un bordo fra gli alberi sposta la base. Ciò che è sepolto resta invisibile. Il radar non segue le pareti ripide: va discretamente per colline, cumuli e cave, male per oggetti come una piramide, e l'intervallo non basta a coprire questo errore. Al collaudo il Monte Testaccio è risultato 458 600 m³ contro i circa 580 000 pubblicati, Cheope 732 400 m³ contro 2,4 milioni: il rilievo tende a stare sotto il vero. Per lo stesso motivo la differenza fra i due modelli non prova un cambiamento: Cheope, che non è cambiata, risulta più bassa di un milione di m³.</p>}
      </div>
      {hypotheses.length > 0 && (
        <div>
          <div className="section-title">Volumi ipotetici</div>
          <table className="data">
            <tbody>
              {hypotheses.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.height.toFixed(1)} m</td>
                  <td>{formatVolume(solidVolume({ rings: [row.ring], height: row.height }).volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button className="btn tiny" onClick={csv}>
        Volumi in CSV
      </button>
    </>
  );
}

function Relief({ engine, expedition, projection, onDrape, addNote, toast }: LabProps) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReturnType<typeof demDifference> | null>(null);
  const compare = async () => {
    setBusy("Leggo NASADEM e Copernicus…");
    setError("");
    try {
      const k = Math.min(512, Math.max(32, Math.round((Math.max(projection.halfX, projection.halfZ) * 2) / 30)));
      const cols = Math.max(16, Math.round((k * projection.halfX) / Math.max(projection.halfX, projection.halfZ)));
      const rows = Math.max(16, Math.round((k * projection.halfZ) / Math.max(projection.halfX, projection.halfZ)));
      const box = expedition.spec.bbox;
      const [older, newer] = await Promise.all([api.demGrid(box, cols, rows, "nasadem"), api.demGrid(box, cols, rows, "copernicus")]);
      const diff = demDifference(older, newer);
      setResult(diff);
      const canvas = demChangeCanvas(diff.difference, cols, rows);
      engine.setDrape(canvas, 0.8);
      onDrape({ label: "Rilievo 2000 → circa 2013", canvas, source: "NASADEM e Copernicus GLO-30" });
      toast("Azzurro: cresciuto. Arancio: abbassato.");
      addNote("confronto", "Rilievo: 2000 contro circa 2013", `Cresciuto di oltre 5 m il ${(diff.rose * 100).toFixed(1)}% dell'area, abbassato di oltre 5 m il ${(diff.sank * 100).toFixed(1)}%.`, { instrument: "rilievo", values: { "massimo in salita": `${diff.highest.toFixed(0)} m`, "massimo in discesa": `${diff.lowest.toFixed(0)} m`, "scarto fra sensori": `${diff.bias.toFixed(1)} m` } });
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy("");
  };
  return (
    <>
      <p className="hint">NASADEM viene dal radar SRTM del febbraio 2000, Copernicus da TanDEM-X, circa 2011–2015. Entrambi misurano anche tetti e chiome: la differenza mostra cosa è cresciuto o scomparso a grana di 30 m, come palazzi nuovi, cave, discariche e boschi tagliati. Sotto i 5 m è soprattutto rumore, e sensori diversi vedono in modo diverso la vegetazione e le pareti ripide: la piramide di Cheope, che non è cambiata, qui risulta abbassata di decine di metri.</p>
      <button className="btn primary" disabled={!!busy} onClick={() => void compare()}>
        Confronta e stendi sul suolo
      </button>
      {busy && <p className="mono small">{busy}</p>}
      {error && <p className="small warn">{error}</p>}
      {result && (
        <dl className="kv">
          <dt>Cresciuto di oltre 5 m</dt>
          <dd>{(result.rose * 100).toFixed(1)}% dell'area</dd>
          <dt>Abbassato di oltre 5 m</dt>
          <dd>{(result.sank * 100).toFixed(1)}% dell'area</dd>
          <dt>Estremi</dt>
          <dd>
            +{result.highest.toFixed(0)} m / {result.lowest.toFixed(0)} m
          </dd>
          <dt>Scarto fra i sensori</dt>
          <dd>{result.bias.toFixed(1)} m, già tolto</dd>
        </dl>
      )}
    </>
  );
}

function Bench({ result }: { result: BenchResult }) {
  return (
    <div className="stack">
      <p>
        <b>{result.label}</b>: l'ombra prevista cade su zone scure il {(result.lift * 100).toFixed(0)}% in più rispetto al terreno intorno.
        {result.suggested != null && ` L'altezza che spiega meglio le ombre è circa ${result.suggested.toFixed(1)} m.`}
      </p>
      <table className="data">
        <thead>
          <tr>
            <th>Ripresa</th>
            <th>Ombra attesa</th>
            <th>Lunghezza</th>
            <th>Coperta</th>
            <th>Fondo</th>
          </tr>
        </thead>
        <tbody>
          {result.scores.map((row) => (
            <tr key={row.date}>
              <td>{row.date}</td>
              <td>{row.expected.toFixed(0)} m²</td>
              <td>{row.lengthM.toFixed(1)} m</td>
              <td>{(row.covered * 100).toFixed(0)}%</td>
              <td>{(row.background * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Hypotheses(props: LabProps) {
  const { engine, expedition, projection, plates, building, onHypotheses, addNote, toast } = props;
  const list = expedition.hypotheses ?? [];
  const [results, setResults] = useState<Record<string, BenchResult>>({});
  const available = () => (plates.length ? plates : [shadowPlateOf(engine.plate.analysis, plateDate(engine.plate.ref))]);
  const update = (id: string, change: Partial<Hypothesis>) => onHypotheses(list.map((row) => (row.id === id ? { ...row, ...change } : row)));
  const test = async (rings: number[][], height: number, key: string, title: string) => {
    const result = runBench(rings, height, available(), engine.plate.canvas, projection);
    setResults((rows) => ({ ...rows, [key]: result }));
    const photo = await pinPicture(engine, result.picture);
    addNote("misura", `Banco delle ombre: ${title}`, `${result.label}. Volume alto ${height.toFixed(1)} m, ${result.scores.length} riprese.`, {
      instrument: "banco delle ombre",
      photo,
      values: { scarto: `${(result.lift * 100).toFixed(0)}%`, ...(result.suggested != null ? { "altezza migliore": `${result.suggested.toFixed(1)} m` } : {}) },
    });
    return result;
  };
  return (
    <>
      <p className="hint">
        Proponi un volume che forse c'era o c'è ancora: con lo strumento <b>Ipotesi di volume</b> nella borsa, F fissa i vertici a terra. Il banco calcola dove deve cadere la sua ombra in ogni ripresa e controlla se la foto è scura proprio lì. Per un risultato forte leggi prima tutte le riprese: {plates.length ? `ora ne ha ${plates.length}` : "ora usa solo la lastra in vista"}.
      </p>
      {!list.length && <p className="muted">Ancora nessuna ipotesi.</p>}
      {list.map((row) => (
        <article key={row.id} className="entry-dark stack">
          <div className="row wrap">
            <input type="text" value={row.name} aria-label="Nome dell'ipotesi" onChange={(e) => update(row.id, { name: e.target.value })} />
            <label className="field grow">
              Altezza {row.height.toFixed(1)} m
              <input type="range" min={1} max={120} step={0.5} value={row.height} onChange={(e) => update(row.id, { height: Number(e.target.value) })} />
            </label>
            <button className="btn tiny primary" onClick={() => void test([row.ring], row.height, row.id, row.name).then((result) => update(row.id, { verdict: result.label }))}>
              Prova sulle ombre
            </button>
            <button className="btn tiny" onClick={() => onHypotheses(list.filter((item) => item.id !== row.id))}>
              Elimina
            </button>
          </div>
          <textarea rows={2} placeholder="Perché lo pensi, cosa lo proverebbe…" value={row.note} onChange={(e) => update(row.id, { note: e.target.value })} />
          {results[row.id] && (
            <>
              <Bench result={results[row.id]!} />
              {results[row.id]!.suggested != null && (
                <button className="btn tiny" onClick={() => update(row.id, { height: results[row.id]!.suggested! })}>
                  Usa {results[row.id]!.suggested!.toFixed(1)} m
                </button>
              )}
            </>
          )}
          {row.verdict && !results[row.id] && <p className="small muted">Ultimo esito: {row.verdict}.</p>}
          <Dossier row={row} props={props} update={(change) => update(row.id, change)} />
        </article>
      ))}
      {building && (
        <div>
          <div className="section-title">Edificio ispezionato: {building.tags.name ?? building.id}</div>
          <div className="row wrap">
            <span className="small mono">
              {building.height.toFixed(1)} m · {building.source}
            </span>
            <button className="btn tiny" onClick={() => void test(building.rings, building.height, `b-${building.id}`, building.tags.name ?? "edificio").catch((e: Error) => toast(e.message))}>
              Prova sulle ombre
            </button>
          </div>
          {results[`b-${building.id}`] && <Bench result={results[`b-${building.id}`]!} />}
          <p className="hint">Dove altri edifici proiettano ombra sulla stessa zona il test si confonde: leggi lo scarto insieme alla foto allegata nel registro.</p>
        </div>
      )}
    </>
  );
}

function SectionTab({ engine, sectionPoints, onSection, addNote }: LabProps) {
  const section = useMemo<Section | null>(() => (sectionPoints.length >= 2 ? sectionAlong(sectionPoints, engine.heightAt, engine.surfaceAt) : null), [sectionPoints]);
  const series = section
    ? [
        // Where nothing stands on the ground the two coincide: the surface goes underneath so that the ground stays readable.
        { label: "Superficie", color: CHART_COLORS.two, values: section.surface },
        { label: "Suolo", color: CHART_COLORS.one, values: section.ground },
      ]
    : [];
  const pin = async () => {
    if (!section) return;
    const picture = chartPicture("Sezione del terreno", section.distance, series, "metri", (v) => `${v.toFixed(0)} m`);
    addNote("misura", `Sezione di ${section.length.toFixed(0)} m`, `Salita ${section.gain.toFixed(1)} m, discesa ${section.loss.toFixed(1)} m.`, { instrument: "sezione", photo: await pinPicture(engine, picture), values: { lunghezza: `${section.length.toFixed(1)} m`, "quota minima": `${section.min.toFixed(1)} m`, "quota massima": `${section.max.toFixed(1)} m`, "pendenza massima": `${section.maxSlope.toFixed(1)}°` } });
  };
  return (
    <>
      <p className="hint">
        Con lo strumento <b>Sezione del terreno</b> nella borsa, F fissa i punti di un tracciato. Qui vedi il profilo del suolo e di ciò che ci sta sopra.
      </p>
      {!section && <p className="muted">Servono almeno due punti: ne hai {sectionPoints.length}.</p>}
      {section && (
        <>
          <LineChart title={`Sezione di ${section.length.toFixed(0)} m`} x={section.distance} xLabel={(v) => `${v.toFixed(0)} m`} series={series} unit="m" height={220} />
          <dl className="kv">
            <dt>Salita / discesa</dt>
            <dd>
              {section.gain.toFixed(1)} / {section.loss.toFixed(1)} m
            </dd>
            <dt>Quote</dt>
            <dd>
              {section.min.toFixed(1)} … {section.max.toFixed(1)} m
            </dd>
            <dt>Pendenza massima</dt>
            <dd>{section.maxSlope.toFixed(1)}°</dd>
          </dl>
          <div className="row">
            <button className="btn tiny primary" onClick={() => void pin()}>
              Allega al registro
            </button>
            <button className="btn tiny" onClick={() => onSection([])}>
              Nuovo tracciato
            </button>
          </div>
        </>
      )}
    </>
  );
}

function Sight({ engine, projection, onDrape, addNote, toast }: LabProps) {
  const [radius, setRadius] = useState(Math.min(1500, Math.round(Math.max(projection.halfX, projection.halfZ) * 1.2)));
  const [eye, setEye] = useState(1.7);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ share: number; farthest: number; at: string } | null>(null);
  const compute = async () => {
    setBusy(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const s = engine.snapshot();
    const v = viewshed(s.x, s.z, s.ground + eye, radius, engine.surfaceAt, 513);
    const canvas = viewshedCanvas(v, s.x, s.z, projection);
    engine.setDrape(canvas, 0.85);
    onDrape({ label: `Visibilità da ${formatLatLon(s.lat, s.lon)}`, canvas, source: "calcolo su DEM ed edifici" });
    setResult({ share: v.share, farthest: v.farthest, at: formatLatLon(s.lat, s.lon) });
    setBusy(false);
    addNote("misura", `Da qui si vede il ${(v.share * 100).toFixed(0)}% del raggio`, `Raggio ${radius} m, occhio a ${eye.toFixed(1)} m. Punto visibile più lontano a ${v.farthest.toFixed(0)} m.`, { instrument: "visibilità", values: { raggio: `${radius} m`, visibile: `${(v.share * 100).toFixed(1)}%` } });
    toast("Azzurro: visibile. Scuro: nascosto.");
  };
  return (
    <>
      <p className="hint">Da dove sei, che cosa si vede? Il calcolo traccia un raggio per ogni direzione sul rilievo e sugli edifici, con curvatura terrestre e rifrazione. Gli alberi non vengono considerati, e oltre il riquadro il disegno non arriva.</p>
      <label className="field">
        Raggio: {radius} m
        <input type="range" min={100} max={6000} step={50} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
      </label>
      <label className="field">
        Altezza dell'occhio: {eye.toFixed(1)} m
        <input type="range" min={1} max={60} step={0.5} value={eye} onChange={(e) => setEye(Number(e.target.value))} />
      </label>
      <button className="btn primary" disabled={busy} onClick={() => void compute()}>
        {busy ? "Calcolo…" : "Calcola dal punto in cui sei"}
      </button>
      {result && (
        <p>
          Da {result.at}: visibile il <b>{(result.share * 100).toFixed(1)}%</b> del cerchio, fino a {result.farthest.toFixed(0)} m.
        </p>
      )}
    </>
  );
}

const yearText = (y: number) => (y < 0 ? `${-y} a.C.` : `${y}`);

function Sky({ engine, projection, building, astroYear: year, onAstroYear: setYear, addNote, toast }: LabProps) {
  const [useRelief, setUseRelief] = useState(true);
  const [drawn, setDrawn] = useState<string[]>([]);
  const s = engine.snapshot();
  const eye = s.ground + 1.7;
  const events = useMemo(() => {
    const flat = astroEvents(projection.lat0, year, 0);
    if (!useRelief) return flat.map((row) => ({ ...row, riseH: 0, setH: 0 }));
    return flat.map((row) => {
      const riseH = horizonAltitude(row.rise, s.x, s.z, eye, engine.heightAt);
      const setH = horizonAltitude(row.set, s.x, s.z, eye, engine.heightAt);
      const lifted = astroEvents(projection.lat0, year, riseH).find((item) => item.id === row.id);
      const liftedSet = astroEvents(projection.lat0, year, setH).find((item) => item.id === row.id);
      return { ...row, rise: lifted?.rise ?? row.rise, set: liftedSet?.set ?? row.set, riseH, setH };
    });
  }, [year, useRelief]);
  useEffect(() => {
    const rays = events
      .filter((row) => drawn.includes(row.id))
      .flatMap((row) => {
        const color = row.body === "sole" ? "#ffb54a" : "#b9c8ff";
        return [
          { azimuth: row.rise, altitude: row.riseH, color },
          { azimuth: row.set, altitude: row.setH, color },
        ];
      });
    engine.setRays(rays.length ? { x: s.x, y: eye, z: s.z } : null, rays);
  }, [drawn, events]);
  const axis = building ? planAxis(building.rings[0]!) : null;
  const matches = axis ? alignments(axis.bearing, events).slice(0, 5) : [];
  const goTo = (day: string) => {
    const date = new Date(`${new Date(engine.clock.t).getUTCFullYear()}-${day}T12:00:00Z`);
    const rise = sunEvents(date, projection.lat0, projection.lon0).rise;
    if (!rise) return toast("Quel giorno il sole non sorge qui.");
    engine.clock.setCustom(rise.valueOf() - 1200_000, 60);
    engine.clock.paused = false;
    toast("Venti minuti prima dell'alba, tempo ×60.");
  };
  return (
    <>
      <p className="hint">Dove sorgono e tramontano sole e luna da questo punto, in qualsiasi epoca: l'obliquità dell'eclittica viene ricalcolata per l'anno scelto. L'anno cambia le declinazioni, non il mondo intorno a te.</p>
      <div className="row wrap">
        <label className="field">
          Anno ({yearText(year)})
          <input type="number" min={-6000} max={3000} value={year} onChange={(e) => setYear(Number(e.target.value))} />
        </label>
        <label className="row small">
          <input type="checkbox" checked={useRelief} onChange={(e) => setUseRelief(e.target.checked)} />
          Usa il profilo reale dell'orizzonte
        </label>
        <button className="btn tiny" onClick={() => goTo("06-21")}>
          Alba del solstizio d'estate
        </button>
        <button className="btn tiny" onClick={() => goTo("12-21")}>
          Alba del solstizio d'inverno
        </button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Evento</th>
            <th>Levata</th>
            <th>Tramonto</th>
            <th>Orizzonte</th>
            <th>Sul campo</th>
          </tr>
        </thead>
        <tbody>
          {events.map((row) => (
            <tr key={row.id}>
              <td>{row.label}</td>
              <td>{row.rise.toFixed(1)}°</td>
              <td>{row.set.toFixed(1)}°</td>
              <td>
                +{row.riseH.toFixed(1)}° / +{row.setH.toFixed(1)}°
              </td>
              <td>
                <input type="checkbox" aria-label={`Traccia ${row.label}`} checked={drawn.includes(row.id)} onChange={(e) => setDrawn(e.target.checked ? [...drawn, row.id] : drawn.filter((id) => id !== row.id))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <div className="section-title">Assi e allineamenti</div>
        {!building && <p className="hint">Ispeziona un edificio con E: qui comparirà il suo asse, confrontato con questi eventi.</p>}
        {building && axis && (
          <>
            <p>
              <b>{building.tags.name ?? "Edificio"}</b>: asse lungo a {axis.bearing.toFixed(1)}° {axis.elongation < 0.25 ? "(pianta quasi regolare: l'asse dice poco)" : ""}.
            </p>
            <table className="data">
              <tbody>
                {matches.map((row, index) => (
                  <tr key={index}>
                    <td>
                      {row.kind} {row.event.label}
                    </td>
                    <td>{row.azimuth.toFixed(1)}°</td>
                    <td>scarto {row.delta.toFixed(1)}°</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">Con nove eventi e due capi per asse, uno scarto di qualche grado capita spesso per caso: {(matches[0]?.delta ?? 9) < 1 ? "questa coincidenza è stretta, ma va sostenuta da altre prove" : "qui non basta per parlare di un allineamento voluto"}.</p>
            <button
              className="btn tiny"
              onClick={() => {
                const first = matches[0];
                if (first) addNote("misura", `Asse a ${axis.bearing.toFixed(1)}°`, `${building.tags.name ?? "Edificio"}: più vicino a ${first.kind} ${first.event.label} (${yearText(year)}), scarto ${first.delta.toFixed(1)}°.`, { instrument: "archeoastronomia", values: { asse: `${axis.bearing.toFixed(1)}°`, scarto: `${first.delta.toFixed(1)}°`, anno: yearText(year) } });
              }}
            >
              Annota
            </button>
          </>
        )}
      </div>
    </>
  );
}

function Water({ engine, flood, onFlood, addNote }: LabProps) {
  const { terrain } = engine.data;
  const level = flood ?? terrain.min;
  const stats = useMemo(() => floodStats(terrain.heights, terrain.spacing, level), [level]);
  const rise = level - terrain.min;
  return (
    <>
      <p className="hint">Alza l'acqua e guarda che cosa sparisce: una costa antica, un'alluvione, una diga. È una lastra piatta a una quota: conta anche le conche non collegate e ignora correnti e difese. Si cammina sempre sul fondo.</p>
      <label className="field">
        Livello dell'acqua: {level.toFixed(1)} m ({rise >= 0 ? "+" : ""}
        {rise.toFixed(1)} m dal punto più basso)
        <input type="range" min={terrain.min - 1} max={terrain.max + 30} step={0.1} value={level} onChange={(e) => onFlood(Number(e.target.value))} />
      </label>
      <dl className="kv">
        <dt>Superficie allagata</dt>
        <dd>
          {(stats.area / 10000).toFixed(2)} ha ({(stats.share * 100).toFixed(0)}%)
        </dd>
        <dt>Volume</dt>
        <dd>{(stats.volume / 1e6).toFixed(3)} milioni di m³</dd>
        <dt>Profondità massima</dt>
        <dd>{stats.deepest.toFixed(1)} m</dd>
      </dl>
      <div className="row">
        <button className="btn tiny primary" onClick={() => addNote("misura", `Acqua a ${level.toFixed(1)} m`, `Allagato il ${(stats.share * 100).toFixed(0)}% del terreno.`, { instrument: "inondazione", values: { ettari: (stats.area / 10000).toFixed(2), "profondità massima": `${stats.deepest.toFixed(1)} m` } })}>
          Annota
        </button>
        <button className="btn tiny" onClick={() => onFlood(null)}>
          Togli l'acqua
        </button>
      </div>
    </>
  );
}

const SOURCE_DETAIL: [string, string][] = [
  ["OSM height", "Altezza scritta nella mappa"],
  ["OSM piani", "Piani scritti nella mappa × 3,2 m"],
  ["laser GEDI", "Misurata dal laser GEDI"],
  ["ombre multi-data", "Ombre di più riprese"],
  ["ombra", "Ombra di una ripresa"],
  ["ripresa", "Corpo dedotto da tetto e ombra"],
  ["quartiere", "Mediana degli edifici vicini"],
  ["tipo edilizio", "Altezza tipica per il tipo"],
];

function Origin({ engine, provenance, onProvenance }: LabProps) {
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const b of [...engine.data.buildings, ...engine.plate.masses]) if (!b.hidden) out[b.source] = (out[b.source] ?? 0) + 1;
    return out;
  }, [provenance, engine.plate]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return (
    <>
      <label className="setting">
        <span>
          Colora il mondo per origine
          <span className="note">Il suolo diventa grigio. Luminosità: quanto è sicura la lettura.</span>
        </span>
        <input type="checkbox" checked={provenance} onChange={(e) => onProvenance(e.target.checked)} style={{ justifySelf: "end" }} />
      </label>
      <div className="stack">
        {PROVENANCE_LEGEND.map((row) => (
          <div key={row.id} className="row">
            <i className="swatch-static" style={{ background: row.color }} />
            <b>{row.label}</b>
            <span className="small muted">{row.note}</span>
          </div>
        ))}
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Fonte dell'altezza</th>
            <th>Edifici</th>
            <th>Quota</th>
          </tr>
        </thead>
        <tbody>
          {SOURCE_DETAIL.map(([id, label]) => (
            <tr key={id}>
              <td>{label}</td>
              <td>{counts[id] ?? 0}</td>
              <td>{(((counts[id] ?? 0) / total) * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Facciate e finestre sono sempre generate: nessuna fonte qui le misura. La fonte precisa di ogni edificio è nella sua scheda (E).</p>
    </>
  );
}

function Export({ engine, expedition, projection }: LabProps) {
  const [busy, setBusy] = useState("");
  const id = expedition.spec.id;
  const glb = async () => {
    setBusy("Preparo il modello…");
    try {
      const { exportGlb } = await import("../world/export.ts");
      const blob = await exportGlb(engine, setBusy);
      saveFile(`sestante-${id}.glb`, blob, "model/gltf-binary");
      setBusy(`Modello pronto, ${(blob.size / 1048576).toFixed(0)} MB.`);
    } catch (e) {
      setBusy((e as Error).message);
    }
  };
  return (
    <>
      <div className="stack">
        <button className="btn" onClick={() => void glb()}>
          Modello 3D (GLB)
        </button>
        <p className="hint">Terreno, tetti con la lastra, edifici e alberi semplificati, in metri locali. Si apre in Blender e in altri motori. Le facciate generate qui restano fuori: viaggia solo ciò che è misurato o letto.</p>
        <button className="btn" onClick={() => saveFile(`sestante-${id}.geojson`, geoJson(expedition, (x, z) => projection.toLatLon(x, z)), "application/geo+json")}>
          Tutti i dati in GeoJSON
        </button>
        <p className="hint">Note, picchetti, traccia, segni sulla carta e volumi ipotetici. Si apre direttamente in QGIS.</p>
        <button className="btn" onClick={() => saveFile(`sestante-${id}.dxf`, dxf(expedition, { lat: projection.lat0, lon: projection.lon0 }), "application/dxf")}>
          Rilievo in DXF
        </button>
        <p className="hint">Traccia, segni, picchetti e ipotesi in metri locali, per il CAD. L'origine è scritta nel file.</p>
        <button className="btn" onClick={() => saveFile(`sestante-${id}.csv`, notesCsv(expedition), "text/csv")}>
          Registro in CSV
        </button>
        <p className="hint">Una riga per annotazione, una colonna per ogni grandezza misurata.</p>
      </div>
      {busy && <p className="mono small">{busy}</p>}
    </>
  );
}

function Services({ expedition }: LabProps) {
  const [rows, setRows] = useState<ServiceState[]>([]);
  const [catalog, setCatalog] = useState<NasaEntry[] | null>(null);
  useEffect(() => {
    api.services().then(setRows).catch(() => undefined);
    api.catalog(expedition.spec.bbox).then(setCatalog).catch(() => setCatalog([]));
  }, []);
  return (
    <>
      <div>
        <div className="section-title">Le tue chiavi</div>
        <p className="hint">Stanno nel file .env del progetto e le usa solo il server: il browser non le riceve mai.</p>
        <table className="data">
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.label}</td>
                <td>
                  <b>{row.state === "pronta" ? "✓ pronta" : row.state === "scaduta" ? "! scaduta" : "− assente"}</b>
                </td>
                <td>{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="section-title">Cosa c'è negli archivi NASA su questo riquadro</div>
        {!catalog && <p className="mono small">Interrogo il catalogo CMR…</p>}
        {catalog && (
          <table className="data">
            <thead>
              <tr>
                <th>Prodotto</th>
                <th>Granuli</th>
                <th>Più recente</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {catalog.map((row) => (
                <tr key={row.id}>
                  <td>{row.label}</td>
                  <td>{row.count ?? "—"}</td>
                  <td>{row.newest ?? "—"}</td>
                  <td>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">Il catalogo è aperto a tutti. Con il token valido Sestante usa GEDI (scheda Laser) e NASADEM (scheda Rilievo); gli altri prodotti, per ora, li elenca soltanto.</p>
      </div>
    </>
  );
}
