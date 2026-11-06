import * as THREE from "three";
import type { CSM } from "three/examples/jsm/csm/CSM.js";
import { shade } from "./shading.ts";

/** The explorer's body in true measures: a figure of known size is the quickest scale bar there is. */
export type AltEgo = { height: number; shoulders: number; build: number; shirt: string; trousers: string; skin: string };

export type Figure = { group: THREE.Group; legs: THREE.Group[]; arms: THREE.Group[]; dispose: () => void };

const capsule = (radius: number, length: number, material: THREE.Material) => {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(0.001, length), 4, 10), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

/** Facing −Z, feet at the origin. Proportions follow the classic canon: legs 47% of the height, head one eighth, arms 44%. */
export function buildFigure(alt: AltEgo, csm: CSM | null): Figure {
  const h = alt.height;
  const k = h / 1.75;
  const material = (color: string, roughness = 0.86) => shade(new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 }), { key: "avatar" }, csm);
  const shirt = material(alt.shirt);
  const trousers = material(alt.trousers);
  const skin = material(alt.skin, 0.62);
  const boots = material("#3a2c20", 0.7);
  const group = new THREE.Group();

  const hip = h * 0.53;
  const shoulderY = h * 0.82;
  const halfShoulder = Math.max(0.1, alt.shoulders / 2);
  const limb = 0.052 * k * alt.build;
  const armRadius = 0.04 * k * alt.build;

  const makeLeg = (side: number) => {
    const leg = new THREE.Group();
    leg.position.set(side * Math.min(halfShoulder * 0.45, 0.11 * k), hip, 0);
    const upper = capsule(limb * 1.2, hip * 0.42, trousers);
    upper.position.y = -hip * 0.26;
    const lower = capsule(limb * 0.95, hip * 0.4, trousers);
    lower.position.y = -hip * 0.68;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(limb * 2.1, h * 0.05, h * 0.15), boots);
    foot.position.set(0, -hip + h * 0.025, -h * 0.03);
    foot.castShadow = true;
    leg.add(upper, lower, foot);
    group.add(leg);
    return leg;
  };
  const makeArm = (side: number) => {
    const arm = new THREE.Group();
    arm.position.set(side * (halfShoulder - armRadius), shoulderY, 0);
    const upper = capsule(armRadius * 1.1, h * 0.14, shirt);
    upper.position.y = -h * 0.1;
    const lower = capsule(armRadius * 0.9, h * 0.13, shirt);
    lower.position.y = -h * 0.26;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(armRadius * 1.15, 8, 8), skin);
    hand.position.y = -h * 0.375;
    hand.castShadow = true;
    arm.add(upper, lower, hand);
    group.add(arm);
    return arm;
  };
  const legs = [makeLeg(-1), makeLeg(1)];
  const arms = [makeArm(-1), makeArm(1)];

  const torso = capsule(0.1 * k, (shoulderY - hip) * 0.72, shirt);
  torso.position.y = (hip + shoulderY) / 2;
  torso.scale.set((halfShoulder - armRadius) / (0.1 * k), 1, 0.92 * alt.build);
  const neck = capsule(0.042 * k, h * 0.035, skin);
  neck.position.y = h * 0.865;
  const head = new THREE.Mesh(new THREE.SphereGeometry(h / 16, 16, 12), skin);
  head.position.y = h - h / 16;
  head.scale.set(0.86, 1, 0.94);
  head.castShadow = true;
  group.add(torso, neck, head);

  return {
    group,
    legs,
    arms,
    dispose: () => {
      group.traverse((item) => {
        if (item instanceof THREE.Mesh) item.geometry.dispose();
      });
      for (const row of [shirt, trousers, skin, boots]) row.dispose();
    },
  };
}

/** Swings the limbs with the step; standing still they fall back to rest. */
export function poseFigure(figure: Figure, phase: number, speed: number) {
  const swing = Math.sin(phase * 0.5) * Math.min(0.62, speed * 0.32);
  figure.legs[0]!.rotation.x = swing;
  figure.legs[1]!.rotation.x = -swing;
  figure.arms[0]!.rotation.x = -swing * 0.7;
  figure.arms[1]!.rotation.x = swing * 0.7;
}
