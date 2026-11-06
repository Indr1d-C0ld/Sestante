/** Photo-interpretation filters of the studio. All pixel work on a working copy; the plate itself is never altered. */
export type PlateFilter = "natural" | "stretch" | "dstretch" | "vegetation" | "shadows" | "edges" | "grey";

export const FILTERS: { id: PlateFilter; label: string; note: string }[] = [
  { id: "natural", label: "Naturale", note: "La lastra così come è stata pubblicata." },
  { id: "stretch", label: "Contrasto", note: "Stira ogni banda fra il 2° e il 98° percentile." },
  { id: "dstretch", label: "Decorrelazione", note: "Stira le componenti principali del colore: è il metodo usato per far emergere crop mark e tracce sepolte." },
  { id: "vegetation", label: "Vegetazione", note: "Indice ExG (2G−R−B): più è caldo, più il verde domina." },
  { id: "shadows", label: "Ombre", note: "Isola le ombre portate da cui si legge il sole." },
  { id: "edges", label: "Contorni", note: "Sobel: mura, solchi e allineamenti risaltano." },
  { id: "grey", label: "Pancromatica", note: "Solo luminanza." },
];

function ramp(t: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0, 20, 26, 60],
    [0.35, 40, 110, 120],
    [0.6, 170, 190, 80],
    [0.85, 240, 150, 40],
    [1, 250, 240, 200],
  ];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (t <= b[0]) {
      const f = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return [250, 240, 200];
}

export function applyFilter(source: HTMLCanvasElement, filter: PlateFilter, maxSide = 3072) {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (filter === "natural") return canvas;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  const n = d.length / 4;
  if (filter === "stretch") {
    for (let c = 0; c < 3; c++) {
      const hist = new Uint32Array(256);
      for (let i = 0; i < n; i++) hist[d[i * 4 + c]!]!++;
      let lo = 0;
      let hi = 255;
      let acc = 0;
      while (lo < 255 && (acc += hist[lo]!) < n * 0.02) lo++;
      acc = 0;
      while (hi > 0 && (acc += hist[hi]!) < n * 0.02) hi--;
      const span = Math.max(1, hi - lo);
      for (let i = 0; i < n; i++) d[i * 4 + c] = ((d[i * 4 + c]! - lo) / span) * 255;
    }
  } else if (filter === "dstretch") {
    const mean = [0, 0, 0];
    const stride = Math.max(1, Math.floor(n / 200000));
    let samples = 0;
    for (let i = 0; i < n; i += stride) {
      for (let c = 0; c < 3; c++) mean[c]! += d[i * 4 + c]!;
      samples++;
    }
    for (let c = 0; c < 3; c++) mean[c]! /= samples;
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < n; i += stride) {
      const v = [d[i * 4]! - mean[0]!, d[i * 4 + 1]! - mean[1]!, d[i * 4 + 2]! - mean[2]!];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a * 3 + b]! += v[a]! * v[b]!;
    }
    for (let k = 0; k < 9; k++) cov[k]! /= samples;
    // Jacobi eigen-decomposition of the 3×3 covariance.
    const A = [...cov];
    const V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let sweep = 0; sweep < 12; sweep++) {
      for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
        const apq = A[p * 3 + q]!;
        if (Math.abs(apq) < 1e-6) continue;
        const theta = (A[q * 3 + q]! - A[p * 3 + p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1);
        const sn = t * cs;
        for (let r = 0; r < 3; r++) {
          const arp = A[r * 3 + p]!;
          const arq = A[r * 3 + q]!;
          A[r * 3 + p] = cs * arp - sn * arq;
          A[r * 3 + q] = sn * arp + cs * arq;
        }
        for (let r = 0; r < 3; r++) {
          const apr = A[p * 3 + r]!;
          const aqr = A[q * 3 + r]!;
          A[p * 3 + r] = cs * apr - sn * aqr;
          A[q * 3 + r] = sn * apr + cs * aqr;
        }
        for (let r = 0; r < 3; r++) {
          const vrp = V[r * 3 + p]!;
          const vrq = V[r * 3 + q]!;
          V[r * 3 + p] = cs * vrp - sn * vrq;
          V[r * 3 + q] = sn * vrp + cs * vrq;
        }
      }
    }
    const target = 52;
    const gain = [0, 1, 2].map((k) => target / Math.sqrt(Math.max(1, A[k * 4]!)));
    const T = new Float64Array(9);
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += V[a * 3 + k]! * gain[k]! * V[b * 3 + k]!;
        T[a * 3 + b] = sum;
      }
    }
    for (let i = 0; i < n; i++) {
      const r = d[i * 4]! - mean[0]!;
      const g = d[i * 4 + 1]! - mean[1]!;
      const b = d[i * 4 + 2]! - mean[2]!;
      d[i * 4] = T[0]! * r + T[1]! * g + T[2]! * b + 128;
      d[i * 4 + 1] = T[3]! * r + T[4]! * g + T[5]! * b + 128;
      d[i * 4 + 2] = T[6]! * r + T[7]! * g + T[8]! * b + 128;
    }
  } else if (filter === "vegetation") {
    for (let i = 0; i < n; i++) {
      const r = d[i * 4]!;
      const g = d[i * 4 + 1]!;
      const b = d[i * 4 + 2]!;
      const exg = (2 * g - r - b) / (r + g + b + 8);
      const [x, y, z] = ramp(Math.max(0, Math.min(1, exg * 2.4 + 0.3)));
      d[i * 4] = x;
      d[i * 4 + 1] = y;
      d[i * 4 + 2] = z;
    }
  } else if (filter === "shadows") {
    for (let i = 0; i < n; i++) {
      const l = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
      const blue = d[i * 4 + 2]! - d[i * 4]!;
      const v = l < 58 ? 255 - l : Math.max(0, 50 - (l - 58) * 0.5);
      d[i * 4] = v * (blue > 2 ? 0.75 : 0.95);
      d[i * 4 + 1] = v * 0.86;
      d[i * 4 + 2] = v;
    }
  } else if (filter === "grey") {
    for (let i = 0; i < n; i++) {
      const l = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = l;
    }
  } else if (filter === "edges") {
    const w = canvas.width;
    const h = canvas.height;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const k = y * w + x;
        const gx = lum[k - w + 1]! + 2 * lum[k + 1]! + lum[k + w + 1]! - lum[k - w - 1]! - 2 * lum[k - 1]! - lum[k + w - 1]!;
        const gy = lum[k + w - 1]! + 2 * lum[k + w]! + lum[k + w + 1]! - lum[k - w - 1]! - 2 * lum[k - w]! - lum[k - w + 1]!;
        const v = Math.min(255, Math.hypot(gx, gy) * 0.9);
        d[k * 4] = v;
        d[k * 4 + 1] = v * 0.92;
        d[k * 4 + 2] = v * 0.78;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export type ChangeCluster = { x: number; y: number; w: number; h: number; area: number; kind: string; strength: number };

/** Compares two plates of the same place. Lighting differs between dates, so each channel is normalised and small misregistration is blurred away. */
export function detectChanges(newer: HTMLCanvasElement, older: HTMLCanvasElement, mpp: number, side = 1024) {
  const scale = Math.min(1, side / Math.max(newer.width, newer.height));
  const w = Math.max(2, Math.round(newer.width * scale));
  const h = Math.max(2, Math.round(newer.height * scale));
  const read = (canvas: HTMLCanvasElement) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.filter = "blur(1.4px)";
    ctx.drawImage(canvas, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  };
  const a = read(newer);
  const b = read(older);
  const n = w * h;
  const stats = (d: Uint8ClampedArray) => {
    const mean = [0, 0, 0];
    const dev = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c]! += d[i * 4 + c]!;
    for (let c = 0; c < 3; c++) mean[c]! /= n;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) dev[c]! += (d[i * 4 + c]! - mean[c]!) ** 2;
    for (let c = 0; c < 3; c++) dev[c] = Math.sqrt(dev[c]! / n) || 1;
    return { mean, dev };
  };
  const sa = stats(a);
  const sb = stats(b);
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < 3; c++) sum += Math.abs((a[i * 4 + c]! - sa.mean[c]!) / sa.dev[c]! - (b[i * 4 + c]! - sb.mean[c]!) / sb.dev[c]!);
    // Two passes rarely share a sun: anything dark in either shot is probably a shadow, not a change on the ground.
    const lumA = 0.3 * a[i * 4]! + 0.59 * a[i * 4 + 1]! + 0.11 * a[i * 4 + 2]!;
    const lumB = 0.3 * b[i * 4]! + 0.59 * b[i * 4 + 1]! + 0.11 * b[i * 4 + 2]!;
    score[i] = Math.min(lumA, lumB) < 46 ? 0 : sum / 3;
  }
  const raw = new Uint8Array(n);
  const threshold = 1.15;
  for (let i = 0; i < n; i++) if (score[i]! > threshold) raw[i] = 1;
  // Opening: thin slivers along roof edges are parallax between the two shots.
  const mask = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (raw[k] && raw[k - 1] && raw[k + 1] && raw[k - w] && raw[k + w] && raw[k - w - 1] && raw[k + w + 1] && raw[k - w + 1] && raw[k + w - 1]) {
        for (const q of [k, k - 1, k + 1, k - w, k + w]) mask[q] = 1;
      }
    }
  }
  for (let i = 0; i < n; i++) if (!mask[i]) score[i] = 0;
  const seen = new Uint8Array(n);
  const clusters: ChangeCluster[] = [];
  const ground = (mpp / scale) ** 2;
  const minPixels = Math.max(10, 90 / ground);
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let count = 0;
    let x0 = w;
    let x1 = 0;
    let y0 = h;
    let y1 = 0;
    let strength = 0;
    let vegA = 0;
    let vegB = 0;
    let lumA = 0;
    let lumB = 0;
    while (stack.length) {
      const k = stack.pop()!;
      count++;
      const x = k % w;
      const y = Math.floor(k / w);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      strength += score[k]!;
      vegA += 2 * a[k * 4 + 1]! - a[k * 4]! - a[k * 4 + 2]! > 18 ? 1 : 0;
      vegB += 2 * b[k * 4 + 1]! - b[k * 4]! - b[k * 4 + 2]! > 18 ? 1 : 0;
      lumA += a[k * 4 + 1]!;
      lumB += b[k * 4 + 1]!;
      for (const nb of [k - 1, k + 1, k - w, k + w]) {
        if (nb >= 0 && nb < n && mask[nb] && !seen[nb]) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
    if (count < minPixels) continue;
    // A blob that sprawls and barely fills its box is lighting, not an object.
    if (count / ((x1 - x0 + 1) * (y1 - y0 + 1)) < 0.16 && count * ground > 2000) continue;
    let kind = "variazione di tono";
    if (vegB / count > 0.5 && vegA / count < 0.2) kind = "vegetazione scomparsa";
    else if (vegA / count > 0.5 && vegB / count < 0.2) kind = "vegetazione comparsa";
    else if (lumA / count > lumB / count + 28) kind = "superficie schiarita, possibile opera nuova";
    else if (lumB / count > lumA / count + 28) kind = "superficie scurita o in ombra";
    clusters.push({ x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h, area: count * ground, kind, strength: strength / count });
  }
  clusters.sort((p, q) => q.area - p.area);
  return { clusters: clusters.slice(0, 40), score, width: w, height: h, threshold };
}

export function changeOverlay(result: { score: Float32Array; width: number; height: number; threshold: number }) {
  const canvas = document.createElement("canvas");
  canvas.width = result.width;
  canvas.height = result.height;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(result.width, result.height);
  for (let i = 0; i < result.score.length; i++) {
    const v = result.score[i]!;
    if (v <= result.threshold) continue;
    image.data[i * 4] = 240;
    image.data[i * 4 + 1] = 90;
    image.data[i * 4 + 2] = 40;
    image.data[i * 4 + 3] = Math.min(220, (v - result.threshold) * 180 + 60);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Archives answer with a valid black or uniform tile where they hold nothing: that is a gap, not a picture. */
export function isBlank(canvas: HTMLCanvasElement) {
  const small = document.createElement("canvas");
  small.width = small.height = 64;
  const ctx = small.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, 64, 64);
  const { data } = ctx.getImageData(0, 0, 64, 64);
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i]! + data[i + 1]! + data[i + 2]!;
    sum += v;
    squares += v * v;
  }
  const n = data.length / 4;
  const mean = sum / n;
  return mean < 9 || Math.sqrt(Math.max(0, squares / n - mean * mean)) < 1.5;
}
