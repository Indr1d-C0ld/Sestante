import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { U } from "./shading.ts";

const ATMOSPHERE_GLSL = /* glsl */ `
const float PI_A = 3.14159265;
const float Re = 6371e3, Ra = 6471e3;
const vec3 betaR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const vec3 betaO = vec3(0.65e-6, 1.881e-6, 0.085e-6);
const float betaM = 21e-6;
vec2 rsi(vec3 ro, vec3 rd, float r) {
  float b = dot(rd, ro), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
float density(float h, float H) { return exp(-h / H); }
vec3 scatter(vec3 rd, vec3 sun, float turbidity, float groundY) {
  vec3 ro = vec3(0., Re + max(groundY, 2.), 0.);
  vec2 hit = rsi(ro, rd, Ra);
  float tMax = hit.y;
  vec2 g = rsi(ro, rd, Re);
  if (g.x > 0.) tMax = min(tMax, g.x);
  float mu = dot(rd, sun);
  float pR = 3. / (16. * PI_A) * (1. + mu * mu);
  float gg = .76;
  float pM = 3. / (8. * PI_A) * ((1. - gg * gg) * (1. + mu * mu)) / ((2. + gg * gg) * pow(1. + gg * gg - 2. * gg * mu, 1.5));
  vec3 sumR = vec3(0.), sumM = vec3(0.);
  float odR = 0., odM = 0., odO = 0.;
  const int STEPS_P = 48;
  float tPrev = 0.;
  for (int i = 0; i < STEPS_P; i++) {
    float f = (float(i) + 1.) / float(STEPS_P);
    float tNext = tMax * f * f * f;
    float ds = tNext - tPrev;
    float t = tPrev + ds * .5;
    tPrev = tNext;
    vec3 p = ro + rd * t;
    float h = length(p) - Re;
    float dR = density(h, 8000.) * ds, dM = density(h, 1200.) * ds, dO = max(0., 1. - abs(h - 25e3) / 15e3) * dR;
    odR += dR; odM += dM; odO += dO;
    vec2 sh = rsi(p, sun, Ra);
    float dsl = sh.y / 6.;
    float lR = 0., lM = 0., lO = 0., tl = dsl * .5;
    bool blocked = false;
    for (int j = 0; j < 6; j++) {
      vec3 q = p + sun * tl;
      float hl = length(q) - Re;
      if (hl < 0.) { blocked = true; break; }
      float d = density(hl, 8000.) * dsl;
      lR += d;
      lM += density(hl, 1200.) * dsl;
      lO += max(0., 1. - abs(hl - 25e3) / 15e3) * d;
      tl += dsl;
    }
    if (!blocked) {
      vec3 tau = betaR * (odR + lR) + betaM * turbidity * 1.1 * (odM + lM) + betaO * 2.5 * (odO + lO);
      vec3 att = exp(-tau);
      sumR += att * dR;
      sumM += att * dM;
    }
  }
  return 22. * (sumR * betaR * pR + sumM * betaM * turbidity * pM);
}
`;

const FULL_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

/** Single scattering baked to a small equirect whenever the sun moves; the dome only looks it up. */
function lutMaterial() {
  return new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    vertexShader: FULL_VERT,
    uniforms: { uSun: { value: new THREE.Vector3(0, 1, 0) }, uTurbidity: { value: 1 }, uGroundY: { value: 0 } },
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform vec3 uSun; uniform float uTurbidity, uGroundY;
      ${ATMOSPHERE_GLSL}
      void main() {
        float theta = vUv.x * 2. * PI_A, phi = (vUv.y - .5) * PI_A;
        vec3 rd = vec3(sin(theta) * cos(phi), sin(phi), -cos(theta) * cos(phi));
        rd.y = max(rd.y, .0015);
        rd = normalize(rd);
        gl_FragColor = vec4(scatter(rd, uSun, uTurbidity, uGroundY), 1.);
      }`,
  });
}

const CLOUD_GLSL = /* glsl */ `
uniform sampler3D uVolume;
uniform sampler2D uNoise, uLut;
uniform vec2 uCloudOff;
uniform float uCover, uTime;
uniform vec3 uSunD, uSunCol, uAmbCol;
#define BASE 1600.
#define TOP 3300.
vec3 lutSample(vec3 d) {
  float az = atan(d.x, -d.z);
  return texture2D(uLut, vec2(fract(az / 6.2831853), asin(clamp(d.y, -1., 1.)) / 3.14159265 + .5)).rgb;
}
float weather(vec2 xz) {
  vec2 q = xz * .000055 + uCloudOff;
  return texture2D(uNoise, q).r * .62 + texture2D(uNoise, q * 2.9).g * .38;
}
float cloudDensity(vec3 p, bool fine) {
  float h = clamp((p.y - BASE) / (TOP - BASE), 0., 1.);
  float wx = weather(p.xz);
  float edge = 1. - uCover * 1.02;
  float cover = smoothstep(edge - .03, edge + .2, wx);
  if (cover < .01) return 0.;
  // Flat bases, domed tops: a denser patch of the weather map simply grows a taller cloud.
  float top = mix(.25, 1., cover);
  float profile = smoothstep(0., .06, h) * smoothstep(top, top * .5, h);
  float d = cover * profile;
  if (d < .005) return 0.;
  vec3 q = p * .00031 + vec3(uCloudOff * 2., uTime * .0015);
  float n = texture(uVolume, q).r;
  d = clamp(d * 1.7 - (1. - n) * .78, 0., 1.);
  if (fine && d > .001 && d < .5) d = clamp(d - (1. - texture(uVolume, q * 3.7).r) * .2, 0., 1.);
  return d;
}
vec4 marchClouds(vec3 ro, vec3 rd, float steps, float lightSteps) {
  if (rd.y < .012) return vec4(0., 0., 0., 0.);
  float t0 = (BASE - ro.y) / rd.y, t1 = (TOP - ro.y) / rd.y;
  t1 = min(t1, t0 + 12000.);
  float dt = (t1 - t0) / steps;
  // Interleaved gradient noise spreads the banding evenly; the dome's tent filter then melts it.
  float t = t0 + dt * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
  float mu = dot(rd, uSunD);
  float phase = mix(.08, .9, pow(max(mu * .5 + .5, 0.), 5.)) + .14;
  vec3 color = vec3(0.);
  float trans = 1.;
  for (float i = 0.; i < steps; i += 1.) {
    vec3 p = ro + rd * t;
    float d = cloudDensity(p, steps > 16.);
    if (d > .002) {
      float od = 0.;
      for (float j = 1.; j <= lightSteps; j += 1.) od += cloudDensity(p + uSunD * j * 230., false);
      float beer = exp(-od * .9);
      float powder = 1. - exp(-d * 8.);
      float h = clamp((p.y - BASE) / (TOP - BASE), 0., 1.);
      vec3 lit = uSunCol * beer * phase * 3.2 * mix(.6, 1., powder) + uAmbCol * mix(.55, 1.05, h);
      float a = 1. - exp(-d * dt * .009);
      color += trans * a * lit;
      trans *= 1. - a;
      if (trans < .02) break;
    }
    t += dt;
  }
  // Clouds melt into the horizon haze instead of ending at a hard line.
  float fade = smoothstep(.012, .14, rd.y);
  return vec4(color * fade, (1. - trans) * fade);
}
`;

function make3dNoise(size = 48) {
  const data = new Uint8Array(size ** 3);
  // Inverted Worley: billowy, tiling, cheap to precompute.
  const cells = 6;
  const points = new Float32Array(cells ** 3 * 3);
  let s = 90317;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < points.length; i++) points[i] = rand();
  const worley = (x: number, y: number, z: number, count: number) => {
    const fx = x * count;
    const fy = y * count;
    const fz = z * count;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const iz = Math.floor(fz);
    let best = 9;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const cx = ((ix + a) % count + count) % count;
          const cy = ((iy + b) % count + count) % count;
          const cz = ((iz + c) % count + count) % count;
          const scale = cells / count;
          const k = (Math.floor(cz * scale) * cells * cells + Math.floor(cy * scale) * cells + Math.floor(cx * scale)) * 3;
          const dx = ix + a + points[k]! - fx;
          const dy = iy + b + points[k + 1]! - fy;
          const dz = iz + c + points[k + 2]! - fz;
          best = Math.min(best, dx * dx + dy * dy + dz * dz);
        }
      }
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const w = z / size;
        const value = worley(u, v, w, 3) * 0.6 + worley(u, v, w, 6) * 0.4;
        data[z * size * size + y * size + x] = Math.max(0, Math.min(255, value * 255));
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RedFormat;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

export class Sky {
  readonly dome: THREE.Mesh;
  private lutTarget: THREE.WebGLRenderTarget;
  private lutQuad: FullScreenQuad;
  private lutMat: THREE.ShaderMaterial;
  private cloudMat: THREE.ShaderMaterial;
  private cloudQuad: FullScreenQuad;
  private cloudTarget: THREE.WebGLRenderTarget;
  private domeMat: THREE.ShaderMaterial;
  private pmrem: THREE.PMREMGenerator;
  private envScene: THREE.Scene;
  private envDome: THREE.Mesh;
  private env: THREE.WebGLRenderTarget | null = null;
  private lastSun = new THREE.Vector3(0, -2, 0);
  private lastTurbidity = -1;
  private lastEnvCloud = -1;
  private lastEnvSun = new THREE.Vector3(0, -2, 0);
  sunColor = new THREE.Color(1, 1, 1);
  ambientColor = new THREE.Color(1, 1, 1);
  cloudScale = 3;
  cloudQuality = 1;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    this.lutTarget = new THREE.WebGLRenderTarget(384, 192, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping });
    this.lutMat = lutMaterial();
    this.lutQuad = new FullScreenQuad(this.lutMat);
    this.cloudTarget = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.cloudMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      defines: { STEPS: "20.0", LIGHT: "3.0" },
      uniforms: {
        uVolume: { value: make3dNoise() },
        uNoise: U.uNoise,
        uLut: { value: this.lutTarget.texture },
        uCloudOff: U.uCloudOff,
        uCover: U.uCloud,
        uTime: U.uTime,
        uSunD: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color(1, 1, 1) },
        uAmbCol: { value: new THREE.Color(0.5, 0.5, 0.5) },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler3D;
        in vec2 vUv;
        out vec4 fragOut;
        #define texture2D texture
        uniform mat4 uInvProj, uCamWorld;
        uniform vec3 uCamPos;
        ${CLOUD_GLSL}
        void main() {
          vec4 v = uInvProj * vec4(vUv * 2. - 1., 1., 1.);
          vec3 rd = normalize((uCamWorld * vec4(normalize(v.xyz / v.w), 0.)).xyz);
          fragOut = uCover < .015 ? vec4(0.) : marchClouds(vec3(uCamPos.x, max(uCamPos.y, 0.), uCamPos.z), rd, STEPS, LIGHT);
        }`,
    });
    this.cloudQuad = new FullScreenQuad(this.cloudMat);

    this.domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uLut: { value: this.lutTarget.texture },
        uClouds: { value: this.cloudTarget.texture },
        uScreen: { value: new THREE.Vector2(1, 1) },
        uSunD: { value: new THREE.Vector3(0, 1, 0) },
        uMoonD: { value: new THREE.Vector3(0, -1, 0) },
        uMoonIllum: { value: 0.5 },
        uLightning: { value: 0 },
        uUseClouds: { value: 1 },
        uFogGrey: { value: 0 },
        uTime: U.uTime,
        uCloud: U.uCloud,
        uSidereal: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * modelMatrix * vec4(position, 1.);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vDir;
        uniform sampler2D uLut, uClouds;
        uniform vec2 uScreen;
        uniform vec3 uSunD, uMoonD;
        uniform float uMoonIllum, uLightning, uUseClouds, uFogGrey, uTime, uCloud, uSidereal;
        float hash31(vec3 p) { p = fract(p * vec3(443.897, 441.423, 437.195)); p += dot(p, p.yzx + 19.19); return fract((p.x + p.y) * p.z); }
        void main() {
          vec3 d = normalize(vDir);
          float az = atan(d.x, -d.z);
          vec3 sky = texture2D(uLut, vec2(fract(az / 6.2831853), asin(clamp(max(d.y, 0.), -1., 1.)) / 3.14159265 + .5)).rgb;
          float night = smoothstep(.02, -.14, uSunD.y);
          if (night > .001) {
            // Stars: rotated with sidereal time around the polar axis approximately fixed up the dome.
            float c = cos(uSidereal), s = sin(uSidereal);
            vec3 sd = vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
            vec3 cell = floor(sd * 230.);
            float h = hash31(cell);
            if (h > .9962) {
              vec3 f = fract(sd * 230.) - .5;
              float tw = .7 + .3 * sin(uTime * (2. + h * 7.) + h * 90.);
              sky += vec3(.9, .94, 1.) * smoothstep(.45, .0, length(f)) * (h - .9962) * 900. * tw * night * smoothstep(.0, .18, d.y);
            }
            sky += vec3(.018, .022, .04) * night * pow(1. - abs(d.y), 8.) * .4;
          }
          float mu = dot(d, uSunD);
          float sunDisc = smoothstep(.99994, .99998, mu);
          vec3 color = sky + vec3(1., .93, .82) * sunDisc * 60. * smoothstep(-.02, .03, uSunD.y) * step(0., d.y);
          float md = dot(d, uMoonD);
          if (md > .9996 && uMoonD.y > -.02) {
            vec3 side = normalize(cross(uMoonD, vec3(0., 1., 0.)));
            vec3 up = cross(side, uMoonD);
            vec2 q = vec2(dot(d, side), dot(d, up)) / .0283;
            float z = sqrt(max(0., 1. - dot(q, q)));
            vec3 n = normalize(side * q.x + up * q.y + uMoonD * z);
            float lit = smoothstep(-.05, .12, dot(n, normalize(uSunD + uMoonD * .001)));
            float maria = .78 + .22 * sin(q.x * 9. + q.y * 5.) * sin(q.y * 7. - q.x * 3.);
            color = mix(color, color + vec3(1.05, 1., .92) * (.08 + 2.4 * lit) * maria * mix(.18, 1., night), smoothstep(1., .95, length(q)));
          }
          if (uUseClouds > .5) {
            vec2 cuv = gl_FragCoord.xy / uScreen;
            vec2 cpx = 2.5 / uScreen * 2.;
            vec4 cl = texture2D(uClouds, cuv) * .28
              + (texture2D(uClouds, cuv + cpx * vec2(1., .4)) + texture2D(uClouds, cuv + cpx * vec2(-1., -.4))
              + texture2D(uClouds, cuv + cpx * vec2(-.4, 1.)) + texture2D(uClouds, cuv + cpx * vec2(.4, -1.))) * .18;
            color = color * (1. - cl.a) + cl.rgb;
          } else {
            float grey = uCloud;
            color = mix(color, vec3(dot(color, vec3(.3, .6, .1))) * .9, grey * .85);
          }
          color = mix(color, vec3(.68, .7, .72) * max(.04, dot(sky, vec3(.3, .6, .1)) * 1.1), uFogGrey * smoothstep(.55, .0, d.y));
          color += vec3(.55, .6, .85) * uLightning * (.4 + .6 * uCloud) * 1.6;
          gl_FragColor = vec4(color, 1.);
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    this.dome.scale.setScalar(10);
    scene.add(this.dome);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envDome = new THREE.Mesh(
      new THREE.SphereGeometry(10, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { uLut: { value: this.lutTarget.texture }, uGrey: { value: 0 }, uGround: { value: new THREE.Color(0.1, 0.09, 0.08) }, uGreyCol: { value: new THREE.Color(0.5, 0.5, 0.5) } },
        vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
        fragmentShader: /* glsl */ `
          varying vec3 vDir;
          uniform sampler2D uLut;
          uniform float uGrey;
          uniform vec3 uGround, uGreyCol;
          void main() {
            vec3 d = normalize(vDir);
            float az = atan(d.x, -d.z);
            vec3 sky = texture2D(uLut, vec2(fract(az / 6.2831853), asin(clamp(max(d.y, 0.), -1., 1.)) / 3.14159265 + .5)).rgb;
            sky = mix(sky, uGreyCol, uGrey);
            // Light bounced around a real landscape is far less blue than the bare sky.
            sky = mix(sky, vec3(dot(sky, vec3(.3, .6, .1))), .42);
            gl_FragColor = vec4(mix(uGround, sky, smoothstep(-.06, .03, d.y)), 1.);
          }`,
      }),
    );
    this.envScene.add(this.envDome);
  }

  setSize(width: number, height: number) {
    this.domeMat.uniforms.uScreen!.value.set(width, height);
    this.cloudTarget.setSize(Math.max(4, Math.round(width / this.cloudScale)), Math.max(4, Math.round(height / this.cloudScale)));
  }

  setQuality(level: number) {
    this.cloudQuality = level;
    this.cloudMat.defines.STEPS = level >= 2 ? "36.0" : "20.0";
    this.cloudMat.defines.LIGHT = level >= 2 ? "5.0" : "3.0";
    this.cloudMat.needsUpdate = true;
    this.cloudScale = level >= 2 ? 2 : 3;
    this.domeMat.uniforms.uUseClouds!.value = level > 0 ? 1 : 0;
    const size = this.domeMat.uniforms.uScreen!.value as THREE.Vector2;
    this.setSize(size.x, size.y);
  }

  update(args: { sun: THREE.Vector3; moon: THREE.Vector3; moonIllum: number; turbidity: number; cloud: number; fogGrey: number; lightning: number; camera: THREE.PerspectiveCamera; sidereal: number; groundY: number }) {
    const { sun, moon, turbidity, camera, cloud } = args;
    const renderer = this.renderer;
    const moved = sun.distanceToSquared(this.lastSun) > 1.5e-5 || Math.abs(turbidity - this.lastTurbidity) > 0.04;
    if (moved) {
      this.lutMat.uniforms.uSun!.value.copy(sun);
      this.lutMat.uniforms.uTurbidity!.value = turbidity;
      this.lutMat.uniforms.uGroundY!.value = Math.max(0, args.groundY);
      const prior = renderer.getRenderTarget();
      renderer.setRenderTarget(this.lutTarget);
      this.lutQuad.render(renderer);
      renderer.setRenderTarget(prior);
      this.lastSun.copy(sun);
      this.lastTurbidity = turbidity;
    }

    // Light colours follow from transmittance: a low sun really does go orange through more air.
    const alt = Math.max(0.0, sun.y);
    const airmass = 1 / (alt + 0.15 * Math.pow(93.885 - (Math.acos(alt) * 180) / Math.PI, -1.253));
    const trans = (beta: number) => Math.exp(-beta * airmass);
    const k = 0.09 + 0.09 * (turbidity - 1);
    this.sunColor.setRGB(trans(k * 0.72), trans(k * 1.25), trans(k * 2.5));
    const dayAmount = THREE.MathUtils.smoothstep(sun.y, -0.1, 0.25);
    const skyLum = 0.055 + 1.08 * dayAmount;
    this.ambientColor.setRGB(0.62 * skyLum + 0.01, 0.74 * skyLum + 0.012, 0.98 * skyLum + 0.024);
    const gray = THREE.MathUtils.smoothstep(cloud, 0.45, 1);
    this.ambientColor.lerp(new THREE.Color(0.68 * skyLum, 0.7 * skyLum, 0.74 * skyLum), gray);

    const dome = this.domeMat.uniforms;
    dome.uSunD!.value.copy(sun);
    dome.uMoonD!.value.copy(moon);
    dome.uMoonIllum!.value = args.moonIllum;
    dome.uLightning!.value = args.lightning;
    dome.uFogGrey!.value = args.fogGrey;
    dome.uSidereal!.value = args.sidereal;

    if (this.cloudQuality > 0) {
      const cu = this.cloudMat.uniforms;
      cu.uSunD!.value.copy(sun.y > -0.1 ? sun : moon);
      const sunTint = sun.y > -0.1 ? this.sunColor : new THREE.Color(0.035, 0.04, 0.06);
      cu.uSunCol!.value.copy(sunTint).multiplyScalar(THREE.MathUtils.smoothstep(sun.y, -0.12, 0.05) * 0.9 + 0.1);
      cu.uAmbCol!.value.copy(this.ambientColor).multiplyScalar(0.72);
      cu.uInvProj!.value.copy(camera.projectionMatrixInverse);
      cu.uCamWorld!.value.copy(camera.matrixWorld);
      cu.uCamPos!.value.copy(camera.position);
      const prior = renderer.getRenderTarget();
      renderer.setRenderTarget(this.cloudTarget);
      this.cloudQuad.render(renderer);
      renderer.setRenderTarget(prior);
    }

    const envMoved = sun.distanceToSquared(this.lastEnvSun) > 0.0006 || Math.abs(cloud - this.lastEnvCloud) > 0.03;
    if (envMoved) {
      const material = this.envDome.material as THREE.ShaderMaterial;
      material.uniforms.uGrey!.value = gray * 0.92;
      material.uniforms.uGreyCol!.value.setRGB(0.55 * skyLum, 0.57 * skyLum, 0.61 * skyLum);
      material.uniforms.uGround!.value.setRGB(0.3 * skyLum, 0.28 * skyLum, 0.24 * skyLum);
      const next = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
      this.scene.environment = next.texture;
      this.env?.dispose();
      this.env = next;
      this.lastEnvSun.copy(sun);
      this.lastEnvCloud = cloud;
    }
  }

  /** Average haze colour along a view direction, used by the aerial perspective pass. */
  get lutTexture() {
    return this.lutTarget.texture;
  }
}
