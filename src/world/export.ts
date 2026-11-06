import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import type { Engine } from "./engine.ts";

function simpleBuildingMesh(mesh: THREE.Mesh, roof: boolean, halfX: number, halfZ: number, plate: THREE.Texture) {
  const source = mesh.geometry;
  const geometry = new THREE.BufferGeometry();
  const position = source.getAttribute("position")!;
  geometry.setAttribute("position", position.clone());
  geometry.setAttribute("normal", source.getAttribute("normal")!.clone());
  geometry.setIndex(source.getIndex()!.clone());
  if (roof) {
    const uv = new Float32Array(position.count * 2);
    for (let i = 0; i < position.count; i++) {
      uv[i * 2] = (position.getX(i) / halfX) * 0.5 + 0.5;
      uv[i * 2 + 1] = (position.getZ(i) / halfZ) * 0.5 + 0.5;
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: plate, roughness: 0.9, side: THREE.DoubleSide }));
  }
  const color = source.getAttribute("aColor")!;
  geometry.setAttribute("color", color.clone());
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
}

/**
 * The reconstruction as a plain GLB in local metres, y up, for Blender or another engine.
 * Procedural facades stay behind as vertex colours: only what was measured or read travels.
 */
export async function exportGlb(engine: Engine, onStep?: (text: string) => void) {
  const { halfX, halfZ } = engine.data.projection;
  const scene = new THREE.Scene();
  onStep?.("Preparo terreno e lastra");
  const limit = 4096;
  const plateSource = engine.plate.canvas;
  const k = Math.min(1, limit / Math.max(plateSource.width, plateSource.height));
  const small = document.createElement("canvas");
  small.width = Math.round(plateSource.width * k);
  small.height = Math.round(plateSource.height * k);
  small.getContext("2d")!.drawImage(plateSource, 0, 0, small.width, small.height);
  const plate = new THREE.CanvasTexture(small);
  plate.colorSpace = THREE.SRGBColorSpace;
  plate.flipY = false;
  const { terrain } = engine.data;
  const half = ((terrain.size - 1) * terrain.spacing) / 2;
  const count = terrain.size * terrain.size;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let j = 0; j < terrain.size; j++) {
    for (let i = 0; i < terrain.size; i++) {
      const n = j * terrain.size + i;
      const x = -half + i * terrain.spacing;
      const z = -half + j * terrain.spacing;
      positions.set([x, terrain.heights[n]!, z], n * 3);
      uvs.set([Math.max(0, Math.min(1, (x / halfX) * 0.5 + 0.5)), Math.max(0, Math.min(1, (z / halfZ) * 0.5 + 0.5))], n * 2);
    }
  }
  const index = new Uint32Array((terrain.size - 1) * (terrain.size - 1) * 6);
  let m = 0;
  for (let j = 0; j < terrain.size - 1; j++) {
    for (let i = 0; i < terrain.size - 1; i++) {
      const a = j * terrain.size + i;
      index.set([a, a + terrain.size, a + 1, a + 1, a + terrain.size, a + terrain.size + 1], m);
      m += 6;
    }
  }
  const ground = new THREE.BufferGeometry();
  ground.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  ground.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  ground.setIndex(new THREE.BufferAttribute(index, 1));
  ground.computeVertexNormals();
  const groundMesh = new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ map: plate, roughness: 0.92 }));
  groundMesh.name = "terreno";
  scene.add(groundMesh);

  onStep?.("Copio edifici");
  const buildings = new THREE.Group();
  buildings.name = "edifici";
  for (const mesh of engine.buildingMeshes()) buildings.add(simpleBuildingMesh(mesh.mesh, mesh.roof, halfX, halfZ, plate));
  scene.add(buildings);

  onStep?.("Pianto gli alberi");
  const crown = new THREE.IcosahedronGeometry(1, 1);
  const trees = engine.plate.trees.slice(0, 6000);
  if (trees.length) {
    const instanced = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: 0x4d6b35, roughness: 0.9 }), trees.length);
    const dummy = new THREE.Object3D();
    trees.forEach((tree, i) => {
      dummy.position.set(tree.x, engine.heightAt(tree.x, tree.z) + tree.h * 0.62, tree.z);
      dummy.scale.set(tree.r, tree.h * 0.42, tree.r);
      dummy.updateMatrix();
      instanced.setMatrixAt(i, dummy.matrix);
    });
    instanced.name = "alberi";
    scene.add(instanced);
  }
  onStep?.("Scrivo il GLB");
  const exporter = new GLTFExporter();
  const binary = await exporter.parseAsync(scene, { binary: true, maxTextureSize: limit });
  return new Blob([binary as ArrayBuffer], { type: "model/gltf-binary" });
}
