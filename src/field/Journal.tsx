import { useMemo, useState } from "react";
import { formatLatLon } from "../core/geo.ts";
import type { Expedition, Note, NoteKind } from "../core/types.ts";
import { geoJson, notesCsv, saveFile } from "./exports.ts";

const KIND_LABEL: Record<NoteKind, string> = {
  manuale: "a mano",
  foto: "foto",
  misura: "misura",
  strumento: "strumento",
  confronto: "confronto",
  tappa: "tappa",
  sistema: "campo",
};

const download = saveFile;

async function inlineImage(url: string) {
  const blob = await (await fetch(url)).blob();
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function exportHtml(expedition: Expedition) {
  const rows: string[] = [];
  for (const note of [...expedition.notes].reverse()) {
    const images = await Promise.all([note.photo, ...(note.attachments ?? [])].filter(Boolean).map((url) => inlineImage(url!).catch(() => "")));
    rows.push(`<article><h3>${esc(note.title)}</h3><p class="w">${esc(note.simTime)} · ${esc(formatLatLon(note.lat, note.lon))} · quota ${note.elev.toFixed(1)} m · azimut ${note.heading.toFixed(0)}° · ${esc(note.plate)}${note.weather ? ` · ${esc(note.weather)}` : ""}</p><p>${esc(note.text)}</p>${note.values ? `<p class="v">${Object.entries(note.values).map(([k, v]) => `<b>${esc(k)}</b> ${esc(v)}`).join(" · ")}</p>` : ""}${images.filter(Boolean).map((src) => `<img src="${src}">`).join("")}</article>`);
  }
  const html = `<!doctype html><html lang="it"><meta charset="utf-8"><title>Registro: ${esc(expedition.spec.name)}</title><style>body{font:16px/1.5 Georgia,serif;max-width:780px;margin:40px auto;padding:0 16px;background:#eae2cf;color:#3c3425}h1{font-size:34px}h3{margin:0}article{border-bottom:1px solid #cfc3a6;padding:14px 0}.w{font:12px monospace;color:#6d6249;margin:2px 0}.v{font:13px monospace}img{max-width:100%;margin-top:8px;border:6px solid #f6f0e0}</style><h1>Registro di esplorazione</h1><h2>${esc(expedition.spec.name)}</h2>${rows.join("")}</html>`;
  download(`registro-${expedition.spec.id}.html`, html, "text/html");
}

export function JournalPanel({
  expedition,
  onAdd,
  onDelete,
  onAttach,
  onClose,
  toLatLon,
  onGoTo,
}: {
  expedition: Expedition;
  onAdd: (title: string, text: string, files: File[], tags: string[]) => void;
  onDelete: (id: string) => void;
  onAttach: (id: string, file: File) => void;
  onClose: () => void;
  toLatLon: (x: number, z: number) => { lat: number; lon: number };
  onGoTo: (lat: number, lon: number) => void;
}) {
  const [filter, setFilter] = useState<NoteKind | "tutte">("tutte");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const notes = useMemo(() => {
    const needle = search.toLowerCase();
    return expedition.notes.filter((note) => (filter === "tutte" || note.kind === filter) && (!needle || `${note.title} ${note.text} ${note.instrument ?? ""}`.toLowerCase().includes(needle)));
  }, [expedition.notes, filter, search]);

  const submit = () => {
    if (!title.trim() && !text.trim() && !files.length) return;
    onAdd(title.trim() || "Annotazione", text.trim(), files, []);
    setTitle("");
    setText("");
    setFiles([]);
  };

  return (
    <div className="panel wide journal" onClick={(e) => e.stopPropagation()}>
      <header className="panel-head">
        <h2 className="grow">Registro di esplorazione</h2>
        <span className="muted small mono">{expedition.notes.length} annotazioni</span>
        <button className="btn tiny" onClick={() => void exportHtml(expedition)}>
          Esporta HTML
        </button>
        <button className="btn tiny" onClick={() => download(`registro-${expedition.spec.id}.geojson`, geoJson(expedition, toLatLon), "application/geo+json")}>
          GeoJSON
        </button>
        <button className="btn tiny" onClick={() => download(`registro-${expedition.spec.id}.csv`, notesCsv(expedition), "text/csv")}>
          CSV
        </button>
        <button className="btn tiny" onClick={onClose}>
          Chiudi (J)
        </button>
      </header>
      <div className="panel-body" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) 1fr", gap: 18 }}>
        <div className="stack">
          <h4>Scrivi</h4>
          <input type="text" placeholder="Titolo" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea rows={7} placeholder="Cosa vedi, cosa pensi, cosa controllare…" value={text} onChange={(e) => setText(e.target.value)} />
          <input type="file" accept="image/*" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          <button className="btn primary" onClick={submit}>
            Annota qui
          </button>
          <p className="small muted">La nota prende posizione, ora, azimut, meteo e lastra del momento. Le misure degli strumenti si scrivono da sole.</p>
          <h4 style={{ marginTop: 10 }}>Sfoglia</h4>
          <input type="text" placeholder="Cerca nel registro" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="row wrap">
            {(["tutte", "manuale", "foto", "misura", "strumento", "confronto", "tappa", "sistema"] as const).map((kind) => (
              <button key={kind} className={`btn tiny ${filter === kind ? "on" : ""}`} onClick={() => setFilter(kind)}>
                {kind === "tutte" ? "tutte" : KIND_LABEL[kind]}
              </button>
            ))}
          </div>
        </div>
        <div>
          {notes.length === 0 && <p className="muted">Ancora nessuna annotazione con questi criteri.</p>}
          {notes.map((note) => (
            <NoteEntry key={note.id} note={note} onDelete={onDelete} onAttach={onAttach} onGoTo={onGoTo} />
          ))}
        </div>
      </div>
    </div>
  );
}

function NoteEntry({ note, onDelete, onAttach, onGoTo }: { note: Note; onDelete: (id: string) => void; onAttach: (id: string, file: File) => void; onGoTo: (lat: number, lon: number) => void }) {
  return (
    <article className="entry">
      <header>
        <span className="stamp">{note.instrument ?? KIND_LABEL[note.kind]}</span>
        <h4>{note.title}</h4>
        <span className="when">{note.simTime}</span>
      </header>
      {note.text && <p>{note.text}</p>}
      {note.values && Object.keys(note.values).length > 0 && (
        <div className="values">
          {Object.entries(note.values).map(([key, value]) => (
            <span key={key}>
              <b>{key}</b> {value}
            </span>
          ))}
        </div>
      )}
      {note.photo && <img src={note.photo} alt={note.title} loading="lazy" />}
      {note.attachments?.map((url) => <img key={url} src={url} alt="" loading="lazy" />)}
      <div className="where">
        {formatLatLon(note.lat, note.lon)} · {note.elev.toFixed(1)} m · {note.heading.toFixed(0)}° · {note.plate}
        {note.weather ? ` · ${note.weather}` : ""}
      </div>
      <div className="row" style={{ marginTop: 5 }}>
        <button className="btn tiny" onClick={() => onGoTo(note.lat, note.lon)}>
          Torna qui
        </button>
        <label className="btn tiny">
          Allega foto
          <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && onAttach(note.id, e.target.files[0])} />
        </label>
        <button className="btn tiny" onClick={() => onDelete(note.id)}>
          Elimina
        </button>
      </div>
    </article>
  );
}
