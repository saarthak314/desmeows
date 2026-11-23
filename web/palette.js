// Clip-wide palette: k-means in Lab over pixels sampled from frames across the whole clip.
// The palette only decides where region boundaries fall (every region is then filled with
// its own true mean colour), and one palette for the whole clip keeps boundaries stable
// from frame to frame instead of flickering.

const GAMMA = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; GAMMA[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

function lab(r, g, b) {
  r = GAMMA[r]; g = GAMMA[g]; b = GAMMA[b];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.412453 * r + 0.35758 * g + 0.180423 * b) / 0.950456);
  const Y = f(0.212671 * r + 0.71516 * g + 0.072169 * b);
  const Z = f((0.019334 * r + 0.119193 * g + 0.950227 * b) / 1.088754);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

// samples: Float32Array of Lab triples. Returns Float32Array of k Lab centres.
export function kmeans(samples, k, iters = 12) {
  const n = samples.length / 3;
  k = Math.min(k, n);
  const C = new Float32Array(k * 3);
  // k-means++ seeding with a deterministic LCG so the same clip gives the same palette.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const d2 = new Float32Array(n).fill(Infinity);
  let pick = Math.floor(rand() * n);
  for (let c = 0; c < k; c++) {
    C[3 * c] = samples[3 * pick]; C[3 * c + 1] = samples[3 * pick + 1]; C[3 * c + 2] = samples[3 * pick + 2];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const a = samples[3 * i] - C[3 * c], b = samples[3 * i + 1] - C[3 * c + 1], e = samples[3 * i + 2] - C[3 * c + 2];
      const d = a * a + b * b + e * e;
      if (d < d2[i]) d2[i] = d;
      total += d2[i];
    }
    let r = rand() * total;
    for (pick = 0; pick < n - 1; pick++) { r -= d2[pick]; if (r <= 0) break; }
  }
  const assign = new Int32Array(n);
  const sum = new Float64Array(k * 3), cnt = new Int32Array(k);
  for (let it = 0; it < iters; it++) {
    sum.fill(0); cnt.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const a = samples[3 * i] - C[3 * c], b = samples[3 * i + 1] - C[3 * c + 1], e = samples[3 * i + 2] - C[3 * c + 2];
        const d = a * a + b * b + e * e;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best; cnt[best]++;
      sum[3 * best] += samples[3 * i]; sum[3 * best + 1] += samples[3 * i + 1]; sum[3 * best + 2] += samples[3 * i + 2];
    }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let j = 0; j < 3; j++) C[3 * c + j] = sum[3 * c + j] / cnt[c];
  }
  return C;
}

// Collect Lab samples from an RGBA frame, every `step`-th pixel.
export function sampleFrame(rgba, step, into) {
  for (let j = 0; j < rgba.length; j += 4 * step) into.push(...lab(rgba[j], rgba[j + 1], rgba[j + 2]));
}

// 32x32x32 lookup: 5-bit RGB -> nearest centre index.
export function buildLUT(C) {
  const k = C.length / 3;
  const lut = new Uint8Array(32768);
  for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
    const [L, A, B] = lab(r * 8 + 4, g * 8 + 4, b * 8 + 4);
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const x = L - C[3 * c], y = A - C[3 * c + 1], z = B - C[3 * c + 2];
      const d = x * x + y * y + z * z;
      if (d < bd) { bd = d; best = c; }
    }
    lut[(r << 10) | (g << 5) | b] = best;
  }
  return lut;
}

// Scene cuts from small thumbnails (RGBA, same size). A cut is a big jump in both the
// colour histogram and the pixels. SceneCutter takes frames one at a time, so cuts (and the
// palettes that depend on them) can be found while the video is still being read.
function hist64(t) {
  const h = new Float32Array(64);
  const n = t.length >> 2;
  for (let j = 0; j < t.length; j += 4) h[((t[j] >> 6) << 4) | ((t[j + 1] >> 6) << 2) | (t[j + 2] >> 6)] += 1 / n;
  return h;
}

export class SceneCutter {
  constructor(minLen = 6) { this.minLen = minLen; this.i = 0; this.s = 0; this.last = 0; this.prev = null; this.prevH = null; }
  // the scene index of this frame
  push(t) {
    const h = hist64(t);
    if (this.i > 0) {
      let hd = 0;
      for (let k = 0; k < 64; k++) hd += Math.abs(h[k] - this.prevH[k]);
      let pd = 0;
      const b = this.prev;
      for (let j = 0; j < t.length; j += 4) pd += Math.abs(t[j] - b[j]) + Math.abs(t[j + 1] - b[j + 1]) + Math.abs(t[j + 2] - b[j + 2]);
      pd /= (t.length >> 2) * 3;
      if (hd > 0.5 && pd > 20 && this.i - this.last >= this.minLen) { this.s++; this.last = this.i; }
    }
    this.prev = t; this.prevH = h; this.i++;
    return this.s;
  }
}

// Scene index per frame for a whole list of thumbnails.
export function detectScenes(thumbs, minLen = 6) {
  const cut = new SceneCutter(minLen);
  return Int32Array.from(thumbs, (t) => cut.push(t));
}

// Lab samples for one scene, from up to 16 of its thumbnails, about `target` in all.
export function sceneSamples(thumbs, scene, s, target = 30000) {
  const frames = [];
  for (let i = 0; i < scene.length; i++) if (scene[i] === s) frames.push(i);
  const pick = frames.length <= 16 ? frames : Array.from({ length: 16 }, (_, j) => frames[Math.floor((j + 0.5) * frames.length / 16)]);
  const samples = [];
  const step = Math.max(1, Math.round((thumbs[0].length >> 2) * pick.length / target));
  for (const i of pick) sampleFrame(thumbs[i], step, samples);
  return Float32Array.from(samples);
}

// One palette per scene, computed in this thread (used by tests).
export function scenePalettes(thumbs, scene, k) {
  const count = scene.length ? scene[scene.length - 1] + 1 : 0;
  const luts = [];
  for (let s = 0; s < count; s++) luts.push(buildLUT(kmeans(sceneSamples(thumbs, scene, s), k)));
  return luts;
}
