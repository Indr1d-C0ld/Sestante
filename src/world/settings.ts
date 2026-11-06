export type Settings = {
  preset: string;
  renderScale: number;
  dynamicRes: boolean;
  targetFps: number;
  shadowSize: number;
  cascades: number;
  shadowFar: number;
  ao: number;
  bloom: number;
  clouds: number;
  aerial: number;
  treeDensity: number;
  treeNear: number;
  grass: number;
  drawFar: number;
  farField: boolean;
  showBuildings: boolean;
  showMasses: boolean;
  showTrees: boolean;
  showProps: boolean;
  showFences: boolean;
  showWater: boolean;
  deshadow: boolean;
  detail: number;
  relief: number;
  exposure: number;
  autoExposure: boolean;
  tonemap: "agx" | "aces" | "neutral";
  saturation: number;
  vignette: number;
  grain: number;
  fov: number;
  showPerf: boolean;
  walkSpeed: number;
  runSpeed: number;
  eye: number;
  bob: number;
  stride: number;
  sensitivity: number;
  invertY: boolean;
  gravity: boolean;
  autoLog: boolean;
  stageMeters: number;
  volume: number;
  ambience: number;
  showCompassTape: boolean;
  northArrow: boolean;
  gridOverlay: boolean;
  plateOpacity: number;
  demSource: "terrarium" | "copernicus" | "nasadem" | "lidar";
  altEgoHeight: number;
  altEgoShoulders: number;
  altEgoBuild: number;
  altEgoShirt: string;
  altEgoTrousers: string;
  altEgoSkin: string;
  thirdPerson: boolean;
  longExposure: number;
  traceSamples: number;
};

export type PresetValues = Pick<Settings, "renderScale" | "shadowSize" | "cascades" | "shadowFar" | "ao" | "bloom" | "clouds" | "treeDensity" | "treeNear" | "grass" | "drawFar">;

export const PRESETS: Record<string, PresetValues> = {
  Essenziale: { renderScale: 0.75, shadowSize: 1024, cascades: 2, shadowFar: 260, ao: 0, bloom: 0.25, clouds: 0, treeDensity: 0.45, treeNear: 40, grass: 0, drawFar: 6000 },
  Bilanciata: { renderScale: 1, shadowSize: 2048, cascades: 3, shadowFar: 500, ao: 0.8, bloom: 0.45, clouds: 1, treeDensity: 0.8, treeNear: 90, grass: 0.5, drawFar: 18000 },
  Alta: { renderScale: 1, shadowSize: 3072, cascades: 3, shadowFar: 800, ao: 1, bloom: 0.5, clouds: 1, treeDensity: 1, treeNear: 110, grass: 0.8, drawFar: 24000 },
  Massima: { renderScale: 1.25, shadowSize: 4096, cascades: 4, shadowFar: 1200, ao: 1, bloom: 0.55, clouds: 2, treeDensity: 1, treeNear: 170, grass: 1, drawFar: 30000 },
};

export const DEFAULT_SETTINGS: Settings = {
  preset: "Bilanciata",
  ...PRESETS.Bilanciata!,
  dynamicRes: true,
  targetFps: 40,
  aerial: 1,
  farField: true,
  showBuildings: true,
  showMasses: true,
  showTrees: true,
  showProps: true,
  showFences: true,
  showWater: true,
  deshadow: true,
  detail: 0.8,
  relief: 1,
  exposure: 1,
  autoExposure: true,
  tonemap: "agx",
  saturation: 1.05,
  vignette: 0.18,
  grain: 0.015,
  fov: 68,
  showPerf: false,
  walkSpeed: 1.5,
  runSpeed: 4.2,
  eye: 1.68,
  bob: 0.6,
  stride: 0.74,
  sensitivity: 1,
  invertY: false,
  gravity: true,
  autoLog: true,
  stageMeters: 150,
  volume: 0.7,
  ambience: 0.7,
  showCompassTape: true,
  northArrow: true,
  gridOverlay: false,
  plateOpacity: 1,
  demSource: "terrarium",
  altEgoHeight: 1.75,
  altEgoShoulders: 0.45,
  altEgoBuild: 1,
  altEgoShirt: "#b4552d",
  altEgoTrousers: "#39414a",
  altEgoSkin: "#c99a78",
  thirdPerson: false,
  longExposure: 24,
  traceSamples: 64,
};

const KEY = "sestante.impostazioni.v2";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* defaults are fine when storage is blocked */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* settings then last for this session only */
  }
}
