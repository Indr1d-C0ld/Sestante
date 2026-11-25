/**
 * Downloads the optional segmentation model into data/models and checks its fingerprint: `npm run modello`.
 * FLAIR-INC RGB 15 classes by IGN, Licence Ouverte Etalab 2.0, converted to ONNX by tools/flair-to-onnx.py and published
 * as an asset of this repository's release "modello-flair-rgb15-v1".
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LANDCOVER_FILE } from "../server/landcover.ts";

const URL = "https://github.com/Indr1d-C0ld/Sestante/releases/download/modello-flair-rgb15-v1/flair-rgb15.onnx";
const SHA256 = "671b3c7619629e962801dfc8ff06249396f91acb1c9d146a719e3aeeb0d353b6";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

if (existsSync(LANDCOVER_FILE) && digest(readFileSync(LANDCOVER_FILE)) === SHA256) {
  console.log(`Il modello c'è già ed è integro: ${LANDCOVER_FILE}`);
  process.exit(0);
}

console.log("Scarico FLAIR-INC RGB 15 classi (IGN, Licence Ouverte Etalab 2.0), 98 MB…");
const res = await fetch(URL);
if (!res.ok) {
  console.error(`Scaricamento fallito: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const bytes = new Uint8Array(await res.arrayBuffer());
const found = digest(bytes);
if (found !== SHA256) {
  console.error(`Impronta diversa da quella attesa: il file non è stato salvato.\n  attesa  ${SHA256}\n  trovata ${found}`);
  process.exit(1);
}
mkdirSync(dirname(LANDCOVER_FILE), { recursive: true });
// Written aside and renamed: a broken download never leaves a half file where the server looks.
const partial = `${LANDCOVER_FILE}.part`;
writeFileSync(partial, bytes);
rmSync(LANDCOVER_FILE, { force: true });
renameSync(partial, LANDCOVER_FILE);
console.log(`Modello installato e verificato: ${LANDCOVER_FILE}\nRiavvia Sestante perché lo usi.`);
