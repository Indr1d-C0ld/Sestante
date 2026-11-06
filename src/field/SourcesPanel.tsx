import { useEffect, useMemo, useState } from "react";
import { api, type PlaceArticle, type PlacePhoto } from "../core/api.ts";
import { compassName, type Bbox, type Projection } from "../core/geo.ts";
import type { Note, NoteKind, PhotoPlacement } from "../core/types.ts";
import type { Engine } from "../world/engine.ts";

type Props = {
  engine: Engine;
  bbox: Bbox;
  projection: Projection;
  self: { x: number; z: number };
  placement: PhotoPlacement | null;
  ghost: { photo: PlacePhoto; opacity: number } | null;
  onGhost: (ghost: { photo: PlacePhoto; opacity: number } | null) => void;
  onPlacement: (placement: PhotoPlacement | null) => void;
  addNote: (kind: NoteKind, title: string, text: string, extra?: Partial<Note>) => void;
  toast: (text: string) => void;
  onClose: () => void;
};

export function SourcesPanel({ engine, bbox, projection, self, placement, ghost, onGhost, onPlacement, addNote, toast, onClose }: Props) {
  const [tab, setTab] = useState<"foto" | "voci">("foto");
  const [photos, setPhotos] = useState<PlacePhoto[] | null>(null);
  const [articles, setArticles] = useState<PlaceArticle[] | null>(null);
  const [filter, setFilter] = useState<"tutte" | "panoramax" | "commons">("tutte");
  const [error, setError] = useState("");
  useEffect(() => {
    // Each catalogue arrives on its own time: Commons can stay busy for many seconds while Panoramax is already here.
    for (const source of ["panoramax", "commons"] as const) {
      api
        .photos(bbox, source)
        .then((rows) => setPhotos((current) => [...(current ?? []), ...rows]))
        .catch((e: Error) => {
          setPhotos((current) => current ?? []);
          setError(`${source}: ${e.message}`);
        });
    }
    const radius = Math.hypot(projection.halfX, projection.halfZ) + 400;
    api.articles(projection.lat0, projection.lon0, radius).then(setArticles).catch(() => setArticles([]));
  }, []);
  const near = useMemo(
    () =>
      (photos ?? [])
        .filter((row) => filter === "tutte" || row.source === filter)
        .map((row) => {
          const local = projection.toLocal(row.lat, row.lon);
          return { row, ...local, d: Math.hypot(local.x - self.x, local.z - self.z) };
        })
        .sort((a, b) => a.d - b.d),
    [photos, filter],
  );
  const counts = useMemo(() => ({ panoramax: (photos ?? []).filter((row) => row.source === "panoramax").length, commons: (photos ?? []).filter((row) => row.source === "commons").length }), [photos]);
  const standThere = (row: PlacePhoto) => {
    const { x, z } = projection.toLocal(row.lat, row.lon);
    engine.teleport(x, z);
    if (row.heading != null) engine.yaw = (-row.heading * Math.PI) / 180;
    engine.pitch = 0;
    toast(`Sei dove fu scattata: ${row.date ?? "data ignota"}.`);
  };
  const project = (row: PlacePhoto) => {
    const { x, z } = projection.toLocal(row.lat, row.lon);
    const snap = engine.snapshot();
    const next: PhotoPlacement = {
      photoId: row.id,
      title: row.title,
      url: api.photoUrl(row.full),
      x,
      y: engine.heightAt(x, z) + 2,
      z,
      azimuth: row.heading ?? snap.heading,
      fov: row.fov && row.fov < 180 ? row.fov : 65,
      pano: row.pano,
      mix: 1,
      range: row.pano ? 40 : 60,
    };
    onPlacement(next);
    addNote("foto", "Foto proiettata sul mondo", `${row.source === "panoramax" ? "Panoramax" : "Wikimedia Commons"}, ${row.date ?? "data ignota"}, autore ${row.author}, licenza ${row.license}.`, { instrument: "proiettore", attachments: [api.photoUrl(row.thumb)], values: { azimut: `${next.azimuth.toFixed(0)}°`, distanza: `${Math.hypot(x - self.x, z - self.z).toFixed(0)} m` } });
  };
  const adjust = (change: Partial<PhotoPlacement>) => placement && onPlacement({ ...placement, ...change });
  return (
    <div className="panel wide" onClick={(e) => e.stopPropagation()}>
      <header className="panel-head">
        <h2 className="grow">Fonti del luogo</h2>
        <button className="btn tiny" onClick={onClose}>
          Chiudi (P)
        </button>
      </header>
      <div className="tabs">
        <button className={tab === "foto" ? "on" : ""} onClick={() => setTab("foto")}>
          Fotografie{photos ? ` (${photos.length})` : ""}
        </button>
        <button className={tab === "voci" ? "on" : ""} onClick={() => setTab("voci")}>
          Voci{articles ? ` (${articles.length})` : ""}
        </button>
      </div>
      <div className="panel-body stack">
        {error && <p className="small warn">{error}</p>}
        {tab === "foto" && (
          <>
            <p className="hint">Foto vere prese in questo riquadro, dalla più vicina a te. Puoi metterti dove furono scattate, sovrapporle alla vista oppure proiettarle sul mondo: i muri prendono l'immagine come sotto un proiettore, senza calcolare chi copre cosa. L'allineamento dipende dal GPS di chi ha scattato, quindi va ritoccato a mano.</p>
            {placement && (
              <div className="callout stack">
                <b>Proiezione attiva: {placement.title}</b>
                <div className="row wrap">
                  <label className="field">
                    Azimut {placement.azimuth.toFixed(0)}°
                    <input type="range" min={0} max={359} step={1} value={placement.azimuth} onChange={(e) => adjust({ azimuth: Number(e.target.value) })} />
                  </label>
                  {!placement.pano && (
                    <label className="field">
                      Campo {placement.fov.toFixed(0)}°
                      <input type="range" min={20} max={120} step={1} value={placement.fov} onChange={(e) => adjust({ fov: Number(e.target.value) })} />
                    </label>
                  )}
                  <label className="field">
                    Forza
                    <input type="range" min={0.1} max={1} step={0.05} value={placement.mix} onChange={(e) => adjust({ mix: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    Portata {placement.range.toFixed(0)} m
                    <input type="range" min={10} max={200} step={5} value={placement.range} onChange={(e) => adjust({ range: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    Altezza {placement.y.toFixed(1)} m
                    <input type="range" min={engine.heightAt(placement.x, placement.z) - 2} max={engine.heightAt(placement.x, placement.z) + 12} step={0.1} value={placement.y} onChange={(e) => adjust({ y: Number(e.target.value) })} />
                  </label>
                  <button className="btn tiny" onClick={() => adjust({ azimuth: engine.snapshot().heading })}>
                    Usa il mio azimut
                  </button>
                  <button className="btn tiny" onClick={() => onPlacement(null)}>
                    Spegni
                  </button>
                </div>
              </div>
            )}
            {ghost && (
              <div className="callout row wrap">
                <b className="grow">Sovrapposta alla vista</b>
                <label className="field">
                  Trasparenza
                  <input type="range" min={0.1} max={1} step={0.05} value={ghost.opacity} onChange={(e) => onGhost({ ...ghost, opacity: Number(e.target.value) })} />
                </label>
                <button className="btn tiny" onClick={() => onGhost(null)}>
                  Togli
                </button>
              </div>
            )}
            <div className="chips">
              {(
                [
                  ["tutte", "Tutte"],
                  ["panoramax", `Panoramax (${counts.panoramax})`],
                  ["commons", `Commons (${counts.commons})`],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className={`btn tiny ${filter === id ? "on" : ""}`} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
            {!photos && !error && <p className="mono small">Interrogo Panoramax e Wikimedia Commons…</p>}
            {photos && !near.length && <p className="hint">Nessuna foto georiferita in questo riquadro.</p>}
            <div className="photo-grid">
              {near.slice(0, 60).map(({ row, d }) => (
                <article key={row.id} className="photo-card">
                  <img src={api.photoUrl(row.thumb)} alt={row.title} loading="lazy" />
                  <div className="stack" style={{ gap: 3 }}>
                    <b className="small" title={row.title}>
                      {row.title.length > 52 ? `${row.title.slice(0, 50)}…` : row.title}
                    </b>
                    <span className="small mono muted">
                      {d.toFixed(0)} m · {row.date ?? "data ignota"}
                      {row.pano ? " · 360°" : ""}
                      {row.heading != null ? ` · ${row.heading.toFixed(0)}° ${compassName(row.heading)}` : ""}
                    </span>
                    <span className="small muted">
                      {row.author.slice(0, 40)} · {row.license}
                    </span>
                    <div className="row wrap">
                      <button className="btn tiny" onClick={() => standThere(row)}>
                        Mettiti lì
                      </button>
                      <button className="btn tiny" onClick={() => onGhost({ photo: row, opacity: 0.6 })}>
                        Sovrapponi
                      </button>
                      <button className="btn tiny" onClick={() => project(row)}>
                        Proietta
                      </button>
                      <a className="btn tiny" href={row.link} target="_blank" rel="noreferrer">
                        Fonte
                      </a>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        {tab === "voci" && (
          <>
            {!articles && <p className="mono small">Interrogo Wikipedia…</p>}
            {articles?.map((row) => {
              const local = projection.toLocal(row.lat, row.lon);
              const d = Math.hypot(local.x - self.x, local.z - self.z);
              return (
                <article key={row.id} className="entry-dark">
                  <div className="row">
                    <b className="grow">{row.title}</b>
                    <span className="small mono muted">
                      {row.lang} · {d.toFixed(0)} m
                    </span>
                  </div>
                  <p className="small" style={{ margin: "4px 0" }}>
                    {row.text}
                  </p>
                  <div className="row wrap">
                    <button
                      className="btn tiny"
                      onClick={() => {
                        engine.teleport(local.x, local.z);
                        onClose();
                      }}
                    >
                      Vai lì
                    </button>
                    <button className="btn tiny" onClick={() => addNote("manuale", row.title, row.text, { instrument: "Wikipedia", values: { fonte: row.link } })}>
                      Annota
                    </button>
                    <a className="btn tiny" href={row.link} target="_blank" rel="noreferrer">
                      Leggi
                    </a>
                  </div>
                </article>
              );
            })}
            {articles && !articles.length && <p className="hint">Nessuna voce georiferita qui vicino, oppure Wikipedia è occupata: riprova tra poco.</p>}
            <p className="small muted">Testi di Wikipedia, licenza CC BY-SA: sono un punto di partenza, non una verifica.</p>
          </>
        )}
      </div>
    </div>
  );
}
