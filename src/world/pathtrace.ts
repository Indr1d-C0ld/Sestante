import * as THREE from "three";
import { WebGLPathTracer } from "three-gpu-pathtracer";
import type { Engine } from "./engine.ts";

/** Sky as an equirectangular picture with the sun inside it, so that the tracer samples it by importance. */
function skyPicture(sun: THREE.Vector3, cloud: number) {
  const width = 512;
  const height = 256;
  const data = new Float32Array(width * height * 4);
  const dir = new THREE.Vector3();
  const zenith = new THREE.Color(0.13, 0.3, 0.68).lerp(new THREE.Color(0.55, 0.57, 0.6), cloud);
  const horizon = new THREE.Color(0.72, 0.8, 0.9).lerp(new THREE.Color(0.62, 0.63, 0.65), cloud);
  const ground = new THREE.Color(0.2, 0.19, 0.17);
  const lit = Math.max(0.03, Math.min(1, sun.y * 3 + 0.25));
  const disc = Math.cos((1.6 * Math.PI) / 180);
  // A clear sun gives several times the sky's irradiance: spread over this small disc, that takes a large radiance.
  const power = 3200 * (1 - cloud * 0.9);
  for (let j = 0; j < height; j++) {
    // Same convention as three.js equirectangular maps: v runs from the bottom pole up, u from −π around y.
    const lat = ((j + 0.5) / height - 0.5) * Math.PI;
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width - 0.5) * Math.PI * 2;
      dir.set(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat));
      const k = (j * width + i) * 4;
      const c = dir.y < 0 ? ground : horizon.clone().lerp(zenith, Math.pow(Math.max(0, dir.y), 0.55));
      const dot = dir.dot(sun);
      const glow = Math.pow(Math.max(0, dot), 90) * 1.6 * (1 - cloud * 0.6);
      const core = dot > disc ? power : 0;
      data[k] = c.r * lit * 1.1 + glow + core;
      data[k + 1] = c.g * lit * 1.1 + glow * 0.92 + core * 0.95;
      data[k + 2] = c.b * lit * 1.1 + glow * 0.8 + core * 0.86;
      data[k + 3] = 1;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Light studied for real: bounces, colour bleeding, the soft edge of every shadow.
 * Works on a simplified copy of the place around the observer, so procedural facades and grass are absent by design.
 */
export async function pathTraced(engine: Engine, samples: number, radius: number, onStep: (text: string, done: number, total: number) => void) {
  const camera = engine.camera;
  const position = camera.position;
  const { halfX, halfZ } = engine.data.projection;
  onStep("Preparo la scena semplificata", 0, samples);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const scene = new THREE.Scene();
  const small = document.createElement("canvas");
  const k = Math.min(1, 2048 / Math.max(engine.plate.canvas.width, engine.plate.canvas.height));
  small.width = Math.round(engine.plate.canvas.width * k);
  small.height = Math.round(engine.plate.canvas.height * k);
  small.getContext("2d")!.drawImage(engine.plate.canvas, 0, 0, small.width, small.height);
  const plate = new THREE.CanvasTexture(small);
  plate.colorSpace = THREE.SRGBColorSpace;
  plate.wrapS = plate.wrapT = THREE.ClampToEdgeWrapping;

  const uvOf = (x: number, z: number) => [Math.max(0, Math.min(1, (x / halfX) * 0.5 + 0.5)), Math.max(0, Math.min(1, (-z / halfZ) * 0.5 + 0.5))];

  // Terrain: a fixed grid around the observer, fine enough for the ground under the camera.
  const step = Math.max(2, radius / 160);
  const side = Math.round((radius * 2) / step) + 1;
  const positions = new Float32Array(side * side * 3);
  const uvs = new Float32Array(side * side * 2);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const x = position.x - radius + i * step;
      const z = position.z - radius + j * step;
      const n = j * side + i;
      positions.set([x, engine.heightAt(x, z), z], n * 3);
      uvs.set(uvOf(x, z), n * 2);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < side - 1; j++) {
    for (let i = 0; i < side - 1; i++) {
      const a = j * side + i;
      index.push(a, a + side, a + 1, a + 1, a + side, a + side + 1);
    }
  }
  const ground = new THREE.BufferGeometry();
  ground.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  ground.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  ground.setIndex(index);
  ground.computeVertexNormals();
  scene.add(new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ map: plate, roughness: 0.95 })));

  // One material per quantised colour: vertex colours do not survive the tracer's merged material table.
  const buckets = new Map<number, { pos: number[] }>();
  const bucketOf = (r: number, g: number, b: number) => {
    const key = (Math.round(r * 15) << 8) | (Math.round(g * 15) << 4) | Math.round(b * 15);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { pos: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  const roofMaterial = new THREE.MeshStandardMaterial({ map: plate, roughness: 0.9, side: THREE.DoubleSide });
  for (const { mesh, roof } of engine.buildingMeshes()) {
    const source = mesh.geometry;
    if (!source.boundingSphere) source.computeBoundingSphere();
    const sphere = source.boundingSphere!;
    if (Math.hypot(sphere.center.x - position.x, sphere.center.z - position.z) > radius + sphere.radius) continue;
    const pos = source.getAttribute("position")!;
    const norm = source.getAttribute("normal")!;
    const order = source.getIndex()!;
    if (roof) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", pos.clone());
      geometry.setAttribute("normal", norm.clone());
      geometry.setIndex(order.clone());
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) uv.set(uvOf(pos.getX(i), pos.getZ(i)), i * 2);
      geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      scene.add(new THREE.Mesh(geometry, roofMaterial));
      continue;
    }
    const tint = source.getAttribute("aColor")!;
    for (let t = 0; t < order.count; t += 3) {
      const first = order.getX(t);
      const bucket = bucketOf(tint.getX(first), tint.getY(first), tint.getZ(first));
      for (let c = 0; c < 3; c++) {
        const v = order.getX(t + c);
        bucket.pos.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      }
    }
  }

  const crown = new THREE.IcosahedronGeometry(1, 1).toNonIndexed();
  const cp = crown.getAttribute("position")!;
  let treeCount = 0;
  for (const tree of engine.plate.trees) {
    if (treeCount >= 2500 || Math.hypot(tree.x - position.x, tree.z - position.z) > radius) continue;
    treeCount++;
    const base = engine.heightAt(tree.x, tree.z);
    const cy = base + tree.h * 0.62;
    const ry = tree.h * 0.42;
    const bucket = bucketOf(Math.min(1, Math.pow(tree.color[0], 2.2) * 1.3 + 0.02), Math.min(1, Math.pow(tree.color[1], 2.2) * 1.5 + 0.035), Math.min(1, Math.pow(tree.color[2], 2.2) + 0.01));
    for (let i = 0; i < cp.count; i++) {
      bucket.pos.push(tree.x + cp.getX(i) * tree.r, cy + cp.getY(i) * ry, tree.z + cp.getZ(i) * tree.r);
    }
  }
  crown.dispose();
  for (const [key, bucket] of buckets) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(bucket.pos, 3));
    // Normals from the triangles themselves: a wall's stored normal can disagree with its winding, and the tracer then shades it black.
    geometry.computeVertexNormals();
    const color = new THREE.Color(((key >> 8) & 15) / 15, ((key >> 4) & 15) / 15, (key & 15) / 15);
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.86, side: THREE.DoubleSide })));
  }

  const sun = engine.sun.y > 0 ? engine.sun.clone() : engine.moon.clone();
  scene.environment = skyPicture(sun, engine.weather.now.cloud);
  scene.background = scene.environment;

  const output = document.createElement("canvas");
  const source = engine.renderer.domElement;
  const scale = Math.min(1, 1280 / source.width);
  output.width = Math.round(source.width * scale);
  output.height = Math.round(source.height * scale);
  const renderer = new THREE.WebGLRenderer({ canvas: output, antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(output.width, output.height, false);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 0.72;
  const eye = camera.clone();
  eye.clearViewOffset();
  eye.updateProjectionMatrix();
  eye.updateMatrixWorld();

  const tracer = new WebGLPathTracer(renderer);
  tracer.tiles.set(3, 3);
  tracer.bounces = 4;
  tracer.minSamples = 1;
  tracer.renderDelay = 0;
  tracer.fadeDuration = 0;
  tracer.dynamicLowRes = false;
  tracer.textureSize.set(2048, 2048);
  engine.stop();
  try {
    onStep("Costruisco la gerarchia di volumi", 0, samples);
    await new Promise((resolve) => setTimeout(resolve, 20));
    tracer.setScene(scene, eye);
    onStep("Compilo lo shader sulla GPU", 0, samples);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let triangles = 0;
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) triangles += (mesh.geometry.getIndex()?.count ?? mesh.geometry.getAttribute("position").count) / 3;
    });
    while (tracer.samples < samples) {
      tracer.renderSample();
      onStep(`Campione ${Math.floor(tracer.samples)}/${samples}`, Math.floor(tracer.samples), samples);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const out = document.createElement("canvas");
    out.width = output.width;
    out.height = output.height;
    out.getContext("2d")!.drawImage(output, 0, 0);
    return { canvas: out, triangles: Math.round(triangles) };
  } finally {
    tracer.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    (scene.environment as THREE.Texture | null)?.dispose();
    plate.dispose();
    ground.dispose();
    scene.traverse((node) => (node as THREE.Mesh).geometry?.dispose());
    engine.start();
  }
}
