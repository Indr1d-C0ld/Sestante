import { useEffect, useRef, useState } from "react";
import { api } from "../core/api.ts";
import { fovFromFocal35, parseExifDate, readExif, type PhotoExif } from "../core/exif.ts";
import { formatLatLon } from "../core/geo.ts";
import type { PhotoFindRow } from "../core/types.ts";
import { extractSkyline, matchSun, searchPhoto, sunFromShadow, type HeightField, type PhotoSearch, type PixelPoint, type Skyline, type SunMatch } from "../vision/horizon.ts";
import type { LabProps } from "./LabPanel.tsx";

type Mode = "linea" | "piede" | "cima" | "ombra";
const LENSES = [25, 40, 55, 70];
const WORKING_WIDTH = 1000;

/** "Where was this taken?": the land's outline against the sky, tried from every spot of the area on an elevation model. */
export function PhotoFind({ engine, expedition, onPlacement, onPhotoFinds, addNote, toast, onClose }: LabProps) {
  const [picture, setPicture] = useState<{ canvas: HTMLCanvasElement; url: string; title: string; exif: PhotoExif } | null>(null);
  const [skyline, setSkyline] = useState<Skyline | null>(null);
  const [mode, setMode] = useState<Mode>("linea");
  const [margin, setMargin] = useState(0);
  const [lens, setLens] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<PhotoSearch | null>(null);
  const [marks, setMarks] = useState<Partial<Record<"piede" | "cima" | "ombra", PixelPoint>>>({});
  const [sun, setSun] = useState<{ altitude: number; azimuth: number; matches: SunMatch[] } | null>(null);
  const stage = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const p = engine.data.projection;

  const load = async (file: File) => {
    setResult(null);
    setSun(null);
    setMarks({});
    setBusy("Leggo la foto…");
    const bytes = await file.arrayBuffer();
    const exif = readExif(bytes);
    const url = await api.uploadMedia(engine.data.spec.id, new Blob([bytes], { type: file.type || "image/jpeg" }), file.type.includes("png") ? "png" : "jpg");
    const bitmap = await createImageBitmap(new Blob([bytes], { type: file.type || "image/jpeg" }));
    const scale = Math.min(1, WORKING_WIDTH / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    setPicture({ canvas, url, title: file.name, exif });
    setLens(exif.focal35 ? fovFromFocal35(exif.focal35) : null);
    setSkyline(extractSkyline(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height));
    setBusy("");
  };

  useEffect(() => {
    const canvas = stage.current;
    if (!canvas || !picture) return;
    canvas.width = picture.canvas.width;
    canvas.height = picture.canvas.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(picture.canvas, 0, 0);
    if (skyline) {
      ctx.strokeStyle = "#ffb54a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      let open = false;
      for (let i = 0; i < skyline.width; i++) {
        if (skyline.confidence[i]! < 0.15) {
          open = false;
          continue;
        }
        if (open) ctx.lineTo(i, skyline.y[i]!);
        else ctx.moveTo(i, skyline.y[i]!);
        open = true;
      }
      ctx.stroke();
    }
    const colours = { piede: "#3987e5", cima: "#199e70", ombra: "#d95926" } as const;
    for (const key of ["piede", "cima", "ombra"] as const) {
      const mark = marks[key];
      if (!mark) continue;
      ctx.fillStyle = colours[key];
      ctx.beginPath();
      ctx.arc(mark.u, mark.v, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [picture, skyline, marks]);

  const toPhoto = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { u: ((e.clientX - box.left) / box.width) * e.currentTarget.width, v: ((e.clientY - box.top) / box.height) * e.currentTarget.height };
  };
  /** A drag redraws the line under the pointer: a roof or a cloud that fooled the reading is quickly corrected by hand. */
  const paint = (point: PixelPoint) => {
    setSkyline((line) => {
      if (!line) return line;
      const y = new Float32Array(line.y);
      const confidence = new Float32Array(line.confidence);
      const reach = Math.round(line.width / 120);
      for (let i = Math.max(0, Math.round(point.u) - reach); i <= Math.min(line.width - 1, Math.round(point.u) + reach); i++) {
        y[i] = point.v;
        confidence[i] = 1;
      }
      return { ...line, y, confidence };
    });
  };

  const search = async () => {
    if (!skyline || !picture) return;
    const halfX = p.halfX + margin;
    const halfZ = p.halfZ + margin;
    // The far ranges make the shape of a skyline: the model reaches well beyond the area searched.
    const reach = Math.max(halfX, halfZ) + 30000;
    const corners = [p.toLatLon(-reach, -reach), p.toLatLon(reach, reach)];
    const box = { n: corners[0]!.lat, w: corners[0]!.lon, s: corners[1]!.lat, e: corners[1]!.lon };
    setBusy("Chiedo il rilievo attorno all'area…");
    setResult(null);
    try {
      const size = 1024;
      const heights = await api.demGrid(box, size, size, "copernicus");
      // Two scales: the far ranges at 60 m, and every 15 m what stands close enough to hide them.
      const nearHalf = Math.max(halfX, halfZ) + 6000;
      const nearSize = Math.min(1024, Math.round((nearHalf * 2) / 15));
      const nearCorners = [p.toLatLon(-nearHalf, -nearHalf), p.toLatLon(nearHalf, nearHalf)];
      const nearHeights = await api.demGrid({ n: nearCorners[0]!.lat, w: nearCorners[0]!.lon, s: nearCorners[1]!.lat, e: nearCorners[1]!.lon }, nearSize, nearSize, "copernicus");
      const field: HeightField = {
        heights,
        size,
        spacing: (reach * 2) / size,
        originX: -reach + reach / size,
        originZ: -reach + reach / size,
        near: { heights: nearHeights, size: nearSize, spacing: (nearHalf * 2) / nearSize, originX: -nearHalf + nearHalf / nearSize, originZ: -nearHalf + nearHalf / nearSize },
      };
      const step = Math.max(field.spacing, (Math.max(halfX, halfZ) * 2) / 36);
      const fovs = lens ? [lens] : LENSES;
      const found = await searchPhoto(field, skyline, { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ }, step, fovs, (share) => setBusy(`Provo ogni punto dell'area: ${(share * 100).toFixed(0)}%`));
      setResult(found);
      const top = found.spots[0];
      const at = top ? p.toLatLon(top.x, top.z) : null;
      const row: PhotoFindRow = {
        id: Date.now().toString(36),
        title: picture.title,
        url: picture.url,
        at: new Date().toISOString(),
        verdict: found.verdict,
        relief: found.relief,
        region: found.region,
        uniqueness: found.uniqueness,
        best: top && at ? { lat: at.lat, lon: at.lon, azimuth: top.azimuth, hfov: top.hfov, rmse: top.rmse } : null,
        exifLat: picture.exif.lat,
        exifLon: picture.exif.lon,
      };
      onPhotoFinds([...(expedition.photoFinds ?? []), row]);
      addNote("misura", `Foto ${picture.title}: ${found.verdict}`, top && at ? `Miglior punto ${formatLatLon(at.lat, at.lon)}, verso ${top.azimuth.toFixed(0)}°, scarto ${top.rmse.toFixed(2)}°, entro circa ${found.region.toFixed(0)} m.` : "L'orizzonte della foto è troppo piatto per riconoscere un luogo.", { instrument: "orizzonte" });
    } catch (e) {
      toast((e as Error).message);
    }
    setBusy("");
  };

  const gpsLocal = picture?.exif.lat != null && picture.exif.lon != null ? p.toLocal(picture.exif.lat, picture.exif.lon) : null;

  const computeSun = () => {
    const top = result?.spots[0];
    if (!picture || !top || !marks.piede || !marks.cima || !marks.ombra) return;
    const row = sunFromShadow(marks.piede, marks.cima, marks.ombra, picture.canvas.width, picture.canvas.height, top.hfov, top.pitch, top.azimuth);
    if (!row) return toast("Con questi tre punti il suolo non torna: il piede e l'ombra devono stare sotto l'orizzonte.");
    const taken = parseExifDate(picture.exif.taken);
    const at = p.toLatLon(top.x, top.z);
    setSun({ ...row, matches: matchSun(row.altitude, row.azimuth, at.lat, at.lon, taken?.getUTCFullYear() ?? new Date().getUTCFullYear(), taken ?? undefined) });
  };

  const VERDICT = { plausibile: "Plausibile", ambiguo: "Ambiguo", impossibile: "Impossibile da dire" } as const;
  return (
    <>
      <p className="hint">Carica una tua foto con il profilo del paesaggio contro il cielo. Sestante legge quella linea e prova da ogni punto dell'area cosa si vedrebbe sul modello del rilievo. Serve un orizzonte di montagne o colline: in città o in pianura il rilievo non basta, e lo dice. È una pista, non una localizzazione: al collaudo su foto reali di Zermatt il punto migliore è caduto da 0,5 a 2,7 km da quello vero, con esito sempre "ambiguo". Il valore sta nella zona e nella direzione, da confermare sovrapponendo la foto al mondo.</p>
      <div className="row wrap">
        <input
          type="file"
          accept="image/*"
          aria-label="Foto da localizzare"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void load(file).catch((error: Error) => (setBusy(""), toast(error.message)));
          }}
        />
        {busy && <span className="small mono">{busy}</span>}
      </div>
      {picture && skyline && (
        <>
          <canvas
            ref={stage}
            className="photo-stage"
            onPointerDown={(e) => {
              const point = toPhoto(e);
              if (mode === "linea") {
                dragging.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                paint(point);
              } else setMarks((rows) => ({ ...rows, [mode]: point }));
            }}
            onPointerMove={(e) => {
              if (dragging.current) paint(toPhoto(e));
            }}
            onPointerUp={() => (dragging.current = false)}
          />
          <p className="small muted">
            In arancio la linea letta. Se è sbagliata, ridisegnala trascinando sulla foto.
            {skyline.quality < 0.35 ? " La lettura è incerta: cielo coperto o foto senza orizzonte netto." : ""}
          </p>
          <dl className="kv">
            <dt>Obiettivo</dt>
            <dd>{picture.exif.focal35 ? `${picture.exif.focal35} mm equivalenti, campo ${lens?.toFixed(0)}°` : lens ? `Campo ${lens}°, indicato da te` : "Ignoto: provo campi da 25° a 70°"}</dd>
            <dt>Data nella foto</dt>
            <dd>{picture.exif.taken ?? "Nessuna"}</dd>
            <dt>GPS nella foto</dt>
            <dd>{picture.exif.lat != null && picture.exif.lon != null ? formatLatLon(picture.exif.lat, picture.exif.lon) : "Nessuno"}</dd>
          </dl>
          <div className="row wrap">
            <label className="field">
              Dove cercare
              <select value={margin} onChange={(e) => setMargin(Number(e.target.value))}>
                <option value={0}>In questo riquadro</option>
                <option value={3000}>Riquadro più 3 km</option>
                <option value={10000}>Riquadro più 10 km</option>
              </select>
            </label>
            {!picture.exif.focal35 && (
              <label className="field">
                Campo visivo orizzontale, se lo sai
                <select value={lens ?? ""} onChange={(e) => setLens(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Non lo so</option>
                  {[10, 15, 20, 25, 30, 40, 50, 55, 60, 65, 70, 75, 85].map((value) => (
                    <option key={value} value={value}>
                      {value}°
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="btn primary" disabled={!!busy} onClick={() => void search()}>
              Dove è stata scattata?
            </button>
          </div>
        </>
      )}
      {result && (
        <div className="stack">
          <div className="section-title">
            {VERDICT[result.verdict]}: la linea varia di {result.relief.toFixed(1)}°
          </div>
          {result.verdict === "impossibile" && <p className="small">Il profilo è troppo piatto: quasi ogni punto vedrebbe la stessa cosa. Serve una foto con rilievi all'orizzonte.</p>}
          {result.verdict === "ambiguo" && <p className="small warn">Il migliore non si stacca dagli altri, o resta troppo lontano dalla linea della foto. Può essere altrove, o punti distanti vedono quasi lo stesso profilo. Considera i risultati come una zona, e controllali sovrapponendo la foto.</p>}
          {result.spots.slice(0, 5).map((row, index) => {
            const at = p.toLatLon(row.x, row.z);
            const inside = Math.abs(row.x) <= p.halfX && Math.abs(row.z) <= p.halfZ;
            return (
              <div key={`${row.x}-${row.z}`} className="row wrap entry-dark">
                <span className="grow small">
                  <b>{index + 1}.</b> {formatLatLon(at.lat, at.lon)} · verso {row.azimuth.toFixed(0)}° · campo {row.hfov.toFixed(0)}° · scarto {row.rmse.toFixed(2)}°
                  {gpsLocal ? ` · ${Math.hypot(row.x - gpsLocal.x, row.z - gpsLocal.z).toFixed(0)} m dal GPS` : ""}
                </span>
                {inside ? (
                  <button
                    className="btn tiny primary"
                    onClick={() => {
                      engine.pos.set(row.x, engine.heightAt(row.x, row.z), row.z);
                      engine.vel.set(0, 0, 0);
                      engine.yaw = -(row.azimuth * Math.PI) / 180;
                      engine.pitch = (row.pitch * Math.PI) / 180;
                      void onPlacement({ photoId: picture!.url, title: picture!.title, url: picture!.url, x: row.x, y: engine.heightAt(row.x, row.z) + 1.7, z: row.z, azimuth: row.azimuth, fov: row.hfov, pano: false, mix: 0.6, range: 400 });
                      onClose();
                    }}
                  >
                    Vai e sovrapponi
                  </button>
                ) : (
                  <span className="small muted">Fuori dal riquadro</span>
                )}
              </div>
            );
          })}
          {result.spots.length > 0 && <p className="small muted">Punti con uno scarto simile arrivano fino a circa {result.region.toFixed(0)} m: è il margine di ciò che il profilo può dire.</p>}
          {result.spots.length > 0 && (
            <div>
              <div className="section-title">E l'ora? Dalle ombre</div>
              <p className="small muted">Scegli un oggetto verticale su suolo piano e segnane il piede, la cima e la punta dell'ombra. Dalla direzione trovata per la foto si risale al Sole.</p>
              <div className="row wrap">
                {(["linea", "piede", "cima", "ombra"] as Mode[]).map((row) => (
                  <button key={row} className={`btn tiny ${mode === row ? "on" : ""}`} onClick={() => setMode(row)}>
                    {row === "linea" ? "Ridisegna la linea" : row === "piede" ? "Piede" : row === "cima" ? "Cima" : "Punta dell'ombra"}
                  </button>
                ))}
                <button className="btn tiny primary" disabled={!marks.piede || !marks.cima || !marks.ombra} onClick={computeSun}>
                  Calcola il Sole
                </button>
              </div>
              {sun && (
                <>
                  <p className="small">
                    Sole alto {sun.altitude.toFixed(1)}°, azimut {sun.azimuth.toFixed(0)}°.{" "}
                    {sun.matches.length ? (picture?.exif.taken ? `Nel giorno scritto nella foto corrisponde a queste ore UTC:` : "Senza data lo stesso Sole torna più volte l'anno, e ogni riga è possibile:") : "Da quel punto il Sole non arriva mai lì: rivedi i tre punti o la direzione."}
                  </p>
                  <ul className="small">
                    {sun.matches.map((row) => (
                      <li key={row.date.getTime()}>
                        {row.date.toISOString().slice(0, 16).replace("T", " ")} UTC, scarto {row.error.toFixed(1)}°
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {(expedition.photoFinds?.length ?? 0) > 0 && (
        <div>
          <div className="section-title">Ricerche di questa indagine</div>
          {expedition.photoFinds!.map((row) => (
            <div key={row.id} className="row small">
              <img src={row.url} alt="" className="study-thumb" />
              <span className="grow">
                {row.title}: {row.verdict}
                {row.best ? `, ${formatLatLon(row.best.lat, row.best.lon)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
