import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

function pass(fragment: string, uniforms: Record<string, THREE.IUniform>, defines?: Record<string, string>) {
  return new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, vertexShader: VERT, fragmentShader: fragment, uniforms, ...(defines ? { defines } : {}) });
}

/** Own HDR chain: scene → AO from depth → aerial perspective → bloom → tonemap. Every pass works on depth alone, so foliage cards cost nothing extra. */
export class PostChain {
  readonly scene: THREE.WebGLRenderTarget;
  private ao: THREE.WebGLRenderTarget;
  private aoBlur: THREE.WebGLRenderTarget;
  private aoFinal: THREE.WebGLRenderTarget;
  private comp: THREE.WebGLRenderTarget;
  private bloomChain: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private quad = new FullScreenQuad();
  private aoMat: THREE.ShaderMaterial;
  private aoBlurMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  private finalMat: THREE.ShaderMaterial;
  width = 1;
  height = 1;

  constructor(private renderer: THREE.WebGLRenderer, lut: THREE.Texture) {
    const depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType);
    depthTexture.format = THREE.DepthFormat;
    depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
    const opts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.scene = new THREE.WebGLRenderTarget(4, 4, { ...opts, depthTexture, depthBuffer: true, samples: 0 });
    this.ao = new THREE.WebGLRenderTarget(4, 4, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.aoBlur = this.ao.clone();
    this.aoFinal = this.ao.clone();
    this.comp = new THREE.WebGLRenderTarget(4, 4, { ...opts, depthBuffer: false });

    this.aoMat = pass(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDepth;
      uniform mat4 uInvProj;
      uniform vec2 uTexel;
      uniform vec4 uProj;
      uniform float uRadius, uTime;
      vec3 viewPos(vec2 uv) {
        float z = texture2D(tDepth, uv).r;
        vec4 p = uInvProj * vec4(uv * 2. - 1., z * 2. - 1., 1.);
        return p.xyz / p.w;
      }
      void main() {
        float depth = texture2D(tDepth, vUv).r;
        if (depth >= .99999) { gl_FragColor = vec4(1.); return; }
        vec3 P = viewPos(vUv);
        vec3 r = viewPos(vUv + vec2(uTexel.x, 0.)) - P, l = P - viewPos(vUv - vec2(uTexel.x, 0.));
        vec3 t = viewPos(vUv + vec2(0., uTexel.y)) - P, b = P - viewPos(vUv - vec2(0., uTexel.y));
        vec3 N = normalize(cross(abs(r.z) < abs(l.z) ? r : l, abs(t.z) < abs(b.z) ? t : b));
        float dist = -P.z;
        float radius = uRadius * (1. + dist * .018);
        float pixels = radius * uProj.x / dist;
        pixels = clamp(pixels, 3., 90.);
        float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
        float occ = 0.;
        const int N_S = 10;
        for (int i = 0; i < N_S; i++) {
          float fi = float(i);
          float a = (fi + noise) * 2.39996;
          float rr = sqrt((fi + .5) / float(N_S)) * pixels;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * rr * uTexel;
          vec3 v = viewPos(uv) - P;
          float vv = dot(v, v);
          float nv = dot(N, v);
          float falloff = max(0., 1. - vv / (radius * radius));
          occ += max(0., nv / sqrt(vv + .0001) - .08 - dist * .0002) * falloff;
        }
        occ = 1. - occ * 2.1 / float(N_S);
        gl_FragColor = vec4(clamp(occ, 0., 1.));
      }`,
      { tDepth: { value: depthTexture }, uInvProj: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() }, uProj: { value: new THREE.Vector4() }, uRadius: { value: 1.6 }, uTime: { value: 0 } },
    );
    this.aoBlurMat = pass(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tAo, tDepth;
      uniform vec2 uDir;
      uniform float uNear, uFar;
      float linear(float z) { return uNear * uFar / (uFar - z * (uFar - uNear)); }
      void main() {
        float center = linear(texture2D(tDepth, vUv).r);
        float sum = 0., weight = 0.;
        for (float i = -3.; i <= 3.; i += 1.) {
          vec2 uv = vUv + uDir * i;
          float d = linear(texture2D(tDepth, uv).r);
          float w = exp(-abs(d - center) / (center * .03 + .05)) * (1. - abs(i) * .12);
          sum += texture2D(tAo, uv).r * w;
          weight += w;
        }
        gl_FragColor = vec4(sum / max(weight, 1e-4));
      }`,
      { tAo: { value: null }, tDepth: { value: depthTexture }, uDir: { value: new THREE.Vector2() }, uNear: { value: 0.2 }, uFar: { value: 3e4 } },
    );
    this.compMat = pass(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor, tDepth, tAo, tLut;
      uniform mat4 uInvProj, uCamWorld;
      uniform vec3 uCamPos, uSunD, uFogLight;
      uniform float uAoOn, uVis, uAerial, uNear, uFar, uGrey, uLightning;
      vec3 lutSample(vec3 d) {
        float az = atan(d.x, -d.z);
        return texture2D(tLut, vec2(fract(az / 6.2831853), asin(clamp(max(d.y, .012), -1., 1.)) / 3.14159265 + .5)).rgb;
      }
      void main() {
        vec3 color = texture2D(tColor, vUv).rgb;
        float z = texture2D(tDepth, vUv).r;
        if (z < .99999) {
          vec4 v = uInvProj * vec4(vUv * 2. - 1., z * 2. - 1., 1.);
          vec3 view = v.xyz / v.w;
          float dist = length(view);
          vec3 rd = (uCamWorld * vec4(view / dist, 0.)).xyz;
          if (uAoOn > .5) {
            float ao = texture2D(tAo, vUv).r;
            color *= mix(1., ao, uAoOn > .5 ? 1. : 0.);
          }
          // Koschmieder: extinction from meteorological visibility, thinned with height through the fog layer.
          vec3 wp = uCamPos + rd * dist;
          float beta = 3.912 / max(uVis, 25.);
          float H = uVis < 2000. ? 160. : 1600.;
          float dy = wp.y - uCamPos.y;
          float integ = abs(dy) > .5 ? (exp(-(uCamPos.y) / H) - exp(-(uCamPos.y + dy) / H)) * H / dy : exp(-uCamPos.y / H);
          float baseY = 1.;
          float fog = 1. - exp(-beta * dist * clamp(integ, .02, 1.) * baseY * uAerial);
          float ray = 1. - exp(-dist * 4.5e-5 * uAerial);
          vec3 haze = lutSample(rd);
          vec3 grey = uFogLight;
          color = mix(color, haze, ray);
          color = mix(color, mix(haze, grey, uGrey), fog);
          color += vec3(.5, .55, .8) * uLightning * .06 * (1. - exp(-dist * .001));
        }
        gl_FragColor = vec4(color, 1.);
      }`,
      {
        tColor: { value: this.scene.texture },
        tDepth: { value: depthTexture },
        tAo: { value: this.aoFinal.texture },
        tLut: { value: lut },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunD: { value: new THREE.Vector3() },
        uFogLight: { value: new THREE.Color() },
        uAoOn: { value: 1 },
        uVis: { value: 20000 },
        uAerial: { value: 1 },
        uNear: { value: 0.2 },
        uFar: { value: 3e4 },
        uGrey: { value: 0 },
        uLightning: { value: 0 },
      },
    );
    this.downMat = pass(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      uniform float uThreshold;
      void main() {
        vec3 c = (texture2D(tSrc, vUv).rgb * 4.
          + texture2D(tSrc, vUv + uTexel * vec2(-1., -1.)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1., -1.)).rgb
          + texture2D(tSrc, vUv + uTexel * vec2(-1., 1.)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1., 1.)).rgb) / 8.;
        if (uThreshold > 0.) {
          float l = max(max(c.r, c.g), c.b);
          c *= smoothstep(uThreshold * .75, uThreshold * 1.6, l);
          c = min(c, vec3(14.));
        }
        gl_FragColor = vec4(c, 1.);
      }`,
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 } },
    );
    this.upMat = pass(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tSrc, tSmall;
      uniform vec2 uTexel;
      void main() {
        vec3 s = vec3(0.);
        s += texture2D(tSmall, vUv + uTexel * vec2(-1., -1.)).rgb;
        s += texture2D(tSmall, vUv + uTexel * vec2(1., -1.)).rgb;
        s += texture2D(tSmall, vUv + uTexel * vec2(-1., 1.)).rgb;
        s += texture2D(tSmall, vUv + uTexel * vec2(1., 1.)).rgb;
        gl_FragColor = vec4(texture2D(tSrc, vUv).rgb + s * .25 * .9, 1.);
      }`,
      { tSrc: { value: null }, tSmall: { value: null }, uTexel: { value: new THREE.Vector2() } },
    );
    this.finalMat = pass(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor, tBloom;
      uniform float uExposure, uBloom, uVignette, uGrain, uSat, uTime, uTone, uMode;
      vec3 aces(vec3 x) { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
      vec3 neutral(vec3 c) {
        float x = min(c.r, min(c.g, c.b));
        float off = x < .08 ? x - 6.25 * x * x : .04;
        c -= off;
        float p = max(c.r, max(c.g, c.b));
        if (p < .76) return c;
        float d = 1. - .76;
        float np = 1. - d * d / (p + d - .76);
        c *= np / p;
        float g = 1. - 1. / (.15 * (p - np) + 1.);
        return mix(c, vec3(np), g);
      }
      vec3 agxContrast(vec3 x) {
        vec3 x2 = x * x, x4 = x2 * x2;
        return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + .4298 * x2 + .1191 * x - .00232;
      }
      vec3 agx(vec3 c) {
        const mat3 inM = mat3(.842479, .0423282, .0423756, .0784336, .878468, .0784336, .0792237, .0791661, .879142);
        const mat3 outM = mat3(1.19688, -.0528968, -.0529716, -.0980208, 1.15190, -.0980434, -.0990297, -.0989612, 1.15107);
        c = inM * c;
        c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0., 1.);
        c = agxContrast(c);
        // A touch of punch: plain AgX reads washed-out next to a satellite photo.
        float l = dot(c, vec3(.2126, .7152, .0722));
        c = pow(max(c, 0.), vec3(1.12));
        c = l + (c - l) * 1.18;
        c = outM * c;
        return pow(max(c, 0.), vec3(2.2));
      }
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec3 c = texture2D(tColor, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom * .09;
        c *= uExposure;
        if (uMode > .5 && uMode < 1.5) {
          float g = c.g, r = c.r, b = c.b;
          float exg = (2. * g - r - b) / (r + g + b + .02);
          c = mix(vec3(dot(c, vec3(.3, .6, .1))) * vec3(.32, .4, .85), vec3(1., .24, .2) * (dot(c, vec3(.3, .6, .1)) * 2.6 + .06), smoothstep(.02, .26, exg));
        } else if (uMode > 1.5 && uMode < 2.5) {
          c = vec3(dot(c, vec3(.3, .6, .1)));
        }
        if (uTone < .5) c = agx(c);
        else if (uTone < 1.5) c = aces(c * .9);
        else c = neutral(c);
        float luma = dot(c, vec3(.2126, .7152, .0722));
        c = mix(vec3(luma), c, uSat);
        vec2 q = vUv - .5;
        c *= 1. - uVignette * smoothstep(.25, .95, dot(q, q) * 2.1);
        vec3 s = mix(c * 12.92, 1.055 * pow(max(c, 0.), vec3(1. / 2.4)) - .055, step(.0031308, c));
        s += (hash(vUv * 917. + fract(uTime)) - .5) * uGrain;
        gl_FragColor = vec4(s, 1.);
      }`,
      {
        tColor: { value: this.comp.texture },
        tBloom: { value: null },
        uExposure: { value: 1 },
        uBloom: { value: 0.5 },
        uVignette: { value: 0.2 },
        uGrain: { value: 0.02 },
        uSat: { value: 1 },
        uTime: { value: 0 },
        uTone: { value: 0 },
        uMode: { value: 0 },
      },
    );
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.scene.setSize(width, height);
    this.comp.setSize(width, height);
    const hw = Math.max(2, width >> 1);
    const hh = Math.max(2, height >> 1);
    this.ao.setSize(hw, hh);
    this.aoBlur.setSize(hw, hh);
    this.aoFinal.setSize(hw, hh);
    this.aoMat.uniforms.uTexel!.value.set(1 / hw, 1 / hh);
    for (const target of [...this.bloomChain, ...this.bloomUp]) target.dispose();
    this.bloomChain = [];
    this.bloomUp = [];
    let w = hw;
    let h = hh;
    for (let i = 0; i < 5; i++) {
      const make = () => new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.bloomChain.push(make());
      this.bloomUp.push(make());
      w >>= 1;
      h >>= 1;
    }
  }

  private run(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.renderer.setRenderTarget(target);
    this.quad.material = material;
    this.quad.render(this.renderer);
  }

  render(args: {
    camera: THREE.PerspectiveCamera;
    aoStrength: number;
    visibility: number;
    aerial: number;
    fogLight: THREE.Color;
    sun: THREE.Vector3;
    fogGrey: number;
    exposure: number;
    bloom: number;
    vignette: number;
    grain: number;
    saturation: number;
    tone: number;
    mode: number;
    time: number;
    lightning: number;
  }) {
    const { camera } = args;
    const useAo = args.aoStrength > 0.01;
    if (useAo) {
      const au = this.aoMat.uniforms;
      au.uInvProj!.value.copy(camera.projectionMatrixInverse);
      au.uProj!.value.set(camera.projectionMatrix.elements[5]! * this.height * 0.25, 0, 0, 0);
      au.uRadius!.value = 1.8 * args.aoStrength;
      this.run(this.aoMat, this.ao);
      const bu = this.aoBlurMat.uniforms;
      bu.uNear!.value = camera.near;
      bu.uFar!.value = camera.far;
      bu.tAo!.value = this.ao.texture;
      bu.uDir!.value.set(1 / this.ao.width, 0);
      this.run(this.aoBlurMat, this.aoBlur);
      bu.tAo!.value = this.aoBlur.texture;
      bu.uDir!.value.set(0, 1 / this.ao.height);
      this.run(this.aoBlurMat, this.aoFinal);
    }
    const cu = this.compMat.uniforms;
    cu.uInvProj!.value.copy(camera.projectionMatrixInverse);
    cu.uCamWorld!.value.copy(camera.matrixWorld);
    cu.uCamPos!.value.copy(camera.position);
    cu.uSunD!.value.copy(args.sun);
    cu.uFogLight!.value.copy(args.fogLight);
    cu.uAoOn!.value = useAo ? 1 : 0;
    cu.uVis!.value = args.visibility;
    cu.uAerial!.value = args.aerial;
    cu.uGrey!.value = args.fogGrey;
    cu.uLightning!.value = args.lightning;
    this.run(this.compMat, this.comp);

    const chain = this.bloomChain;
    if (args.bloom > 0.01 && chain.length) {
      let src = this.comp.texture;
      let threshold = 1.3 / Math.max(args.exposure, 0.05);
      for (const target of chain) {
        this.downMat.uniforms.tSrc!.value = src;
        this.downMat.uniforms.uTexel!.value.set(1 / target.width, 1 / target.height);
        this.downMat.uniforms.uThreshold!.value = threshold;
        this.run(this.downMat, target);
        threshold = 0;
        src = target.texture;
      }
      let small = chain[chain.length - 1]!;
      for (let i = chain.length - 2; i >= 0; i--) {
        const target = this.bloomUp[i]!;
        this.upMat.uniforms.tSrc!.value = chain[i]!.texture;
        this.upMat.uniforms.tSmall!.value = small.texture;
        this.upMat.uniforms.uTexel!.value.set(1 / small.width, 1 / small.height);
        this.run(this.upMat, target);
        small = target;
      }
      this.finalMat.uniforms.tBloom!.value = small.texture;
    }
    const fu = this.finalMat.uniforms;
    fu.uExposure!.value = args.exposure;
    fu.uBloom!.value = args.bloom;
    fu.uVignette!.value = args.vignette;
    fu.uGrain!.value = args.grain;
    fu.uSat!.value = args.saturation;
    fu.uTime!.value = args.time;
    fu.uTone!.value = args.tone;
    fu.uMode!.value = args.mode;
    this.run(this.finalMat, null);
  }
}
