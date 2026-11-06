import type { Bbox } from "./geo.ts";
import type { TreeModel } from "../vision/laser.ts";

import type { Candidate } from "../vision/anomalies.ts";
import type { RouteMode } from "./routes.ts";
export type Capture = {
  date: string | null;
  sensor: string | null;
  provider: string | null;
  product: string | null;
  resolution: number | null;
  accuracy: number | null;
  block: string | null;
};

export type PlateVersion = { release: number; published: string; oldest: string; count: number; capture: Capture | null };

export type PlateRef =
  | { kind: "wayback"; release: number; published: string; capture: Capture | null }
  | { kind: "tiles"; source: string; label: string; attribution: string; date?: string }
  | { kind: "upload"; url: string; label: string; capture: Capture | null; manualSun: { azimuth: number; altitude: number } | null };

/** The exact point the user asked for: the centre of the box when it was set, a landmark after any crop. */
export type FocusPoint = { lat: number; lon: number; format: string; precision: number | null };

export type FieldSpec = { id: string; name: string; bbox: Bbox; zoom: number; plate: PlateRef; focus?: FocusPoint };

export type NoteKind = "manuale" | "foto" | "misura" | "strumento" | "confronto" | "tappa" | "sistema";

export type Note = {
  id: string;
  created: string;
  simTime: string;
  kind: NoteKind;
  instrument?: string;
  title: string;
  text: string;
  values?: Record<string, string>;
  lat: number;
  lon: number;
  elev: number;
  heading: number;
  plate: string;
  weather?: string;
  photo?: string;
  attachments?: string[];
  tags?: string[];
};

/** A volume someone proposes: a tower that fell, a wall under a field. Ring in local metres, x east, z south. */
export type EvidenceStance = "a favore" | "contro" | "neutra";
export type Evidence = { id: string; stance: EvidenceStance; source: string; text: string; created: string; auto: boolean; photo?: string; noteId?: string };
export type Hypothesis = { id: string; name: string; ring: number[]; height: number; color: string; note: string; created: string; verdict?: string; evidence?: Evidence[]; skipped?: string[]; conclusion?: string };

export type SourceUse = { name: string; state: "usata" | "saltata"; detail: string };
export type Investigation = { at: string; plate: string; candidates: Candidate[]; sources: SourceUse[] };

/** An old map or drawing pinned to the plate by control points: a·u + b·v + c, d·u + e·v + f. */
export type MapOverlay = { id: string; name: string; url: string; points: { u: number; v: number; x: number; z: number }[]; transform: [number, number, number, number, number, number]; rms: number };

export type PhotoPlacement = { photoId: string; title: string; url: string; x: number; y: number; z: number; azimuth: number; fov: number; pano: boolean; mix: number; range: number };

export type StrataSummary = {
  at: string;
  shots: { date: string; sensor: string | null; resolution: number | null; sunAzimuth: number; altitude: number; confidence: number; method: string; instant: string | null }[];
  heights: Record<string, { h: number; low: number; high: number; n: number; samples: { date: string; h: number; c: number }[] }>;
  presence: Record<string, { firstSeen: string | null; lastAbsent: string | null; confidence: number; absent: string[]; checked: number }>;
};

/** A mass measured on the surface models: what the register and the Laboratory keep of it. */
export type MassReport = {
  id: string;
  name: string;
  ring: number[];
  area: number;
  nativeCells: number;
  fill: { value: number; low: number; high: number };
  cut: { value: number; low: number; high: number };
  peak: number;
  pit: number;
  rimRoughness: number;
  sources: string;
  warning: string;
  /** Fill read on each surface model, to show when they disagree. */
  models: { name: string; fill: number; peak: number }[];
  /** What the map's own solids inside the outline add up to, for comparison. */
  mapVolume: number;
  change: { net: number; low: number; high: number; significant: boolean; noise: number } | null;
  created: string;
};

/** A view to come back to: where, looking where, when, under what sky, with which plate and layer. */
export type SavedStudy = {
  id: string;
  name: string;
  created: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  drone: boolean;
  simTime: number;
  weather: { mode: string; target: Record<string, unknown> };
  release: unknown;
  plateLabel: string;
  drape?: { url: string; label: string; source: string };
  photo?: string;
};

export type SavedRoute = {
  id: string;
  name: string;
  created: string;
  mode: RouteMode;
  water: string;
  points: { x: number; z: number }[];
  seconds: number;
  length: number;
  ascent: number;
  descent: number;
  straight: number;
  straightSeconds: number | null;
  corridorShare: number;
  color: string;
};

export type PhotoFindRow = {
  id: string;
  title: string;
  url: string;
  at: string;
  verdict: string;
  relief: number;
  region: number;
  uniqueness: number;
  best: { lat: number; lon: number; azimuth: number; hfov: number; rmse: number } | null;
  exifLat: number | null;
  exifLon: number | null;
};

export type SavedVideo = { id: string; name: string; url: string; poster: string; created: string; seconds: number };

export type LidarReport = {
  provider: string;
  name: string;
  at: string;
  seen: number;
  changed: number;
  bySource: { label: string; n: number; bias: number; typical: number; within3: number }[];
  tallest: { name: string; measured: number; mapped: number; source: string }[];
};

/** A copy of the explorer left standing somewhere, as a scale bar in the world. */
export type PosedFigure = { id: string; x: number; z: number; yaw: number };

export type Pin = { id: string; x: number; z: number; y: number; label: string; color: string; created: string };

export type SheetStroke = { color: string; width: number; pts: number[]; route?: string };
export type SheetLabel = { x: number; z: number; text: string; color: string };
export type Sheet = { strokes: SheetStroke[]; labels: SheetLabel[] };

export type Expedition = {
  spec: FieldSpec;
  notes: Note[];
  pins: Pin[];
  sheet: Sheet;
  track: number[];
  counters: { steps: number; distance: number };
  hypotheses?: Hypothesis[];
  overlays?: MapOverlay[];
  placement?: PhotoPlacement | null;
  strata?: StrataSummary | null;
  laserApplied?: boolean;
  treeModel?: TreeModel | null;
  masses?: MassReport[];
  studies?: SavedStudy[];
  figures?: PosedFigure[];
  investigation?: Investigation;
  routes?: SavedRoute[];
  photoFinds?: PhotoFindRow[];
  videos?: SavedVideo[];
  lidarReport?: LidarReport | null;
  thumb?: string;
  status?: "aperta" | "conclusa";
  /** Observations made in the Studio before anyone went down to the field. */
  studioFindings?: { title: string; text: string }[];
};

export const newExpedition = (spec: FieldSpec): Expedition => ({
  spec,
  notes: [],
  pins: [],
  sheet: { strokes: [], labels: [] },
  track: [],
  counters: { steps: 0, distance: 0 },
});

export function plateLabel(ref: PlateRef) {
  if (ref.kind === "wayback") return ref.capture?.date ? `scatto ${ref.capture.date}` : `archivio ${ref.published}`;
  return ref.label;
}

export type TileSourceInfo = {
  id: string;
  label: string;
  group: "ripresa" | "carta" | "storico" | "quota" | "tuo";
  template: string;
  maxZoom: number;
  ext: string;
  attribution: string;
  note?: string;
  bulkLimit?: number;
};

export type DownloadJob = {
  id: string;
  name: string;
  source: string;
  format: "directory" | "mbtiles" | "stitched";
  state: "running" | "done" | "failed" | "cancelled";
  total: number;
  done: number;
  failed: number;
  fromCache: number;
  output: string;
  message: string;
};
