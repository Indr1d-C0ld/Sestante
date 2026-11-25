import * as THREE from "three";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, PMREMGenerator, RenderPipeline, WebGPURenderer } from "three/webgpu";
import { abs, cameraPosition, cameraViewMatrix, clamp, exp, float, Fn, getViewPosition, int, max, mix, mrt, normalView, output, pass, pmremTexture, positionWorld, screenUV, pow, select, smoothstep, texture, uniform, vec2, vec3, vec4 } from "three/tsl";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import { PORTED } from "./gpuMaterials.ts";
import { GROUND_LAYERS } from "./ground.ts";
import { U } from "./shading.ts";

/**
 * The WebGPU engine, beside the WebGL2 one and chosen by a setting. three's WebGPURenderer runs TSL node materials, so
 * the GLSL patches of shade() cannot come along: each material is ported by its key, one at a time, and every key not
 * yet ported falls back to a plain material and is listed, so the gap is always visible. Where the browser has no
 * WebGPU, the same renderer draws through WebGL2.
 */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- TSL nodes are untyped chains

const PLACEHOLDER = (() => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.needsUpdate = true;
  return t;
})();

/** TSL uniforms mirroring U, synced once a frame: the WebGL2 code keeps writing U as before. */
class Bridge {
  private values = new Map<string, Any>();
  private textures = new Map<string, Any[]>();

  value(name: keyof typeof U): Any {
    let node = this.values.get(name);
    if (!node) {
      const v = U[name].value as unknown;
      node = typeof v === "number" ? uniform(v) : v instanceof THREE.Vector2 ? uniform(v.clone()) : v instanceof THREE.Vector3 ? uniform(v.clone()) : uniform(0);
      this.values.set(name, node);
    }
    return node;
  }

  /** A sample of one of U's textures; every sample is kept so a later swap of the texture reaches all of them. */
  sample(name: keyof typeof U, uv: Any, bias?: Any): Any {
    const current = (U[name].value as THREE.Texture | null) ?? PLACEHOLDER;
    let node = texture(current, uv);
    if (bias) node = node.bias(bias);
    const list = this.textures.get(name) ?? [];
    list.push(node);
    this.textures.set(name, list);
    return node;
  }

  sync() {
    for (const [name, node] of this.values) {
      const v = U[name as keyof typeof U].value as unknown;
      if (typeof v === "number") node.value = v;
      else if (v instanceof THREE.Vector2 || v instanceof THREE.Vector3) node.value.copy(v);
    }
    for (const [name, nodes] of this.textures) {
      const t = (U[name as keyof typeof U].value as THREE.Texture | null) ?? PLACEHOLDER;
      for (const node of nodes) if (node.value !== t) node.value = t;
    }
  }
}

/** `reason` says why WebGL2 draws when it does: the browser has no WebGPU, its WebGPU is software only, or it was asked. */
export type GpuReport = { backend: "WebGPU" | "WebGL2" | "in avvio"; reason: string | null; ported: string[]; missing: string[]; hidden: string[] };

export class GpuView {
  renderer: WebGPURenderer | null = null;
  readonly ready: Promise<void>;
  isReady = false;
  readonly bridge = new Bridge();
  private converted = new WeakMap<THREE.Material, THREE.Material>();
  private sky: SkyMesh;
  private sunLight: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private csm: Any = null;
  readonly report: GpuReport = { backend: "in avvio", reason: null, ported: [], missing: [], hidden: [] };
  private size = { w: 2, h: 2 };
  private pipeline: RenderPipeline | null = null;
  private aoStrength = uniform(0.8);
  private aoNode: Any = null;
  private bloomNode: Any = null;
  private pmrem: PMREMGenerator | null = null;
  private envSky: SkyMesh | null = null;
  private envScene = new THREE.Scene();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envSun = new THREE.Vector3(0, -2, 0);
  private visibility = uniform(30000);
  private aerial = uniform(1);
  private grey = uniform(0);
  private greyLight = uniform(new THREE.Color(0.7, 0.72, 0.76));
  private hazeNode: Any = null;
  sunColor = new THREE.Color(1, 0.96, 0.9);
  ambientColor = new THREE.Color(0.5, 0.6, 0.75);

  constructor(canvas: HTMLCanvasElement, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, shadow: { size: number; cascades: number; far: number }, forceWebGL = false) {
    this.ready = (async () => {
      // A software adapter (SwiftShader, a "fallback adapter") is slower than WebGL2 on the real GPU, and here it drew black.
      let reason: string | null = forceWebGL ? "richiesto" : null;
      if (!reason) {
        const gpu = (navigator as Any).gpu;
        const adapter = gpu ? await gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null) : null;
        const info = adapter?.info ?? {};
        if (!gpu) reason = "il browser non offre WebGPU";
        else if (!adapter) reason = "nessuna scheda grafica per WebGPU";
        else if (info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`)) reason = "WebGPU solo in software";
      }
      const renderer = new WebGPURenderer({ canvas, antialias: false, powerPreference: "high-performance", forceWebGL: reason !== null });
      renderer.toneMapping = THREE.AgXToneMapping;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = shadow.size > 0;
      await renderer.init();
      const backend = (renderer as Any).backend;
      this.report.backend = backend?.isWebGPUBackend ? "WebGPU" : "WebGL2";
      this.report.reason = this.report.backend === "WebGL2" ? (reason ?? "WebGPU non avviato") : null;
      this.renderer = renderer;
      renderer.setPixelRatio(1);
      renderer.setSize(this.size.w, this.size.h, false);
      this.buildPipeline(renderer);
      this.pmrem = new PMREMGenerator(renderer);
      this.isReady = true;
    })();

    this.sky = new SkyMesh();
    this.sky.scale.setScalar(450000);
    (this.sky as Any).turbidity.value = 2.5;
    (this.sky as Any).rayleigh.value = 1.2;
    (this.sky.material as Any).fog = false;
    scene.add(this.sky);
    // The same sky, alone, lights the world as an environment: what the WebGL2 engine draws as its own LUT dome.
    this.envSky = new SkyMesh();
    this.envSky.scale.setScalar(1000);
    (this.envSky as Any).turbidity.value = 2.5;
    (this.envSky as Any).rayleigh.value = 1.2;
    this.envScene.add(this.envSky);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.castShadow = shadow.size > 0;
    this.sunLight.shadow.mapSize.set(shadow.size || 1024, shadow.size || 1024);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 6000;
    this.sunLight.shadow.bias = -0.00012;
    this.sunLight.shadow.normalBias = 0.35;
    if (shadow.size > 0) {
      this.csm = new CSMShadowNode(this.sunLight, { cascades: shadow.cascades, maxFar: shadow.far, mode: "practical", lightMargin: 400 });
      this.csm.fade = true;
      (this.sunLight.shadow as Any).shadowNode = this.csm;
    }
    scene.add(this.sunLight, this.sunLight.target);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x6b5a48, 0.9);
    scene.add(this.hemi);
  }

  /**
   * After the scene: occlusion from depth and normals (GTAO, at half resolution) and bloom. Tone mapping and the
   * conversion to sRGB come last, in the pipeline's own output transform.
   */
  private buildPipeline(renderer: WebGPURenderer) {
    const scenePass = pass(this.scene, this.camera);
    // Normals stay unpacked in the half-float target: GTAO samples them as they are.
    scenePass.setMRT(mrt({ output, normal: normalView }));
    const color = scenePass.getTextureNode("output");
    const depth = scenePass.getTextureNode("depth");
    const normal = scenePass.getTextureNode("normal");
    this.aoNode = ao(depth, normal, this.camera);
    this.aoNode.resolutionScale = 0.5;
    this.aoNode.radius.value = 1.6;
    this.aoNode.thickness.value = 2;
    const occlusion = mix(float(1), this.aoNode.getTextureNode().r, this.aoStrength);
    this.shaded = vec4(color.rgb.mul(occlusion), color.a);
    this.depth = depth;
    this.pipeline = new RenderPipeline(renderer);
    this.compose(null);
  }

  private shaded: Any = null;
  private depth: Any = null;

  /** The output: the shaded scene, through the aerial perspective once there is an environment to take its colour from, then bloom. */
  private compose(env: THREE.Texture | null) {
    const pipeline = this.pipeline!;
    this.env = env;
    const scene = env ? this.aerialPerspective(this.shaded, this.depth, env) : this.shaded;
    // Only what is well above white blooms: at a lower threshold the bright sky veiled the whole frame. Bloom is a dozen
    // blur passes, nearly a fifth of the processor's time per frame: with the setting at zero it is left out altogether.
    if (this.bloomOn) {
      this.bloomNode = bloom(scene, 0.05, 0.3, 1.4);
      pipeline.outputNode = scene.add(this.bloomNode) as Any;
    } else {
      this.bloomNode = null;
      pipeline.outputNode = scene as Any;
    }
    pipeline.needsUpdate = true;
  }

  private env: THREE.Texture | null = null;
  private bloomOn = true;
  private frame = 0;

  /**
   * The near cascade is redrawn every frame, the second every other frame, the third every fourth. Each map keeps the
   * matrix it was drawn with, so a stale far map still falls in the right place; only its reach lags a few frames behind
   * a moving eye. It saved a third of the shadows' cost, which is a third of the processor's time per frame.
   */
  private staggerCascades() {
    const lights = this.csm?.lights as THREE.DirectionalLight[] | undefined;
    if (!lights?.length) return;
    this.frame++;
    lights.forEach((light, i) => {
      light.shadow.autoUpdate = false;
      const every = Math.min(4, 2 ** i);
      if (this.frame % every === i % every) light.shadow.needsUpdate = true;
    });
  }

  /**
   * Aerial perspective as in post.ts: the colour of the sky along each line of sight (from the environment, so it warms
   * towards the sun), a faint Rayleigh veil with distance, and Koschmieder's extinction from the reported visibility,
   * thinned with height through a 1.6 km layer (160 m in fog).
   */
  private aerialPerspective(color: Any, depth: Any, env: THREE.Texture) {
    // From the depth buffer back to a line of sight and a distance, as post.ts does: the haze costs one pass, not every material.
    // A full-screen pass has its own camera: the scene camera's matrices come in as uniforms.
    const view = getViewPosition(screenUV, depth, uniform(this.camera.projectionMatrixInverse));
    const dist = view.length();
    const rd = uniform(this.camera.matrixWorld).mul(vec4(view.div(dist), 0)).xyz;
    const toPoint = rd.mul(dist);
    // Read at a broad roughness: the haze is the sky's mean colour along that line, not the sun's disc.
    this.hazeNode = pmremTexture(env, vec3(rd.x, max(rd.y, 0.012), rd.z).normalize(), float(0.18));
    const haze = this.hazeNode.rgb.mul(0.35);
    const beta = float(3.912).div(max(this.visibility, 25));
    const H = select(this.visibility.lessThan(2000), float(160), float(1600));
    const camY = max(uniform(this.camera.position).y, 0);
    const dy = toPoint.y;
    const integ = select(abs(dy).greaterThan(0.5), exp(camY.negate().div(H)).sub(exp(camY.add(dy).negate().div(H))).mul(H).div(dy), exp(camY.negate().div(H)));
    const fogF = exp(beta.mul(dist).mul(clamp(integ, 0.02, 1)).mul(this.aerial).negate()).oneMinus();
    const ray = exp(dist.mul(4.5e-5).mul(this.aerial).negate()).oneMinus();
    const veiled = mix(color.rgb, haze, ray);
    const hazed = mix(veiled, mix(haze, this.greyLight, this.grey), fogF);
    return vec4(select(depth.greaterThanEqual(0.99999), color.rgb, hazed), color.a);
  }

  /** Every mesh gets its node material: ported keys get their TSL port, the rest a plain stand-in that is listed. */
  convert(root: THREE.Object3D) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh && !(object as THREE.Points).isPoints && !(object as THREE.Line).isLine) return;
      const swap = (material: THREE.Material) => this.nodeMaterial(material, object);
      if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(swap);
      else if (mesh.material) mesh.material = swap(mesh.material);
    });
  }

  private note(list: string[], key: string) {
    if (!list.includes(key)) list.push(key);
  }

  private nodeMaterial(material: THREE.Material, object: THREE.Object3D): THREE.Material {
    if ((material as Any).isNodeMaterial) return material;
    const cached = this.converted.get(material);
    if (cached) return cached;
    const key = (material.userData.shadeKey as string | undefined) ?? material.type;
    let out: THREE.Material;
    if ((material as THREE.ShaderMaterial).isShaderMaterial) {
      // Raw GLSL cannot run here: hidden until ported, and listed.
      object.visible = false;
      this.note(this.report.hidden, key);
      out = material;
    } else if (PORTED[key]) {
      out = PORTED[key]!(this, material);
      this.note(this.report.ported, key);
    } else {
      out = this.standIn(material);
      this.note(this.report.missing, key);
    }
    this.converted.set(material, out);
    return out;
  }

  /** The same colour, roughness and maps without the GLSL patch. Walls take their per-vertex colour. */
  standIn(material: THREE.Material): THREE.Material {
    const source = material as THREE.MeshStandardMaterial;
    if ((material as THREE.LineBasicMaterial).isLineBasicMaterial || (material as THREE.PointsMaterial).isPointsMaterial) {
      const basic = new MeshBasicNodeMaterial({ color: (source.color ?? new THREE.Color(1, 1, 1)).clone(), transparent: material.transparent, depthTest: material.depthTest });
      return basic;
    }
    const out = new MeshStandardNodeMaterial({
      color: source.color?.clone() ?? new THREE.Color(1, 1, 1),
      roughness: source.roughness ?? 0.8,
      metalness: source.metalness ?? 0,
      map: source.map ?? null,
      side: material.side,
      transparent: material.transparent,
      opacity: material.opacity,
      vertexColors: source.vertexColors,
      alphaTest: material.alphaTest,
      flatShading: source.flatShading,
    });
    return out;
  }

  /** plateAlbedo of PLATE_GLSL in TSL: plate, its time-travel twin, shadows lifted from the gain map, drape, and the far mosaic past the edge. */
  plateAlbedo(p: Any, blur: Any) {
    const b = this.bridge;
    const half = b.value("uHalf");
    const uv = vec2(p.x.div(half.x), p.y.negate().div(half.y)).mul(0.5).add(0.5);
    const inside = uv.x.greaterThanEqual(0).and(uv.y.greaterThanEqual(0)).and(uv.x.lessThanEqual(1)).and(uv.y.lessThanEqual(1));
    const far = b.sample("uFarPlate", vec2(p.x, p.y.negate()).div(b.value("uFarHalf")).mul(0.5).add(0.5)).rgb;
    let c = b.sample("uPlate", uv, blur).rgb;
    c = mix(c, b.sample("uPlateB", uv, blur).rgb, b.value("uPlateMix"));
    const fill = b.sample("uGain", uv);
    const lit = pow(fill.rgb, vec3(2.2));
    c = mix(c, lit.mul(c.mul(2.4).add(0.82)), fill.a.mul(0.97).mul(b.value("uDeshadow")));
    const drape = b.sample("uDrape", uv);
    c = mix(c, drape.rgb, drape.a.mul(b.value("uDrapeMix")));
    return { albedo: select(inside, c, far), cls: b.sample("uClass", uv), inside };
  }

  /** The ground: the plate with its shadows lifted, the procedural grain near the eye, water darker and glossy. */
  /**
   * The ground of terrain.ts: the plate with its shadows lifted; the procedural tones within 240 m; within 70 m the four
   * ground layers (asphalt, slabs, earth, lawn) chosen by the plate's classes; small bumps in the normal; water dark,
   * glossy and rippling. Photo projection and provenance colouring not yet.
   */
  groundMaterial() {
    const b = this.bridge;
    const m = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    const xz = positionWorld.xz;
    const dist = cameraPosition.sub(positionWorld).length();
    const detail = b.value("uDetail");
    const close = float(1).sub(smoothstep(10, 70, dist)).mul(detail.mul(1.25).min(1));
    const { albedo, cls } = this.plateAlbedo(xz, close.mul(1.6));
    const near = float(1).sub(smoothstep(25, 240, dist)).mul(detail);
    const water = cls.b.greaterThan(0.5);

    const nA = b.sample("uNoise", xz.mul(0.021)).b;
    const nB = b.sample("uNoise", xz.mul(0.083)).b;
    const nC = b.sample("uNoise", xz.mul(0.4)).b;
    const grit = b.sample("uNoise", xz.mul(1.9)).a;
    const fine = b.sample("uNoise", xz.mul(5.3)).a;
    const veg = cls.r.max(cls.g);
    const paved = cls.a;
    const grassTone = albedo.mul(nB.mul(0.2).add(0.9)).mul(nC.mul(0.4).add(0.8)).mul(grit.mul(0.32).add(0.84)).mul(mix(vec3(1), vec3(0.9, 1.03, 0.82), nA.mul(0.5)));
    const stoneTone = albedo.mul(nB.mul(0.08).add(0.96)).mul(nC.mul(0.14).add(0.93)).mul(fine.mul(0.2).add(0.9));
    const bareTone = albedo.mul(nB.mul(0.12).add(0.94)).mul(nC.mul(0.24).add(0.88)).mul(grit.mul(0.36).add(0.82));
    const near3 = mix(mix(bareTone, grassTone, veg), stoneTone, smoothstep(0, 0.6, paved).mul(veg.oneMinus()));
    let color: Any = mix(albedo, near3, near.mul(close.mul(0.75).oneMinus()));

    // The four layers, weighted as in GROUND_FRAG, each read at its own tile and again slower, rotated, so it does not repeat.
    const gx = xz.dFdx();
    const gy = xz.dFdy();
    const layers = U.uMat.value as THREE.Texture;
    const layer = (index: number, tile: number) => {
      const a = texture(layers, xz.div(tile)).depth(int(index)).grad(gx.div(tile), gy.div(tile));
      const wide = tile * 4.3;
      const r = vec2(xz.x.mul(0.819).sub(xz.y.mul(0.574)), xz.x.mul(0.574).add(xz.y.mul(0.819))).div(wide);
      const slow = texture(layers, r).depth(int(index)).grad(gx.div(wide), gy.div(wide)).b;
      return vec4(a.r, a.g, a.b.add(slow.sub(0.5).mul(0.7)), a.a);
    };
    const wRoad = smoothstep(0.55, 0.85, paved).mul(veg.oneMinus());
    const wHard = smoothstep(0.2, 0.4, paved).mul(smoothstep(0.55, 0.85, paved).oneMinus()).mul(veg.oneMinus());
    const wGreen = veg;
    const wEarth = max(float(1).sub(smoothstep(0.55, 0.85, paved)).sub(wHard).sub(wGreen), 0);
    const sum = max(wRoad.add(wHard).add(wEarth).add(wGreen), 0.001);
    const mat = layer(0, GROUND_LAYERS[0]!.tile).mul(wRoad).add(layer(1, GROUND_LAYERS[1]!.tile).mul(wHard)).add(layer(2, GROUND_LAYERS[2]!.tile).mul(wEarth)).add(layer(3, GROUND_LAYERS[3]!.tile).mul(wGreen)).div(sum);
    const ground = mix(vec4(0.5, 0.5, 0.5, 0.9), mat, close);
    color = color.mul(mat.b.sub(0.5).mul(1.5).mul(close).add(1));
    const grid = b.value("uGrid");
    const g = abs(xz.div(100).add(0.5).fract().sub(0.5)).mul(100);
    color = mix(color, vec3(0.95, 0.55, 0.2), smoothstep(0, 0.9, g.x.min(g.y)).oneMinus().mul(0.75).mul(grid));
    m.colorNode = select(water, albedo.mul(0.62), color) as Any;

    const rough = mix(mix(mix(float(0.92), float(0.78), paved), float(0.98), veg), ground.a, close);
    m.roughnessNode = select(water, float(0.07), rough) as Any;

    // Bumps: two octaves of noise within 240 m, the layer's own slope within 70 m; water gets two drifting ripple layers.
    const height = (p: Any) => b.sample("uNoise", p.mul(0.083)).b.add(b.sample("uNoise", p.mul(0.4)).b.mul(0.5));
    const h0 = height(xz);
    const hx = height(xz.add(vec2(0.225, 0)));
    const hz = height(xz.add(vec2(0, 0.225)));
    const amp = mix(float(0.5), float(0.1), smoothstep(0, 0.6, paved)).mul(near).mul(close.mul(0.8).oneMinus());
    const bump = vec3(hx.sub(h0), 0, hz.sub(h0)).mul(amp.mul(4)).add(vec3(ground.r.sub(0.5), 0, ground.g.sub(0.5)).mul(close.mul(2)));
    const t = b.value("uTime").mul(0.35);
    const wa = vec2(b.sample("uNoise", xz.mul(0.07).add(vec2(t.mul(0.08), t.mul(0.05)))).a, b.sample("uNoise", xz.mul(0.07).add(vec2(t.mul(-0.06), t.mul(0.09)))).a).sub(0.5);
    const wb = vec2(b.sample("uNoise", xz.mul(0.31).add(vec2(t.mul(0.2), t.mul(-0.1)))).b, b.sample("uNoise", xz.mul(0.31).sub(vec2(t.mul(0.15), t.mul(0.19)))).b).sub(0.5);
    const ripple = wa.mul(0.22).add(wb.mul(0.1));
    const tilt = select(water, vec3(ripple.x, 0, ripple.y).negate(), bump);
    m.normalNode = normalView.sub(cameraViewMatrix.mul(vec4(tilt, 0)).xyz).normalize() as Any;
    return m;
  }

  roofMaterial(source: THREE.Material) {
    const b = this.bridge;
    const m = new MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0, side: source.side });
    m.colorNode = Fn(() => {
      const { albedo } = this.plateAlbedo(positionWorld.xz, float(0));
      const d = cameraPosition.sub(positionWorld).length();
      const n = b.sample("uNoise", positionWorld.xz.mul(0.47)).a;
      return albedo.mul(mix(float(1), n.mul(0.3).add(0.85), float(1).sub(smoothstep(15, 120, d)).mul(b.value("uDetail"))));
    })();
    return m;
  }

  setShadow(size: number, far: number) {
    this.sunLight.shadow.mapSize.set(size, size);
    if (this.csm) this.csm.maxFar = far;
  }

  setSize(w: number, h: number) {
    this.size = { w, h };
    this.renderer?.setSize(w, h, false);
  }

  /** Sun, sky, haze and exposure for one frame, then the scene through the pipeline. */
  render(sun: THREE.Vector3, intensity: number, exposure: number, look: { ao: number; bloom: number; visibility: number; aerial: number } = { ao: 0.8, bloom: 0.45, visibility: 30000, aerial: 1 }) {
    this.bridge.sync();
    (this.sky as Any).sunPosition.value.copy(sun);
    const up = Math.max(0, sun.y);
    // A cheap stand-in for the sky model's colours until the atmosphere is ported: warmer and dimmer near the horizon.
    this.sunColor.setRGB(1, 0.72 + 0.26 * Math.min(1, up * 3), 0.5 + 0.45 * Math.min(1, up * 2.5));
    this.sunLight.color.copy(this.sunColor);
    this.sunLight.intensity = intensity;
    this.sunLight.position.copy(this.camera.position).addScaledVector(sun, 1500);
    this.sunLight.target.position.copy(this.camera.position);
    this.sunLight.target.updateMatrixWorld();
    const renderer = this.renderer;
    if (!renderer) return;
    // Tuned by eye against the WebGL2 engine on the Zurich test box: three's sky and AgX sit brighter than the own chain.
    renderer.toneMappingExposure = exposure * 0.6;
    this.scene.environmentIntensity = 0.35;
    this.visibility.value = look.visibility;
    this.aerial.value = look.aerial;
    this.grey.value = look.visibility < 12000 ? 1 : THREE.MathUtils.smoothstep(25000 - look.visibility, 8000, 24000);
    this.greyLight.value.setRGB(0.55 + 0.25 * up, 0.58 + 0.24 * up, 0.64 + 0.2 * up);
    this.aoStrength.value = look.ao;
    const wantBloom = look.bloom > 0.01;
    if (wantBloom !== this.bloomOn && this.pipeline) {
      this.bloomOn = wantBloom;
      this.compose(this.env);
    }
    if (this.bloomNode) this.bloomNode.strength.value = look.bloom * 0.12;
    this.staggerCascades();
    // The environment follows the sun, re-baked when it has moved half a degree.
    if (this.pmrem && this.envSky && this.envSun.angleTo(sun) > 0.009) {
      this.envSun.copy(sun);
      (this.envSky as Any).sunPosition.value.copy(sun);
      this.envTarget?.dispose();
      this.envTarget = this.pmrem.fromScene(this.envScene) as unknown as THREE.WebGLRenderTarget;
      this.scene.environment = this.envTarget.texture;
      if (this.hazeNode) this.hazeNode.value = this.envTarget.texture;
      else this.compose(this.envTarget.texture);
    }
    this.hemi.intensity = 0.08;
    if (this.pipeline) this.pipeline.render();
    else renderer.render(this.scene, this.camera);
  }

  info() {
    const r = (this.renderer as Any)?.info?.render;
    return { calls: r?.drawCalls ?? 0, triangles: r?.triangles ?? 0 };
  }

  dispose() {
    this.renderer?.dispose();
  }
}
