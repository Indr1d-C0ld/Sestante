import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./sources.ts";

/**
 * Land cover from a neural network: FLAIR-INC, RGB, 15 classes, by IGN (Institut national de l'information géographique
 * et forestière), weights under Etalab 2.0. Trained on French aerial orthophotos at 0.2 m from April to November: elsewhere,
 * on other sensors and in winter it is weaker, and the LiDAR benchmark says by how much. Optional: without the model file
 * or without onnxruntime-node the analysis carries on with its own rules.
 *
 * The ONNX file has the normalisation, the softmax and the argmax baked in (tools/flair-to-onnx.py): it takes RGB 0..255 and
 * returns the class index and its probability. Indices are FLAIR's classes minus one.
 */
export const LANDCOVER_FILE = join(DATA, "models", "flair-rgb15.onnx");

export const FLAIR_CLASSES = [
  "edificio",
  "superficie permeabile",
  "superficie impermeabile",
  "suolo nudo",
  "acqua",
  "conifere",
  "latifoglie",
  "arbusti",
  "vigneto",
  "erba",
  "coltivo",
  "terreno arato",
  "piscina",
  "neve",
  "taglio raso",
  "bosco misto",
  "legnose",
  "serra",
  "altro",
] as const;

type Ort = typeof import("onnxruntime-node");
type Session = import("onnxruntime-node").InferenceSession;

let loading: Promise<{ ort: Ort; session: Session; provider: string } | null> | null = null;
let lastProblem: string | null = null;

async function load() {
  if (!existsSync(LANDCOVER_FILE)) {
    lastProblem = `Modello assente: ${LANDCOVER_FILE}. Si ottiene con tools/flair-to-onnx.py, vedi il README.`;
    return null;
  }
  let ort: Ort;
  try {
    ort = await import("onnxruntime-node");
  } catch {
    lastProblem = "onnxruntime-node non è installato: npm install onnxruntime-node.";
    return null;
  }
  // The GPU through WebGPU when there is one, the processor otherwise: same model, same classes, a few times slower.
  for (const provider of ["webgpu", "cpu"]) {
    try {
      const session = await ort.InferenceSession.create(LANDCOVER_FILE, { executionProviders: [provider], logSeverityLevel: 3 });
      lastProblem = null;
      return { ort, session, provider };
    } catch (error) {
      lastProblem = `Esecuzione ${provider} non disponibile: ${(error as Error).message.slice(0, 160)}`;
    }
  }
  return null;
}

function model() {
  loading ??= load().then((found) => {
    // A missing file may appear later: only a loaded model is kept.
    if (!found) loading = null;
    return found;
  });
  return loading;
}

export function landcoverStatus() {
  return {
    file: existsSync(LANDCOVER_FILE),
    bytes: existsSync(LANDCOVER_FILE) ? statSync(LANDCOVER_FILE).size : 0,
    problem: lastProblem,
    model: "FLAIR-INC RGB 15 classi (IGN, Etalab 2.0)",
    classes: FLAIR_CLASSES,
  };
}

// One plate at a time: the GPU is shared with the browser, and two runs would only queue inside it anyway.
let queue: Promise<unknown> = Promise.resolve();

const TILE = 512;
const MARGIN = 64;

/**
 * Classes of an RGBA raster, one byte per pixel, plus the model's confidence (0..255). Tiles of 512 with a 64-pixel margin
 * that is thrown away: a tile's border sees too little around it, and whole images do not fit in one GPU buffer.
 */
export async function landcover(rgba: Uint8Array, width: number, height: number) {
  const found = await model();
  if (!found) throw new Error(lastProblem ?? "Modello non disponibile.");
  const run = queue.then(async () => {
    const { ort, session, provider } = found;
    const started = performance.now();
    const classes = new Uint8Array(width * height);
    const confidence = new Uint8Array(width * height);
    const input = new Float32Array(3 * TILE * TILE);
    const plane = TILE * TILE;
    const step = TILE - 2 * MARGIN;
    for (let ty = 0; ty < height; ty += step) {
      for (let tx = 0; tx < width; tx += step) {
        const ox = tx - MARGIN;
        const oy = ty - MARGIN;
        for (let y = 0; y < TILE; y++) {
          const sy = Math.min(height - 1, Math.max(0, oy + y));
          for (let x = 0; x < TILE; x++) {
            const k = (sy * width + Math.min(width - 1, Math.max(0, ox + x))) * 4;
            const o = y * TILE + x;
            input[o] = rgba[k]!;
            input[plane + o] = rgba[k + 1]!;
            input[2 * plane + o] = rgba[k + 2]!;
          }
        }
        const out = await session.run({ rgb: new ort.Tensor("float32", input, [1, 3, TILE, TILE]) });
        const cls = out.class!.data as Uint8Array;
        const conf = out.confidence!.data as Uint8Array;
        for (let y = MARGIN; y < TILE - MARGIN; y++) {
          const Y = oy + y;
          if (Y < 0 || Y >= height) continue;
          for (let x = MARGIN; x < TILE - MARGIN; x++) {
            const X = ox + x;
            if (X < 0 || X >= width) continue;
            classes[Y * width + X] = cls[y * TILE + x]!;
            confidence[Y * width + X] = conf[y * TILE + x]!;
          }
        }
      }
    }
    return { classes, confidence, provider, ms: Math.round(performance.now() - started) };
  });
  queue = run.catch(() => undefined);
  return run;
}
