import { api } from "../core/api.ts";
import { formatLatLon, pointInRing } from "../core/geo.ts";
import type { Evidence, EvidenceStance, Expedition, Hypothesis } from "../core/types.ts";
import type { LaserAssessment } from "../vision/laser.ts";
import { fillGaps, standingHeight } from "../vision/lidar.ts";
import { formatVolume, planMeasures } from "../vision/volume.ts";
import type { ShadowPlate } from "../vision/shadowTest.ts";
import type { Engine } from "../world/engine.ts";
import { saveFile } from "./exports.ts";
import { measureMass, plateDate, runBench, shadowPlateOf } from "./research.ts";

const nid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export type GatherArgs = { engine: Engine; expedition: Expedition; hypothesis: Hypothesis; plates: ShadowPlate[]; laser: LaserAssessment | null; onStep: (text: string) => void };

const auto = (stance: EvidenceStance, source: string, text: string, extra: Partial<Evidence> = {}): Evidence => ({ id: nid(), stance, source, text, created: new Date().toISOString(), auto: true, ...extra });

/**
 * Asks each instrument what it knows about the outline. A stance is a reading of one instrument, not a judgement: tools
 * that cannot test the hypothesis say so instead of voting. Nothing here is a probability, and nothing is added up to one.
 */
export async function gatherEvidence({ engine, expedition, hypothesis, plates, laser, onStep }: GatherArgs) {
  const out: Evidence[] = [];
  const skipped: string[] = [];
  const { ring, height } = hypothesis;
  const projection = engine.data.projection;
  const inside = (x: number, z: number) => pointInRing(x, z, ring);

  onStep("Provo le ombre…");
  const usable = plates.length ? plates : [shadowPlateOf(engine.plate.analysis, plateDate(engine.plate.ref))];
  const bench = runBench([ring], height, usable, engine.plate.canvas, projection);
  const tested = bench.scores.filter((row) => row.expected > 0).length;
  if (!tested) skipped.push("Banco delle ombre: il Sole era troppo basso, o la lastra non permette la prova.");
  else {
    const picture = await new Promise<Blob>((resolve, reject) => bench.picture.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("immagine"))), "image/jpeg", 0.9));
    const photo = await api.uploadMedia(engine.data.spec.id, picture, "jpg");
    const stance: EvidenceStance = bench.lift > 0.2 ? "a favore" : bench.lift <= 0.05 ? "contro" : "neutra";
    out.push(auto(stance, "Banco delle ombre", `${bench.label}, su ${tested} ${tested === 1 ? "ripresa" : "riprese"}: dove un volume alto ${height.toFixed(1)} m getterebbe ombra, la foto è più scura del fondo del ${(bench.lift * 100).toFixed(0)}%.${stance === "contro" ? " Un volume di oggi lo mostrerebbe; se non c'è più, vale solo per le date provate." : ""}`, { photo }));
  }

  if (!laser) skipped.push("Laser GEDI: impronte non ancora chieste, nella scheda Laser.");
  else {
    const shots = laser.readings.filter((row) => row.shot.good && inside(row.shot.x, row.shot.z));
    if (!shots.length) skipped.push("Laser GEDI: nessuna impronta cade dentro il contorno.");
    for (const row of shots.slice(0, 6)) {
      const measured = row.kind === "edificio" ? row.measured : row.shot.rh98;
      const close = Math.abs(measured - height) <= Math.max(3, height * 0.25);
      // Over crowns the laser reads the trees, so it can neither support nor deny a building.
      const stance: EvidenceStance = row.kind === "albero" ? "neutra" : close ? "a favore" : measured < height * 0.4 ? "contro" : "neutra";
      out.push(auto(stance, "Laser GEDI", `Il ${row.shot.date} il laser misura ${measured.toFixed(1)} m contro i ${height.toFixed(1)} m dell'ipotesi${row.kind === "albero" ? ", ma qui ci sono chiome" : ""}. Misura di quella data: nulla dice di prima.`));
    }
  }

  const standing = engine.data.buildings.filter((b) => !b.hidden && inside(b.rings[0]![0]!, b.rings[0]![1]!));
  if (standing.length) out.push(auto("neutra", "Mappa", `Sulla mappa, dentro il contorno: ${standing.slice(0, 4).map((b) => `${b.tags.name ?? "edificio"} di ${b.height.toFixed(0)} m`).join(", ")}${standing.length > 4 ? ` e altri ${standing.length - 4}` : ""}.`));

  for (const place of expedition.investigation?.candidates ?? []) {
    if (!inside(place.x, place.z)) continue;
    // A shadow or a bank can be the volume itself. A changed plate or a disagreeing laser only says that something is odd here.
    const strong = place.kinds.some((kind) => kind === "ombra" || kind === "lidar");
    out.push(auto(strong ? "a favore" : "neutra", "Indagine", `${place.clues.map((clue) => clue.text).join(" ")}${place.explained ? ` ${place.explained}` : ""}`));
  }

  onStep("Misuro la massa sul rilievo…");
  try {
    const mass = await measureMass(engine, ring, hypothesis.name);
    if (mass.nativeCells < 4) skipped.push("Rilievo: il contorno è troppo piccolo per celle da 30 m.");
    else {
      const rises = mass.peak >= height * 0.5;
      out.push(auto(rises ? "a favore" : "neutra", "Rilievo Copernicus e NASADEM", `Sul rilievo il contorno sale fino a ${mass.peak.toFixed(1)} m e sporge ${formatVolume(mass.fill.value)}.${mass.warning ? ` ${mass.warning}` : ""} Il radar perde gli oggetti ripidi e non vede ciò che è sepolto, quindi la sua assenza non prova nulla.`));
    }
  } catch (e) {
    skipped.push(`Rilievo: ${(e as Error).message}`);
  }

  try {
    const best = (await api.lidarCoverage(engine.data.spec.bbox)).find((row) => row.share > 0.5 && row.surface);
    if (!best) skipped.push("LiDAR: nessun rilievo aperto con superficie copre questo riquadro.");
    else {
      onStep(`Chiedo ${best.name}…`);
      const box = engine.data.spec.bbox;
      const cols = Math.min(1600, Math.round((projection.halfX * 2) / Math.max(1, best.resolution)));
      const rows = Math.min(1600, Math.round((projection.halfZ * 2) / Math.max(1, best.resolution)));
      const [dsm, dtm] = await Promise.all([api.lidarGrid(best.id, "dsm", box, cols, rows), api.lidarGrid(best.id, "dtm", box, cols, rows)]);
      const ground = fillGaps(dtm, cols, rows).heights;
      const cells: number[] = [];
      for (let j = 0; j < rows; j++) {
        const z = ((j + 0.5) / rows) * 2 * projection.halfZ - projection.halfZ;
        for (let i = 0; i < cols; i++) if (inside(((i + 0.5) / cols) * 2 * projection.halfX - projection.halfX, z)) cells.push(j * cols + i);
      }
      const row = standingHeight(dsm, ground, cells);
      if (!row) skipped.push(`${best.name}: troppe poche celle dentro il contorno.`);
      else {
        const close = Math.abs(row.height - height) <= Math.max(2, height * 0.25);
        out.push(auto(close ? "a favore" : row.height < height * 0.4 ? "contro" : "neutra", best.name, `Il rilievo laser misura fino a ${row.height.toFixed(1)} m sul suolo dentro il contorno, contro i ${height.toFixed(1)} m dell'ipotesi. Vale per la data del volo.`));
      }
    }
  } catch (e) {
    skipped.push(`LiDAR: ${(e as Error).message}`);
  }

  for (const note of expedition.notes) {
    const at = projection.toLocal(note.lat, note.lon);
    if (!inside(at.x, at.z) || note.kind === "tappa" || note.kind === "sistema") continue;
    out.push(auto("neutra", "Registro", `${note.title}. ${note.text}`.slice(0, 400), { photo: note.photo, noteId: note.id }));
  }
  return { evidence: out, skipped };
}

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function dataUrl(url: string) {
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
  } catch {
    return "";
  }
}

/** The plate around the outline, with a margin: the one picture a reader needs to know what is being claimed and where. */
function mapPicture(engine: Engine, hypothesis: Hypothesis) {
  const { ring } = hypothesis;
  const p = engine.data.projection;
  const source = engine.plate.canvas;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i]!);
    x1 = Math.max(x1, ring[i]!);
    z0 = Math.min(z0, ring[i + 1]!);
    z1 = Math.max(z1, ring[i + 1]!);
  }
  const margin = Math.max(40, Math.max(x1 - x0, z1 - z0) * 0.6);
  const left = Math.max(-p.halfX, x0 - margin);
  const right = Math.min(p.halfX, x1 + margin);
  const top = Math.max(-p.halfZ, z0 - margin);
  const bottom = Math.min(p.halfZ, z1 + margin);
  const toU = (x: number) => ((x + p.halfX) / (2 * p.halfX)) * source.width;
  const toV = (z: number) => ((z + p.halfZ) / (2 * p.halfZ)) * source.height;
  const width = 900;
  const height = Math.round((width * (bottom - top)) / (right - left));
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(source, toU(left), toV(top), toU(right) - toU(left), toV(bottom) - toV(top), 0, 0, width, height);
  ctx.beginPath();
  for (let i = 0; i < ring.length; i += 2) ctx.lineTo(((ring[i]! - left) / (right - left)) * width, ((ring[i + 1]! - top) / (bottom - top)) * height);
  ctx.closePath();
  ctx.lineWidth = 3;
  ctx.strokeStyle = hypothesis.color;
  ctx.stroke();
  const metres = 10 ** Math.floor(Math.log10((right - left) / 3));
  const bar = (metres / (right - left)) * width;
  ctx.fillStyle = "rgba(16,20,16,.8)";
  ctx.fillRect(12, height - 40, bar + 24, 28);
  ctx.fillStyle = "#eae2cf";
  ctx.fillRect(24, height - 22, bar, 4);
  ctx.font = "13px sans-serif";
  ctx.fillText(`${metres} m`, 24, height - 26);
  return out.toDataURL("image/jpeg", 0.88);
}

const STANCES: EvidenceStance[] = ["a favore", "contro", "neutra"];
const STANCE_TITLES: Record<EvidenceStance, string> = { "a favore": "A favore", contro: "Contro", neutra: "Né a favore né contro" };

export async function exportDossier(engine: Engine, expedition: Expedition, hypothesis: Hypothesis) {
  const p = engine.data.projection;
  const list = hypothesis.evidence ?? [];
  const { area } = planMeasures([hypothesis.ring]);
  const centre = (() => {
    let x = 0;
    let z = 0;
    for (let i = 0; i < hypothesis.ring.length; i += 2) {
      x += hypothesis.ring[i]!;
      z += hypothesis.ring[i + 1]!;
    }
    return p.toLatLon(x / (hypothesis.ring.length / 2), z / (hypothesis.ring.length / 2));
  })();
  const sections: string[] = [];
  for (const stance of STANCES) {
    const rows = list.filter((row) => row.stance === stance);
    if (!rows.length) continue;
    const items = await Promise.all(
      rows.map(async (row) => {
        const image = row.photo ? await dataUrl(row.photo) : "";
        return `<li><b>${esc(row.source)}.</b> ${esc(row.text)}${row.auto ? "" : " <i>Aggiunta dall'esploratore.</i>"}${image ? `<img src="${image}" alt="">` : ""}</li>`;
      }),
    );
    sections.push(`<h2>${STANCE_TITLES[stance]} (${rows.length})</h2><ul>${items.join("")}</ul>`);
  }
  const count = (stance: EvidenceStance) => list.filter((row) => row.stance === stance).length;
  const html = `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fascicolo: ${esc(hypothesis.name)}</title><style>body{font:16px/1.55 Georgia,serif;max-width:800px;margin:40px auto;padding:0 16px;background:#f4efe2;color:#2e2a20}h1{font-size:32px;margin:0 0 4px}h2{font-size:21px;margin:28px 0 8px;border-bottom:1px solid #cfc3a6;padding-bottom:3px}.w{font:13px monospace;color:#6d6249}ul{padding-left:20px}li{margin:10px 0}img{display:block;max-width:100%;margin-top:8px;border:5px solid #fff}blockquote{margin:10px 0;padding:8px 14px;background:#ebe3cf;border-left:3px solid #a2622f}table{border-collapse:collapse}td{padding:2px 14px 2px 0}.small{font-size:14px;color:#57503f}@media print{body{background:#fff;margin:0}}</style>
<h1>${esc(hypothesis.name)}</h1><p class="w">Fascicolo d'ipotesi · ${esc(expedition.spec.name)} · ${esc(formatLatLon(centre.lat, centre.lon))} · ${new Date().toISOString().slice(0, 10)}</p>
<table><tr><td>Altezza ipotizzata</td><td>${hypothesis.height.toFixed(1)} m</td></tr><tr><td>Pianta</td><td>${area.toFixed(0)} m²</td></tr><tr><td>Volume ipotizzato</td><td>${esc(formatVolume(area * hypothesis.height))}</td></tr><tr><td>Lastra in uso</td><td>${esc(plateDate(engine.plate.ref))}</td></tr></table>
${hypothesis.note ? `<h2>L'ipotesi</h2><p>${esc(hypothesis.note)}</p>` : ""}
<img src="${mapPicture(engine, hypothesis)}" alt="Il contorno dell'ipotesi sulla lastra">
<h2>Il conto</h2><p>${count("a favore")} a favore, ${count("contro")} contro, ${count("neutra")} né a favore né contro. Sono letture di strumenti diversi, che non pesano tutte uguale e non si sommano in una probabilità.</p>
${hypothesis.conclusion ? `<h2>Conclusione dell'esploratore</h2><blockquote>${esc(hypothesis.conclusion)}</blockquote>` : ""}
${sections.join("")}
${hypothesis.skipped?.length ? `<h2>Cosa non si è potuto provare</h2><ul>${hypothesis.skipped.map((row) => `<li>${esc(row)}</li>`).join("")}</ul>` : ""}
<h2>Limiti del metodo</h2><p class="small">Le immagini sono ortofoto e le altezze sono dedotte o misurate in date precise: l'assenza di un segnale oggi non dice nulla di ciò che c'era prima. I modelli radar del rilievo non seguono le pareti ripide e non vedono ciò che è sepolto. Un fascicolo raccoglie indizi: la verifica spetta a una ricognizione sul posto o a uno scavo.</p>
<p class="w">Prodotto con Sestante. Lastra Esri World Imagery Wayback, altezze da OpenStreetMap, GEDI, Copernicus GLO-30 e NASADEM dove citati.</p></html>`;
  saveFile(`fascicolo-${hypothesis.name.replace(/[^\w-]+/g, "-").toLowerCase() || hypothesis.id}.html`, html, "text/html");
}
