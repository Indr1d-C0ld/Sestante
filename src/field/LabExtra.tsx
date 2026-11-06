import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type LidarOffer } from "../core/api.ts";
import { leastCostRoute, ROUTE_MODES, sightLines, type RouteMode, type SightLine } from "../core/routes.ts";
import type { EvidenceStance, Hypothesis, SavedRoute } from "../core/types.ts";
import { corridorCanvas, formatDuration, routeGrid, sitesOf, WATER_RULES, type WaterRule } from "./ancient.ts";
import { applyLidar, bareGround, reliefCanvas, shadedCanvas } from "./lidarTools.ts";
import { CLUE_NAMES, type Candidate } from "../vision/anomalies.ts";
import { exportDossier, gatherEvidence } from "./dossier.ts";
import { investigate } from "./investigate.ts";
import type { LabProps } from "./LabPanel.tsx";

/** Saved views: position, hour, weather, plate and layer, ready to come back to. */
export function Studies({ expedition, onSaveStudy, onOpenStudy, onStudies }: LabProps) {
  const list = expedition.studies ?? [];
  const [name, setName] = useState("");
  return (
    <>
      <p className="hint">Uno studio ricorda dove sei, dove guardi, l'ora, il meteo, lo scatto in uso e lo strato drappeggiato. Si salva da qui o con il tasto K, e si ritrova anche nell'Archivio della pagina iniziale.</p>
      <div className="row">
        <input className="grow" placeholder={`Studio ${list.length + 1}`} aria-label="Nome dello studio" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn tiny primary"
          onClick={() => {
            void onSaveStudy(name.trim() || undefined);
            setName("");
          }}
        >
          Salva questa inquadratura
        </button>
      </div>
      {!list.length && <p className="muted">Ancora nessuno studio.</p>}
      {list.map((row) => (
        <article key={row.id} className="entry-dark row wrap">
          {row.photo && <img src={row.photo} alt="" className="study-thumb" />}
          <div className="grow stack">
            <input type="text" value={row.name} aria-label="Nome dello studio" onChange={(e) => onStudies(list.map((item) => (item.id === row.id ? { ...item, name: e.target.value } : item)))} />
            <span className="small muted mono">
              {new Date(row.simTime).toISOString().slice(0, 16).replace("T", " ")} UTC · {row.plateLabel}
              {row.drape ? ` · ${row.drape.label}` : ""}
            </span>
          </div>
          <button className="btn tiny primary" onClick={() => void onOpenStudy(row)}>
            Torna qui
          </button>
          <button className="btn tiny" onClick={() => onStudies(list.filter((item) => item.id !== row.id))}>
            Togli
          </button>
        </article>
      ))}
    </>
  );
}

const nid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const STATUS: Candidate["status"][] = ["da vedere", "visto", "interessante", "spiegato"];

/** "What is odd here?": the instruments' disagreements turned into a list of places to go and see. */
export function Inquiry(props: LabProps) {
  const { engine, expedition, versions, plateCache, laser, onInvestigation, onHypotheses, onTab, onClose, addNote } = props;
  const [step, setStep] = useState("");
  const [problem, setProblem] = useState("");
  const result = expedition.investigation;
  const run = () => {
    setProblem("");
    setStep("Comincio…");
    void investigate({ engine, expedition, versions, plateCache, laser, onStep: setStep })
      .then((row) => {
        onInvestigation(row);
        addNote("sistema", `Indagine: ${row.candidates.length} luoghi da vedere`, `Fonti usate: ${row.sources.filter((s) => s.state === "usata").map((s) => s.name).join(", ") || "nessuna"}.`, { instrument: "indagine" });
      })
      .catch((e: Error) => setProblem(e.message))
      .finally(() => setStep(""));
  };
  const setStatus = (id: string, status: Candidate["status"]) => result && onInvestigation({ ...result, candidates: result.candidates.map((row) => (row.id === id ? { ...row, status } : row)) });
  const openHypothesis = (row: Candidate) => {
    const radius = Math.max(8, Math.min(row.radius, 150));
    const ring: number[] = [];
    for (let k = 0; k < 10; k++) ring.push(row.x + Math.cos((k / 10) * 2 * Math.PI) * radius, row.z + Math.sin((k / 10) * 2 * Math.PI) * radius);
    const hypothesis: Hypothesis = { id: nid(), name: `Luogo ${result!.candidates.indexOf(row) + 1}`, ring, height: 6, color: "#ffb54a", note: row.clues.map((clue) => clue.text).join(" "), created: new Date().toISOString() };
    onHypotheses([...(expedition.hypotheses ?? []), hypothesis]);
    onTab("ipotesi");
  };
  return (
    <>
      <p className="hint">Sestante mette insieme ciò che fra strumenti diversi non torna: scatti che cambiano, chiazze di vegetazione, ombre senza edificio, disaccordi con il laser, rilievo cambiato, tracce nel LiDAR. Ne esce un elenco di posti da andare a vedere. L'ordine dice da dove cominciare, non che lì ci sia qualcosa: due indizi indipendenti sullo stesso punto valgono più di uno forte da solo.</p>
      <div className="row">
        <button className="btn primary" disabled={!!step} onClick={run}>
          {result ? "Rifai l'indagine" : "Cosa c'è di strano qui?"}
        </button>
        {step && <span className="small mono">{step}</span>}
      </div>
      {problem && <p className="warn small">{problem}</p>}
      {result && (
        <>
          <div>
            <div className="section-title">Fonti di questa indagine</div>
            <dl className="kv">
              {result.sources.map((row) => (
                <Fragment key={row.name}>
                  <dt className={row.state === "saltata" ? "muted" : ""}>{row.name}</dt>
                  <dd className={row.state === "saltata" ? "muted" : ""}>
                    {row.state === "saltata" ? "Saltata. " : ""}
                    {row.detail}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </div>
          <div className="section-title">Luoghi da andare a vedere: {result.candidates.length}</div>
          {!result.candidates.length && <p className="muted">Nessun indizio dalle fonti usate. Non vuol dire che qui non ci sia nulla: controlla quali fonti sono state saltate.</p>}
          {result.candidates.map((row, index) => (
            <article key={row.id} className="entry-dark stack">
              <div className="row wrap">
                <b className="grow">
                  {index + 1}. {row.kinds.map((kind) => CLUE_NAMES[kind]).join(" · ")}
                </b>
                <span className="small mono muted">
                  {row.kinds.length === 1 ? "un tipo di indizio" : `${row.kinds.length} tipi di indizio`} · raggio {row.radius.toFixed(0)} m
                </span>
              </div>
              {row.clues.slice(0, 4).map((clue, k) => (
                <p key={k} className="small">
                  {clue.text}
                </p>
              ))}
              {row.clues.length > 4 && <p className="small muted">E altri {row.clues.length - 4} indizi dello stesso gruppo.</p>}
              {row.explained && <p className="small warn">{row.explained}</p>}
              <div className="row wrap">
                <button
                  className="btn tiny primary"
                  onClick={() => {
                    engine.teleport(row.x, row.z);
                    onClose();
                  }}
                >
                  Vai a vedere
                </button>
                <button className="btn tiny" onClick={() => openHypothesis(row)}>
                  Apri un'ipotesi
                </button>
                <select value={row.status} aria-label="Stato del luogo" style={{ width: "auto" }} onChange={(e) => setStatus(row.id, e.target.value as Candidate["status"])}>
                  {STATUS.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </div>
            </article>
          ))}
        </>
      )}
    </>
  );
}

const STANCES: EvidenceStance[] = ["a favore", "contro", "neutra"];

/** One hypothesis's file: what each instrument says about it, for and against, and a report anyone can read. */
export function Dossier({ row, props, update }: { row: Hypothesis; props: LabProps; update: (change: Partial<Hypothesis>) => void }) {
  const { engine, expedition, plates, laser, addNote, toast } = props;
  const [step, setStep] = useState("");
  const [manual, setManual] = useState("");
  const [stance, setStance] = useState<EvidenceStance>("a favore");
  const list = row.evidence ?? [];
  const count = (kind: EvidenceStance) => list.filter((item) => item.stance === kind).length;
  const gather = () => {
    setStep("Interrogo gli strumenti…");
    void gatherEvidence({ engine, expedition, hypothesis: row, plates, laser, onStep: setStep })
      .then(({ evidence, skipped }) => update({ evidence: [...list.filter((item) => !item.auto), ...evidence], skipped }))
      .catch((e: Error) => toast(e.message))
      .finally(() => setStep(""));
  };
  return (
    <details className="dossier" open={list.length > 0}>
      <summary>
        Fascicolo: {count("a favore")} a favore, {count("contro")} contro, {count("neutra")} neutre
      </summary>
      <div className="stack">
        <div className="row wrap">
          <button className="btn tiny primary" disabled={!!step} onClick={gather}>
            {list.some((item) => item.auto) ? "Raccogli di nuovo" : "Raccogli le prove"}
          </button>
          <button
            className="btn tiny"
            disabled={!list.length}
            onClick={() => {
              void exportDossier(engine, expedition, row)
                .then(() => addNote("sistema", `Fascicolo esportato: ${row.name}`, `${count("a favore")} a favore, ${count("contro")} contro, ${count("neutra")} neutre.`, { instrument: "fascicolo" }))
                .catch((e: Error) => toast(e.message));
            }}
          >
            Rapporto esportabile
          </button>
          {step && <span className="small mono">{step}</span>}
        </div>
        {list.map((item) => (
          <div key={item.id} className={`evidence ${item.stance === "a favore" ? "pro" : item.stance === "contro" ? "con" : ""}`}>
            <select
              value={item.stance}
              aria-label="Posizione della prova"
              onChange={(e) => update({ evidence: list.map((other) => (other.id === item.id ? { ...other, stance: e.target.value as EvidenceStance, auto: false } : other)) })}
            >
              {STANCES.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <p className="small grow">
              <b>{item.source}.</b> {item.text}
            </p>
            {item.photo && <img src={item.photo} alt="" className="study-thumb" />}
            <button className="btn tiny" aria-label="Togli questa prova" onClick={() => update({ evidence: list.filter((other) => other.id !== item.id) })}>
              ×
            </button>
          </div>
        ))}
        {(row.skipped?.length ?? 0) > 0 && (
          <div className="small muted">
            Non provato:
            <ul>
              {row.skipped!.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!manual.trim()) return;
            update({ evidence: [...list, { id: nid(), stance, source: "Esploratore", text: manual.trim(), created: new Date().toISOString(), auto: false }] });
            setManual("");
          }}
        >
          <select value={stance} aria-label="Posizione della prova" style={{ width: "auto", flex: "0 0 auto" }} onChange={(e) => setStance(e.target.value as EvidenceStance)}>
            {STANCES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <input type="text" className="grow" placeholder="Aggiungi una prova tua: una fonte, un'osservazione…" aria-label="Nuova prova" value={manual} onChange={(e) => setManual(e.target.value)} />
          <button className="btn tiny">Aggiungi</button>
        </form>
        <textarea rows={2} placeholder="La tua conclusione, per il rapporto. Sestante non ne scrive una al posto tuo." aria-label="Conclusione" value={row.conclusion ?? ""} onChange={(e) => update({ conclusion: e.target.value })} />
      </div>
    </details>
  );
}

const ROUTE_COLORS = ["#ffb54a", "#7cc4ff", "#c6e27a", "#f08fb0"];

/** Paths of least effort on the land, and who can see whom: two classic questions asked of a real relief. */
export function AncientRoutes(props: LabProps) {
  const { engine, expedition, onRoutes, onSights, onDrape, onSection, onTab, addNote, toast } = props;
  const sites = useMemo(() => sitesOf(engine, expedition), [engine, expedition.pins, expedition.hypotheses, expedition.investigation]);
  const here = { id: "tu", name: "Dove sei ora", x: engine.pos.x, z: engine.pos.z };
  const choices = [here, ...sites];
  const [from, setFrom] = useState("tu");
  const [to, setTo] = useState(sites[0]?.id ?? "");
  const [mode, setMode] = useState<RouteMode>("piedi");
  const [water, setWater] = useState<WaterRule>("guado");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<SightLine[] | null>(null);
  const routes = expedition.routes ?? [];

  const compute = () => {
    const a = choices.find((row) => row.id === from);
    const b = choices.find((row) => row.id === to);
    if (!a || !b || a.id === b.id) return toast("Scegli due punti diversi.");
    setBusy(true);
    // The grid search takes a moment: let the button show it first.
    setTimeout(() => {
      try {
        const { grid, origin } = routeGrid(engine, water);
        const route = leastCostRoute(grid, a, b, origin, mode);
        if (!route) {
          toast("Nessun percorso: l'acqua chiude ogni passaggio. Prova con i guadi.");
          return;
        }
        const row: SavedRoute = {
          id: nid(),
          name: `${a.name} → ${b.name}`,
          created: new Date().toISOString(),
          mode,
          water,
          points: route.points,
          seconds: route.seconds,
          length: route.length,
          ascent: route.ascent,
          descent: route.descent,
          straight: route.straight,
          straightSeconds: route.straightSeconds,
          corridorShare: route.corridorShare,
          color: ROUTE_COLORS[routes.length % ROUTE_COLORS.length]!,
        };
        onRoutes([...routes, row]);
        const corridor = corridorCanvas(route.corridor, grid.size, grid.spacing, origin, engine);
        engine.setDrape(corridor, 1);
        onDrape({ label: `Corridoio: ${row.name}`, canvas: corridor, source: "Calcolo sul rilievo in uso" });
        addNote("misura", `Via: ${row.name}`, `${ROUTE_MODES[mode].label}, ${formatDuration(route.seconds)} su ${(route.length / 1000).toFixed(2)} km, salita ${route.ascent.toFixed(0)} m. È il percorso di minor fatica sul rilievo di oggi: un'ipotesi, non una strada documentata.`, { instrument: "vie antiche", values: { tempo: formatDuration(route.seconds), lunghezza: `${(route.length / 1000).toFixed(2)} km`, salita: `${route.ascent.toFixed(0)} m`, discesa: `${route.descent.toFixed(0)} m` } });
      } finally {
        setBusy(false);
      }
    }, 30);
  };

  const sights = () => {
    if (sites.length < 2) return toast("Servono almeno due siti: pianta dei picchetti o apri un'ipotesi.");
    const chosen = sites.slice(0, 16);
    // Monuments a few steps apart say nothing about the land between them.
    const rows = sightLines(chosen, engine.heightAt, engine.settings.eye).filter((row) => row.distance > 50);
    setLines(rows);
    const at = (id: string) => chosen.find((row) => row.id === id)!;
    onSights(rows.filter((row) => row.visible).map((row) => ({ a: at(row.a), b: at(row.b), visible: true })));
  };
  const nameOf = (id: string) => sites.find((row) => row.id === id)?.name ?? id;

  return (
    <>
      <p className="hint">Il metodo classico dell'archeologia del paesaggio: quale strada richiede meno fatica fra due punti? Il risultato è un'ipotesi da confrontare con ciò che si trova sul terreno, non la prova di una strada. Il rilievo è quello di oggi, con le sue cave e i suoi terrapieni, e i fiumi possono essersi spostati. Bastano due picchetti, un'ipotesi o un sito storico della mappa.</p>
      <div className="row wrap">
        <label className="field grow">
          Da
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {choices.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          A
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Scegli…</option>
            {choices.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Chi cammina
          <select value={mode} onChange={(e) => setMode(e.target.value as RouteMode)}>
            {(Object.keys(ROUTE_MODES) as RouteMode[]).map((key) => (
              <option key={key} value={key}>
                {ROUTE_MODES[key].label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Acqua
          <select value={water} onChange={(e) => setWater(e.target.value as WaterRule)}>
            {(Object.keys(WATER_RULES) as WaterRule[]).map((key) => (
              <option key={key} value={key}>
                {WATER_RULES[key]}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={busy || !to} onClick={compute}>
          {busy ? "Calcolo…" : "Traccia la via"}
        </button>
      </div>
      <p className="small muted">{ROUTE_MODES[mode].note}.</p>
      {routes.map((row) => (
        <article key={row.id} className="entry-dark stack">
          <div className="row wrap">
            <span className="route-swatch" style={{ background: row.color }} aria-hidden />
            <b className="grow">{row.name}</b>
            <button
              className="btn tiny"
              onClick={() => {
                onSection(row.points);
                onTab("sezione");
              }}
            >
              Profilo
            </button>
            <button className="btn tiny" onClick={() => onRoutes(routes.filter((item) => item.id !== row.id))}>
              Togli
            </button>
          </div>
          <dl className="kv">
            <dt>Chi cammina</dt>
            <dd>{ROUTE_MODES[row.mode].label}</dd>
            <dt>Tempo</dt>
            <dd>{formatDuration(row.seconds)}</dd>
            <dt>Lunghezza</dt>
            <dd>
              {(row.length / 1000).toFixed(2)} km, contro {(row.straight / 1000).toFixed(2)} km in linea retta
            </dd>
            <dt>Dislivelli</dt>
            <dd>
              +{row.ascent.toFixed(0)} m, −{row.descent.toFixed(0)} m
            </dd>
            <dt>Sulla retta</dt>
            <dd>{row.straightSeconds == null ? "Attraversa acqua invalicabile" : `${formatDuration(row.straightSeconds)}: la deviazione ${row.straightSeconds > row.seconds * 1.02 ? `fa risparmiare ${formatDuration(row.straightSeconds - row.seconds)}` : "non fa guadagnare quasi nulla"}`}</dd>
            <dt>Corridoio</dt>
            <dd>{row.corridorShare < 0.06 ? `Stretto, ${(row.corridorShare * 100).toFixed(0)}% dell'area: la terra lascia poca scelta, e la via è un'ipotesi più solida` : `Largo, ${(row.corridorShare * 100).toFixed(0)}% dell'area: molte strade costano quasi uguale, e il tracciato esatto vale poco`}</dd>
          </dl>
        </article>
      ))}
      <div>
        <div className="section-title">Chi vede chi</div>
        <p className="hint">Da occhi all'altezza del tuo alter-ego, sul terreno senza gli edifici di oggi. Un margine di pochi metri può cambiare la risposta: il rilievo ha i suoi errori e la vegetazione di allora non si conosce.</p>
        <button className="btn tiny" disabled={sites.length < 2} onClick={sights}>
          Controlla la visibilità fra {Math.min(16, sites.length)} siti
        </button>
        {lines && (
          <table className="data">
            <thead>
              <tr>
                <th>Fra</th>
                <th>E</th>
                <th>Distanza</th>
                <th>Vista</th>
                <th>Margine</th>
              </tr>
            </thead>
            <tbody>
              {lines.slice(0, 40).map((row) => (
                <tr key={`${row.a}-${row.b}`}>
                  <td>{nameOf(row.a)}</td>
                  <td>{nameOf(row.b)}</td>
                  <td>{(row.distance / 1000).toFixed(2)} km</td>
                  <td>{row.visible ? "Sì" : "No"}</td>
                  <td>{row.clearance.toFixed(1)} m</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** National airborne surveys: where they exist, the ground itself with the trees taken off. */
export function LidarTab(props: LabProps) {
  const { engine, expedition, onDrape, onLidarReport, onUseLidarTerrain, addNote, toast } = props;
  const [offers, setOffers] = useState<LidarOffer[] | null>(null);
  const [busy, setBusy] = useState("");
  const [radius, setRadius] = useState(15);
  const report = expedition.lidarReport ?? null;
  useEffect(() => {
    let live = true;
    api
      .lidarCoverage(engine.data.spec.bbox)
      .then((rows) => live && setOffers(rows))
      .catch(() => live && setOffers([]));
    return () => {
      live = false;
    };
  }, [engine]);
  const usable = (offers ?? []).filter((row) => row.share > 0.3);
  const offer = usable[0] ?? null;
  const work = (label: string, job: () => Promise<void>) => {
    setBusy(label);
    job()
      .catch((e: Error) => toast(e.message))
      .finally(() => setBusy(""));
  };
  return (
    <>
      <p className="hint">Un laser da aereo misura il suolo anche sotto gli alberi, a circa un metro. Rende visibili terrapieni, fossati e tracciati antichi che nessuna foto mostra, e dà altezze vere agli edifici. Esiste solo dove un paese lo ha pubblicato: Paesi Bassi, Francia, Inghilterra, Svizzera, Fiandre, Renania Settentrionale-Vestfalia, Polonia e Stati Uniti, con copertura a volte incompleta. In Italia il portale nazionale permette di scaricare solo il modello a 20 m, e l'1 m si può soltanto guardare.</p>
      {offers === null && <p className="small mono">Chiedo chi copre questo riquadro…</p>}
      {offers !== null && !usable.length && <p className="warn small">Nessun rilievo aperto copre questo riquadro. Restano Copernicus e NASADEM, a 30 m.</p>}
      {(offers ?? []).filter((row) => row.error || row.share > 0.3).map((row) => (
        <div key={row.id} className="row small">
          <span className="grow">
            <b>{row.name}</b>, {row.country}, {row.resolution} m. {row.license}.{" "}
            {row.error ? `Non risponde: ${row.error}.` : `Copre il centro del riquadro${row.surface ? ", con edifici e chiome" : ", solo il suolo"}.`}
          </span>
          <a href={row.url} target="_blank" rel="noreferrer">
            Fonte
          </a>
        </div>
      ))}
      {offer && (
        <>
          <div className="row wrap">
            <button
              className="btn tiny primary"
              disabled={!!busy}
              onClick={() =>
                work("Scarico il suolo…", async () => {
                  const grid = await bareGround(engine, offer);
                  const canvas = shadedCanvas(grid);
                  engine.setDrape(canvas, 0.92);
                  onDrape({ label: "Suolo in rilievo ombreggiato", canvas, source: offer.name });
                })
              }
            >
              Suolo ombreggiato
            </button>
            <button
              className="btn tiny primary"
              disabled={!!busy}
              onClick={() =>
                work("Scarico il suolo…", async () => {
                  const grid = await bareGround(engine, offer);
                  const canvas = reliefCanvas(grid, radius);
                  engine.setDrape(canvas, 0.92);
                  onDrape({ label: `Rilievo locale entro ${radius} m`, canvas, source: offer.name });
                })
              }
            >
              Rilievo locale
            </button>
            <label className="field travel-slider">
              Tracce larghe fino a {radius} m
              <input type="range" min={5} max={60} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
            </label>
            <button
              className="btn tiny"
              onClick={() => {
                engine.setDrape(null);
                onDrape(null);
              }}
            >
              Togli lo strato
            </button>
            {busy && <span className="small mono">{busy}</span>}
          </div>
          <p className="small muted">Rilievo locale: azzurro sopra i dintorni, arancio sotto, colore pieno a un metro. Toglie la forma generale del terreno e lascia le piccole forme.</p>
          <div className="row wrap">
            <button
              className="btn tiny"
              disabled={!!busy || !offer.surface}
              title={offer.surface ? undefined : "Questo rilievo non pubblica la superficie con gli edifici."}
              onClick={() =>
                work("Misuro gli edifici…", async () => {
                  const row = await applyLidar(engine, offer);
                  onLidarReport(row);
                  addNote("sistema", `Il LiDAR ha fissato ${row.changed} altezze`, `${row.name}: ${row.seen} edifici visti. Le altezze scritte sulla mappa restano, per poterle confrontare.`, { instrument: "LiDAR" });
                })
              }
            >
              Altezze degli edifici dal laser
            </button>
            <button className="btn tiny" onClick={onUseLidarTerrain}>
              Usalo come terreno del mondo
            </button>
          </div>
          {!offer.surface && <p className="small muted">{offer.name} pubblica solo il suolo: niente altezze degli edifici.</p>}
        </>
      )}
      {report && (
        <div>
          <div className="section-title">Altezze dal rilievo: {report.name}</div>
          <p className="small">
            {report.seen} edifici misurati, {report.changed} altezze sostituite. Le altezze scritte sulla mappa non vengono toccate.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Altezza di prima</th>
                <th>Edifici</th>
                <th>Scarto tipico dal laser</th>
                <th>Tendenza</th>
              </tr>
            </thead>
            <tbody>
              {report.bySource.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>{row.n}</td>
                  <td>{row.typical.toFixed(1)} m</td>
                  <td>{row.bias > 0 ? "+" : ""}{row.bias.toFixed(1)} m</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="section-title">I più alti</div>
          <table className="data">
            <tbody>
              {report.tallest.map((row, index) => (
                <tr key={index}>
                  <td>{row.name}</td>
                  <td>{row.measured.toFixed(1)} m dal laser</td>
                  <td>{row.mapped.toFixed(1)} m prima, {row.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Il laser vola in una sua data e con punti distanti forse un metro: una guglia sottile può risultare più bassa del vero.</p>
        </div>
      )}
    </>
  );
}
