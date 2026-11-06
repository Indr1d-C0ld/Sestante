import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ArchiveRow } from "../core/api.ts";
import { formatLatLon } from "../core/geo.ts";
import type { Expedition, FieldSpec } from "../core/types.ts";
import { saveFile } from "../field/exports.ts";

type Props = { onResume: (id: string, study?: string) => void; onStudio: (spec: FieldSpec) => void };

const MEDIA = /\/media\/[\w-]+\/[\w.-]+/g;

const asDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("file illeggibile"));
    reader.readAsDataURL(blob);
  });

/** A whole investigation in one file: its photos travel inside it, so it can be moved or kept without the data folder. */
async function exportPackage(id: string) {
  let text = JSON.stringify(await api.expedition(id));
  for (const url of new Set(text.match(MEDIA) ?? [])) {
    const blob = await (await fetch(url)).blob();
    text = text.split(url).join(await asDataUrl(blob));
  }
  saveFile(`${id}.sestante.json`, text, "application/json");
}

/** Brought back under a new id, so importing twice or over an existing one never overwrites anything. */
async function importPackage(file: File) {
  const value = JSON.parse(await file.text()) as Expedition;
  if (!value.spec?.bbox) throw new Error("Questo file non è un'indagine di Sestante.");
  const id = `imp-${Date.now().toString(36)}`;
  let text = JSON.stringify({ ...value, spec: { ...value.spec, id } });
  for (const url of new Set(text.match(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g) ?? [])) {
    const blob = await (await fetch(url)).blob();
    const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "bin";
    text = text.split(url).join(await api.uploadMedia(id, blob, ext));
  }
  await api.saveExpedition(JSON.parse(text) as Expedition);
  return id;
}

const COUNTS: [keyof ArchiveRow, string, string][] = [
  ["notes", "annotazione", "annotazioni"],
  ["hypotheses", "ipotesi", "ipotesi"],
  ["places", "luogo da vedere", "luoghi da vedere"],
  ["routes", "via", "vie"],
  ["masses", "massa", "masse"],
  ["photoFinds", "foto cercata", "foto cercate"],
];

export function Archive({ onResume, onStudio }: Props) {
  const [rows, setRows] = useState<ArchiveRow[] | null>(null);
  const [trash, setTrash] = useState<{ id: string; name?: string; trashed: string }[]>([]);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"tutte" | "aperta" | "conclusa">("tutte");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => {
    api.expeditions().then(setRows).catch(() => setRows([]));
    api.trash().then(setTrash).catch(() => setTrash([]));
  };
  useEffect(reload, []);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (rows ?? []).filter((row) => (only === "tutte" || row.status === only) && words.every((word) => row.search.includes(word)));
  }, [rows, query, only]);

  const change = async (id: string, edit: (e: Expedition) => Expedition) => {
    await api.saveExpedition(edit(await api.expedition(id)));
    reload();
  };
  const guarded = (work: () => Promise<unknown>) => {
    setProblem("");
    work().catch((e: Error) => setProblem(e.message));
  };

  return (
    <>
      <p className="hint">Ogni indagine resta qui con riprese, registro, ipotesi, vie e studi: la riapri dove l'avevi lasciata. Uno studio è un'inquadratura salvata con il tasto K sul campo, con ora, meteo, scatto e strato.</p>
      <div className="row">
        <input type="text" className="grow" placeholder="Cerca per nome, nota, ipotesi…" aria-label="Cerca nell'archivio" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={only} aria-label="Stato" style={{ flex: "0 0 auto", width: "auto" }} onChange={(e) => setOnly(e.target.value as typeof only)}>
          <option value="tutte">Tutte</option>
          <option value="aperta">Aperte</option>
          <option value="conclusa">Concluse</option>
        </select>
      </div>
      <div className="row">
        <button className="btn tiny" onClick={() => fileRef.current?.click()}>
          Importa un'indagine
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) guarded(() => importPackage(file).then(reload));
          }}
        />
      </div>
      {problem && <p className="hint" style={{ color: "var(--danger)" }}>{problem}</p>}
      {rows === null && <p className="muted small">Apro l'archivio…</p>}
      {rows !== null && !shown.length && <p className="muted">{rows.length ? "Nessuna indagine corrisponde." : "L'archivio è vuoto. Scegli un riquadro, poi salva la ripresa dallo Studio o scendi sul campo."}</p>}
      {shown.map((row) => (
        <article key={row.id} className="archive-card">
          <div className="archive-thumb">{row.thumb ? <img src={row.thumb} alt="" loading="lazy" /> : <span className="muted small">Mai visitata</span>}</div>
          <div className="stack archive-text">
            {editing?.id === row.id ? (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = editing.name.trim();
                  if (name) guarded(() => change(row.id, (value) => ({ ...value, spec: { ...value.spec, name } })));
                  setEditing(null);
                }}
              >
                <input className="grow" autoFocus aria-label="Nuovo nome" value={editing.name} onChange={(e) => setEditing({ id: row.id, name: e.target.value })} />
                <button className="btn tiny">Salva</button>
              </form>
            ) : (
              <b>
                {row.name ?? row.id} {row.status === "conclusa" && <span className="muted small">· conclusa</span>}
              </b>
            )}
            <span className="small muted mono">
              {row.bbox ? formatLatLon((row.bbox.n + row.bbox.s) / 2, (row.bbox.e + row.bbox.w) / 2) : ""} · {row.updated.slice(0, 10)}
              {row.plate ? ` · ${row.plate}` : ""}
            </span>
            <span className="small muted">
              {COUNTS.filter(([key]) => (row[key] as number) > 0)
                .map(([key, one, many]) => `${row[key]} ${row[key] === 1 ? one : many}`)
                .join(" · ") || "Ancora nessuno studio"}
            </span>
            <div className="row wrap">
              <button className="btn tiny primary" onClick={() => onResume(row.id)}>
                Scendi sul campo
              </button>
              <button className="btn tiny" onClick={() => guarded(() => api.expedition(row.id).then((value) => onStudio(value.spec)))}>
                Studio
              </button>
              <button className="btn tiny" onClick={() => setEditing({ id: row.id, name: row.name ?? "" })}>
                Rinomina
              </button>
              <button className="btn tiny" onClick={() => guarded(() => change(row.id, (value) => ({ ...value, status: row.status === "conclusa" ? "aperta" : "conclusa" })))}>
                {row.status === "conclusa" ? "Riapri" : "Concludi"}
              </button>
              <button className="btn tiny" onClick={() => guarded(() => exportPackage(row.id))}>
                Esporta
              </button>
              <button
                className="btn tiny"
                onClick={() => {
                  if (confirm !== row.id) return setConfirm(row.id);
                  setConfirm(null);
                  guarded(() => api.trashExpedition(row.id).then(reload));
                }}
              >
                {confirm === row.id ? "Conferma: nel cestino" : "Cestina"}
              </button>
            </div>
            {row.studies.length > 0 && (
              <div className="archive-studies">
                {row.studies.map((study) => (
                  <button key={study.id} className="archive-study" title={`${study.name}, ${study.created.slice(0, 10)}`} onClick={() => onResume(row.id, study.id)}>
                    {study.photo ? <img src={study.photo} alt="" loading="lazy" /> : null}
                    <span className="small">{study.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </article>
      ))}
      {trash.length > 0 && (
        <div>
          <div className="section-title">Cestino</div>
          <p className="hint">Nulla viene cancellato davvero: resta nella cartella dei dati, sotto "cestino", finché non la svuoti tu.</p>
          {trash.map((row) => (
            <div key={row.id} className="row">
              <span className="grow small">
                {row.name ?? row.id} <span className="muted">· {row.trashed.slice(0, 10)}</span>
              </span>
              <button className="btn tiny" onClick={() => guarded(() => api.restoreExpedition(row.id).then(reload))}>
                Ripristina
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
