import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, canvasBlob } from "../core/api.ts";
import type { Expedition, PlateRef, PlateVersion, SavedStudy, SavedVideo } from "../core/types.ts";
import type { Engine } from "../world/engine.ts";
import { saveFile } from "./exports.ts";
import { readPlate } from "./load.ts";
import { absentIds, plateDate } from "./research.ts";

type Props = {
  engine: Engine;
  expedition: Expedition;
  versions: PlateVersion[];
  plateCache: Map<string, HTMLCanvasElement>;
  onClose: () => void;
  onVideo: (video: SavedVideo) => void;
  toast: (text: string) => void;
};

type CameraMode = "ferma" | "orbita" | "studi";
type Shot = { date: string; label: string; canvas: HTMLCanvasElement };
type Pose = { x: number; y: number; z: number; yaw: number; pitch: number };

const shrink = (canvas: HTMLCanvasElement, side = 2048) => {
  const scale = Math.min(1, side / Math.max(canvas.width, canvas.height));
  if (scale === 1) return canvas;
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
};

const catmull = (a: number, b: number, c: number, d: number, t: number) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);

/** Follows the saved studies in order, through a smooth curve, turning the short way round. */
function pathPose(list: SavedStudy[], t: number): Pose {
  const n = list.length - 1;
  const f = Math.min(n - 1e-6, Math.max(0, t) * n);
  const i = Math.floor(f);
  const u = f - i;
  const at = (k: number) => list[Math.max(0, Math.min(n, k))]!;
  const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
  const turn = ((((c.yaw - b.yaw + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  return { x: catmull(a.x, b.x, c.x, d.x, u), y: catmull(a.y, b.y, c.y, d.y, u) + 1.65, z: catmull(a.z, b.z, c.z, d.z, u), yaw: b.yaw + turn * u, pitch: b.pitch + (c.pitch - b.pitch) * u };
}

function orbitPose(centre: { x: number; y: number; z: number }, radius: number, lift: number, t: number): Pose {
  const angle = t * Math.PI * 1.5 + 0.7;
  const x = centre.x + Math.sin(angle) * radius;
  const z = centre.z + Math.cos(angle) * radius;
  return { x, y: centre.y + lift, z, yaw: Math.atan2(x - centre.x, z - centre.z), pitch: -Math.atan2(lift, radius) };
}

/** Drags the world through its dated shots, the camera moving while the ground changes under it. */
export function TimeTravel({ engine, expedition, versions, plateCache, onClose, onVideo, toast }: Props) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [loading, setLoading] = useState("Preparo gli scatti…");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [mode, setMode] = useState<CameraMode>("orbita");
  const [seconds, setSeconds] = useState(4);
  const p = engine.data.projection;
  const [radius, setRadius] = useState(Math.round(Math.min(p.halfX, p.halfZ) * 0.7));
  const [lift, setLift] = useState(Math.round(Math.min(p.halfX, p.halfZ) * 0.35));
  const centre = useRef({ x: engine.pos.x, y: engine.pos.y, z: engine.pos.z });
  const absentKey = useRef("");
  const tRef = useRef(0);
  const studies = useMemo(() => expedition.studies ?? [], [expedition.studies]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const seen = new Set<string>();
      const dated = [...versions]
        .map((row) => ({ row, date: row.capture?.date ?? row.published }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .filter(({ date }) => (seen.has(date) ? false : (seen.add(date), true)));
      // Evenly through time, with both ends: twelve is what memory can hold and the eye can follow.
      const picked = dated.length <= 12 ? dated : Array.from({ length: 12 }, (_, i) => dated[Math.round((i * (dated.length - 1)) / 11)]!);
      const out: Shot[] = [];
      for (const [index, { row, date }] of picked.entries()) {
        if (!live) return;
        setLoading(`Sviluppo lo scatto ${index + 1} di ${picked.length}: ${date}`);
        const key = `wb-${row.release}`;
        let canvas = plateCache.get(key);
        if (!canvas) {
          const ref: PlateRef = { kind: "wayback", release: row.release, published: row.published, capture: row.capture };
          canvas = await readPlate(ref, engine.data.spec, () => undefined);
          plateCache.set(key, canvas);
        }
        out.push({ date, label: date, canvas: shrink(canvas) });
      }
      if (!live) return;
      if (out.length >= 2) engine.travelStart(out.map((row) => row.canvas));
      setShots(out);
      setLoading("");
    })().catch((e: Error) => setLoading(`Scatti non raggiunti: ${e.message}`));
    return () => {
      live = false;
    };
  }, [engine, versions, plateCache]);

  const dateAt = useCallback(
    (value: number) => {
      if (!shots.length) return "";
      const f = value * (shots.length - 1);
      const a = shots[Math.floor(Math.min(f, shots.length - 1))]!;
      const b = shots[Math.min(shots.length - 1, Math.floor(f) + 1)]!;
      const start = Date.parse(a.date);
      const end = Date.parse(b.date);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return a.date;
      return new Date(start + (end - start) * (f - Math.floor(f))).toISOString().slice(0, 7);
    },
    [shots],
  );

  const apply = useCallback(
    (value: number) => {
      tRef.current = value;
      if (shots.length >= 2) engine.travelSet(value);
      engine.cinema = mode === "orbita" ? orbitPose(centre.current, radius, lift, value) : mode === "studi" && studies.length >= 2 ? pathPose(studies, value) : null;
      // Buildings leave the scene only if the plates have been read, and only when the set really changes.
      if (expedition.strata) {
        const shot = shots[Math.round(value * (shots.length - 1))];
        if (shot) {
          const absent = absentIds(expedition.strata, shot.date);
          const key = [...absent].sort().join();
          if (key !== absentKey.current) {
            absentKey.current = key;
            engine.refreshBuildings(absent);
          }
        }
      }
    },
    [engine, expedition.strata, lift, mode, radius, shots, studies],
  );

  useEffect(() => {
    if (!loading) apply(tRef.current);
  }, [apply, loading]);

  // Leaving puts everything back as it was: the plate in use, the buildings for its date, your own eyes.
  useEffect(
    () => () => {
      engine.travelEnd();
      engine.cinema = null;
      engine.refreshBuildings(absentIds(expedition.strata, plateDate(engine.plate.ref)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine],
  );

  useEffect(() => {
    if (!playing || recording) return;
    let frame = 0;
    const started = performance.now() - tRef.current * seconds * Math.max(1, shots.length - 1) * 1000;
    const tick = (now: number) => {
      const value = (now - started) / (seconds * Math.max(1, shots.length - 1) * 1000);
      if (value >= 1) {
        apply(1);
        setT(1);
        setPlaying(false);
        return;
      }
      apply(value);
      setT(value);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [apply, playing, recording, seconds, shots.length]);

  const record = async () => {
    const source = engine.renderer.domElement;
    const width = 1280;
    const height = 720;
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d")!;
    const type = ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((row) => MediaRecorder.isTypeSupported(row));
    if (!type) return toast("Questo browser non sa registrare video.");
    setRecording(true);
    setPlaying(false);
    const stream = out.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.start(250);
    const duration = seconds * Math.max(1, shots.length - 1) * 1000;
    const start = performance.now();
    const place = expedition.spec.name;
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        const value = Math.min(1, (now - start) / duration);
        apply(value);
        setT(value);
        // Render here rather than wait for the world's own frame: a WebGL picture can be read only right after it is drawn.
        engine.render();
        const scale = Math.max(width / source.width, height / source.height);
        ctx.drawImage(source, (width - source.width * scale) / 2, (height - source.height * scale) / 2, source.width * scale, source.height * scale);
        ctx.fillStyle = "rgba(16,20,16,.72)";
        ctx.fillRect(24, height - 96, 330, 72);
        ctx.fillStyle = "#eae2cf";
        ctx.font = "500 34px 'IBM Plex Mono', monospace";
        ctx.fillText(dateAt(value), 40, height - 56);
        ctx.font = "14px 'IBM Plex Sans', sans-serif";
        ctx.fillText(place.slice(0, 40), 40, height - 34);
        if (mode === "orbita") {
          // Metres per pixel where the camera is looking, at the centre of the orbit.
          const distance = Math.hypot(radius, lift);
          const metresPerPixel = (2 * distance * Math.tan((engine.camera.fov * Math.PI) / 360)) / height;
          const metres = 10 ** Math.floor(Math.log10((width / 5) * metresPerPixel));
          const bar = metres / metresPerPixel;
          ctx.fillRect(width - 40 - bar, height - 40, bar, 4);
          ctx.textAlign = "right";
          ctx.fillText(`${metres} m al centro`, width - 40, height - 50);
          ctx.textAlign = "left";
        }
        ctx.font = "11px 'IBM Plex Sans', sans-serif";
        ctx.fillStyle = "rgba(234,226,207,.7)";
        ctx.textAlign = "right";
        ctx.fillText("Immagini Esri World Imagery Wayback. Edifici ed elevazione ricostruiti.", width - 24, height - 14);
        ctx.textAlign = "left";
        if (value >= 1) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    recorder.stop();
    await done;
    for (const track of stream.getTracks()) track.stop();
    const blob = new Blob(chunks, { type: type.split(";")[0] });
    const ext = type.includes("mp4") ? "mp4" : "webm";
    const name = `viaggio-${expedition.spec.id}.${ext}`;
    saveFile(name, blob);
    const url = await api.uploadMedia(engine.data.spec.id, blob, ext);
    const poster = await canvasBlob(out, "image/jpeg", 0.85).then((row) => api.uploadMedia(engine.data.spec.id, row, "jpg"));
    onVideo({ id: Date.now().toString(36), name: `Viaggio ${shots[0]?.date ?? ""} – ${shots[shots.length - 1]?.date ?? ""}`, url, poster, created: new Date().toISOString(), seconds: duration / 1000 });
    setRecording(false);
    toast("Video salvato, e conservato fra i media dell'indagine.");
  };

  const ready = !loading && shots.length >= 2;
  return (
    <div className="travel" onClick={(e) => e.stopPropagation()}>
      <div className="row wrap">
        <b className="grow">Viaggio nel tempo {shots.length ? <span className="mono travel-date">{dateAt(t)}</span> : null}</b>
        {loading && <span className="small mono">{loading}</span>}
        <button className="btn tiny" disabled={recording} onClick={onClose}>
          Chiudi (Esc)
        </button>
      </div>
      {!loading && shots.length < 2 && <p className="small warn">Questa fonte ha un solo scatto del luogo: non c'è un tempo da percorrere.</p>}
      {ready && (
        <>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={t}
            disabled={recording}
            aria-label="Momento fra gli scatti"
            onChange={(e) => {
              const value = Number(e.target.value);
              setPlaying(false);
              setT(value);
              apply(value);
            }}
          />
          <div className="travel-ticks small mono" aria-hidden>
            {shots.map((row) => (
              <span key={row.date}>{row.date.slice(0, 4)}</span>
            ))}
          </div>
          <div className="row wrap">
            <button
              className="btn tiny primary"
              disabled={recording}
              onClick={() => {
                if (t >= 1) {
                  tRef.current = 0;
                  setT(0);
                }
                setPlaying((value) => !value);
              }}
            >
              {playing ? "Pausa" : "Scorri"}
            </button>
            <label className="field">
              Camera
              <select value={mode} disabled={recording} onChange={(e) => setMode(e.target.value as CameraMode)}>
                <option value="ferma">La tua vista</option>
                <option value="orbita">Orbita attorno a dove eri</option>
                <option value="studi" disabled={studies.length < 2}>
                  Attraverso gli studi salvati ({studies.length})
                </option>
              </select>
            </label>
            {mode === "orbita" && (
              <>
                <label className="field travel-slider">
                  Raggio {radius} m
                  <input type="range" min={40} max={Math.round(Math.max(p.halfX, p.halfZ) * 1.5)} value={radius} disabled={recording} onChange={(e) => setRadius(Number(e.target.value))} />
                </label>
                <label className="field travel-slider">
                  Quota {lift} m
                  <input type="range" min={10} max={Math.round(Math.max(p.halfX, p.halfZ))} value={lift} disabled={recording} onChange={(e) => setLift(Number(e.target.value))} />
                </label>
              </>
            )}
            <label className="field travel-slider">
              {seconds} s per scatto
              <input type="range" min={1} max={12} value={seconds} disabled={recording} onChange={(e) => setSeconds(Number(e.target.value))} />
            </label>
            <button className="btn tiny" disabled={recording} onClick={() => void record()}>
              {recording ? "Registro…" : `Esporta il video (${seconds * (shots.length - 1)} s)`}
            </button>
          </div>
          <p className="small muted">Solo il suolo viene dagli scatti. Edifici e alberi restano quelli ricostruiti, salvo gli edifici che la lettura delle riprese nel Laboratorio data dopo lo scatto.</p>
        </>
      )}
    </div>
  );
}
