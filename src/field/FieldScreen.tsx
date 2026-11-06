import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, canvasBlob, imageCanvas, type PlacePhoto } from "../core/api.ts";
import { measureLeg, SURVEY_CLASSES } from "../core/fieldwork.ts";
import { compassName, formatLatLon } from "../core/geo.ts";
import { sunPosition } from "../core/solar.ts";
import { plateLabel, type Expedition, type FieldSpec, type Hypothesis, type MapOverlay, type Note, type NoteKind, type PhotoPlacement, type Pin, type PlateRef, type PlateVersion, type SavedStudy } from "../core/types.ts";
import type { ShadowPlate } from "../vision/shadowTest.ts";
import { Engine, type Snapshot } from "../world/engine.ts";
import { loadSettings, saveSettings, type Settings } from "../world/settings.ts";
import { describeState, describeWmo } from "../world/sim.ts";
import { detectChanges, type ChangeCluster } from "../vision/filters.ts";
import { CompassDial, CompassTape, GaugeDial, Reticle, WatchDial } from "./Dials.tsx";
import { finishTraverse, HOTBAR, localPressure, magneticInfo, swElapsed, surveyStats, TOOLS, toolById, type Ctx, type InstrumentState, type ToolId } from "./instruments.ts";
import { LabPanel, type LabTab } from "./LabPanel.tsx";
import { LayersPanel, type Drape } from "./LayersPanel.tsx";
import { applyLidar } from "./lidarTools.ts";
import { TimeTravel } from "./TimeTravel.tsx";
import { absentIds, applyLaser, applyStrata, assessWorld, correctTrees, heightErrorsFrom, loadSpectrum, measureMass, plateDate, volumeOfBuilding } from "./research.ts";
import { crownVolume, formatRange, formatVolume } from "../vision/volume.ts";
import type { LaserAssessment } from "../vision/laser.ts";
import { SourcesPanel } from "./SourcesPanel.tsx";
import { PROVENANCE_LEGEND } from "../world/shading.ts";
import { JournalPanel } from "./Journal.tsx";
import { interpretPlate, loadField, readPlate, type Building, type FieldData } from "./load.ts";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { SheetPanel } from "./SheetPanel.tsx";

type Panel = "borsa" | "registro" | "carta" | "impostazioni" | "cronologia" | "strati" | "fonti" | "laboratorio" | null;

type Props = {
  expedition: Expedition;
  canvas?: HTMLCanvasElement;
  findings: { title: string; text: string }[];
  study?: string;
  onExit: (spec: FieldSpec) => void;
};

const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());

const nid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  );
}

export function FieldScreen({ expedition: initial, canvas, findings, study, onExit }: Props) {
  const glRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [steps, setSteps] = useState<string[]>(["Preparo lo zaino"]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [panel, setPanelState] = useState<Panel>(null);
  const [tool, setToolState] = useState<ToolId>("mano");
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [expedition, setExpedition] = useState<Expedition>(initial);
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);
  const [info, setInfo] = useState<{ title: string; rows: [string, string][]; tags?: Record<string, string>; link?: string; note: string } | null>(null);
  const [showTags, setShowTags] = useState(false);
  const [shutter, setShutter] = useState(0);
  const [versions, setVersions] = useState<PlateVersion[]>([]);
  const [plateBusy, setPlateBusy] = useState("");
  const [changes, setChanges] = useState<ChangeCluster[]>([]);
  const [baseline, setBaseline] = useState<{ canvas: HTMLCanvasElement; label: string } | null>(null);
  const [shotInfo, setShotInfo] = useState<string | null>(null);
  const [showReadout, setShowReadout] = useState(true);
  const [drape, setDrape] = useState<Drape | null>(null);
  const [travel, setTravel] = useState(false);
  const travelRef = useRef(false);
  travelRef.current = travel;
  const drapeRef = useRef<Drape | null>(null);
  drapeRef.current = drape;
  const [labTab, setLabTab] = useState<LabTab>("riprese");
  const [shadowPlates, setShadowPlates] = useState<ShadowPlate[]>([]);
  const [inspected, setInspected] = useState<Building | null>(null);
  const [flood, setFlood] = useState<number | null>(null);
  const [provenance, setProvenance] = useState(false);
  const [ghost, setGhost] = useState<{ photo: PlacePhoto; opacity: number } | null>(null);
  const [sectionPoints, setSectionPoints] = useState<{ x: number; z: number }[]>([]);
  const [longShot, setLongShot] = useState("");
  const [laser, setLaser] = useState<LaserAssessment | null>(null);
  const [laserShown, setLaserShown] = useState(false);
  const [astroYear, setAstroYear] = useState(new Date().getUTCFullYear());
  const stateRef = useRef<InstrumentState>({
    qnhRef: 1013,
    stopwatch: { running: false, start: 0, elapsed: 0, laps: [] },
    survey: [],
    gnomon: null,
    magnetic: false,
    pedometerZero: { steps: 0, distance: 0 },
    focal: 35,
    filter: 0,
    traverse: { cls: 0, start: null, last: null, legs: [] },
    hypothesisDraft: [],
    section: [],
    owm: null,
    fires: null,
    spectrum: null,
    remoteError: "",
    astroYear: new Date().getUTCFullYear(),
    laser: null,
    volumeDraft: [],
    volumeErrors: null,
  });
  stateRef.current.astroYear = astroYear;
  const rereadRef = useRef<Parameters<typeof interpretPlate>[2] | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const infoRef = useRef(info);
  infoRef.current = info;
  const expRef = useRef(expedition);
  expRef.current = expedition;
  const plateCacheRef = useRef(new Map<string, HTMLCanvasElement>());

  const toast = useCallback((text: string) => {
    const id = nid();
    setToasts((rows) => [...rows.slice(-3), { id, text }]);
    window.setTimeout(() => setToasts((rows) => rows.filter((row) => row.id !== id)), 5200);
  }, []);

  // Autosave, debounced: everything in the expedition lands on disk.
  const saveTimer = useRef(0);
  const updateExpedition = useCallback((change: (e: Expedition) => Expedition, now = false) => {
    setExpedition((current) => {
      const next = change(current);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void api.saveExpedition(next), now ? 0 : 800);
      return next;
    });
  }, []);

  const addNote = useCallback(
    (kind: NoteKind, title: string, text: string, extra: Partial<Note> = {}, silent = false) => {
      const engine = engineRef.current;
      if (!engine) return;
      const s = engine.snapshot();
      const w = engine.weather.now;
      const note: Note = {
        id: nid(),
        created: new Date().toISOString(),
        simTime: engine.clock.civil({ dateStyle: "medium", timeStyle: "medium" } as Intl.DateTimeFormatOptions),
        kind,
        title,
        text,
        lat: s.lat,
        lon: s.lon,
        elev: s.y,
        heading: s.heading,
        plate: plateLabel(engine.plate.ref),
        weather: `${describeState(w)}, ${w.temp.toFixed(0)}°C, vento ${w.wind.toFixed(0)} m/s`,
        ...extra,
      };
      updateExpedition((e) => ({ ...e, notes: [note, ...e.notes] }));
      if (!silent) toast(`Nel registro: ${title}`);
    },
    [toast, updateExpedition],
  );

  // Build everything once.
  useEffect(() => {
    let live = true;
    let engine: Engine | null = null;
    (async () => {
      const spec = initial.spec;
      if (spec.plate.kind === "upload" && canvas && !spec.plate.url) {
        const blob = await canvasBlob(canvas, "image/jpeg", 0.95);
        spec.plate.url = await api.uploadMedia(spec.id, blob, "jpg");
      }
      const { data, rereadCtx } = await loadField(spec, (text) => live && setSteps((rows) => (rows[rows.length - 1] === text || /^Sviluppo la lastra: /.test(rows[rows.length - 1] ?? "") ? [...rows.slice(0, /^Sviluppo la lastra: /.test(rows[rows.length - 1] ?? "") ? -1 : rows.length), text] : [...rows, text]).slice(-9)), canvas, loadSettings().demSource);
      if (!live) return;
      setSteps((rows) => [...rows, "Costruisco il mondo"].slice(-9));
      await new Promise((resolve) => setTimeout(resolve, 30));
      rereadRef.current = rereadCtx;
      engine = new Engine(glRef.current!, data, loadSettings());
      engineRef.current = engine;
      stateRef.current.qnhRef = engine.weather.now.pressureMsl;
      (window as unknown as { sestante: unknown }).sestante = { engine, addNote };
      engine.setPins(initial.pins);
      engine.setFigures(initial.figures ?? []);
      // The chosen point becomes a stake in the world, and the first thing you face when it is not under your feet.
      const focus = spec.focus;
      if (focus) {
        const at = data.projection.toLocal(focus.lat, focus.lon);
        const dx = at.x - engine.pos.x;
        const dz = at.z - engine.pos.z;
        if (Math.hypot(dx, dz) > 1) engine.yaw = Math.atan2(-dx, -dz);
        if (!initial.pins.some((pin) => pin.id === "punto")) {
          const pin: Pin = { id: "punto", x: at.x, y: engine.heightAt(at.x, at.z), z: at.z, label: "Punto scelto", color: "#ffb54a", created: new Date().toISOString() };
          engine.setPins([...initial.pins, pin]);
          updateExpedition((e) => ({ ...e, pins: [...e.pins, pin] }));
        }
      }
      engine.setHypotheses(initial.hypotheses ?? []);
      if (initial.treeModel) {
        correctTrees(engine.plate.trees, initial.treeModel);
        engine.refreshTrees();
      }
      // Resuming a trip: what the shots already told is still true, without developing them again.
      if (initial.strata) {
        applyStrata(engine, initial.strata);
        engine.refreshBuildings(absentIds(initial.strata, plateDate(engine.plate.ref)));
      }
      engine.steps = initial.counters.steps;
      engine.distance = initial.counters.distance;
      engine.hooks.onEdge = (() => {
        let last = 0;
        return () => {
          if (Date.now() - last > 6000) {
            last = Date.now();
            toast("Qui finisce la ripresa: oltre c'è solo il mosaico a bassa risoluzione. Vola col drone per guardarlo.");
          }
        };
      })();
      engine.hooks.onStage = () => {
        const s = engine!.snapshot();
        addNote("tappa", `Tappa a ${s.distance.toFixed(0)} m`, `${compassName(s.heading)}, ${s.slope.toFixed(0)}° di pendenza.`, { instrument: "contapassi", values: { passi: String(s.steps), quota: `${s.y.toFixed(1)} m`, pressione: `${localPressure({ engine: engine!, snap: s, state: stateRef.current }).toFixed(1)} hPa` } }, true);
      };
      engine.onTrack = (x, z) => updateExpedition((e) => ({ ...e, track: [...e.track, Math.round(x * 10) / 10, Math.round(z * 10) / 10].slice(-6000) }));
      engine.start();

      const r = data.plate.analysis;
      const deg = (v: number) => ((v * 180) / Math.PI).toFixed(1);
      const heightCounts = data.buildings.reduce<Record<string, number>>((acc, b) => {
        if (!b.hidden) acc[b.source] = (acc[b.source] ?? 0) + 1;
        return acc;
      }, {});
      if (!initial.notes.length) {
        const sunLine = r.sun.method === "ombre+data" ? `Sole letto dalle ombre: azimut ${deg(r.sun.sunAzimuth)}°, altezza ${deg(r.sun.altitude)}° (attendibilità ${(r.sun.confidence * 100).toFixed(0)}%).` : `Sole ricavato da ${r.sun.method}: azimut ${deg(r.sun.sunAzimuth)}°, altezza ${deg(r.sun.altitude)}°.`;
        const cross = r.sun.crossCheckAltitude != null ? ` Controllo su ${r.sun.crossCheckSamples} edifici di altezza nota: ${deg(r.sun.crossCheckAltitude)}°.` : "";
        addNote(
          "sistema",
          "Lettura della lastra",
          `${sunLine}${cross}\n${data.log.join(" ")}`,
          {
            values: {
              edifici: String(data.buildings.filter((b) => !b.hidden).length),
              "dalle ombre": String(heightCounts["ombra"] ?? 0),
              "corpi dedotti": String(data.plate.masses.length),
              alberi: String(data.plate.trees.length),
              chiome: `${(r.stats.canopy / 10000).toFixed(2)} ha`,
              prato: `${(r.stats.lawn / 10000).toFixed(2)} ha`,
            },
          },
          true,
        );
      }
      const fromStudio = [...findings, ...(initial.studioFindings ?? []).filter((row) => !findings.some((item) => item.title === row.title))];
      for (const finding of fromStudio) addNote("confronto", finding.title, finding.text, {}, true);
      if (initial.studioFindings?.length) updateExpedition((e) => ({ ...e, studioFindings: undefined }));
      api.versions(data.projection.lat0, data.projection.lon0, Math.min(17, spec.zoom)).then((rows) => live && setVersions(rows)).catch(() => undefined);
      setReady(true);
    })().catch((e: Error) => {
      console.error(e);
      if (live) setError(e.message);
    });
    return () => {
      live = false;
      window.clearTimeout(saveTimer.current);
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Live weather refresh; HUD snapshot.
  useEffect(() => {
    if (!ready) return;
    const engine = engineRef.current!;
    const timer = window.setInterval(() => {
      api.weather<FieldData["weather"]>(engine.data.projection.lat0, engine.data.projection.lon0).then((row) => row && engine.weather.setStation(row)).catch(() => undefined);
    }, 600_000);
    const hud = window.setInterval(() => {
      const current = engine.snapshot();
      setSnap(current);
      // A card belongs to what you were looking at: walking away dismisses it.
      if (infoAt.current && Math.hypot(current.x - infoAt.current.x, current.z - infoAt.current.z) > 6) {
        infoAt.current = null;
        setInfo(null);
      }
      updateCounters();
    }, 160);
    let lastCountSave = 0;
    const updateCounters = () => {
      if (Date.now() - lastCountSave > 5000) {
        lastCountSave = Date.now();
        const s = engine.snapshot();
        const c = expRef.current.counters;
        if (c.steps !== s.steps) updateExpedition((e) => ({ ...e, counters: { steps: s.steps, distance: s.distance } }));
      }
    };
    return () => {
      window.clearInterval(timer);
      window.clearInterval(hud);
    };
  }, [ready, updateExpedition]);

  const applySettings = useCallback((next: Settings) => {
    setSettingsState(next);
    saveSettings(next);
    engineRef.current?.applySettings(next);
  }, []);

  const openPanel = useCallback((next: Panel) => {
    const engine = engineRef.current;
    const wasOpen = panelRef.current;
    setPanelState(next);
    if (next) {
      engine?.unlock();
      engine?.stopWalking();
    } else if (wasOpen) engine?.lock(); // Closing a panel means going back to walking, without one more click.
  }, []);

  const infoAt = useRef<{ x: number; z: number } | null>(null);
  const closeMassRef = useRef<() => Promise<unknown> | void>(() => undefined);
  const saveStudyRef = useRef<(name?: string) => Promise<unknown> | void>(() => undefined);

  const putAway = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    setInfo(null);
    infoAt.current = null;
    if (toolRef.current === "drone" && engine.drone) engine.setDrone(false);
    if (toolRef.current === "mano") return;
    setToolState("mano");
    engine.zoomTarget = 1;
    engine.renderMode = 0;
  }, []);

  const applyZoomFor = useCallback((id: ToolId, engine: Engine) => {
    if (id === "binocolo") engine.zoomTarget = 8;
    else if (id === "monocolo") engine.zoomTarget = 20;
    else if (id === "fotocamera") engine.zoomTarget = Math.tan((settings.fov * Math.PI) / 360) / (18 / stateRef.current.focal);
    else engine.zoomTarget = 1;
    engine.renderMode = id === "fotocamera" ? stateRef.current.filter : 0;
  }, [settings.fov]);

  const setTool = useCallback(
    (id: ToolId) => {
      const engine = engineRef.current;
      if (!engine) return;
      if (id === "carta") return openPanel("carta");
      if (id === "cronologia") return openPanel("cronologia");
      if (id === "strati" || id === "fonti" || id === "laboratorio") return openPanel(id);
      // The same key again puts it back in the bag. A drone in flight stays up until it is recalled.
      if (toolRef.current === id && id !== "mano") return putAway();
      setToolState(id);
      applyZoomFor(id, engine);
      setShowReadout(true);
    },
    [openPanel, applyZoomFor, putAway],
  );

  const ctxFor = useCallback((): Ctx | null => {
    const engine = engineRef.current;
    if (!engine) return null;
    return { engine, snap: engine.snapshot(), state: stateRef.current };
  }, []);

  const inspect = useCallback(() => {
    const engine = engineRef.current!;
    const s = engine.snapshot();
    const hit = engine.castLook();
    infoAt.current = { x: s.x, z: s.z };
    if (hit.kind === "cielo") {
      setInfo({ title: "Cielo", rows: [["Sole", `${((s.sunAlt * 180) / Math.PI).toFixed(1)}° · az ${((s.sunAz * 180) / Math.PI).toFixed(0)}°`], ["Luna", `${((s.moonAlt * 180) / Math.PI).toFixed(1)}° · fase ${(s.moonIllum * 100).toFixed(0)}%`], ["Copertura", `${(engine.weather.now.cloud * 100).toFixed(0)} %`]], note: "Niente in linea di tiro." });
      return;
    }
    if (hit.building) {
      const b = hit.building;
      setInspected(b);
      const tags = b.tags;
      const describe: Record<Building["source"], string> = {
        "OSM height": "altezza mappata",
        "OSM piani": "dai piani mappati",
        "laser GEDI": "misurata dal laser spaziale GEDI",
        "ombre multi-data": `dalle ombre di ${b.shots ?? "più"} riprese${b.range ? `, ${b.range[0].toFixed(1)}–${b.range[1].toFixed(1)} m` : ""}`,
        ombra: `letta dall'ombra sulla lastra, attendibilità ${(b.confidence * 100).toFixed(0)}%`,
        quartiere: "mediana degli edifici vicini",
        "tipo edilizio": "tipica per questo tipo",
        ripresa: "corpo dedotto da tetto e ombra",
        LiDAR: "misurata dal rilievo laser nazionale",
      };
      const rows: [string, string][] = [
        ["Tipo", tags["building"] && tags["building"] !== "yes" ? tags.building : tags["building:part"] ? "parte di edificio" : "edificio"],
        ["Altezza", `${b.height.toFixed(1)} m, ${(b.height / engine.settings.altEgoHeight).toFixed(1)} volte te`],
        ["Fonte altezza", describe[b.source]],
        ["Piani", b.levels ? String(b.levels) : "—"],
        ["Copertura", b.roofShape],
        ["Sedime", `${b.area.toFixed(0)} m²`],
      ];
      if (b.shadowHeight != null && b.source !== "ombra") rows.push(["Dall'ombra", `${b.shadowHeight.toFixed(1)} m`]);
      const strata = expRef.current.strata;
      const series = strata?.heights[b.id];
      if (series) rows.push(["Da più riprese", `${series.h.toFixed(1)} m (${series.low.toFixed(1)}–${series.high.toFixed(1)}), ${series.n} misure`]);
      const presence = strata?.presence[b.id];
      if (presence?.lastAbsent) rows.push(["Comparso", `fra ${presence.lastAbsent} e ${presence.firstSeen ?? "oggi"}`]);
      else if (presence?.firstSeen) rows.push(["Visibile dal", presence.firstSeen]);
      const volume = volumeOfBuilding(b, engine.data.buildings, stateRef.current.volumeErrors ?? heightErrorsFrom(stateRef.current.laser));
      const main = volume.complex ?? volume.own;
      rows.push([volume.complex ? `Volume di ${volume.complex.name}` : "Volume", `${formatVolume(main.value)} (${formatRange(main)})`]);
      if (tags.start_date) rows.push(["Data", tags.start_date]);
      if (tags["building:material"]) rows.push(["Materiale", tags["building:material"]]);
      if (tags.historic) rows.push(["Storico", tags.historic]);
      const wiki = tags.wikipedia ? `https://${tags.wikipedia.split(":")[0]}.wikipedia.org/wiki/${encodeURIComponent(tags.wikipedia.split(":").slice(1).join(":"))}` : tags.website;
      setInfo({ title: tags.name ?? tags["name:it"] ?? (b.source === "ripresa" ? "Corpo dedotto" : "Edificio"), rows, tags, link: wiki, note: `Edificio ${tags.name ?? b.id}: ${b.height.toFixed(1)} m (${describe[b.source]}).` });
      return;
    }
    if (hit.tree) {
      const t = hit.tree;
      setInfo({
        title: t.species ?? ["Latifoglia", "Conifera", "Arbusto"][t.kind] ?? "Albero",
        rows: [
          ["Altezza stimata", `${t.h.toFixed(1)} m`],
          ["Raggio chioma", `${t.r.toFixed(1)} m`],
          ["Volume chioma", `circa ${formatVolume(crownVolume(t.r, t.h).value)}, solo ordine di grandezza`],
          ["Fonte", t.origin === "mappa" ? "altezza scritta sulla mappa" : t.rawH != null ? "quota locale delle chiome, dal laser GEDI" : t.origin === "ombra" ? "ombra sulla lastra, poco attendibile" : t.source === "osm" ? "albero mappato, altezza dalla chioma" : "dimensione della chioma, poco attendibile"],
          ...(t.rawH != null ? ([["Letta dalla lastra", `${t.rawH.toFixed(1)} m`]] as [string, string][]) : []),
        ],
        note: `Albero: ${t.h.toFixed(1)} m, chioma ${(t.r * 2).toFixed(1)} m.`,
      });
      return;
    }
    if (hit.prop) {
      const tags = hit.prop.feature.tags;
      setInfo({ title: tags.name ?? hit.prop.kind, rows: Object.entries(tags).slice(0, 8), tags, note: `${tags.name ?? hit.prop.kind} osservato.` });
      return;
    }
    const { lat, lon } = engine.data.projection.toLatLon(hit.x, hit.z);
    const near = engine.data.places.map((place) => ({ place, d: Math.hypot(place.x - hit.x, place.z - hit.z) })).sort((a, b) => a.d - b.d)[0];
    setInfo({
      title: "Terreno",
      rows: [
        ["Posizione", formatLatLon(lat, lon)],
        ["Quota", `${hit.y.toFixed(1)} m`],
        ["Luogo più vicino", near ? `${near.place.tags.name} (${near.d.toFixed(0)} m)` : "—"],
      ],
      note: `Terreno a quota ${hit.y.toFixed(1)} m.`,
    });
  }, []);

  const photograph = useCallback(
    async (aerial = false) => {
      const engine = engineRef.current!;
      const s = engine.snapshot();
      const shot = engine.photograph();
      setShutter((n) => n + 1);
      engine.audio.shutter();
      const blob = await canvasBlob(shot, "image/jpeg", 0.9);
      const url = await api.uploadMedia(engine.data.spec.id, blob, "jpg");
      const look = s.look && s.look.kind !== "cielo" ? `${s.look.kind} a ${s.look.dist.toFixed(0)} m` : "orizzonte";
      addNote("foto", `${aerial ? "Veduta aerea" : "Fotografia"} verso ${compassName(s.heading)}`, `Inquadra ${look}.`, {
        instrument: aerial ? "drone" : "fotocamera",
        photo: url,
        values: { focale: `${stateRef.current.focal.toFixed(0)} mm`, azimut: `${s.heading.toFixed(0)}°`, ...(aerial ? { quota: `${(s.y - s.ground).toFixed(0)} m` } : {}) },
      });
    },
    [addNote],
  );

  const action = useCallback(() => {
    const ctx = ctxFor();
    if (!ctx) return;
    const { engine, snap: s, state } = ctx;
    const id = toolRef.current;
    const def = toolById(id);
    switch (id) {
      case "mano":
        return inspect();
      case "fotocamera":
        return void photograph();
      case "drone":
        if (!s.drone) {
          engine.setDrone(true);
          toast("Drone in volo. WASD, Spazio sale, C scende, N vista nadirale, F scatta.");
        } else void photograph(true);
        return;
      case "torcia":
        engine.torchOn = !engine.torchOn;
        return;
      case "picchetti": {
        if (!s.look || s.look.kind === "cielo") return toast("Mira un punto a terra.");
        const label = `P${expRef.current.pins.length + 1}`;
        const pin: Pin = { id: nid(), x: s.look.x, y: s.look.y, z: s.look.z, label, color: "#d9442a", created: new Date().toISOString() };
        updateExpedition((e) => {
          const pins = [...e.pins, pin];
          engine.setPins(pins);
          return { ...e, pins };
        });
        const { lat, lon } = engine.data.projection.toLatLon(pin.x, pin.z);
        addNote("strumento", `Picchetto ${label}`, formatLatLon(lat, lon), { instrument: "picchetti", values: { quota: `${pin.y.toFixed(1)} m` } });
        return;
      }
      case "rotella": {
        if (!s.look || s.look.kind === "cielo") return toast("Mira un punto.");
        state.survey = [...state.survey, { x: s.look.x, y: s.look.y, z: s.look.z }];
        engine.setSurvey(state.survey);
        engine.audio.beep();
        return;
      }
      case "stazione": {
        if (!s.look || s.look.kind === "cielo") return toast("Mira un punto.");
        const target = { x: s.look.x, y: s.look.y, z: s.look.z };
        const t = state.traverse;
        if (!t.start) {
          t.start = target;
          t.last = target;
          state.survey = [target];
          engine.setSurvey(state.survey);
          toast("Partenza fissata: ora mira il prossimo vertice e premi F.");
          return;
        }
        t.legs.push(measureLeg(t.last!, target, SURVEY_CLASSES[t.cls]!, gauss));
        t.last = target;
        state.survey = [...state.survey, target];
        engine.setSurvey(state.survey);
        engine.audio.beep();
        return;
      }
      case "ipotesi": {
        if (!s.look || s.look.kind === "cielo") return toast("Mira il suolo.");
        state.hypothesisDraft = [...state.hypothesisDraft, { x: s.look.x, z: s.look.z }];
        engine.setHypotheses(expRef.current.hypotheses ?? [], state.hypothesisDraft);
        engine.audio.beep();
        return;
      }
      case "sezione": {
        if (!s.look || s.look.kind === "cielo") return toast("Mira un punto.");
        state.section = [...state.section, { x: s.look.x, z: s.look.z }];
        setSectionPoints(state.section);
        state.survey = state.section.map((p) => ({ x: p.x, z: p.z, y: engine.heightAt(p.x, p.z) }));
        engine.setSurvey(state.survey);
        engine.audio.beep();
        return;
      }
      case "altego": {
        if (!s.look || s.look.kind === "cielo") return toast("Mira il suolo.");
        const figure = { id: nid(), x: s.look.x, z: s.look.z, yaw: engine.yaw + Math.PI };
        const figures = [...(expRef.current.figures ?? []), figure];
        updateExpedition((e) => ({ ...e, figures }));
        engine.setFigures(figures);
        engine.audio.beep();
        return;
      }
      case "volumetro": {
        const look = s.look;
        if (!state.volumeDraft.length && (look?.building || look?.tree)) {
          const note = def.note?.(ctx);
          if (note) addNote("misura", note.title, note.text, { instrument: "volumetro", values: note.values });
          engine.audio.beep();
          return;
        }
        if (!look || look.kind === "cielo") return toast("Mira il suolo.");
        const draft = state.volumeDraft;
        // Coming back to the first point closes the outline: no buttons, no stopping.
        if (draft.length >= 3 && Math.hypot(look.x - draft[0]!.x, look.z - draft[0]!.z) < Math.max(5, look.dist * 0.04)) return void closeMassRef.current();
        state.volumeDraft = [...draft, { x: look.x, z: look.z }];
        engine.setHypotheses(expRef.current.hypotheses ?? [], state.volumeDraft);
        engine.audio.beep();
        return;
      }
      case "gnomone": {
        if (!state.gnomon) {
          const x = s.x - Math.sin((-s.heading * Math.PI) / 180) * 0.9;
          const z = s.z - Math.cos((-s.heading * Math.PI) / 180) * 0.9;
          const placed = engine.plantGnomon(x, z, 1);
          state.gnomon = { ...placed, h: 1 };
          return toast("Gnomone piantato. Di nuovo F per leggere l'ombra.");
        }
        if (s.sunAlt <= 0.01 || engine.weather.now.cloud > 0.85) return toast("Nessuna ombra leggibile adesso.");
        const length = state.gnomon.h / Math.tan(s.sunAlt);
        const az = ((s.sunAz * 180) / Math.PI + 180) % 360;
        addNote("misura", `Ombra di ${length.toFixed(2)} m`, `Asta da ${state.gnomon.h.toFixed(2)} m: altezza del sole ${((s.sunAlt * 180) / Math.PI).toFixed(1)}°.`, { instrument: "gnomone", values: { ombra: `${length.toFixed(2)} m`, "direzione ombra": `${az.toFixed(0)}° ${compassName(az)}` } });
        return;
      }
      case "scala": {
        if (s.onRoof) {
          engine.descendToGround();
          return;
        }
        const hit = engine.castLook();
        if (hit.building && hit.dist < 5) {
          engine.climb(hit.building);
          addNote("strumento", `Salito su ${hit.building.tags.name ?? "un edificio"}`, `Tetto a ${hit.building.height.toFixed(1)} m dal suolo.`, { instrument: "scala" }, true);
        } else toast("Avvicinati a meno di 5 m da un muro e guardalo.");
        return;
      }
      case "campionatore": {
        const hit = engine.castLook();
        if (hit.kind === "cielo") return toast("Mira il suolo o un tetto.");
        const plate = engine.plate;
        const u = (hit.x + engine.data.projection.halfX) / (2 * engine.data.projection.halfX);
        const v = (hit.z + engine.data.projection.halfZ) / (2 * engine.data.projection.halfZ);
        if (u < 0 || v < 0 || u > 1 || v > 1) return toast("Fuori dalla lastra.");
        const c = plate.canvas.getContext("2d")!.getImageData(Math.floor(u * plate.canvas.width), Math.floor(v * plate.canvas.height), 1, 1).data;
        const a = plate.analysis;
        const k = (Math.floor(v * a.height) * a.width + Math.floor(u * a.width)) * 4;
        const cls = a.classMap[k]! > 128 ? "chioma" : a.classMap[k + 1]! > 128 ? "prato" : a.classMap[k + 2]! > 128 ? "acqua" : a.classMap[k + 3]! > 200 ? "strada" : a.classMap[k + 3]! > 80 ? "superficie grigia" : "suolo o tetto";
        const exg = (2 * c[1]! - c[0]! - c[2]!) / (c[0]! + c[1]! + c[2]! + 1);
        const hex = `#${[c[0], c[1], c[2]].map((n) => n!.toString(16).padStart(2, "0")).join("")}`;
        addNote("misura", `Campione ${hex}`, `Classe assegnata: ${cls}.`, { instrument: "spettrocolorimetro", values: { R: String(c[0]), G: String(c[1]), B: String(c[2]), ExG: exg.toFixed(3), ombra: a.gainMap[k + 3]! > 128 ? "sì" : "no" } });
        return;
      }
      default: {
        const note = def.note?.(ctx);
        if (note) {
          addNote(id === "telemetro" || id === "clinometro" || id === "sestante" || id === "geologo" ? "misura" : "strumento", note.title, note.text, { instrument: def.name, values: note.values });
          engine.audio.beep();
        } else if (id === "sestante") toast("Nessun astro nel mirino.");
        else if (id === "telemetro") toast("Nessun ritorno dal laser.");
      }
    }
  }, [addNote, ctxFor, inspect, photograph, toast, updateExpedition]);

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (travelRef.current) {
        if (e.code === "Escape") setTravel(false);
        return;
      }
      const engine = engineRef.current;
      if (!engine) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        // Esc still leaves a panel from inside a text field.
        if (e.code === "Escape" && panelRef.current) {
          (e.target as HTMLElement).blur();
          openPanel(null);
        }
        return;
      }
      const toggle = (next: Panel) => openPanel(panelRef.current === next ? null : next);
      if (e.code === "KeyB") toggle("borsa");
      else if (e.code === "KeyJ") toggle("registro");
      else if (e.code === "KeyM") toggle("carta");
      else if (e.code === "KeyO") toggle("impostazioni");
      else if (e.code === "KeyT") toggle("cronologia");
      else if (e.code === "KeyG") toggle("strati");
      else if (e.code === "KeyP") toggle("fonti");
      else if (e.code === "KeyR") toggle("laboratorio");
      else if (panelRef.current) {
        if (e.code === "Escape" || e.code === "KeyQ") openPanel(null);
      } else if (e.code === "Tab") {
        e.preventDefault();
        engine.setFreeCursor(!engine.freeCursor);
      } else if (e.code === "Escape") engine.freeCursor = false;
      else if (e.code === "KeyQ") putAway();
      else if (e.code === "KeyF" || e.code === "Enter") action();
      else if (e.code === "KeyE") {
        if (infoRef.current) {
          setInfo(null);
          infoAt.current = null;
        } else inspect();
      } else if (e.code === "KeyV" && infoRef.current) {
        const card = infoRef.current;
        addNote("strumento", card.title, card.note, { instrument: "ispezione", values: Object.fromEntries(card.rows) });
        setInfo(null);
        infoAt.current = null;
      }
      else if (e.code === "KeyL") engine.torchOn = !engine.torchOn;
      else if (e.code === "KeyH") setShowReadout((v) => !v);
      else if (e.code === "KeyN") engine.droneNadir = !engine.droneNadir;
      else if (e.code === "KeyK") void saveStudyRef.current();
      else if (e.code === "KeyX") {
        setSettingsState((current) => {
          const next = { ...current, thirdPerson: !current.thirdPerson };
          saveSettings(next);
          engineRef.current?.applySettings(next);
          return next;
        });
      }
      else if (/^Digit[1-9]$/.test(e.code)) setTool(HOTBAR[Number(e.code[5]) - 1]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [action, addNote, inspect, openPanel, putAway, setTool]);

  // With the pointer captured the mouse is the tool: left uses it, right puts it away.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!engineRef.current?.isLocked) return;
      if (e.button === 0) action();
      else if (e.button === 2) putAway();
    };
    const onMenu = (e: MouseEvent) => {
      if (engineRef.current?.isLocked || (e.target as HTMLElement).tagName === "CANVAS") e.preventDefault();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("contextmenu", onMenu);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("contextmenu", onMenu);
    };
  }, [action, putAway]);

  // Wheel works the magnifying optics; with anything else in hand it runs through the hotbar.
  const lastWheel = useRef(0);
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const engine = engineRef.current;
      if (!engine || panelRef.current) return;
      const id = toolRef.current;
      const factor = Math.exp(-e.deltaY * 0.0012);
      if (id === "binocolo") engine.zoomTarget = Math.max(8, Math.min(12, engine.zoomTarget * factor));
      else if (id === "monocolo") engine.zoomTarget = Math.max(20, Math.min(40, engine.zoomTarget * factor));
      else if (id === "fotocamera") {
        stateRef.current.focal = Math.max(18, Math.min(400, stateRef.current.focal * factor));
        engine.zoomTarget = Math.max(0.5, Math.tan((engine.settings.fov * Math.PI) / 360) / (18 / stateRef.current.focal));
      } else if (engine.isLocked && performance.now() - lastWheel.current > 130) {
        lastWheel.current = performance.now();
        const row: ToolId[] = HOTBAR.filter((item) => item !== "carta" && item !== "cronologia");
        const index = row.indexOf(id);
        const next = row[(index + (e.deltaY > 0 ? 1 : row.length - 1) + (index < 0 ? 1 : 0)) % row.length]!;
        setToolRef.current(next);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  const setToolRef = useRef(setTool);
  setToolRef.current = setTool;

  const goToPlate = useCallback(
    async (row: PlateVersion) => {
      const engine = engineRef.current!;
      const ctx = rereadRef.current;
      if (!ctx) return;
      setPlateBusy("Sviluppo…");
      const before = engine.plate;
      const ref: PlateRef = { kind: "wayback", release: row.release, published: row.published, capture: row.capture };
      const deep = await api.capture(row.release, engine.data.projection.lat0, engine.data.projection.lon0, engine.data.spec.zoom).catch(() => null);
      if (deep) ref.capture = deep;
      const key = `wb-${row.release}`;
      let canvasNew = plateCacheRef.current.get(key);
      if (!canvasNew) {
        canvasNew = await readPlate(ref, engine.data.spec, (text) => setPlateBusy(text));
        plateCacheRef.current.set(key, canvasNew);
      }
      setPlateBusy("Rileggo ombre, chiome e tetti…");
      const state = await interpretPlate(ref, canvasNew, ctx);
      correctTrees(state.trees, expRef.current.treeModel ?? null);
      engine.setPlate(state);
      engine.refreshBuildings(absentIds(expRef.current.strata, plateDate(ref)));
      setPlateBusy("Confronto con la lastra precedente…");
      const mpp = (engine.data.projection.halfX * 2) / canvasNew.width;
      const diff = detectChanges(before.canvas, canvasNew, mpp);
      setChanges(diff.clusters);
      setBaseline({ canvas: before.canvas, label: plateLabel(before.ref) });
      setPlateBusy("");
      addNote(
        "confronto",
        `Lastra: ${plateLabel(ref)}`,
        `Da ${plateLabel(before.ref)} a ${plateLabel(ref)}: ${state.trees.length} chiome contro ${before.trees.length}, ${diff.clusters.length} zone cambiate.`,
        {
          values: {
            sensore: ref.capture?.sensor ?? "—",
            risoluzione: ref.capture?.resolution ? `${ref.capture.resolution} m/px` : "—",
            chioma: `${(state.analysis.stats.canopy / 10000).toFixed(2)} ha (era ${(before.analysis.stats.canopy / 10000).toFixed(2)})`,
            prato: `${(state.analysis.stats.lawn / 10000).toFixed(2)} ha (era ${(before.analysis.stats.lawn / 10000).toFixed(2)})`,
          },
        },
      );
    },
    [addNote],
  );

  const toShotDay = useCallback(async () => {
    const engine = engineRef.current!;
    const reading = engine.plate.analysis.sun;
    const ref = engine.plate.ref;
    const capture = ref.kind === "tiles" ? null : ref.capture;
    if (!reading.instant || !capture?.date) {
      setShotInfo("Questa lastra non ha una data di scatto: non si può tornare a quel momento.");
      return;
    }
    engine.clock.setCustom(Date.parse(reading.instant), 1);
    engine.clock.paused = true;
    const { lat0, lon0 } = engine.data.projection;
    const when = new Date(reading.instant);
    const pos = sunPosition(when, lat0, lon0);
    let text = `Fermato al ${engine.clock.civil({ dateStyle: "long", timeStyle: "short" } as Intl.DateTimeFormatOptions)}: sole a ${((pos.altitude * 180) / Math.PI).toFixed(1)}°.`;
    try {
      const past = await api.pastWeather<{ hourly: { time: string[]; temperature_2m: number[]; cloud_cover: number[]; precipitation: number[]; wind_speed_10m: number[]; weather_code: number[]; surface_pressure: number[] } }>(lat0, lon0, capture.date);
      const hour = Math.min(past.hourly.time.length - 1, Math.max(0, Math.round((when.getUTCHours() + lon0 / 15 + 24) % 24)));
      engine.weather.mode = "manual";
      engine.weather.target = {
        ...engine.weather.target,
        cloud: past.hourly.cloud_cover[hour]! / 100,
        rain: past.hourly.precipitation[hour]!,
        snow: 0,
        wind: past.hourly.wind_speed_10m[hour]! / 3.6,
        temp: past.hourly.temperature_2m[hour]!,
      };
      text += ` Archivio meteo: ${describeWmo(past.hourly.weather_code[hour]!)}, ${past.hourly.temperature_2m[hour]!.toFixed(0)}°C, nubi ${past.hourly.cloud_cover[hour]}%.`;
    } catch {
      text += " Archivio meteo non raggiunto: meteo lasciato com'era.";
    }
    setShotInfo(text);
    addNote("sistema", "Ritorno al momento dello scatto", text, {}, true);
    toast("Sole e tempo riportati al momento dello scatto.");
  }, [addNote, toast]);

  // Footprints already fetched for this box come back at once, and heights the laser set stay set.
  const showLaser = useCallback((assessment: LaserAssessment, visible: boolean) => {
    setLaserShown(visible);
    engineRef.current?.setFootprints(visible ? assessment.readings.map(({ shot }) => ({ x: shot.x, z: shot.z, topY: shot.good && shot.rh98 < 450 ? shot.top - assessment.datum : 0, good: shot.good })) : []);
  }, []);

  const onLaser = useCallback((assessment: LaserAssessment) => {
    stateRef.current.laser = assessment;
    stateRef.current.volumeErrors = heightErrorsFrom(assessment);
    setLaser(assessment);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const engine = engineRef.current!;
    api
      .gedi(engine.data.spec.bbox)
      .then((status) => {
        if (status.state !== "pronto") return;
        const assessment = assessWorld(engine, status.shots);
        onLaser(assessment);
        if (initial.laserApplied) {
          applyLaser(engine, assessment);
          engine.refreshBuildings();
          onLaser(assessWorld(engine, status.shots));
        }
      })
      .catch(() => undefined);
  }, [ready]);

  /** Tools that read a remote service start asking only when picked up, so a walk costs no quota. */
  useEffect(() => {
    if (!ready) return;
    const engine = engineRef.current!;
    const state = stateRef.current;
    const box = engine.data.spec.bbox;
    const { lat0, lon0 } = engine.data.projection;
    state.remoteError = "";
    if (tool === "aria" && !state.owm) api.owm(lat0, lon0).then((row) => (state.owm = row)).catch((e: Error) => (state.remoteError = e.message));
    if (tool === "termico" && !state.fires) {
      const radius = 100;
      const dLat = radius / 111.32;
      const dLon = dLat / Math.cos((lat0 * Math.PI) / 180);
      api.fires({ s: lat0 - dLat, n: lat0 + dLat, w: lon0 - dLon, e: lon0 + dLon }, 7, null).then((rows) => (state.fires = { rows, radius })).catch((e: Error) => (state.remoteError = e.message));
    }
    if (tool === "spettroradiometro" && !state.spectrum) {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 150 * 86_400_000).toISOString().slice(0, 10);
      const p = engine.data.projection;
      const k = Math.min(1, 640 / ((Math.max(p.halfX, p.halfZ) * 2) / 10));
      loadSpectrum(api.earthSpectrumUrl(box, from, to, Math.max(8, (p.halfX * 2 * k) / 10), Math.max(8, (p.halfZ * 2 * k) / 10)), from, to).then((row) => (state.spectrum = row)).catch((e: Error) => (state.remoteError = e.message));
    }
  }, [tool, ready]);

  // Hypotheses, the projector and the water all follow what the expedition says.
  const onHypotheses = useCallback((hypotheses: Hypothesis[]) => {
    updateExpedition((e) => ({ ...e, hypotheses }));
    engineRef.current?.setHypotheses(hypotheses, stateRef.current.hypothesisDraft);
  }, [updateExpedition]);

  const placementImage = useRef<{ url: string; image: HTMLCanvasElement } | null>(null);
  const applyPlacement = useCallback(async (next: PhotoPlacement | null) => {
    updateExpedition((e) => ({ ...e, placement: next }));
    const engine = engineRef.current;
    if (!engine) return;
    if (!next) {
      engine.setProjection(null);
      placementImage.current = null;
      return;
    }
    if (placementImage.current?.url !== next.url) placementImage.current = { url: next.url, image: await imageCanvas(next.url) };
    engine.setProjection(placementImage.current.image, next);
  }, [updateExpedition]);

  useEffect(() => {
    if (ready && initial.placement) void applyPlacement(initial.placement).catch(() => undefined);
  }, [ready]);

  const closeHypothesis = useCallback(() => {
    const draft = stateRef.current.hypothesisDraft;
    if (draft.length < 3) return toast("Servono almeno tre vertici.");
    const list = expRef.current.hypotheses ?? [];
    const item: Hypothesis = { id: nid(), name: `Ipotesi ${list.length + 1}`, ring: draft.flatMap((p) => [p.x, p.z]), height: 12, color: "#ffb54a", note: "", created: new Date().toISOString() };
    stateRef.current.hypothesisDraft = [];
    onHypotheses([...list, item]);
    setLabTab("ipotesi");
    openPanel("laboratorio");
  }, [onHypotheses, openPanel, toast]);

  const endTraverse = useCallback((closed: boolean) => {
    const engine = engineRef.current!;
    const state = stateRef.current;
    const t = state.traverse;
    if (closed && t.start && t.last) t.legs.push(measureLeg(t.last, t.start, SURVEY_CLASSES[t.cls]!, gauss));
    const result = finishTraverse(state, closed);
    if (!result) return;
    const m = result.misclosure;
    const cls = SURVEY_CLASSES[t.cls]!;
    addNote(
      "misura",
      closed ? `Poligonale chiusa: errore ${(m.linear * 100).toFixed(1)} cm` : `Poligonale aperta di ${result.length.toFixed(1)} m`,
      closed ? `${t.legs.length} lati con ${cls.label}. Errore distribuito sui vertici con la regola di Bowditch.` : `${t.legs.length} lati con ${cls.label}. Senza chiusura l'errore non si può conoscere.`,
      { instrument: "stazione topografica", values: { sviluppo: `${result.length.toFixed(2)} m`, ...(closed ? { "errore lineare": `${(m.linear * 100).toFixed(1)} cm`, "errore in quota": `${(m.dy * 100).toFixed(1)} cm`, precisione: Number.isFinite(m.ratio) ? `1:${Math.round(m.ratio)}` : "esatta" } : {}) } },
    );
    updateExpedition((e) => ({ ...e, sheet: { ...e.sheet, strokes: [...e.sheet.strokes, { color: "#3fb0a8", width: 2.2, pts: result.adjusted.flatMap((p) => [p.x, p.z]) }] } }));
    state.traverse = { cls: t.cls, start: null, last: null, legs: [] };
    state.survey = [];
    engine.setSurvey([]);
  }, [addNote, updateExpedition]);

  const photographLong = useCallback(async () => {
    const engine = engineRef.current!;
    const s = engine.snapshot();
    const frames = settings.longExposure;
    const shot = await engine.photographLong(frames, (done) => setLongShot(`Posa ${done}/${frames}`));
    setLongShot("");
    setShutter((n) => n + 1);
    engine.audio.shutter();
    const url = await api.uploadMedia(engine.data.spec.id, await canvasBlob(shot, "image/jpeg", 0.94), "jpg");
    addNote("foto", `Lunga posa verso ${compassName(s.heading)}`, `${frames} esposizioni sommate: bordi risolti e penombre vere del disco solare.`, { instrument: "fotocamera", photo: url, values: { focale: `${stateRef.current.focal.toFixed(0)} mm`, azimut: `${s.heading.toFixed(0)}°`, esposizioni: String(frames) } });
  }, [addNote, settings.longExposure]);

  const closeMass = useCallback(async () => {
    const engine = engineRef.current!;
    const state = stateRef.current;
    const draft = state.volumeDraft;
    if (draft.length < 3) return toast("Servono almeno tre punti.");
    state.volumeDraft = [];
    engine.setHypotheses(expRef.current.hypotheses ?? []);
    toast("Misuro la massa sui modelli del rilievo…");
    const ring = draft.flatMap((p) => [p.x, p.z]);
    try {
      const list = expRef.current.masses ?? [];
      const report = await measureMass(engine, ring, `Massa ${list.length + 1}`);
      updateExpedition((e) => ({ ...e, masses: [...(e.masses ?? []), report], sheet: { ...e.sheet, strokes: [...e.sheet.strokes, { color: "#ffb54a", width: 2.2, pts: [...ring, ring[0]!, ring[1]!] }] } }), true);
      const biggest = report.fill.value >= report.cut.value ? `sporge ${formatVolume(report.fill.value)}` : `manca ${formatVolume(report.cut.value)}`;
      addNote("misura", `${report.name}: ${biggest}`, `${report.warning ? `${report.warning} ` : ""}Rilievo meno il terreno ricostruito dal bordo. Fonte: ${report.sources}.`, {
        instrument: "volumetro",
        values: {
          sopra: `${formatVolume(report.fill.value)} (${formatRange(report.fill)})`,
          sotto: `${formatVolume(report.cut.value)} (${formatRange(report.cut)})`,
          area: `${(report.area / 10000).toFixed(2)} ha`,
          "altezza massima": `${report.peak.toFixed(1)} m`,
          "fondo massimo": `${report.pit.toFixed(1)} m`,
        },
      });
    } catch (e) {
      toast((e as Error).message);
    }
  }, [addNote, toast, updateExpedition]);
  closeMassRef.current = closeMass;

  const saveStudy = useCallback(
    async (name?: string) => {
      const engine = engineRef.current!;
      const id = engine.data.spec.id;
      const smallShot = await canvasBlob(engine.photograph(640));
      const photo = await api.uploadMedia(id, smallShot, "jpg");
      const ref = engine.plate.ref;
      const current = drapeRef.current;
      const drapeUrl = current ? await api.uploadMedia(id, await canvasBlob(current.canvas, "image/png"), "png") : null;
      const count = expRef.current.studies?.length ?? 0;
      const row: SavedStudy = {
        id: nid(),
        name: name ?? `Studio ${count + 1}`,
        created: new Date().toISOString(),
        x: engine.pos.x,
        y: engine.pos.y,
        z: engine.pos.z,
        yaw: engine.yaw,
        pitch: engine.pitch,
        drone: engine.drone,
        simTime: engine.clock.date.getTime(),
        weather: { mode: engine.weather.mode, target: { ...engine.weather.target } },
        release: ref.kind === "wayback" ? ref.release : null,
        plateLabel: plateLabel(ref),
        drape: current && drapeUrl ? { url: drapeUrl, label: current.label, source: current.source } : undefined,
        photo,
      };
      updateExpedition((e) => ({ ...e, studies: [...(e.studies ?? []), row], thumb: photo }), true);
      toast(`Salvato: ${row.name}. Lo ritrovi nel Laboratorio e nell'Archivio.`);
    },
    [toast, updateExpedition],
  );
  saveStudyRef.current = saveStudy;

  const versionsRef = useRef(versions);
  versionsRef.current = versions;
  const pendingRelease = useRef<unknown>(null);
  const openStudy = useCallback(
    async (row: SavedStudy) => {
      const engine = engineRef.current!;
      engine.drone = row.drone;
      engine.pos.set(row.x, row.y, row.z);
      engine.vel.set(0, 0, 0);
      engine.yaw = row.yaw;
      engine.pitch = row.pitch;
      engine.clock.setCustom(row.simTime, 1);
      engine.clock.paused = true;
      engine.weather.mode = row.weather.mode as typeof engine.weather.mode;
      Object.assign(engine.weather.target, row.weather.target);
      Object.assign(engine.weather.now, row.weather.target);
      const layer = row.drape ? { label: row.drape.label, source: row.drape.source, canvas: await imageCanvas(row.drape.url) } : null;
      engine.setDrape(layer?.canvas ?? null, 0.9);
      setDrape(layer);
      const ref = engine.plate.ref;
      if (row.release != null && (ref.kind !== "wayback" || ref.release !== row.release)) {
        const version = versionsRef.current.find((item) => item.release === row.release);
        if (version) await goToPlate(version);
        else pendingRelease.current = row.release;
      }
      toast(`Studio: ${row.name}`);
    },
    [goToPlate, toast],
  );

  // A deep link opens one study once the world stands; its plate may have to wait for the list of plates.
  const studyOpened = useRef(false);
  useEffect(() => {
    if (!ready || !study || studyOpened.current) return;
    const row = initial.studies?.find((item) => item.id === study);
    if (!row) return;
    studyOpened.current = true;
    void openStudy(row);
  }, [ready, study, initial, openStudy]);
  useEffect(() => {
    if (pendingRelease.current == null) return;
    const version = versions.find((item) => item.release === pendingRelease.current);
    if (!version) return;
    pendingRelease.current = null;
    void goToPlate(version);
  }, [versions, goToPlate]);

  // What the world draws of an investigation follows what is saved: routes, and the places still to be seen.
  useEffect(() => {
    if (!ready) return;
    engineRef.current?.setRoutes(expedition.routes ?? []);
  }, [ready, expedition.routes]);
  useEffect(() => {
    if (!ready) return;
    const rows = expedition.investigation?.candidates ?? [];
    engineRef.current?.setMarkers(rows.slice(0, 12).filter((row) => row.status !== "spiegato").map((row, index) => ({ id: row.id, x: row.x, z: row.z, label: String(index + 1), color: row.status === "spiegato" || row.status === "visto" ? "#a9ad9f" : row.status === "interessante" ? "#199e70" : "#ffb54a" })));
  }, [ready, expedition.investigation]);

  // Laser heights are measured once and kept in the cache: on reopening they only need applying again.
  const lidarReapplied = useRef(false);
  useEffect(() => {
    const report = initial.lidarReport;
    if (!ready || !report || lidarReapplied.current) return;
    lidarReapplied.current = true;
    const engine = engineRef.current!;
    void api
      .lidarCoverage(engine.data.spec.bbox)
      .then((rows) => {
        const offer = rows.find((row) => row.id === report.provider);
        return offer ? applyLidar(engine, offer) : null;
      })
      .catch(() => undefined);
  }, [ready, initial.lidarReport]);

  // The archive's picture of this place: the first view of it, until a study replaces it.
  useEffect(() => {
    if (!ready || expRef.current.thumb) return;
    const timer = setTimeout(() => {
      const engine = engineRef.current;
      if (!engine) return;
      void canvasBlob(engine.photograph(480))
        .then((blob) => api.uploadMedia(engine.data.spec.id, blob, "jpg"))
        .then((thumb) => updateExpedition((e) => ({ ...e, thumb: e.thumb ?? thumb })))
        .catch(() => undefined);
    }, 7000);
    return () => clearTimeout(timer);
  }, [ready, updateExpedition]);

  const photographLight = useCallback(async () => {
    const engine = engineRef.current!;
    const s = engine.snapshot();
    try {
      const { pathTraced } = await import("../world/pathtrace.ts");
      const started = performance.now();
      const samples = settings.traceSamples;
      const result = await pathTraced(engine, samples, 320, (text) => setLongShot(text));
      const seconds = (performance.now() - started) / 1000;
      setLongShot("");
      setShutter((n) => n + 1);
      engine.audio.shutter();
      const url = await api.uploadMedia(engine.data.spec.id, await canvasBlob(result.canvas, "image/jpeg", 0.94), "jpg");
      addNote("foto", `Studio della luce verso ${compassName(s.heading)}`, `Tracciamento di cammini su una copia semplificata del luogo: rimbalzi e penombre sono calcolati, facciate ed erba non ci sono. Cielo uniforme, senza nuvole.`, { instrument: "fotocamera", photo: url, values: { campioni: String(samples), triangoli: String(result.triangles), tempo: `${seconds.toFixed(0)} s` } });
    } catch (e) {
      setLongShot("");
      toast(`Studio della luce non riuscito: ${(e as Error).message}`);
    }
  }, [addNote, settings.traceSamples, toast]);

  const uploadAll = async (files: File[]) => {
    const engine = engineRef.current!;
    return Promise.all(files.map((file) => api.uploadMedia(engine.data.spec.id, file, file.name.split(".").pop() ?? "jpg")));
  };

  const ctxNow = snap && engineRef.current ? { engine: engineRef.current, snap, state: stateRef.current } : null;
  const def = toolById(tool);
  const reading = ctxNow ? def.read(ctxNow) : null;
  const projection = engineRef.current?.data.projection;
  const scoped = tool === "binocolo" || tool === "monocolo" || tool === "fotocamera" || tool === "sestante";
  const weather = engineRef.current?.weather;
  const engine = engineRef.current;
  const groups = useMemo(() => [...new Set(TOOLS.map((item) => item.group))], []);

  const dial = useMemo(() => {
    if (!ctxNow || !def.dial || !showReadout) return null;
    const { snap: s, engine: en, state } = ctxNow;
    if (def.dial === "bussola") return <CompassDial heading={s.heading} declination={magneticInfo(s.lat, s.lon, s.y).declination} />;
    if (def.dial === "orologio") {
      const hour = Number(en.clock.civil({ hour: "numeric", hourCycle: "h23" } as Intl.DateTimeFormatOptions));
      const minute = Number(en.clock.civil({ minute: "numeric" }));
      const second = Number(en.clock.civil({ second: "numeric" }));
      return <WatchDial hours={hour} minutes={minute} seconds={second} sunAz={(s.sunAz * 180) / Math.PI} chrono={swElapsed(state)} />;
    }
    if (def.dial === "altimetro") {
      const alt = s.y;
      const center = Math.round(alt / 50) * 50;
      return <GaugeDial value={alt} min={center - 100} max={center + 100} step={50} unit="metri" label="Altimetro" />;
    }
    const p = localPressure(ctxNow);
    return <GaugeDial value={p} min={960} max={1050} step={15} unit="hPa" label="Barometro" marker={state.qnhRef} />;
  }, [ctxNow, def.dial, showReadout]);

  if (error) {
    return (
      <div className="loading">
        <h2>La discesa è fallita</h2>
        <p className="mono small">{error}</p>
        <button className="btn" onClick={() => onExit(initial.spec)}>
          Torna all'Atlante
        </button>
      </div>
    );
  }

  return (
    <div className="fieldscreen">
      <canvas ref={glRef} className="gl" onClick={() => !panel && !engineRef.current?.isLocked && engineRef.current?.lock()} />
      {!ready && (
        <div className="loading">
          <h2>{initial.spec.name}</h2>
          <ol>
            {steps.map((row, index) => (
              <li key={`${row}${index}`} className={index === steps.length - 1 ? "now" : ""}>
                {row}
              </li>
            ))}
          </ol>
        </div>
      )}
      {ready && snap && engine && (
        <div className="hud">
          {scoped && <Reticle kind={tool as "binocolo"} zoom={snap.zoom} />}
          {!scoped && <div className="crosshair" />}
          {!scoped && snap.look && snap.look.kind !== "cielo" && snap.look.dist < 300 && (
            <div className="look-tag">
              {snap.look.building?.tags?.name ?? snap.look.tree?.species ?? snap.look.prop?.feature.tags.name ?? snap.look.kind} · {snap.look.dist.toFixed(snap.look.dist < 20 ? 1 : 0)} m
            </div>
          )}
          {settings.showCompassTape && <CompassTape heading={snap.heading} />}
          <div className="hud-tl hud-card">
            <h3>{engine.data.spec.name}</h3>
            <div className="mono small">{formatLatLon(snap.lat, snap.lon)}</div>
            <div className="mono small muted">
              quota {snap.y.toFixed(1)} m{snap.onRoof ? " · sul tetto" : ""}
              {snap.drone ? ` · drone +${(snap.y - snap.ground).toFixed(0)} m` : ""} · {plateLabel(engine.plate.ref)}
            </div>
          </div>
          <div className="hud-tr hud-card">
            <div className="mono">{engine.clock.civil({ hour: "2-digit", minute: "2-digit" })} <span className="muted small">{engine.clock.civil({ day: "2-digit", month: "short", year: "numeric" })}{engine.clock.mode === "live" ? " · 1:1" : engine.clock.paused ? " · fermo" : ` · ×${engine.clock.rate}`}</span></div>
            <div className="small">
              {weather!.label}, {weather!.now.temp.toFixed(0)}°C · {weather!.now.wind.toFixed(1)} m/s da {compassName(weather!.now.windDir)}
            </div>
            <div className="small muted">{weather!.mode === "live" ? "stazione reale" : "meteo a mano"}</div>
          </div>
          <div className="toast-area" aria-live="polite">
            {toasts.map((row) => (
              <div key={row.id} className="toast">
                {row.text}
              </div>
            ))}
          </div>
          {shutter > 0 && <div key={shutter} className="shutter" />}
          {ghost &&
            (ghost.photo.pano ? (
              <div
                className="photo-ghost"
                style={{
                  opacity: ghost.opacity,
                  backgroundImage: `url("${api.photoUrl(ghost.photo.full)}")`,
                  backgroundSize: `${(360 / (engine.camera.fov * engine.camera.aspect)) * 100}% auto`,
                  backgroundRepeat: "repeat-x",
                  backgroundPosition: `${-(((snap.heading - (ghost.photo.heading ?? 0)) / 360 + 1.5) % 1) * (360 / (engine.camera.fov * engine.camera.aspect)) * 100 + 50}% center`,
                }}
              />
            ) : (
              <img className="photo-ghost" alt="" src={api.photoUrl(ghost.photo.full)} style={{ opacity: ghost.opacity }} />
            ))}
          {provenance && (
            <div className="prov-legend hud-card">
              <b className="small">Origine delle altezze</b>
              {PROVENANCE_LEGEND.map((row) => (
                <span key={row.id} className="small">
                  <i className="swatch-static" style={{ background: row.color }} /> {row.label}
                </span>
              ))}
            </div>
          )}
          {!snap.locked && !panel && engine.freeCursor && (
            <div className="free-chip small">Cursore libero: continui a camminare. Clic sul mondo o Tab per tornare a guardare.</div>
          )}
          {!snap.locked && !panel && !engine.freeCursor && (
            <div className="pause">
              <button className="btn primary" onClick={() => engine.lock()}>
                Clicca per camminare
              </button>
              <p className="small hud-card" style={{ marginTop: 8 }}>
                WASD cammina · Maiusc corre · Spazio salta · C si accovaccia · E ispeziona · 1–9 o rotella strumenti
                <br />
                <b>Clic o F usa lo strumento · Clic destro o Q lo ripone · Tab libera il cursore senza fermarti</b>
                <br />B borsa · J registro · M carta · T archivio · G strati · P fonti · R laboratorio · O impostazioni · L torcia · Esc pausa
              </p>
              <button className="btn tiny" style={{ marginTop: 6 }} onClick={() => onExit(engine.data.spec)}>
                Torna all'Atlante
              </button>
            </div>
          )}
          {showReadout && tool !== "mano" && reading && (
            <section className={`instrument hud-card ${snap.speed > 0.4 ? "walking" : ""}`} aria-label={def.name}>
              <div className="row">
                <h4 className="grow">{def.name}</h4>
                <button className="btn tiny ghost" title="Riponi (Q o clic destro)" onClick={putAway}>
                  ×
                </button>
              </div>
              {dial}
              <dl className="readout">
                {reading.big && (
                  <>
                    <dt>{reading.big[0]}</dt>
                    <dd className="big">{reading.big[1]}</dd>
                  </>
                )}
                {reading.rows.map(([label, value]) => (
                  <div key={label} style={{ display: "contents" }}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {reading.note && <p className="small muted">{reading.note}</p>}
              {snap.locked && <p className="small muted" style={{ margin: "0 0 6px" }}>Clic o F usa · Clic destro o Q ripone · Tab per i pulsanti</p>}
              <div className="row wrap">
                {def.actionLabel && (
                  <button className="btn tiny primary" onClick={action}>
                    {def.actionLabel} (F)
                  </button>
                )}
                {tool === "altimetro" && (
                  <button
                    className="btn tiny"
                    onClick={() => {
                      const p = localPressure(ctxNow!);
                      // Solve QNH so that the reading equals the charted altitude here.
                      stateRef.current.qnhRef = p / Math.pow(1 - snap.y / 44330, 5.255);
                      addNote("strumento", "Altimetro calibrato", `Su quota nota ${snap.y.toFixed(1)} m.`, { instrument: "altimetro", values: { QNH: `${stateRef.current.qnhRef.toFixed(1)} hPa` } }, true);
                    }}
                  >
                    Calibra qui
                  </button>
                )}
                {tool === "contapassi" && (
                  <button className="btn tiny" onClick={() => (stateRef.current.pedometerZero = { steps: snap.steps, distance: snap.distance })}>
                    Azzera
                  </button>
                )}
                {tool === "orologio" && (
                  <>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        const sw = stateRef.current.stopwatch;
                        if (sw.running) sw.elapsed += performance.now() - sw.start;
                        else sw.start = performance.now();
                        sw.running = !sw.running;
                      }}
                    >
                      Cronometro
                    </button>
                    <button className="btn tiny" onClick={() => (stateRef.current.stopwatch = { running: false, start: 0, elapsed: 0, laps: [] })}>
                      Azzera
                    </button>
                    <button className="btn tiny" onClick={() => openPanel("impostazioni")}>
                      Regola il tempo
                    </button>
                  </>
                )}
                {tool === "rotella" && (
                  <>
                    <button
                      className="btn tiny"
                      disabled={stateRef.current.survey.length < 2}
                      onClick={() => {
                        const points = stateRef.current.survey;
                        const stats = surveyStats(points);
                        addNote("misura", `Rilievo di ${stats.length.toFixed(1)} m`, `${points.length} punti, area ${stats.area.toFixed(1)} m² se chiuso.`, { instrument: "rotella metrica", values: { lunghezza: `${stats.length.toFixed(2)} m`, pianta: `${stats.plan.toFixed(2)} m`, salita: `${stats.climb.toFixed(2)} m`, area: `${stats.area.toFixed(1)} m²` } });
                        updateExpedition((e) => ({ ...e, sheet: { ...e.sheet, strokes: [...e.sheet.strokes, { color: "#f0a02e", width: 2.4, pts: points.flatMap((p) => [p.x, p.z]) }] } }));
                        stateRef.current.survey = [];
                        engine.setSurvey([]);
                      }}
                    >
                      Chiudi e registra
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        stateRef.current.survey = [];
                        engine.setSurvey([]);
                      }}
                    >
                      Azzera
                    </button>
                  </>
                )}
                {tool === "stazione" && (
                  <>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        const t = stateRef.current.traverse;
                        t.cls = (t.cls + 1) % SURVEY_CLASSES.length;
                      }}
                    >
                      Cambia strumento
                    </button>
                    <button className="btn tiny" disabled={!stateRef.current.traverse.legs.length} onClick={() => endTraverse(true)}>
                      Chiudi sulla partenza
                    </button>
                    <button className="btn tiny" disabled={!stateRef.current.traverse.legs.length} onClick={() => endTraverse(false)}>
                      Registra aperta
                    </button>
                  </>
                )}
                {tool === "altego" && (expedition.figures?.length ?? 0) > 0 && (
                  <button
                    className="btn tiny"
                    onClick={() => {
                      updateExpedition((e) => ({ ...e, figures: [] }));
                      engine.setFigures([]);
                    }}
                  >
                    Togli le figure
                  </button>
                )}
                {tool === "volumetro" && stateRef.current.volumeDraft.length > 0 && (
                  <>
                    <button className="btn tiny primary" disabled={stateRef.current.volumeDraft.length < 3} onClick={() => void closeMass()}>
                      Chiudi e misura
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        stateRef.current.volumeDraft = [];
                        engine.setHypotheses(expedition.hypotheses ?? []);
                      }}
                    >
                      Azzera
                    </button>
                  </>
                )}
                {tool === "ipotesi" && (
                  <>
                    <button className="btn tiny primary" disabled={stateRef.current.hypothesisDraft.length < 3} onClick={closeHypothesis}>
                      Chiudi il volume
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        stateRef.current.hypothesisDraft = [];
                        engine.setHypotheses(expedition.hypotheses ?? []);
                      }}
                    >
                      Azzera
                    </button>
                  </>
                )}
                {tool === "sezione" && (
                  <>
                    <button
                      className="btn tiny primary"
                      disabled={stateRef.current.section.length < 2}
                      onClick={() => {
                        setLabTab("sezione");
                        openPanel("laboratorio");
                      }}
                    >
                      Apri la sezione
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        stateRef.current.section = [];
                        setSectionPoints([]);
                        stateRef.current.survey = [];
                        engine.setSurvey([]);
                      }}
                    >
                      Azzera
                    </button>
                  </>
                )}
                {tool === "fotocamera" && (
                  <>
                    <button className="btn tiny" disabled={!!longShot} onClick={() => void photographLong()}>
                      {longShot || "Lunga posa"}
                    </button>
                    <button className="btn tiny" disabled={!!longShot} onClick={() => void photographLight()}>
                      Studio della luce
                    </button>
                  </>
                )}
                {tool === "fotocamera" &&
                  ["colore", "falso colore", "b/n"].map((name, index) => (
                    <button
                      key={name}
                      className={`btn tiny ${stateRef.current.filter === index ? "on" : ""}`}
                      onClick={() => {
                        stateRef.current.filter = index;
                        engine.renderMode = index;
                      }}
                    >
                      {name}
                    </button>
                  ))}
                {tool === "drone" && snap.drone && (
                  <>
                    <button className="btn tiny" onClick={() => (engine.droneNadir = !engine.droneNadir)}>
                      Nadir (N)
                    </button>
                    <button className="btn tiny" onClick={() => engine.setDrone(false)}>
                      Atterra
                    </button>
                  </>
                )}
                {tool === "gnomone" && stateRef.current.gnomon && (
                  <button
                    className="btn tiny"
                    onClick={() => {
                      stateRef.current.gnomon = null;
                      engine.clearGnomon();
                    }}
                  >
                    Togli l'asta
                  </button>
                )}
              </div>
            </section>
          )}
          {info && (
            <aside className="card-info hud-card" aria-label="Scheda">
              <div className="row">
                <h4 className="grow">{info.title}</h4>
                <button className="btn tiny ghost" onClick={() => setInfo(null)}>
                  ×
                </button>
              </div>
              <dl className="readout">
                {info.rows.map(([label, value]) => (
                  <div key={label} style={{ display: "contents" }}>
                    <dt>{label}</dt>
                    <dd style={{ whiteSpace: "normal" }}>{value}</dd>
                  </div>
                ))}
              </dl>
              {info.tags && (
                <>
                  <button className="btn tiny" onClick={() => setShowTags((v) => !v)}>
                    Tutti i tag OSM
                  </button>
                  {showTags && (
                    <dl className="readout small">
                      {Object.entries(info.tags)
                        .filter(([key]) => !key.startsWith("name:") && !key.startsWith("old_name") && !key.startsWith("alt_name") && !key.startsWith("_"))
                        .map(([key, value]) => (
                          <div key={key} style={{ display: "contents" }}>
                            <dt>{key}</dt>
                            <dd style={{ whiteSpace: "normal", fontSize: 11 }}>{value}</dd>
                          </div>
                        ))}
                    </dl>
                  )}
                </>
              )}
              <p className="small muted" style={{ margin: "6px 0 0" }}>V annota · E o Q chiude · Tab per i pulsanti · camminando si chiude da sola</p>
              <div className="row wrap" style={{ marginTop: 6 }}>
                <button
                  className="btn tiny primary"
                  onClick={() => {
                    addNote("strumento", info.title, info.note, { instrument: "ispezione", values: Object.fromEntries(info.rows) });
                    setInfo(null);
                  }}
                >
                  Annota
                </button>
                {inspected && info.rows.some(([label]) => label === "Sedime") && (
                  <>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        setLabTab("ipotesi");
                        openPanel("laboratorio");
                      }}
                    >
                      Banco delle ombre
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        setLabTab("cielo");
                        openPanel("laboratorio");
                      }}
                    >
                      Asse e cielo
                    </button>
                  </>
                )}
                {info.link && (
                  <a className="btn tiny" href={info.link} target="_blank" rel="noreferrer">
                    Fonte esterna
                  </a>
                )}
              </div>
            </aside>
          )}
          {settings.showPerf && (
            <div className="perf">
              {snap.fps.toFixed(0)} fps · scala {(snap.scale * settings.renderScale * 100).toFixed(0)}% · {(engine.debug().triangles / 1000).toFixed(0)}k tri · {engine.debug().calls} draw
            </div>
          )}
          <nav className="hotbar" aria-label="Strumenti rapidi">
            {HOTBAR.map((id, index) => {
              const item = toolById(id);
              return (
                <button key={id} className={tool === id ? "on" : ""} title={item.blurb} onClick={() => setTool(id)}>
                  <kbd>{index + 1}</kbd>
                  <Icon path={item.icon} />
                  {item.name.split(" ")[0]}
                </button>
              );
            })}
            <button onClick={() => openPanel("borsa")} title="Tutti gli strumenti">
              <kbd>B</kbd>
              <Icon path="M6 8h12l1 12H5zM9 8V6a3 3 0 0 1 6 0v2" />
              Borsa
            </button>
            <button onClick={() => openPanel("registro")} title="Registro di esplorazione">
              <kbd>J</kbd>
              <Icon path="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM9 8h6M9 12h6" />
              Registro
            </button>
            <button onClick={() => openPanel("strati")} title="Strati della Terra">
              <kbd>G</kbd>
              <Icon path={toolById("strati").icon} />
              Strati
            </button>
            <button onClick={() => openPanel("fonti")} title="Fonti del luogo">
              <kbd>P</kbd>
              <Icon path={toolById("fonti").icon} />
              Fonti
            </button>
            <button onClick={() => openPanel("laboratorio")} title="Laboratorio">
              <kbd>R</kbd>
              <Icon path={toolById("laboratorio").icon} />
              Lab
            </button>
            <button onClick={() => openPanel("impostazioni")} title="Impostazioni">
              <kbd>O</kbd>
              <Icon path="M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4" />
              Regola
            </button>
          </nav>
          {travel && (
            <TimeTravel
              engine={engine}
              expedition={expedition}
              versions={versions}
              plateCache={plateCacheRef.current}
              onClose={() => {
                setTravel(false);
                engine.freeCursor = false;
              }}
              onVideo={(video) => {
                updateExpedition((e) => ({ ...e, videos: [...(e.videos ?? []), video] }), true);
                addNote("foto", video.name, `Viaggio nel tempo di ${video.seconds.toFixed(0)} secondi, salvato fra i media: ${video.url}`, { instrument: "viaggio nel tempo", photo: video.poster });
              }}
              toast={toast}
            />
          )}
          {panel && (
            <div className="panel-wrap" onClick={() => openPanel(null)}>
              {panel === "borsa" && (
                <div className="panel wide" onClick={(e) => e.stopPropagation()}>
                  <header className="panel-head">
                    <h2 className="grow">La borsa dell'esploratore</h2>
                    <button className="btn tiny" onClick={() => openPanel(null)}>
                      Chiudi (B)
                    </button>
                  </header>
                  <div className="panel-body">
                    {groups.map((group) => (
                      <div key={group}>
                        <h3 className="bag-group">{group}</h3>
                        <div className="bag">
                          {TOOLS.filter((item) => item.group === group).map((item) => (
                            <button
                              key={item.id}
                              className={`bag-item ${tool === item.id ? "on" : ""}`}
                              onClick={() => {
                                setTool(item.id);
                                if (!["carta", "cronologia", "strati", "fonti", "laboratorio"].includes(item.id)) openPanel(null);
                              }}
                            >
                              <Icon path={item.icon} />
                              <b>{item.name}</b>
                              <span>{item.blurb}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {panel === "registro" && projection && (
                <JournalPanel
                  expedition={expedition}
                  toLatLon={(x, z) => projection.toLatLon(x, z)}
                  onClose={() => openPanel(null)}
                  onGoTo={(lat, lon) => {
                    const local = projection.toLocal(lat, lon);
                    engine.teleport(local.x, local.z);
                    openPanel(null);
                  }}
                  onDelete={(id) => updateExpedition((e) => ({ ...e, notes: e.notes.filter((note) => note.id !== id) }))}
                  onAttach={async (id, file) => {
                    const [url] = await uploadAll([file]);
                    updateExpedition((e) => ({ ...e, notes: e.notes.map((note) => (note.id === id ? { ...note, attachments: [...(note.attachments ?? []), url!] } : note)) }));
                  }}
                  onAdd={async (title, text, files) => {
                    const urls = await uploadAll(files);
                    addNote("manuale", title, text, { attachments: urls });
                  }}
                />
              )}
              {panel === "carta" && projection && (
                <SheetPanel
                  drape={drape}
                  hypotheses={expedition.hypotheses ?? []}
                  section={sectionPoints}
                  laser={laserShown && laser ? laser.readings.map(({ shot }) => ({ x: shot.x, z: shot.z, good: shot.good })) : []}
                  plate={engine.plate.canvas}
                  projection={projection}
                  sheet={expedition.sheet}
                  pins={[...expedition.pins, ...(expedition.investigation?.candidates ?? []).filter((row) => row.status === "da vedere" || row.status === "interessante").map((row, index) => ({ id: row.id, x: row.x, z: row.z, y: 0, label: `Luogo ${index + 1}`, color: "#ffb54a", created: "" }))]}
                  track={expedition.track}
                  self={{ x: snap.x, z: snap.z }}
                  heading={snap.heading}
                  buildings={engine.data.buildings}
                  bboxZoom={engine.data.spec.zoom}
                  bbox={engine.data.spec.bbox}
                  onChange={(sheet) => updateExpedition((e) => ({ ...e, sheet }))}
                  onTeleport={(x, z) => {
                    engine.teleport(x, z);
                    toast("Ti sei spostato sulla carta.");
                  }}
                  onSnapshot={async (out) => {
                    const url = await api.uploadMedia(engine.data.spec.id, await canvasBlob(out), "jpg");
                    addNote("foto", "Carta annotata", "Copia della carta con i segni, la traccia e i picchetti.", { photo: url, instrument: "carta" });
                  }}
                  onClose={() => openPanel(null)}
                />
              )}
              {panel === "impostazioni" && <SettingsPanel engine={engine} settings={settings} onChange={applySettings} onClose={() => openPanel(null)} onShotDay={() => void toShotDay()} shotInfo={shotInfo} />}
              {panel === "strati" && projection && (
                <LayersPanel
                  engine={engine}
                  bbox={engine.data.spec.bbox}
                  projection={projection}
                  drape={drape}
                  overlays={expedition.overlays ?? []}
                  self={{ lat: snap.lat, lon: snap.lon }}
                  onDrape={setDrape}
                  onOverlays={(overlays: MapOverlay[]) => updateExpedition((e) => ({ ...e, overlays }))}
                  addNote={(kind, title, text, extra) => addNote(kind, title, text, extra)}
                  toast={toast}
                  onClose={() => openPanel(null)}
                />
              )}
              {panel === "fonti" && projection && (
                <SourcesPanel
                  engine={engine}
                  bbox={engine.data.spec.bbox}
                  projection={projection}
                  self={{ x: snap.x, z: snap.z }}
                  placement={expedition.placement ?? null}
                  ghost={ghost}
                  onGhost={setGhost}
                  onPlacement={(next) => void applyPlacement(next).catch((e: Error) => toast(e.message))}
                  addNote={(kind, title, text, extra) => addNote(kind, title, text, extra)}
                  toast={toast}
                  onClose={() => openPanel(null)}
                />
              )}
              {panel === "laboratorio" && projection && (
                <LabPanel
                  engine={engine}
                  onSaveStudy={saveStudy}
                  onOpenStudy={openStudy}
                  onStudies={(studies) => updateExpedition((e) => ({ ...e, studies }))}
                  onInvestigation={(investigation) => updateExpedition((e) => ({ ...e, investigation }), true)}
                  onRoutes={(routes) =>
                    updateExpedition(
                      (e) => ({
                        ...e,
                        routes,
                        // The map keeps one line per route: removing a route removes its line too.
                        sheet: { ...e.sheet, strokes: [...e.sheet.strokes.filter((stroke) => !stroke.route), ...routes.map((row) => ({ color: row.color, width: 2.4, route: row.id, pts: row.points.flatMap((p) => [p.x, p.z]) }))] },
                      }),
                      true,
                    )
                  }
                  onSights={(rows) => engine.setSights(rows)}
                  onLidarReport={(lidarReport) => updateExpedition((e) => ({ ...e, lidarReport }), true)}
                  onUseLidarTerrain={() => {
                    applySettings({ ...settings, demSource: "lidar" });
                    location.href = `${location.pathname}?spedizione=${engine.data.spec.id}`;
                  }}
                  onPlacement={applyPlacement}
                  onPhotoFinds={(photoFinds) => updateExpedition((e) => ({ ...e, photoFinds }), true)}
                  expedition={expedition}
                  projection={projection}
                  versions={versions}
                  rereadCtx={rereadRef.current}
                  plateCache={plateCacheRef.current}
                  plates={shadowPlates}
                  sectionPoints={sectionPoints}
                  building={inspected}
                  tab={labTab}
                  flood={flood}
                  provenance={provenance}
                  astroYear={astroYear}
                  onAstroYear={setAstroYear}
                  laser={laser}
                  laserShown={laserShown}
                  onLaser={onLaser}
                  onShowLaser={showLaser}
                  onLaserApplied={() => updateExpedition((e) => ({ ...e, laserApplied: true }), true)}
                  onTreeModel={(treeModel) => updateExpedition((e) => ({ ...e, treeModel }), true)}
                  onTab={setLabTab}
                  onPlates={setShadowPlates}
                  onStrata={(strata) => updateExpedition((e) => ({ ...e, strata }), true)}
                  onHypotheses={onHypotheses}
                  onSection={(points) => {
                    stateRef.current.section = points;
                    setSectionPoints(points);
                    stateRef.current.survey = [];
                    engine.setSurvey([]);
                  }}
                  onFlood={(level) => {
                    setFlood(level);
                    engine.setFlood(level);
                  }}
                  onProvenance={(on) => {
                    setProvenance(on);
                    engine.setProvenance(on);
                  }}
                  onDrape={setDrape}
                  addNote={(kind, title, text, extra) => addNote(kind, title, text, extra)}
                  toast={toast}
                  onClose={() => openPanel(null)}
                />
              )}
              {panel === "cronologia" && (
                <div className="panel" onClick={(e) => e.stopPropagation()}>
                  <header className="panel-head">
                    <h2 className="grow">Cronologia degli scatti</h2>
                    <button className="btn tiny" onClick={() => openPanel(null)}>
                      Chiudi (T)
                    </button>
                  </header>
                  <div className="panel-body stack">
                    <p className="hint">
                      Scegli uno scatto e il suolo sfuma su quella foto: tetti e prati cambiano colore, alberi e corpi dedotti vengono riletti da quella ripresa. Gli edifici mappati restano quelli di oggi, finché non leggi tutte le riprese nel Laboratorio: da lì in poi spariscono quelli che risultano costruiti dopo lo scatto.
                    </p>
                    {plateBusy && <p className="mono small">{plateBusy}</p>}
                    <div className="row">
                      <button
                        className="btn tiny primary"
                        disabled={versions.length < 2 || !!plateBusy}
                        onClick={() => {
                          setPanelState(null);
                          panelRef.current = null;
                          engine.freeCursor = true;
                          engine.stopWalking();
                          document.exitPointerLock?.();
                          setTravel(true);
                        }}
                      >
                        Viaggio nel tempo
                      </button>
                      <span className="small muted">Un cursore che scorre fra gli scatti con la camera in movimento, esportabile come video.</span>
                    </div>
                    {versions.length === 0 && <p className="hint">Sto chiedendo all'archivio, o questa fonte non ne ha uno.</p>}
                    <div>
                      {versions.map((row) => {
                        const active = engine.plate.ref.kind === "wayback" && engine.plate.ref.release === row.release;
                        return (
                          <button key={row.release} className={`version ${active ? "on" : ""}`} disabled={!!plateBusy} onClick={() => void goToPlate(row)}>
                            <b>{row.capture?.date ?? `pubbl. ${row.published}`}</b>
                            <span className="small" style={{ gridRow: 2 }}>
                              {row.capture?.sensor ?? "sensore ignoto"}
                              {row.capture?.resolution ? ` · ${row.capture.resolution} m/px` : ""}
                              {row.capture?.accuracy ? ` · ±${row.capture.accuracy} m` : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {changes.length > 0 && baseline && (
                      <div>
                        <div className="section-title">Differenze da {baseline.label}</div>
                        {changes.slice(0, 14).map((cluster, index) => (
                          <div key={index} className="row">
                            <button
                              className="change grow"
                              onClick={() => {
                                const x = (cluster.x + cluster.w / 2) * 2 * projection!.halfX - projection!.halfX;
                                const z = (cluster.y + cluster.h / 2) * 2 * projection!.halfZ - projection!.halfZ;
                                engine.teleport(x, z);
                                openPanel(null);
                                toast(`Sei sul punto: ${cluster.kind}`);
                              }}
                            >
                              {cluster.kind} <span className="muted small mono">{cluster.area.toFixed(0)} m²</span>
                            </button>
                            <button className="btn tiny" onClick={() => addNote("confronto", `Variazione: ${cluster.kind}`, `${cluster.area.toFixed(0)} m² rispetto a ${baseline.label}.`)}>
                              Annota
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
