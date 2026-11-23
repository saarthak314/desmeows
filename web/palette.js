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

// Nearest centre, exactly as a scan of every centre in order finds it (the first with the
// strictly smallest squared distance), starting from a guess g. With r the distance to g, a
// centre more than 2r from g is more than r from the point and can't win or tie, so only
// centres within 2r of g (plus a margin far above rounding error) are measured. Each centre
// lists its NB nearest by squared distance (ND, NI); past the list's reach, scan them all.
const NB = 16;
function nearest(C, k, x, y, z, g, ND, NI, NL) {
  const a = x - C[3 * g], b = y - C[3 * g + 1], e = z - C[3 * g + 2];
  let bd = a * a + b * b + e * e, best = g;
  const lim = 4.0004 * bd, o = g * NB, len = NL[g];
  if (len === NB && lim >= ND[o + NB - 1]) {
    best = 0; bd = Infinity;
    for (let c = 0; c < k; c++) {
      const a = x - C[3 * c], b = y - C[3 * c + 1], e = z - C[3 * c + 2];
      const d = a * a + b * b + e * e;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  for (let j = o, end = o + len; j < end && ND[j] <= lim; j++) {
    const c = NI[j];
    const a = x - C[3 * c], b = y - C[3 * c + 1], e = z - C[3 * c + 2];
    const d = a * a + b * b + e * e;
    if (d < bd || (d === bd && c < best)) { bd = d; best = c; }
  }
  return best;
}

// Each centre's NB nearest other centres, nearest first. A list shorter than NB holds them all;
// a full one holds every centre nearer than its last entry.
function neighbours(C, k, ND, NI, NL) {
  for (let g = 0; g < k; g++) {
    const x = C[3 * g], y = C[3 * g + 1], z = C[3 * g + 2], o = g * NB;
    let len = 0;
    for (let c = 0; c < k; c++) {
      if (c === g) continue;
      const a = C[3 * c] - x, b = C[3 * c + 1] - y, e = C[3 * c + 2] - z;
      const d = a * a + b * b + e * e;
      if (len === NB && d >= ND[o + NB - 1]) continue;
      let j = len < NB ? len++ : NB - 1;
      for (; j > 0 && ND[o + j - 1] > d; j--) { ND[o + j] = ND[o + j - 1]; NI[o + j] = NI[o + j - 1]; }
      ND[o + j] = d; NI[o + j] = c;
    }
    NL[g] = len;
  }
}

// samples: Float32Array of Lab triples. Returns Float32Array of k Lab centres.
export function kmeans(samples, k, iters = 12) {
  const n = samples.length / 3;
  k = Math.min(k, n);
  const C = new Float32Array(k * 3);
  // k-means++ seeding with a deterministic LCG so the same clip gives the same palette.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  // float32 values held as doubles: the same numbers, without a conversion per use
  const S = Float64Array.from(samples), d2 = new Float64Array(n).fill(Infinity);
  const near = new Int32Array(n); // the centre that set d2[i]: where nearest() starts
  const run = new Float64Array(n); // running total after each sample
  let pick = Math.floor(rand() * n);
  for (let c = 0; c < k; c++) {
    C[3 * c] = samples[3 * pick]; C[3 * c + 1] = samples[3 * pick + 1]; C[3 * c + 2] = samples[3 * pick + 2];
    const x = C[3 * c], y = C[3 * c + 1], z = C[3 * c + 2];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const a = S[3 * i] - x, b = S[3 * i + 1] - y, e = S[3 * i + 2] - z;
      const d = a * a + b * b + e * e;
      let v = d2[i];
      if (d < v) { v = Math.fround(d); d2[i] = v; near[i] = c; }
      total += v; run[i] = total;
    }
    pick = pickAt(rand() * total, run, d2, n);
  }
  const assign = near;
  const sum = new Float64Array(k * 3), cnt = new Int32Array(k);
  const ND = new Float64Array(k * NB), NI = new Int32Array(k * NB), NL = new Int32Array(k);
  for (let it = 0; it < iters; it++) {
    sum.fill(0); cnt.fill(0);
    neighbours(C, k, ND, NI, NL);
    for (let i = 0; i < n; i++) {
      const x = S[3 * i], y = S[3 * i + 1], z = S[3 * i + 2];
      const best = nearest(C, k, x, y, z, assign[i], ND, NI, NL);
      assign[i] = best; cnt[best]++;
      sum[3 * best] += x; sum[3 * best + 1] += y; sum[3 * best + 2] += z;
    }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let j = 0; j < 3; j++) C[3 * c + j] = sum[3 * c + j] / cnt[c];
  }
  return C;
}

// The seeding's pick: the first i < n - 1 at which r, less d2[0..i] one subtraction at a time,
// reaches 0, else n - 1. Those differences track r - run[i] to within E, so wherever run[]
// puts the crossing clear of E, that's the answer without the n subtractions; else do them.
function pickAt(r, run, d2, n) {
  const E = (n + 2) * 2 ** -50 * (run[n - 1] + Math.abs(r));
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (run[m] >= r) hi = m; else lo = m + 1; }
  if (r - run[lo] < -E && (lo === 0 || r - run[lo - 1] > E)) return Math.min(lo, n - 1);
  let pick;
  for (pick = 0; pick < n - 1; pick++) { r -= d2[pick]; if (r <= 0) break; }
  return pick;
}

// Collect Lab samples from an RGBA frame, every `step`-th pixel.
export function sampleFrame(rgba, step, into) {
  for (let j = 0; j < rgba.length; j += 4 * step) { const v = lab(rgba[j], rgba[j + 1], rgba[j + 2]); into.push(v[0], v[1], v[2]); }
}

// 32x32x32 lookup: 5-bit RGB -> nearest centre index.
// Cells go in 4x4x4 blocks. Some centre is within U of every cell in a block (U: the least,
// over centres, of the farthest corner of the block's Lab bounding box), so a centre whose
// nearest box point is beyond U (plus a margin far above rounding error) is strictly farther
// than that one from every cell and can't win or tie. Each cell scans the rest in index order,
// as a full scan would.
let GRID = null, BOX = null; // per cell: Lab of its centre colour; per block: Lab bounds
function grid() {
  GRID = new Float64Array(3 * 32768);
  for (let r = 0, i = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++, i += 3) {
    const v = lab(r * 8 + 4, g * 8 + 4, b * 8 + 4);
    GRID[i] = v[0]; GRID[i + 1] = v[1]; GRID[i + 2] = v[2];
  }
  BOX = new Float64Array(512 * 6);
  for (let blk = 0; blk < 512; blk++) {
    const o = 6 * blk, R = 4 * (blk >> 6), G = 4 * ((blk >> 3) & 7), B = 4 * (blk & 7);
    for (let j = 0; j < 3; j++) { BOX[o + j] = Infinity; BOX[o + 3 + j] = -Infinity; }
    for (let r = R; r < R + 4; r++) for (let g = G; g < G + 4; g++) for (let b = B; b < B + 4; b++) {
      const i = 3 * ((r << 10) | (g << 5) | b);
      for (let j = 0; j < 3; j++) { BOX[o + j] = Math.min(BOX[o + j], GRID[i + j]); BOX[o + 3 + j] = Math.max(BOX[o + 3 + j], GRID[i + j]); }
    }
  }
}
export function buildLUT(C) {
  const k = C.length / 3;
  const lut = new Uint8Array(32768);
  if (k === 0) return lut;
  if (!GRID) grid();
  const cand = new Int32Array(k);
  for (let blk = 0; blk < 512; blk++) {
    const o = 6 * blk;
    const l0 = BOX[o], l1 = BOX[o + 1], l2 = BOX[o + 2], h0 = BOX[o + 3], h1 = BOX[o + 4], h2 = BOX[o + 5];
    let U = Infinity;
    for (let c = 0; c < k; c++) {
      const x = C[3 * c], y = C[3 * c + 1], z = C[3 * c + 2];
      const a = Math.max(x - l0, h0 - x), b = Math.max(y - l1, h1 - y), e = Math.max(z - l2, h2 - z);
      const u = a * a + b * b + e * e;
      if (u < U) U = u;
    }
    const lim = U * 1.000001;
    let m = 0;
    for (let c = 0; c < k; c++) {
      const x = C[3 * c], y = C[3 * c + 1], z = C[3 * c + 2];
      const a = x < l0 ? l0 - x : x > h0 ? x - h0 : 0;
      const b = y < l1 ? l1 - y : y > h1 ? y - h1 : 0;
      const e = z < l2 ? l2 - z : z > h2 ? z - h2 : 0;
      if (a * a + b * b + e * e <= lim) cand[m++] = c;
    }
    const R = 4 * (blk >> 6), G = 4 * ((blk >> 3) & 7), B = 4 * (blk & 7);
    for (let r = R; r < R + 4; r++) for (let g = G; g < G + 4; g++) for (let b = B; b < B + 4; b++) {
      const i = (r << 10) | (g << 5) | b, L = GRID[3 * i], A = GRID[3 * i + 1], Bb = GRID[3 * i + 2];
      let best = 0, bd = Infinity;
      for (let t = 0; t < m; t++) {
        const c = cand[t];
        const x = L - C[3 * c], y = A - C[3 * c + 1], z = Bb - C[3 * c + 2];
        const d = x * x + y * y + z * z;
        if (d < bd) { bd = d; best = c; }
      }
      lut[i] = best;
    }
  }
  return lut;
}

// Scene cuts from small thumbnails (RGBA, same size). A cut is a big jump in both the
// colour histogram and the pixels. SceneCutter takes frames one at a time, so cuts (and the
// palettes that depend on them) can be found while the video is still being read.
// Each bin adds the same 1/n to a float32 per pixel, so its value depends only on its count:
// count, then read the running float32 sum for that count from a table built once per n.
let STEPS = new Float32Array(1), STEPS_N = 0;
function hist64(t) {
  const n = t.length >> 2;
  if (STEPS_N !== n) {
    STEPS = new Float32Array(n + 1); STEPS_N = n;
    for (let m = 1; m <= n; m++) STEPS[m] = STEPS[m - 1] + 1 / n;
  }
  const count = new Int32Array(64);
  for (let j = 0; j < t.length; j += 4) count[((t[j] >> 6) << 4) | ((t[j + 1] >> 6) << 2) | (t[j + 2] >> 6)]++;
  const h = new Float32Array(64);
  for (let k = 0; k < 64; k++) h[k] = STEPS[count[k]];
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
  const step = Math.max(1, Math.round((thumbs[0].length >> 2) * pick.length / target));
  let total = 0;
  for (const i of pick) total += Math.ceil(thumbs[i].length / (4 * step));
  const samples = new Float32Array(3 * total);
  let o = 0;
  for (const i of pick) {
    const t = thumbs[i];
    for (let j = 0; j < t.length; j += 4 * step, o += 3) { const v = lab(t[j], t[j + 1], t[j + 2]); samples[o] = v[0]; samples[o + 1] = v[1]; samples[o + 2] = v[2]; }
  }
  return samples;
}

// One palette per scene, computed in this thread (used by tests).
export function scenePalettes(thumbs, scene, k) {
  const count = scene.length ? scene[scene.length - 1] + 1 : 0;
  const luts = [];
  for (let s = 0; s < count; s++) luts.push(buildLUT(kmeans(sceneSamples(thumbs, scene, s), k)));
  return luts;
}
