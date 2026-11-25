import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LidarOffer } from "../core/api.ts";
import { plateKey, type PlateLean } from "../core/types.ts";
import { describeLean, leanFrom } from "../vision/lean.ts";
import type { LabProps } from "./LabPanel.tsx";
import { measureLean } from "./lidarTools.ts";

const SPAN = 160;

/**
 * The satellite's lean. Roofs are drawn where the plate shows them, which on a leaning satellite is shifted by their
 * height; walls facing the satellite show in the plate too. Measured on a laser survey where one exists, set by hand
 * against the roof outlines elsewhere, and always said which.
 */
export function LeanTab(props: LabProps) {
  const { engine, expedition, onLean, toast, addNote } = props;
  const saved = expedition.lean && expedition.lean.plate === plateKey(engine.data.plate.ref) ? expedition.lean : null;
  const start = describeLean(saved ?? { x: 0, z: 0 });
  const [tilt, setTilt] = useState(start.tilt);
  const [toward, setToward] = useState(start.toward);
  const [offers, setOffers] = useState<LidarOffer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ref = engine.data.plate.ref;
  const capture = ref.kind === "tiles" ? null : ref.capture;
  const aerial = capture?.accuracy != null && capture.accuracy <= 1;

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
  const offer = (offers ?? []).find((row) => row.share > 0.5 && row.surface) ?? null;

  /** The plate around the explorer, with every roof outline drawn where this lean puts it. */
  const draw = useCallback(() => {
    const out = canvas.current;
    if (!out) return;
    const ctx = out.getContext("2d")!;
    const plate = engine.plate.canvas;
    const p = engine.data.projection;
    const toPx = (x: number, z: number) => [((x + p.halfX) / (p.halfX * 2)) * plate.width, ((z + p.halfZ) / (p.halfZ * 2)) * plate.height] as const;
    const [cx, cz] = toPx(engine.pos.x, engine.pos.z);
    const half = (SPAN / (p.halfX * 2)) * plate.width * 0.5;
    ctx.drawImage(plate, cx - half, cz - half, half * 2, half * 2, 0, 0, out.width, out.height);
    const scale = out.width / (half * 2);
    const lean = leanFrom(tilt, toward);
    ctx.strokeStyle = "#3df0ff";
    ctx.lineWidth = 1.2;
    for (const b of engine.data.buildings) {
      if (b.hidden) continue;
      const ring = b.rings[0]!;
      const eave = Math.max(0, b.height - b.roofHeight);
      ctx.beginPath();
      for (let i = 0; i < ring.length; i += 2) {
        const [x, y] = toPx(ring[i]! + lean.x * eave, ring[i + 1]! + lean.z * eave);
        const sx = (x - (cx - half)) * scale;
        const sy = (y - (cz - half)) * scale;
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.stroke();
    }
    engine.setLean(lean.x, lean.z);
  }, [engine, tilt, toward]);

  useEffect(() => {
    draw();
  }, [draw]);

  const save = (source: PlateLean["source"], detail: string, lean = leanFrom(tilt, toward)) => {
    const row: PlateLean = { x: lean.x, z: lean.z, source, detail, plate: plateKey(ref), at: new Date().toISOString() };
    onLean(row);
    const said = describeLean(lean);
    addNote("strumento", "Inclinazione della ripresa", `${said.tilt.toFixed(1)}° verso ${said.toward.toFixed(0)}°, ${source === "LiDAR" ? `misurata sul rilievo laser: ${detail}` : "regolata a mano sui contorni dei tetti"}. I tetti leggono la foto nel punto in cui il satellite li ha visti.`);
  };

  const fromSurvey = () => {
    if (!offer) return;
    setBusy(true);
    measureLean(engine, offer)
      .then((lean) => {
        if (!lean) return toast("Il rilievo ha troppo pochi bordi in questo riquadro per misurare l'inclinazione.");
        const said = describeLean(lean);
        setTilt(said.tilt);
        setToward(said.toward);
        save("LiDAR", `${offer.name}, ${lean.edges} bordi, allineamento ${((lean.gain - 1) * 100).toFixed(0)}% migliore che senza inclinazione`, lean);
      })
      .catch((e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <p className="hint">
        Un satellite guarda quasi sempre un po' di sbieco: tutto ciò che sta in piedi compare spostato nella foto, tanto più quanto è alto, e i lati rivolti al satellite si vedono. Le ortofoto aeree sono raddrizzate e lo mostrano appena. Con l'inclinazione giusta i tetti leggono la foto nel punto in cui il satellite li ha visti, invece della strada o della facciata accanto.
      </p>
      <p className="small">
        Questa ripresa: {capture?.sensor ?? "fonte senza metadati"}
        {capture?.accuracy != null ? `, precisione dichiarata ${capture.accuracy} m` : ""}.{" "}
        {aerial ? "È un'ortofoto aerea: l'inclinazione di solito è trascurabile." : "Se è una ripresa satellitare, l'inclinazione conta: a Parigi il rilievo laser l'ha misurata in 10°, a Londra in 16°."}
      </p>
      <p className="small">
        {saved ? `In uso: ${describeLean(saved).tilt.toFixed(1)}° verso ${describeLean(saved).toward.toFixed(0)}°, ${saved.source === "LiDAR" ? `misurata sul rilievo (${saved.detail})` : "regolata a mano"}.` : "Nessuna inclinazione salvata: i tetti leggono la foto in verticale."}
      </p>
      <canvas ref={canvas} width={420} height={420} style={{ width: "100%", maxWidth: 420, imageRendering: "pixelated", border: "1px solid var(--line)" }} />
      <p className="small muted">La ripresa per {SPAN} m attorno a te. In azzurro i bordi dei tetti, alla quota della gronda, dove questa inclinazione li mette: sono giusti quando combaciano coi tetti della foto.</p>
      <label className="setting">
        <span>Inclinazione</span>
        <input type="range" min={0} max={30} step={0.5} value={tilt} onChange={(e) => setTilt(Number(e.target.value))} />
        <span className="mono small">{tilt.toFixed(1)}°</span>
      </label>
      <label className="setting">
        <span>I tetti cadono verso</span>
        <input type="range" min={0} max={359} step={1} value={toward} onChange={(e) => setToward(Number(e.target.value))} />
        <span className="mono small">{toward.toFixed(0)}°</span>
      </label>
      <div className="row wrap">
        <button className="btn" onClick={() => save("a mano", "regolata sui contorni dei tetti")}>
          Salva a mano
        </button>
        <button className="btn" disabled={!offer || busy} onClick={fromSurvey}>
          {busy ? "Misuro sul rilievo…" : "Misura sul rilievo LiDAR"}
        </button>
        <button
          className="btn"
          onClick={() => {
            setTilt(0);
            setToward(0);
            onLean(null);
            engine.setLean(0, 0);
          }}
        >
          Azzera
        </button>
      </div>
      {offers !== null && !offer && <p className="small muted">Nessun rilievo con edifici e chiome copre questo riquadro: qui l'inclinazione si regola a mano.</p>}
      <p className="small muted">
        Le facciate restano disegnate: prenderne il colore dalla foto è stato provato, ma una facciata di sei piani occupa pochi pixel e, con gli errori residui di due o tre metri, la lettura finiva spesso sul tetto o sulla strada. Senza rilievo non esiste ancora una stima automatica affidabile: provata sui bordi dei tetti di Parigi e Londra, sbagliava di circa 3 m a 20 m d'altezza, perché uno spostamento della mappa e un'inclinazione si somigliano quando gli edifici sono alti uguali.
      </p>
    </>
  );
}
