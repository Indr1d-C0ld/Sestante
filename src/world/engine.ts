import * as THREE from "three";
import { CSM } from "three/addons/csm/CSM.js";
import { dirVector, moonPosition, sunPosition } from "../core/solar.ts";
import type { Hypothesis, Pin } from "../core/types.ts";
import type { Building, FieldData, PlateState } from "../field/load.ts";
import { terrainSampler } from "../field/load.ts";
import { Soundscape } from "./audio.ts";
import { buildBuildings } from "./buildings.ts";
import { buildFences, buildProps, buildRibbons, buildWater, Precipitation, type PlacedProp } from "./details.ts";
import { Forest, Meadow } from "./nature.ts";
import { PostChain } from "./post.ts";
import { WorldQuery, type Hit } from "./query.ts";
import { canvasTexture, dataTexture, makeNoiseTexture, shade, U } from "./shading.ts";
import type { Settings } from "./settings.ts";
import { buildFigure, poseFigure, type AltEgo, type Figure } from "./avatar.ts";
import { SimClock, WeatherModel } from "./sim.ts";
import { Sky } from "./sky.ts";
import { buildFarField, buildTerrain } from "./terrain.ts";

export type Snapshot = {
  x: number;
  y: number;
  z: number;
  lat: number;
  lon: number;
  ground: number;
  heading: number;
  pitch: number;
  speed: number;
  steps: number;
  distance: number;
  cadence: number;
  onRoof: boolean;
  drone: boolean;
  sunAz: number;
  sunAlt: number;
  moonAz: number;
  moonAlt: number;
  moonIllum: number;
  shaded: boolean;
  slope: number;
  aspect: number;
  fps: number;
  scale: number;
  locked: boolean;
  zoom: number;
  ascent: number;
  look: Hit | null;
};

export type EngineHooks = {
  onStage?: () => void;
  onEdge?: () => void;
};

const TONE = { agx: 0, aces: 1, neutral: 2 } as const;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly clock = new SimClock();
  readonly weather = new WeatherModel();
  readonly audio = new Soundscape();
  readonly query: WorldQuery;
  readonly heightAt: (x: number, z: number) => number;
  readonly sun = new THREE.Vector3(0, 1, 0);
  readonly moon = new THREE.Vector3(0, -1, 0);
  private csm: CSM | null = null;
  private sky: Sky;
  private post: PostChain;
  private forest: Forest;
  private meadow: Meadow;
  private precip: Precipitation;
  private buildingsGroup: THREE.Group | null = null;
  private massGroup: THREE.Group | null = null;
  private world = new THREE.Group();
  private farMesh: THREE.Mesh | null = null;
  private propGroup: THREE.Group | null = null;
  private fenceMesh: THREE.Object3D | null = null;
  private waterMesh: THREE.Mesh | null = null;
  private torch: THREE.SpotLight;
  private ambient: THREE.AmbientLight;
  private pinsGroup = new THREE.Group();
  private surveyLine: THREE.Line;
  private surveyDots: THREE.Points;
  private gnomonGroup = new THREE.Group();
  private hypothesisGroup = new THREE.Group();
  private figuresGroup = new THREE.Group();
  private routeGroup = new THREE.Group();
  private markerGroup = new THREE.Group();
  private sightGroup = new THREE.Group();
  private travelTextures: THREE.Texture[] = [];
  /** A camera path takes over the eyes: the time machine's orbit, or a walk through saved studies. */
  cinema: { x: number; y: number; z: number; yaw: number; pitch: number } | null = null;
  private posedFigures: Figure[] = [];
  posedList: { id: string; x: number; z: number; yaw: number }[] = [];
  private avatar: Figure | null = null;
  private avatarKey = "";
  private bodyYaw = 0;
  /** Length of the camera boom in third person: aim and measures start past it, at the explorer's eyes. */
  private boom = 0;
  private rayGroup = new THREE.Group();
  private laserGroup = new THREE.Group();
  private floodMesh: THREE.Mesh | null = null;
  private drapeTexture: THREE.Texture | null = null;
  private projTexture: THREE.Texture | null = null;
  private absent = new Set<string>();
  private sunJitter = new THREE.Vector3();
  private fadeTarget: THREE.Texture | null = null;
  private plateTexture: THREE.Texture;
  private gainTexture: THREE.Texture;
  private classTexture: THREE.Texture;
  private placedProps: PlacedProp[] = [];

  settings: Settings;
  data: FieldData;
  plate: PlateState;
  hooks: EngineHooks = {};

  // Observer.
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  drone = false;
  droneNadir = false;
  crouch = false;
  grounded = true;
  torchOn = false;
  renderMode = 0;
  zoom = 1;
  zoomTarget = 1;
  hideWorldEdge = false;
  freeCursor = false;
  private breathe = 0;
  private bobPhase = 0;
  private bobY = 0;
  steps = 0;
  distance = 0;
  ascent = 0;
  private strideLeft = 0;
  private lastStepTimes: number[] = [];
  private stageLeft = 0;
  private keys = new Set<string>();
  private mouse = { dx: 0, dy: 0 };
  private running = false;
  private rafId = 0;
  private lastTime = 0;
  private fpsAcc = { t: 0, frames: 0, fps: 60 };
  private scale = 1;
  private resAcc = 0;
  private lookCache: Hit | null = null;
  private lookCounter = 0;
  private shaded = false;
  private shadeCounter = 0;
  private exposure = 1;
  private cloudOff = new THREE.Vector2();
  private size = { w: 2, h: 2 };
  private disposed = false;
  private lastTrack = new THREE.Vector2(Infinity, Infinity);
  private lastInfo = { calls: 0, triangles: 0 };
  onTrack: ((x: number, z: number) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement, data: FieldData, settings: Settings) {
    this.data = data;
    this.plate = data.plate;
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = true;
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.18, 40000);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.world, this.pinsGroup, this.gnomonGroup, this.hypothesisGroup, this.figuresGroup, this.routeGroup, this.markerGroup, this.sightGroup, this.rayGroup, this.laserGroup);

    this.heightAt = terrainSampler(data.terrain);
    this.query = new WorldQuery(this.heightAt);

    U.uNoise.value = makeNoiseTexture();
    U.uHalf.value.set(data.projection.halfX, data.projection.halfZ);
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.plateTexture = canvasTexture(this.plate.canvas, Math.min(12, aniso));
    this.gainTexture = dataTexture(this.plate.analysis.gainMap, this.plate.analysis.width, this.plate.analysis.height);
    this.classTexture = dataTexture(this.plate.analysis.classMap, this.plate.analysis.width, this.plate.analysis.height);
    U.uPlate.value = this.plateTexture;
    U.uPlateB.value = this.plateTexture;
    U.uGain.value = this.gainTexture;
    U.uClass.value = this.classTexture;
    if (data.far) {
      const farTexture = canvasTexture(data.far.plate, 8);
      U.uFarPlate.value = farTexture;
      U.uFarHalf.value = data.far.span / 2;
    } else U.uFarPlate.value = this.plateTexture;

    this.sky = new Sky(this.renderer, this.scene);
    this.post = new PostChain(this.renderer, this.sky.lutTexture);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.02);
    this.scene.add(this.ambient);
    this.torch = new THREE.SpotLight(0xfff0d8, 0, 60, 0.42, 0.55, 1.4);
    this.scene.add(this.torch, this.torch.target);
    this.precip = new Precipitation();
    this.scene.add(this.precip.mesh);

    this.buildCsm();
    this.forest = new Forest(this.plate.trees, this.heightAt, this.csm);
    this.meadow = new Meadow(this.plate.analysis.classMap, this.plate.analysis.width, this.plate.analysis.height, data.projection.halfX, data.projection.halfZ, this.heightAt, this.csm);
    this.buildWorld();

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(600), 3));
    this.surveyLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xff9d3c, depthTest: false, transparent: true }));
    this.surveyLine.frustumCulled = false;
    this.surveyLine.renderOrder = 20;
    this.surveyDots = new THREE.Points(lineGeo, new THREE.PointsMaterial({ color: 0xffd9a0, size: 6, sizeAttenuation: false, depthTest: false, transparent: true }));
    this.surveyDots.frustumCulled = false;
    this.surveyDots.renderOrder = 21;
    this.scene.add(this.surveyLine, this.surveyDots);
    this.surveyLine.geometry.setDrawRange(0, 0);

    // Starts on open ground as near to the centre as the map allows.
    const start = this.findOpenSpot(0, 0);
    this.pos.set(start.x, this.heightAt(start.x, start.z), start.z);

    this.weather.onBolt = (distance) => this.audio.thunder(distance);
    if (data.weather) {
      this.clock.timezone = data.weather.timezone;
      this.weather.setStation(data.weather);
      const read = this.weather.fromStationAt(Date.now());
      if (read) {
        this.weather.target = read;
        this.weather.now = { ...read };
      }
    }
    this.applySettings(settings);
    this.resize();
    this.listen();
  }

  findOpenSpot(x: number, z: number) {
    for (let r = 0; r < 400; r += 6) {
      for (let a = 0; a < 16; a++) {
        const px = x + Math.cos((a / 16) * Math.PI * 2) * r;
        const pz = z + Math.sin((a / 16) * Math.PI * 2) * r;
        if (!this.query.buildingAt(px, pz)) return { x: px, z: pz };
        if (r === 0) break;
      }
    }
    return { x, z };
  }

  private buildCsm() {
    const s = this.settings;
    if (this.csm) {
      this.csm.remove();
      this.csm.dispose();
      this.csm = null;
    }
    if (s.shadowSize <= 0) {
      this.renderer.shadowMap.enabled = false;
      const fallback = new THREE.DirectionalLight(0xffffff, 3);
      fallback.name = "fallback-sun";
      this.scene.add(fallback, fallback.target);
      return;
    }
    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: s.cascades,
      maxFar: s.shadowFar,
      mode: "practical",
      shadowMapSize: s.shadowSize,
      shadowBias: -0.00012,
      lightDirection: new THREE.Vector3(-0.4, -0.8, -0.4).normalize(),
      lightMargin: 400,
      lightNear: 1,
      lightFar: 6000,
      lightIntensity: 3,
    });
    this.csm.fade = true;
    for (const light of this.csm.lights) light.shadow.normalBias = 0.35;
    this.csm.updateFrustums();
  }

  private buildWorld() {
    const { data, csm } = this;
    this.world.clear();
    const terrain = buildTerrain(data.terrain, csm);
    this.world.add(terrain);
    if (data.far) {
      this.farMesh = buildFarField(data.far, data.terrain, data.projection.halfX, data.projection.halfZ, csm);
      this.world.add(this.farMesh);
    }
    this.rebuildBuildings();
    this.rebuildMasses();

    const water = buildWater(data.waterAreas, data.waterLines, this.heightAt, csm);
    this.waterMesh = water.mesh;
    this.world.add(water.mesh);

    const fences = buildFences(data.barriers, this.heightAt, csm);
    this.fenceMesh = fences.mesh;
    this.world.add(fences.mesh);
    this.query.setFences(fences.segments);

    const ribbons = buildRibbons(data.highways, data.railways, this.heightAt, csm);
    this.world.add(ribbons.mesh);
    this.query.decks = ribbons.decks;

    const props = buildProps(data.props, this.heightAt, csm);
    this.propGroup = props.group;
    this.placedProps = props.placed;
    this.world.add(props.group);
    this.query.setProps(props.placed);

    this.world.add(this.forest.group, this.meadow.mesh);
    this.query.setTrees(this.plate.trees);
  }

  /** Current building meshes for export: walls and roofs apart, since they carry different materials. */
  buildingMeshes() {
    const out: { mesh: THREE.Mesh; roof: boolean }[] = [];
    for (const group of [this.buildingsGroup, this.massGroup]) {
      group?.children.forEach((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) out.push({ mesh, roof: !mesh.geometry.getAttribute("aM") || (mesh.material as THREE.Material).side === THREE.DoubleSide });
      });
    }
    return out;
  }

  private rebuildBuildings() {
    if (this.buildingsGroup) {
      this.world.remove(this.buildingsGroup);
      this.buildingsGroup.traverse((child) => {
        if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
      });
    }
    const built = buildBuildings(this.data.buildings.filter((building) => !this.absent.has(building.id)), this.csm);
    this.buildingsGroup = built.group;
    this.world.add(built.group);
    this.syncCollisions();
  }

  private syncCollisions() {
    const s = this.settings;
    this.query.setBuildings([...(s.showBuildings ? this.data.buildings.filter((building) => !this.absent.has(building.id)) : []), ...(s.showMasses ? this.plate.masses : [])]);
  }

  /** Height changes and era changes both land here: geometry and collisions always agree. */
  refreshBuildings(absent: Set<string> = this.absent) {
    this.absent = absent;
    this.rebuildBuildings();
    this.applyVisibility();
  }

  /** After tree heights have been corrected in place. */
  refreshTrees() {
    this.forest.setTrees(this.plate.trees);
    this.query.setTrees(this.settings.showTrees ? this.plate.trees : []);
  }

  /** Top of whatever stands here, for sections and lines of sight. */
  surfaceAt = (x: number, z: number) => {
    const hit = this.query.buildingAt(x, z);
    return hit ? hit.top : this.heightAt(x, z);
  };

  // --- Research layers ---

  /** Spreads an image over the plate's rectangle. A canvas of any size, north up, with alpha where it has no data. */
  setDrape(canvas: HTMLCanvasElement | null, mix = 1) {
    this.drapeTexture?.dispose();
    this.drapeTexture = canvas ? canvasTexture(canvas, 8) : null;
    U.uDrape.value = this.drapeTexture ?? this.plateTexture;
    U.uDrapeMix.value = canvas ? mix : 0;
  }

  setProvenance(on: boolean) {
    U.uProv.value = on ? 1 : 0;
    this.forest.setProvenance(on);
  }

  setProjection(image: HTMLImageElement | HTMLCanvasElement | null, params?: { x: number; y: number; z: number; azimuth: number; fov: number; pano: boolean; mix: number; range: number }) {
    if (!image || !params) {
      U.uProjOn.value = 0;
      this.projTexture?.dispose();
      this.projTexture = null;
      return;
    }
    if (!this.projTexture || this.projTexture.image !== image) {
      this.projTexture?.dispose();
      const texture = new THREE.Texture(image as HTMLImageElement);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      this.projTexture = texture;
    }
    const width = (image as HTMLImageElement).naturalWidth || image.width;
    const height = (image as HTMLImageElement).naturalHeight || image.height;
    U.uProjTex.value = this.projTexture;
    U.uProjPos.value.set(params.x, params.y, params.z);
    U.uProjAz.value = (params.azimuth * Math.PI) / 180;
    U.uProjFov.value = params.fov;
    U.uProjAspect.value = width / Math.max(1, height);
    U.uProjPano.value = params.pano ? 1 : 0;
    U.uProjMix.value = params.mix;
    U.uProjRange.value = params.range;
    U.uProjOn.value = 1;
  }

  setHypotheses(list: Hypothesis[], draft: { x: number; z: number }[] = []) {
    this.hypothesisGroup.clear();
    for (const item of list) {
      if (item.ring.length < 6) continue;
      const contour: THREE.Vector2[] = [];
      let base = Infinity;
      for (let i = 0; i < item.ring.length; i += 2) {
        contour.push(new THREE.Vector2(item.ring[i], item.ring[i + 1]));
        base = Math.min(base, this.heightAt(item.ring[i]!, item.ring[i + 1]!));
      }
      const top = base + item.height;
      const positions: number[] = [];
      const edges: number[] = [];
      const n = contour.length;
      for (let i = 0; i < n; i++) {
        const a = contour[i]!;
        const b = contour[(i + 1) % n]!;
        positions.push(a.x, base, a.y, b.x, base, b.y, b.x, top, b.y, a.x, base, a.y, b.x, top, b.y, a.x, top, a.y);
        edges.push(a.x, base, a.y, a.x, top, a.y, a.x, top, a.y, b.x, top, b.y, a.x, base, a.y, b.x, base, b.y);
      }
      for (const face of THREE.ShapeUtils.triangulateShape(contour, [])) for (const k of face) positions.push(contour[k]!.x, top, contour[k]!.y);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const color = new THREE.Color(item.color);
      const ghost = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
      ghost.renderOrder = 8;
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edges, 3));
      const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, toneMapped: false }));
      lines.renderOrder = 9;
      this.hypothesisGroup.add(ghost, lines);
    }
    if (draft.length) {
      const points: number[] = [];
      for (const p of [...draft, ...(draft.length > 2 ? [draft[0]!] : [])]) points.push(p.x, this.heightAt(p.x, p.z) + 0.25, p.z);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffd27a, depthTest: false, transparent: true }));
      line.renderOrder = 20;
      this.hypothesisGroup.add(line);
    }
  }

  /** Each GEDI footprint as it really was: a 25 m ring on the ground, a beam up to the highest return, and a ring there. */
  setFootprints(shots: { x: number; z: number; topY: number; good: boolean }[]) {
    this.laserGroup.clear();
    if (!shots.length) return;
    const segments: Record<"good" | "poor", number[]> = { good: [], poor: [] };
    const sides = 28;
    for (const shot of shots) {
      const list = shot.good ? segments.good : segments.poor;
      const ground = this.heightAt(shot.x, shot.z) + 0.15;
      const top = Math.max(shot.topY, ground);
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const b = ((i + 1) / sides) * Math.PI * 2;
        const [ax, az, bx, bz] = [shot.x + Math.cos(a) * 12.5, shot.z + Math.sin(a) * 12.5, shot.x + Math.cos(b) * 12.5, shot.z + Math.sin(b) * 12.5];
        list.push(ax, this.heightAt(ax, az) + 0.15, az, bx, this.heightAt(bx, bz) + 0.15, bz);
        if (top - ground > 1) list.push(ax, top, az, bx, top, bz);
      }
      list.push(shot.x, ground, shot.z, shot.x, top, shot.z);
    }
    for (const [key, color, opacity] of [["good", 0x7fb4ff, 0.95], ["poor", 0x8f8f8c, 0.45]] as const) {
      if (!segments[key].length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(segments[key], 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, toneMapped: false }));
      lines.frustumCulled = false;
      lines.renderOrder = 18;
      this.laserGroup.add(lines);
    }
  }

  /** A sheet of water at this altitude. Walking stays on the bottom: nothing here pretends to be hydraulics. */
  setFlood(level: number | null) {
    if (level == null) {
      if (this.floodMesh) this.floodMesh.visible = false;
      return;
    }
    if (!this.floodMesh) {
      const span = (this.data.terrain.size - 1) * this.data.terrain.spacing;
      const geometry = new THREE.PlaneGeometry(span, span);
      geometry.rotateX(-Math.PI / 2);
      const material = shade(
        new THREE.MeshStandardMaterial({ color: 0x2f5560, roughness: 0.09, metalness: 0.05, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
        {
          key: "flood",
          noWeather: true,
          afterNormal: `
            vec2 fw = vec2(texture2D(uNoise, vW.xz * .05 + uTime * vec2(.006, .004)).a, texture2D(uNoise, vW.xz * .05 - uTime * vec2(.004, .007)).a) - .5;
            normal = normalize(normal + (viewMatrix * vec4(fw.x * .16, 0., fw.y * .16, 0.)).xyz);`,
        },
        this.csm,
      );
      this.floodMesh = new THREE.Mesh(geometry, material);
      this.floodMesh.renderOrder = 6;
      this.world.add(this.floodMesh);
    }
    this.floodMesh.visible = true;
    this.floodMesh.position.y = level;
  }

  /** Bearings drawn from a fixed point out to the horizon, above everything: solstices, axes, sightlines. */
  setRays(origin: { x: number; y: number; z: number } | null, rays: { azimuth: number; altitude?: number; color: string; length?: number }[] = []) {
    this.rayGroup.clear();
    if (!origin) return;
    for (const ray of rays) {
      const az = (ray.azimuth * Math.PI) / 180;
      const alt = ((ray.altitude ?? 0) * Math.PI) / 180;
      const length = ray.length ?? 2500;
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(origin.x, origin.y, origin.z),
        new THREE.Vector3(origin.x + Math.sin(az) * Math.cos(alt) * length, origin.y + Math.sin(alt) * length, origin.z - Math.cos(az) * Math.cos(alt) * length),
      ]);
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: ray.color, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false }));
      line.renderOrder = 22;
      line.frustumCulled = false;
      this.rayGroup.add(line);
    }
  }

  private rebuildMasses() {
    if (this.massGroup) {
      this.world.remove(this.massGroup);
      this.massGroup.traverse((child) => {
        if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
      });
    }
    const built = buildBuildings(this.plate.masses, this.csm);
    this.massGroup = built.group;
    this.world.add(built.group);
  }

  /** Goes to another shot of the same place: ground and roofs cross-fade, and trees and unmapped volumes are re-read from that shot. */
  setPlate(state: PlateState) {
    this.plate = state;
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    const next = canvasTexture(state.canvas, Math.min(12, aniso));
    U.uPlateB.value = next;
    U.uPlateMix.value = 0.0001;
    this.fadeTarget = next;
    this.gainTexture.dispose();
    this.classTexture.dispose();
    this.gainTexture = dataTexture(state.analysis.gainMap, state.analysis.width, state.analysis.height);
    this.classTexture = dataTexture(state.analysis.classMap, state.analysis.width, state.analysis.height);
    U.uGain.value = this.gainTexture;
    U.uClass.value = this.classTexture;
    this.forest.setTrees(state.trees);
    this.meadow.setClass(state.analysis.classMap);
    this.query.setTrees(state.trees);
    this.rebuildMasses();
    this.applyVisibility();
  }

  applyVisibility() {
    const s = this.settings;
    if (this.buildingsGroup) this.buildingsGroup.visible = s.showBuildings;
    if (this.massGroup) this.massGroup.visible = s.showMasses;
    this.forest.group.visible = s.showTrees;
    if (this.propGroup) this.propGroup.visible = s.showProps;
    if (this.fenceMesh) this.fenceMesh.visible = s.showFences;
    if (this.waterMesh) this.waterMesh.visible = s.showWater;
    if (this.farMesh) this.farMesh.visible = s.farField;
    this.syncCollisions();
    this.query.setProps(s.showProps ? this.placedProps : []);
    this.query.setTrees(s.showTrees ? this.plate.trees : []);
  }

  applySettings(next: Settings) {
    const previous = this.settings;
    const rebuild = previous.shadowSize !== next.shadowSize || previous.cascades !== next.cascades || previous.shadowFar !== next.shadowFar;
    this.settings = next;
    if (rebuild && this.csm) {
      this.csm.shadowMapSize = next.shadowSize;
      this.csm.maxFar = next.shadowFar;
      for (const light of this.csm.lights) {
        light.shadow.mapSize.set(next.shadowSize, next.shadowSize);
        light.shadow.map?.dispose();
        light.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      }
      this.csm.updateFrustums();
    }
    this.sky.setQuality(next.clouds);
    this.forest.setDetail(next.treeDensity, next.treeNear);
    this.meadow.density = next.grass;
    this.meadow.mesh.visible = next.grass > 0.01;
    U.uDeshadow.value = next.deshadow ? 1 : 0;
    U.uDetail.value = next.detail;
    U.uGrid.value = next.gridOverlay ? 1 : 0;
    this.camera.far = next.drawFar;
    this.syncAvatar();
    this.applyVisibility();
    this.resize();
  }

  // --- Input ---

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.isLocked && !this.freeCursor) return;
    this.keys.add(e.code);
    if (e.code === "KeyC") this.crouch = !this.crouch;
    if (e.code === "Space" && this.grounded && !this.drone) this.vel.y = 3.9;
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onMouse = (e: MouseEvent) => {
    if (!this.isLocked) return;
    // Browsers occasionally report one wild jump when the pointer is captured: it would spin the view.
    if (Math.abs(e.movementX) > 600 || Math.abs(e.movementY) > 600) return;
    this.mouse.dx += e.movementX;
    this.mouse.dy += e.movementY;
  };
  private onResize = () => this.resize();
  private onBlur = () => this.keys.clear();

  get isLocked() {
    return document.pointerLockElement === this.canvas;
  }

  /** Pointer released on the instruments without stopping: the walk goes on, the view stays put. */
  setFreeCursor(on: boolean) {
    this.freeCursor = on;
    if (on) this.unlock();
    else this.lock();
  }

  stopWalking() {
    this.keys.clear();
    this.freeCursor = false;
  }

  lock() {
    this.freeCursor = false;
    this.audio.start();
    const request = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    request?.catch?.(() => undefined);
  }

  unlock() {
    if (this.isLocked) document.exitPointerLock();
  }

  private listen() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouse);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("blur", this.onBlur);
  }

  resize() {
    const w = Math.max(2, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(2, this.canvas.clientHeight || window.innerHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * this.settings.renderScale * this.scale;
    const rw = Math.max(16, Math.round(w * pixelRatio));
    const rh = Math.max(16, Math.round(h * pixelRatio));
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(rw, rh, false);
    if (this.size.w !== rw || this.size.h !== rh) {
      this.size = { w: rw, h: rh };
      this.post.setSize(rw, rh);
      this.sky.setSize(rw, rh);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.csm?.updateFrustums();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.update(dt);
      this.render();
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouse);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("blur", this.onBlur);
    this.audio.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // --- Simulation ---

  private update(dt: number) {
    this.clock.tick(dt);
    const t = this.clock.t;
    this.weather.update(dt, t);
    const w = this.weather.now;
    const { lat0, lon0 } = this.data.projection;
    const date = this.clock.date;
    const sunPos = sunPosition(date, lat0, lon0);
    const moonPos = moonPosition(date, lat0, lon0);
    const sd = dirVector(sunPos.azimuth, sunPos.altitude);
    const md = dirVector(moonPos.azimuth, moonPos.altitude);
    this.sun.set(sd.x, sd.y, sd.z);
    this.moon.set(md.x, md.y, md.z);

    U.uTime.value += dt;
    this.moveObserver(dt);

    // Wetness lags rain and dries slowly in sun and wind; snow cover needs cold.
    const wetTarget = Math.min(1, w.rain * 0.6);
    const dry = 0.008 + w.wind * 0.0012 + Math.max(0, this.sun.y) * 0.012;
    U.uWet.value += (wetTarget > U.uWet.value ? (wetTarget - U.uWet.value) * dt * 0.25 : -dry * dt * Math.max(6, this.clockSpeed()));
    U.uWet.value = THREE.MathUtils.clamp(U.uWet.value, 0, 1);
    const snowTarget = w.snow > 0.02 && w.temp < 2.5 ? Math.min(1, w.snow * 0.6) : 0;
    U.uSnow.value += (snowTarget > U.uSnow.value ? (snowTarget - U.uSnow.value) * dt * 0.08 : w.temp > 1 ? -dt * 0.004 * Math.max(10, this.clockSpeed()) : 0);
    U.uSnow.value = THREE.MathUtils.clamp(U.uSnow.value, 0, 1);

    U.uCloud.value = w.cloud;
    const dirRad = ((w.windDir + 180) * Math.PI) / 180;
    const wx = Math.sin(dirRad) * w.wind;
    const wz = -Math.cos(dirRad) * w.wind;
    this.cloudOff.x += (wx * dt * (0.8 + this.clockSpeed() * 0.2)) * 0.000055 * 2.2;
    this.cloudOff.y += (wz * dt * (0.8 + this.clockSpeed() * 0.2)) * 0.000055 * 2.2;
    U.uCloudOff.value.copy(this.cloudOff);
    U.uWindVec.value.set(wx === 0 && wz === 0 ? 1 : wx / (w.wind || 1), wx === 0 && wz === 0 ? 0 : wz / (w.wind || 1));
    U.uWindAmp.value = 0.2 + Math.min(w.wind, 25) * 0.09;

    const main = this.sun.y > -0.03 ? this.sun : this.moon;
    U.uSunDir.value.copy(main);
    const night = 1 - THREE.MathUtils.smoothstep(this.sun.y, -0.1, 0.06);
    U.uNight.value = night;
    U.uCam.value.copy(this.camera.position);

    if (this.fadeTarget) {
      U.uPlateMix.value = Math.min(1, U.uPlateMix.value + dt * 0.9);
      if (U.uPlateMix.value >= 1) {
        this.plateTexture.dispose();
        this.plateTexture = this.fadeTarget;
        U.uPlate.value = this.plateTexture;
        U.uPlateMix.value = 0;
        this.fadeTarget = null;
      }
    }

    if (++this.shadeCounter > 20) {
      this.shadeCounter = 0;
      this.shaded = this.sun.y <= 0 || this.query.shadedFrom(this.pos.x, this.pos.y + 1.5, this.pos.z, this.sun.x, this.sun.y, this.sun.z);
    }

    this.forest.update(this.camera.position.x, this.camera.position.z);
    this.meadow.update(this.camera.position.x, this.camera.position.z);

    const greenery = (this.plate.analysis.stats.canopy + this.plate.analysis.stats.lawn) / (4 * this.data.projection.halfX * this.data.projection.halfZ);
    const dayAmount = THREE.MathUtils.smoothstep(this.sun.y, -0.05, 0.15);
    this.audio.update(dt, {
      volume: this.settings.volume,
      ambience: this.settings.ambience,
      wind: w.wind,
      rain: w.rain,
      urban: Math.min(1, this.data.buildings.length / (4 * this.data.projection.halfX * this.data.projection.halfZ) * 900) * 0.25,
      night,
      greenery: Math.min(1, greenery * 3),
      temp: w.temp,
      day: dayAmount,
      altitude: this.pos.y - this.heightAt(this.pos.x, this.pos.z),
    });

    this.fpsAcc.t += dt;
    this.fpsAcc.frames++;
    if (this.fpsAcc.t > 0.5) {
      this.fpsAcc.fps = this.fpsAcc.frames / this.fpsAcc.t;
      this.fpsAcc.t = 0;
      this.fpsAcc.frames = 0;
      this.resAcc += 0.5;
      if (this.settings.dynamicRes && this.resAcc >= 2) {
        this.resAcc = 0;
        const target = this.settings.targetFps;
        const before = this.scale;
        if (this.fpsAcc.fps < target * 0.82) this.scale = Math.max(0.5, this.scale * 0.88);
        else if (this.fpsAcc.fps > target * 1.2 && this.scale < 1) this.scale = Math.min(1, this.scale * 1.06);
        if (Math.abs(before - this.scale) > 0.001) this.resize();
      }
    }
  }

  private clockSpeed() {
    return this.clock.mode === "live" ? 1 : this.clock.paused ? 0 : Math.max(1, this.clock.rate);
  }

  private moveObserver(dt: number) {
    const s = this.settings;
    const look = 0.0021 * s.sensitivity / Math.max(1, this.zoom * 0.7);
    this.yaw -= this.mouse.dx * look;
    this.pitch -= this.mouse.dy * look * (s.invertY ? -1 : 1);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.54, 1.54);
    this.mouse.dx = 0;
    this.mouse.dy = 0;

    const k = this.keys;
    let mx = 0;
    let mz = 0;
    if (k.has("KeyW") || k.has("ArrowUp")) mz -= 1;
    if (k.has("KeyS") || k.has("ArrowDown")) mz += 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) mx -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) mx += 1;
    const len = Math.hypot(mx, mz) || 1;
    mx /= len;
    mz /= len;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const fx = mx * cos + mz * sin;
    const fz = -mx * sin + mz * cos;

    const { halfX, halfZ } = this.data.projection;
    if (this.drone) {
      const speed = (k.has("ShiftLeft") ? 26 : 9) * (1 + Math.max(0, this.pos.y - this.heightAt(this.pos.x, this.pos.z)) * 0.012);
      const climb = (k.has("Space") ? 1 : 0) - (k.has("KeyC") || k.has("ControlLeft") ? 1 : 0);
      this.pos.x = THREE.MathUtils.clamp(this.pos.x + fx * speed * dt, -halfX - 3000, halfX + 3000);
      this.pos.z = THREE.MathUtils.clamp(this.pos.z + fz * speed * dt, -halfZ - 3000, halfZ + 3000);
      this.pos.y = Math.max(this.heightAt(this.pos.x, this.pos.z) + 1, this.pos.y + climb * speed * 0.7 * dt);
      this.vel.set(0, 0, 0);
    } else {
      const moving = mx !== 0 || mz !== 0;
      const run = k.has("ShiftLeft") || k.has("ShiftRight");
      const speed = (run ? s.runSpeed : s.walkSpeed) * (this.crouch ? 0.5 : 1);
      const accel = this.grounded ? 12 : 2;
      this.vel.x += (fx * (moving ? speed : 0) - this.vel.x) * Math.min(1, accel * dt);
      this.vel.z += (fz * (moving ? speed : 0) - this.vel.z) * Math.min(1, accel * dt);
      const before = this.pos.clone();
      let nx = this.pos.x + this.vel.x * dt;
      let nz = this.pos.z + this.vel.z * dt;
      // Past the plate there is no information: the walker is held at its edge.
      const edge = 6;
      if (Math.abs(nx) > halfX + edge || Math.abs(nz) > halfZ + edge) {
        nx = THREE.MathUtils.clamp(nx, -halfX - edge, halfX + edge);
        nz = THREE.MathUtils.clamp(nz, -halfZ - edge, halfZ + edge);
        this.hooks.onEdge?.();
      }
      const solved = this.query.collide(nx, nz, this.pos.y, 0.32);
      this.pos.x = solved.x;
      this.pos.z = solved.z;
      const floor = this.query.floorAt(this.pos.x, this.pos.z, this.pos.y);
      if (s.gravity) {
        this.vel.y -= 9.81 * dt;
        this.pos.y += this.vel.y * dt;
        if (this.pos.y <= floor) {
          // Ease up small steps instead of snapping: terrain grids otherwise jitter the eye.
          const gap = floor - this.pos.y;
          this.pos.y = gap < 0.6 ? this.pos.y + gap * Math.min(1, dt * 14) : floor;
          if (this.pos.y < floor - 0.3) this.pos.y = floor - 0.3;
          this.vel.y = 0;
          this.grounded = true;
        } else this.grounded = this.pos.y - floor < 0.08;
      } else {
        this.pos.y = floor;
        this.grounded = true;
      }
      const moved = Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
      if (this.grounded && moved > 0.0001) {
        const rise = this.pos.y - before.y;
        if (rise > 0) this.ascent += rise;
        this.distance += moved;
        this.strideLeft -= moved;
        this.bobPhase += moved * (Math.PI * 2) / (s.stride * 2);
        if (this.strideLeft <= 0) {
          this.strideLeft = s.stride * (run ? 1.3 : 1);
          this.steps++;
          const now = performance.now();
          this.lastStepTimes.push(now);
          if (this.lastStepTimes.length > 12) this.lastStepTimes.shift();
          this.audio.step(this.surfaceUnder(), U.uWet.value, 0.28 + (run ? 0.1 : 0));
        }
        this.stageLeft -= moved;
        if (this.stageLeft <= 0) {
          this.stageLeft = s.stageMeters;
          if (s.autoLog) this.hooks.onStage?.();
        }
      }
      if (this.lastTrack.distanceTo(new THREE.Vector2(this.pos.x, this.pos.z)) > 8) {
        this.lastTrack.set(this.pos.x, this.pos.z);
        this.onTrack?.(this.pos.x, this.pos.z);
      }
    }

    this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 7);
    const baseFov = s.fov;
    const fov = (2 * Math.atan(Math.tan((baseFov * Math.PI) / 360) / Math.max(1, this.zoom)) * 180) / Math.PI;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    const eye = this.drone ? 0 : (this.crouch ? s.eye * 0.58 : s.eye);
    const speedNow = Math.hypot(this.vel.x, this.vel.z);
    this.bobY = Math.sin(this.bobPhase) * 0.024 * s.bob * Math.min(1, speedNow / 1.2);
    this.breathe += dt;
    const sway = this.zoom > 1.5 ? 0.00034 * this.zoom * (this.crouch ? 0.35 : 1) : 0;
    this.camera.position.set(this.pos.x, this.pos.y + eye + this.bobY, this.pos.z);
    this.camera.rotation.set(
      this.droneNadir && this.drone ? -Math.PI / 2 : this.pitch + Math.sin(this.breathe * 0.9) * sway,
      this.yaw + Math.sin(this.breathe * 0.63) * sway * 0.7,
      Math.sin(this.bobPhase * 0.5) * 0.0018 * s.bob * Math.min(1, speedNow / 1.2),
    );
    this.boom = 0;
    const outside = s.thirdPerson && !this.drone;
    if (this.avatar) {
      this.avatar.group.visible = outside;
      if (outside) {
        if (speedNow > 0.2) this.bodyYaw = Math.atan2(-this.vel.x, -this.vel.z);
        else if (Math.abs(((this.bodyYaw - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 1.2) this.bodyYaw = this.yaw;
        this.avatar.group.position.copy(this.pos);
        this.avatar.group.rotation.y = this.bodyYaw;
        this.avatar.group.scale.y = this.crouch ? 0.62 : 1;
        poseFigure(this.avatar, this.bobPhase, speedNow);
        // The boom shortens against ground and walls, rather than passing through them.
        this.camera.updateMatrixWorld();
        const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
        const side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const reach = 2.2 + s.altEgoHeight * 1.1;
        const p = new THREE.Vector3();
        while (this.boom < reach) {
          p.copy(this.camera.position).addScaledVector(back, this.boom + 0.3).addScaledVector(side, 0.45);
          if (p.y < this.heightAt(p.x, p.z) + 0.3) break;
          const wall = this.query.buildingAt(p.x, p.z);
          if (wall && p.y < wall.top) break;
          this.boom += 0.3;
        }
        this.camera.position.addScaledVector(back, this.boom).addScaledVector(side, this.boom > 0.6 ? 0.45 : 0);
      }
    }
    if (this.cinema) {
      this.boom = 0;
      if (this.avatar) this.avatar.group.visible = false;
      this.camera.position.set(this.cinema.x, this.cinema.y, this.cinema.z);
      this.camera.rotation.set(this.cinema.pitch, this.cinema.yaw, 0);
    }
    this.camera.updateMatrixWorld();

    if (this.torchOn) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.torch.position.copy(this.camera.position).addScaledVector(new THREE.Vector3(0, -0.2, 0), 1);
      this.torch.target.position.copy(this.camera.position).addScaledVector(forward, 10);
      this.torch.target.updateMatrixWorld();
      this.torch.intensity = 90;
    } else this.torch.intensity = 0;

    if (++this.lookCounter > 5) {
      this.lookCounter = 0;
      this.lookCache = this.castLook();
    }
  }

  private surfaceUnder(): "erba" | "pietra" | "terra" | "tetto" {
    const a = this.plate.analysis;
    const { halfX, halfZ } = this.data.projection;
    if (this.pos.y - this.heightAt(this.pos.x, this.pos.z) > 1) return "tetto";
    const u = Math.floor(((this.pos.x + halfX) / (2 * halfX)) * a.width);
    const v = Math.floor(((this.pos.z + halfZ) / (2 * halfZ)) * a.height);
    if (u < 0 || v < 0 || u >= a.width || v >= a.height) return "terra";
    const k = (v * a.width + u) * 4;
    if (a.classMap[k]! > 128 || a.classMap[k + 1]! > 128) return "erba";
    return a.classMap[k + 3]! > 90 ? "pietra" : "terra";
  }

  castLook(): Hit {
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    // Past the boom: what stands behind the explorer's back is not what the explorer is aiming at.
    const o = this.camera.position;
    return this.query.raycast(o.x + d.x * this.boom, o.y + d.y * this.boom, o.z + d.z * this.boom, d.x, d.y, d.z);
  }

  /** Puts the observer's feet on a building's roof: the telescopic ladder. */
  climb(building: Building) {
    this.pos.y = building.top - building.roofHeight * 0.5 + 0.05;
    this.vel.set(0, 0, 0);
    this.grounded = true;
  }

  descendToGround() {
    const spot = this.findOpenSpot(this.pos.x, this.pos.z);
    this.pos.set(spot.x, this.heightAt(spot.x, spot.z), spot.z);
    this.vel.set(0, 0, 0);
  }

  setDrone(on: boolean) {
    if (on === this.drone) return;
    this.drone = on;
    if (on) this.pos.y += 25;
    else {
      const spot = this.findOpenSpot(this.pos.x, this.pos.z);
      this.pos.set(spot.x, this.heightAt(spot.x, spot.z), spot.z);
      this.droneNadir = false;
    }
  }

  teleport(x: number, z: number) {
    const spot = this.findOpenSpot(x, z);
    this.pos.set(spot.x, this.heightAt(spot.x, spot.z), spot.z);
    this.vel.set(0, 0, 0);
  }

  private altEgo(): AltEgo {
    const s = this.settings;
    return { height: s.altEgoHeight, shoulders: s.altEgoShoulders, build: s.altEgoBuild, shirt: s.altEgoShirt, trousers: s.altEgoTrousers, skin: s.altEgoSkin };
  }

  private syncAvatar() {
    const alt = this.altEgo();
    const key = JSON.stringify(alt);
    if (key === this.avatarKey) return;
    this.avatarKey = key;
    if (this.avatar) {
      this.scene.remove(this.avatar.group);
      this.avatar.dispose();
    }
    this.avatar = buildFigure(alt, this.csm);
    this.avatar.group.visible = false;
    this.scene.add(this.avatar.group);
    this.setFigures(this.posedList);
  }

  /** Copies of the explorer left in the world. The label keeps its size at any distance: from afar the figure is a speck, and that is the point. */
  setFigures(list: { id: string; x: number; z: number; yaw: number }[]) {
    this.posedList = list;
    for (const figure of this.posedFigures) figure.dispose();
    this.posedFigures = [];
    this.figuresGroup.clear();
    const h = this.settings.altEgoHeight;
    for (const row of list) {
      const figure = buildFigure(this.altEgo(), this.csm);
      figure.group.position.set(row.x, this.heightAt(row.x, row.z), row.z);
      figure.group.rotation.y = row.yaw;
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "rgba(16,20,16,.82)";
      ctx.fillRect(0, 0, 256, 64);
      ctx.fillStyle = "#eae2cf";
      ctx.font = "34px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`Tu, ${h.toFixed(2)} m`, 128, 34);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false, toneMapped: false }));
      label.scale.set(0.12, 0.03, 1);
      label.position.y = h + 0.5;
      label.renderOrder = 12;
      figure.group.add(label);
      this.figuresGroup.add(figure.group);
      this.posedFigures.push(figure);
    }
  }

  /** Routes as ribbons laid on the ground, a little above it so the terrain does not swallow them. */
  setRoutes(list: { id: string; points: { x: number; z: number }[]; color: string }[]) {
    for (const child of this.routeGroup.children) (child as THREE.Mesh).geometry.dispose();
    this.routeGroup.clear();
    for (const route of list) {
      const dense: { x: number; z: number }[] = [];
      for (let i = 0; i + 1 < route.points.length; i++) {
        const a = route.points[i]!;
        const b = route.points[i + 1]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 6));
        for (let s = 0; s < steps; s++) dense.push({ x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps });
      }
      const last = route.points[route.points.length - 1];
      if (last) dense.push(last);
      if (dense.length < 2) continue;
      const positions: number[] = [];
      const index: number[] = [];
      const half = 1.1;
      dense.forEach((p, i) => {
        const prev = dense[Math.max(0, i - 1)]!;
        const next = dense[Math.min(dense.length - 1, i + 1)]!;
        const len = Math.hypot(next.x - prev.x, next.z - prev.z) || 1;
        const nx = -(next.z - prev.z) / len;
        const nz = (next.x - prev.x) / len;
        const lx = p.x + nx * half;
        const lz = p.z + nz * half;
        const rx = p.x - nx * half;
        const rz = p.z - nz * half;
        positions.push(lx, this.heightAt(lx, lz) + 0.7, lz, rx, this.heightAt(rx, rz) + 0.7, rz);
        if (i) index.push((i - 1) * 2, (i - 1) * 2 + 1, i * 2, i * 2, (i - 1) * 2 + 1, i * 2 + 1);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(index);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: route.color, transparent: true, opacity: 0.86, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
      mesh.frustumCulled = false;
      mesh.renderOrder = 7;
      this.routeGroup.add(mesh);
    }
  }

  /** Numbered places to go and see: a pole and a label that keeps its size, so they are found from far off. */
  setMarkers(list: { id: string; x: number; z: number; label: string; color: string }[]) {
    this.markerGroup.clear();
    for (const row of list) {
      const group = new THREE.Group();
      group.position.set(row.x, this.heightAt(row.x, row.z), row.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 10, 6), new THREE.MeshBasicMaterial({ color: row.color, toneMapped: false }));
      pole.position.y = 5;
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = row.color;
      ctx.fillRect(0, 0, 96, 64);
      ctx.fillStyle = "#14170f";
      ctx.font = "600 42px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(row.label, 48, 34);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      // Hidden by what stands in front: seen through every wall, twenty-five numbers would bury the view.
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true, sizeAttenuation: false, toneMapped: false }));
      label.scale.set(0.04, 0.0267, 1);
      label.position.y = 11;
      label.renderOrder = 12;
      group.add(pole, label);
      this.markerGroup.add(group);
    }
  }

  setSights(list: { a: { x: number; z: number }; b: { x: number; z: number } }[]) {
    for (const child of this.sightGroup.children) (child as THREE.LineSegments).geometry.dispose();
    this.sightGroup.clear();
    if (!list.length) return;
    const positions: number[] = [];
    const eye = this.settings.eye;
    for (const { a, b } of list) positions.push(a.x, this.heightAt(a.x, a.z) + eye, a.z, b.x, this.heightAt(b.x, b.z) + eye, b.z);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x7cc4ff, transparent: true, opacity: 0.9, toneMapped: false }));
    lines.frustumCulled = false;
    this.sightGroup.add(lines);
  }

  /** The ground as a film: every shot on the GPU, and two neighbours mixed at any moment between them. */
  travelStart(canvases: HTMLCanvasElement[]) {
    if (this.fadeTarget) {
      this.plateTexture.dispose();
      this.plateTexture = this.fadeTarget;
      U.uPlate.value = this.plateTexture;
      U.uPlateMix.value = 0;
      this.fadeTarget = null;
    }
    this.travelTextures = canvases.map((canvas) => canvasTexture(canvas, 8));
    // The shadow removal map belongs to one plate: on the others it would paint that plate's shadows.
    U.uDeshadow.value = 0;
  }

  travelSet(t: number) {
    const n = this.travelTextures.length - 1;
    if (n < 1) return;
    const f = Math.max(0, Math.min(1, t)) * n;
    const i = Math.min(n - 1, Math.floor(f));
    U.uPlate.value = this.travelTextures[i]!;
    U.uPlateB.value = this.travelTextures[i + 1]!;
    U.uPlateMix.value = f - i;
  }

  travelEnd() {
    U.uPlate.value = this.plateTexture;
    U.uPlateMix.value = 0;
    U.uDeshadow.value = this.settings.deshadow ? 1 : 0;
    for (const texture of this.travelTextures) texture.dispose();
    this.travelTextures = [];
  }

  setPins(pins: Pin[]) {
    this.pinsGroup.clear();
    for (const pin of pins) {
      const group = new THREE.Group();
      const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 1.5, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.8 }));
      stake.position.y = 0.72;
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.22), new THREE.MeshStandardMaterial({ color: pin.color, emissive: pin.color, emissiveIntensity: 0.25, side: THREE.DoubleSide }));
      flag.position.set(0.19, 1.34, 0);
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 96;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "rgba(16,20,16,.78)";
      ctx.fillRect(0, 0, 512, 96);
      ctx.fillStyle = "#eae2cf";
      ctx.font = "44px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(pin.label.slice(0, 22), 256, 50);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true, sizeAttenuation: true, toneMapped: false }));
      label.scale.set(1.4, 0.27, 1);
      label.position.y = 1.78;
      group.add(stake, flag, label);
      group.position.set(pin.x, pin.y, pin.z);
      this.pinsGroup.add(group);
    }
  }

  setSurvey(points: { x: number; y: number; z: number }[]) {
    const attribute = this.surveyLine.geometry.getAttribute("position") as THREE.BufferAttribute;
    const count = Math.min(points.length, 200);
    for (let i = 0; i < count; i++) attribute.setXYZ(i, points[i]!.x, points[i]!.y + 0.02, points[i]!.z);
    attribute.needsUpdate = true;
    this.surveyLine.geometry.setDrawRange(0, count);
  }

  plantGnomon(x: number, z: number, height: number) {
    this.gnomonGroup.clear();
    const y = this.heightAt(x, z);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, height, 8), new THREE.MeshStandardMaterial({ color: 0xc94a2a, roughness: 0.6 }));
    rod.position.set(x, y + height / 2, z);
    rod.castShadow = true;
    this.gnomonGroup.add(rod);
    return { x, y, z };
  }

  clearGnomon() {
    this.gnomonGroup.clear();
  }

  snapshot(): Snapshot {
    const sunPos = sunPosition(this.clock.date, this.data.projection.lat0, this.data.projection.lon0);
    const moonPos = moonPosition(this.clock.date, this.data.projection.lat0, this.data.projection.lon0);
    const { lat, lon } = this.data.projection.toLatLon(this.pos.x, this.pos.z);
    const ground = this.heightAt(this.pos.x, this.pos.z);
    const e = 2.5;
    const dzdx = (this.heightAt(this.pos.x + e, this.pos.z) - this.heightAt(this.pos.x - e, this.pos.z)) / (2 * e);
    const dzdz = (this.heightAt(this.pos.x, this.pos.z + e) - this.heightAt(this.pos.x, this.pos.z - e)) / (2 * e);
    // Downhill direction: −gradient; bearing from north, z points south.
    const aspect = (Math.atan2(-dzdx, dzdz) * 180) / Math.PI;
    const now = performance.now();
    const times = this.lastStepTimes;
    const cadence = times.length >= 2 && now - times[times.length - 1]! < 2200 ? ((times.length - 1) / (times[times.length - 1]! - times[0]!)) * 60000 : 0;
    return {
      x: this.pos.x,
      y: this.pos.y,
      z: this.pos.z,
      lat,
      lon,
      ground,
      heading: ((-this.yaw * 180) / Math.PI + 3600) % 360,
      pitch: (this.pitch * 180) / Math.PI,
      speed: Math.hypot(this.vel.x, this.vel.z),
      steps: this.steps,
      distance: this.distance,
      cadence,
      onRoof: this.pos.y - ground > 1.2 && !this.drone,
      drone: this.drone,
      sunAz: sunPos.azimuth,
      sunAlt: sunPos.altitude,
      moonAz: moonPos.azimuth,
      moonAlt: moonPos.altitude,
      moonIllum: moonPos.illumination,
      shaded: this.shaded,
      slope: (Math.atan(Math.hypot(dzdx, dzdz)) * 180) / Math.PI,
      aspect: (aspect + 360) % 360,
      fps: this.fpsAcc.fps,
      scale: this.scale,
      locked: this.isLocked,
      zoom: this.zoom,
      ascent: this.ascent,
      look: this.lookCache,
    };
  }

  render() {
    if (this.disposed) return;
    const w = this.weather.now;
    const s = this.settings;
    const camera = this.camera;
    const fogGrey = THREE.MathUtils.smoothstep(25000 - w.visibility, 8000, 24000);
    const turbidity = 1 + w.humidity * 0.009 + (w.visibility < 15000 ? (15000 - w.visibility) * 0.00016 : 0);
    const sun = this.sun;
    const dirIsMoon = sun.y < -0.03;
    const dir = dirIsMoon ? this.moon : sun;
    const sidereal = (this.clock.t / 86164090) * Math.PI * 2;
    this.sky.update({ sun, moon: this.moon, moonIllum: 0, turbidity, cloud: w.cloud, fogGrey: Math.max(fogGrey * 0.9, w.visibility < 3000 ? 0.9 : 0), lightning: this.weather.lightning, camera, sidereal, groundY: Math.max(0, this.pos.y) });

    const sunI = THREE.MathUtils.smoothstep(sun.y, -0.03, 0.08);
    const lightColor = dirIsMoon ? new THREE.Color(0.5, 0.56, 0.74) : this.sky.sunColor;
    const moonLight = dirIsMoon ? Math.max(0, this.moon.y) * 0.7 : 0;
    const intensity = dirIsMoon ? moonLight : 4.1 * sunI;
    const lightDir = new THREE.Vector3(-dir.x, -Math.max(dir.y, 0.03), -dir.z).add(this.sunJitter).normalize();
    if (this.csm) {
      this.csm.lightDirection.copy(lightDir);
      for (const light of this.csm.lights) {
        light.color.copy(lightColor);
        light.intensity = intensity;
      }
      this.csm.update();
    }
    this.scene.environmentIntensity = 1.25 + 0.35 * w.cloud;
    this.ambient.intensity = 0.02 + this.weather.lightning * 1.8;
    this.ambient.color.setRGB(0.5, 0.55, 0.8);

    const light = this.sky.ambientColor.clone().multiplyScalar(0.95);
    this.precip.update(camera, w.rain, w.snow, U.uWindVec.value.clone().multiplyScalar(w.wind), light);

    // Eyes adapt: night needs far more gain than a clear noon, but never enough to turn it into day.
    const skyLevel = 0.03 + Math.max(0, sun.y) * 1.3 + (dirIsMoon ? 0 : 0.14);
    const target = s.autoExposure ? Math.min(6.5, 0.72 / Math.pow(skyLevel * (1 - w.cloud * 0.4), 0.6)) : 1;
    // Heavy rain clouds are optically thick: the eye adapts to a gloom, not to a normal day.
    const gloom = 1 - 0.5 * Math.min(1, w.rain / 12) * THREE.MathUtils.smoothstep(w.cloud, 0.7, 1);
    this.exposure += (target * gloom - this.exposure) * 0.02;

    this.renderer.setRenderTarget(this.post.scene);
    this.renderer.clear();
    this.renderer.render(this.scene, camera);
    this.lastInfo = { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
    this.post.render({
      camera,
      aoStrength: s.ao,
      visibility: Math.max(40, w.visibility),
      aerial: s.aerial,
      fogLight: light.multiplyScalar(0.9),
      sun,
      fogGrey: w.visibility < 12000 ? 1 : fogGrey,
      exposure: this.exposure * s.exposure,
      bloom: s.bloom,
      vignette: s.vignette,
      grain: s.grain,
      saturation: s.saturation,
      tone: TONE[s.tonemap],
      mode: this.renderMode,
      time: this.clock.t / 1000 % 1000,
      lightning: this.weather.lightning,
    });
  }

  /** Grabs the frame just drawn; the drawing buffer is only valid until the browser composites. */
  photograph(maxWidth = 1600) {
    this.render();
    const source = this.renderer.domElement;
    const scale = Math.min(1, maxWidth / source.width);
    const out = document.createElement("canvas");
    out.width = Math.round(source.width * scale);
    out.height = Math.round(source.height * scale);
    out.getContext("2d")!.drawImage(source, 0, 0, out.width, out.height);
    return out;
  }

  /**
   * A long exposure: many frames with the camera shifted under a pixel and the sun spread over its true disc.
   * Edges resolve and shadows gain their real penumbra, which a single frame cannot show.
   */
  async photographLong(frames: number, onProgress?: (done: number) => void, maxWidth = 2400) {
    const camera = this.camera;
    const previousScale = this.scale;
    const grain = this.settings.grain;
    this.settings.grain = 0;
    if (this.scale < 1) {
      this.scale = 1;
      this.resize();
    }
    const source = this.renderer.domElement;
    const scale = Math.min(1, maxWidth / source.width);
    const out = document.createElement("canvas");
    out.width = Math.round(source.width * scale);
    out.height = Math.round(source.height * scale);
    const ctx = out.getContext("2d")!;
    const sunRadius = 0.00465 * 2.2;
    this.stop();
    try {
      for (let i = 0; i < frames; i++) {
        // Halton (2,3): even coverage for any number of frames.
        const halton = (index: number, base: number) => {
          let f = 1;
          let r = 0;
          let n = index;
          while (n > 0) {
            f /= base;
            r += f * (n % base);
            n = Math.floor(n / base);
          }
          return r;
        };
        const jx = halton(i + 1, 2) - 0.5;
        const jy = halton(i + 1, 3) - 0.5;
        camera.setViewOffset(source.width, source.height, jx, jy, source.width, source.height);
        const a = Math.sqrt(halton(i + 1, 5)) * sunRadius;
        const b = halton(i + 1, 7) * Math.PI * 2;
        this.sunJitter.set(Math.cos(b) * a, 0, Math.sin(b) * a);
        this.render();
        ctx.globalAlpha = 1 / (i + 1);
        ctx.drawImage(source, 0, 0, out.width, out.height);
        onProgress?.(i + 1);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    } finally {
      camera.clearViewOffset();
      this.sunJitter.set(0, 0, 0);
      this.settings.grain = grain;
      this.scale = previousScale;
      this.resize();
      this.start();
    }
    return out;
  }

  /** Numbers the instruments need at a glance. */
  debug() {
    return this.lastInfo;
  }
}
