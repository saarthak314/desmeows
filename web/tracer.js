// Frame tracer, run as a module Web Worker. One message in per frame, one out.
//
//   paint: quantise to the clip's palette, clean speckle, split into 4-connected regions,
//          merge regions under minArea, trace each region's outer boundary exactly (pixel
//          cracks), simplify, colour it with the region's true mean colour. Drawn largest
//          enclosing area first, so a region's holes are painted by what sits inside them.
//   lines: per-channel Lab Canny, thinned to 1px, walked into centerlines, simplified,
//          coloured from the bright side (line art) or the dark side (ink over paint).
//
// Output per layer: verts Float32Array (x, y pairs, y up), counts Uint32Array (vertices per
// shape), rgb Uint8Array (3 per shape). Coordinates are in trace pixels.

import { kmeans, buildLUT } from './palette.js';

let LUTS = []; // per scene: Uint8Array(32768), 5-bit RGB -> palette index

let lastTransfer = [];
if (typeof self !== 'undefined') self.onmessage = ({ data }) => {
  const res = handle(data);
  self.postMessage(res, lastTransfer);
};

export function setPalettes(luts) { LUTS = luts; }

export function handle(data) {
  if (data.type === 'palettes') { LUTS = data.luts; lastTransfer = []; return { type: 'ready' }; }
  if (data.type === 'kmeans') {
    const lut = buildLUT(kmeans(data.samples, data.k, data.iters));
    lastTransfer = [lut.buffer];
    return { lut };
  }
  const { id, w, h, rgba, opts } = data;
  const res = { id };
  const transfer = [];
  const keep = (name, layer) => {
    if (!layer) return;
    res[name] = layer;
    transfer.push(layer.verts.buffer, layer.counts.buffer, layer.rgb.buffer);
  };
  if (opts.style === 'paint') {
    keep('fill', paint(rgba, w, h, opts));
    if (opts.ink) keep('line', lines(rgba, w, h, opts, true));
  } else {
    keep('line', lines(rgba, w, h, opts, false));
  }
  res.mean = meanColor(rgba);
  lastTransfer = transfer;
  return res;
}

// ---------------------------------------------------------------- shared

function meanColor(rgba) {
  let r = 0, g = 0, b = 0;
  const n = rgba.length >> 2;
  for (let i = 0; i < rgba.length; i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

class Layer {
  constructor() { this.v = []; this.c = []; this.rgb = []; }
  push(pts, r, g, b) { for (const p of pts) this.v.push(p); this.c.push(pts.length >> 1); this.rgb.push(r, g, b); }
  done() {
    return { verts: Float32Array.from(this.v), counts: Uint32Array.from(this.c), rgb: Uint8Array.from(this.rgb) };
  }
}

// Ramer–Douglas–Peucker on a flat [x0,y0,x1,y1,...] array.
function rdp(p, eps, closed) {
  const n = p.length >> 1;
  if (n < 3) return p.slice();
  const keep = new Uint8Array(n);
  const e2 = eps * eps;
  const stack = [];
  const seg = (a, b) => {
    stack.push(a, b);
    while (stack.length) {
      const j = stack.pop(), i = stack.pop();
      const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * j], by = p[2 * j + 1];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let best = -1, bi = -1;
      for (let k = i + 1; k < j; k++) {
        const px = p[2 * k] - ax, py = p[2 * k + 1] - ay;
        let d;
        if (L === 0) d = px * px + py * py;
        else { const cr = px * dy - py * dx; d = cr * cr / L; }
        if (d > best) { best = d; bi = k; }
      }
      if (best > e2) { keep[bi] = 1; stack.push(i, bi, bi, j); }
    }
  };
  if (closed) {
    // Split the loop at the start and the vertex farthest from it.
    let far = 0, fd = -1;
    for (let k = 1; k < n; k++) {
      const dx = p[2 * k] - p[0], dy = p[2 * k + 1] - p[1], d = dx * dx + dy * dy;
      if (d > fd) { fd = d; far = k; }
    }
    keep[0] = keep[far] = 1;
    seg(0, far);
    // second half: far .. n-1 .. 0, unrolled by appending the start vertex
    const q = p.slice(2 * far).concat([p[0], p[1]]);
    const sub = rdp(q, eps, false);
    const out = [];
    for (let k = 0; k <= far; k++) if (keep[k]) out.push(p[2 * k], p[2 * k + 1]);
    for (let k = 2; k < sub.length - 2; k += 2) out.push(sub[k], sub[k + 1]);
    return out;
  }
  keep[0] = keep[n - 1] = 1;
  seg(0, n - 1);
  const out = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(p[2 * k], p[2 * k + 1]);
  return out;
}

// ---------------------------------------------------------------- paint

function paint(rgba, w, h, o) {
  const n = w * h;
  const LUT = LUTS[o.scene || 0];
  let lab = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    lab[i] = LUT[((rgba[j] >> 3) << 10) | ((rgba[j + 1] >> 3) << 5) | (rgba[j + 2] >> 3)];
  }
  for (let pass = 0; pass < o.smooth; pass++) lab = modeFilter(lab, w, h);

  // 4-connected components of equal palette index.
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  let nc = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    const v = lab[s];
    let top = 0, size = 0;
    stack[top++] = s; comp[s] = nc;
    while (top) {
      const p = stack[--top]; size++;
      const x = p % w;
      if (x > 0 && comp[p - 1] === -1 && lab[p - 1] === v) { comp[p - 1] = nc; stack[top++] = p - 1; }
      if (x < w - 1 && comp[p + 1] === -1 && lab[p + 1] === v) { comp[p + 1] = nc; stack[top++] = p + 1; }
      if (p >= w && comp[p - w] === -1 && lab[p - w] === v) { comp[p - w] = nc; stack[top++] = p - w; }
      if (p < n - w && comp[p + w] === -1 && lab[p + w] === v) { comp[p + w] = nc; stack[top++] = p + w; }
    }
    sizes.push(size); nc++;
  }

  // Merge regions under minArea into the neighbour they share the most border with.
  const parent = new Int32Array(nc);
  for (let i = 0; i < nc; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const size = Int32Array.from(sizes);
  const start = new Int32Array(nc + 1);
  for (let p = 0; p < n; p++) start[comp[p] + 1]++;
  for (let i = 0; i < nc; i++) start[i + 1] += start[i];
  const fillAt = start.slice(0, nc);
  const pix = new Int32Array(n);
  for (let p = 0; p < n; p++) pix[fillAt[comp[p]]++] = p;
  const small = [];
  for (let i = 0; i < nc; i++) if (size[i] < o.minArea) small.push(i);
  small.sort((a, b) => size[a] - size[b]);
  const votes = new Map();
  for (const c of small) {
    if (find(c) !== c || size[c] >= o.minArea) continue;
    votes.clear();
    for (let k = start[c]; k < start[c + 1]; k++) {
      const p = pix[k], x = p % w;
      if (x > 0) vote(votes, find(comp[p - 1]), c);
      if (x < w - 1) vote(votes, find(comp[p + 1]), c);
      if (p >= w) vote(votes, find(comp[p - w]), c);
      if (p < n - w) vote(votes, find(comp[p + w]), c);
    }
    let best = -1, bv = 0;
    for (const [k, v] of votes) if (v > bv) { bv = v; best = k; }
    if (best >= 0) { parent[c] = best; size[best] += size[c]; }
  }

  // Final labels, compacted, with exact mean colour and first (top-left) pixel.
  const id = new Int32Array(nc).fill(-1);
  const L = new Int32Array(n);
  const acc = [];
  let m = 0;
  for (let p = 0, j = 0; p < n; p++, j += 4) {
    const r = find(comp[p]);
    let f = id[r];
    if (f === -1) { f = id[r] = m++; acc.push({ first: p, n: 0, r: 0, g: 0, b: 0 }); }
    L[p] = f;
    const a = acc[f];
    a.n++; a.r += rgba[j]; a.g += rgba[j + 1]; a.b += rgba[j + 2];
  }

  const shapes = [];
  for (let f = 0; f < m; f++) {
    const a = acc[f];
    const loop = traceOuter(L, w, h, f, a.first % w, (a.first / w) | 0);
    let area = 0;
    for (let k = 0; k < loop.length; k += 2) {
      const k2 = (k + 2) % loop.length;
      area += loop[k] * loop[k2 + 1] - loop[k2] * loop[k + 1];
    }
    const simp = rdp(loop, o.epsilon, true);
    if (simp.length < 6) continue;
    shapes.push({ area: Math.abs(area), pts: simp, r: a.r / a.n, g: a.g / a.n, b: a.b / a.n });
  }
  // Painter's order: a region that encloses another has the larger enclosed area.
  shapes.sort((s, t) => t.area - s.area);
  const out = new Layer();
  for (const s of shapes) {
    for (let k = 1; k < s.pts.length; k += 2) s.pts[k] = h - s.pts[k];
    out.push(s.pts, Math.round(s.r), Math.round(s.g), Math.round(s.b));
  }
  return out.done();
}

function vote(map, k, self) { if (k !== self) map.set(k, (map.get(k) || 0) + 1); }

function modeFilter(src, w, h) {
  const dst = new Uint8Array(src.length);
  const nb = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          nb[c++] = src[yy * w + xx];
        }
      }
      // keep the centre unless a strict majority (5 of 9) disagrees
      let best = src[y * w + x], bc = 0;
      for (let i = 0; i < 9; i++) {
        let k = 0;
        for (let j = 0; j < 9; j++) if (nb[j] === nb[i]) k++;
        if (k > bc) { bc = k; best = nb[i]; }
      }
      dst[y * w + x] = bc >= 5 ? best : src[y * w + x];
    }
  }
  return dst;
}

// Walk a region's outer boundary along pixel cracks, region on the right, 4-connected,
// then replace the staircase with the midpoints of its unit edges: steps become diagonals,
// and neighbouring regions, which share the same cracks, share the same midpoints.
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1]; // E S W N (y down)
function traceOuter(L, w, h, f, sx, sy) {
  const inR = (x, y) => x >= 0 && y >= 0 && x < w && y < h && L[y * w + x] === f;
  const pts = [sx, sy];
  let x = sx, y = sy, d = 0, guard = 4 * (w + 1) * (h + 1);
  do {
    x += DX[d]; y += DY[d];
    let ar, al;
    switch (d) {
      case 0: ar = inR(x, y); al = inR(x, y - 1); break;
      case 1: ar = inR(x - 1, y); al = inR(x, y); break;
      case 2: ar = inR(x - 1, y - 1); al = inR(x - 1, y); break;
      default: ar = inR(x, y - 1); al = inR(x - 1, y - 1);
    }
    d = ar ? (al ? (d + 3) & 3 : d) : (d + 1) & 3;
    if (!(x === sx && y === sy)) pts.push(x, y);
  } while (!(x === sx && y === sy && d === 0) && --guard > 0);
  const n = pts.length >> 1;
  // Keep frame-edge corners exact so the picture still meets the frame's border.
  const mid = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
    if ((ax === 0 || ax === w) && (ay === 0 || ay === h)) mid.push(ax, ay);
    mid.push((ax + bx) / 2, (ay + by) / 2);
  }
  return mid;
}

// ---------------------------------------------------------------- lines

function lines(rgba, w, h, o, ink) {
  const n = w * h;
  const sm = bilateral(rgba, w, h);
  const [L, A, B] = toLab(sm, n);
  const edges = new Uint8Array(n);
  for (const ch of [L, A, B]) canny(ch, w, h, o.detail, edges);
  thin(edges, w, h);
  const paths = walk(edges, w, h);

  const shapes = [];
  for (const p of paths) {
    if (pathLength(p) < o.minLen) continue;
    let s = rdp(p, o.lineEpsilon, false);
    if (s.length < 4) continue;
    const col = sideColor(rgba, w, h, p, ink);
    if (!col) continue;
    shapes.push({ s, col, len: s.length });
  }
  shapes.sort((a, b) => b.len - a.len);
  const out = new Layer();
  let total = 0;
  for (const { s, col } of shapes) {
    if (total + s.length > o.maxLinePoints * 2) break;
    total += s.length;
    // Out and back: a zero-area polygon whose outline is the open line.
    const loop = s.slice();
    for (let k = s.length - 4; k >= 2; k -= 2) loop.push(s[k], s[k + 1]);
    for (let k = 1; k < loop.length; k += 2) loop[k] = h - loop[k];
    out.push(loop, col[0], col[1], col[2]);
  }
  return out.done();
}

function pathLength(p) {
  let d = 0;
  for (let k = 2; k < p.length; k += 2) d += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
  return d;
}

// Colour of a line from the pixels around it: the bright side for line art (the thing it
// outlines), the dark side for ink over paint (the ink itself). As ink, a line has to be
// real ink, clearly darker than what it borders; edges between two shades are left to the
// fills, which already draw them, and return null.
function sideColor(rgba, w, h, p, ink) {
  const samples = [];
  const step = Math.max(2, ((p.length >> 1) / 60 | 0) * 2);
  for (let k = 0; k < p.length; k += step) {
    const cx = p[k], cy = p[k + 1];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = Math.min(w - 1, Math.max(0, cx + dx)), y = Math.min(h - 1, Math.max(0, cy + dy));
      const j = (y * w + x) * 4;
      samples.push(rgba[j], rgba[j + 1], rgba[j + 2]);
    }
  }
  const m = samples.length / 3;
  const lum = new Float32Array(m);
  for (let i = 0; i < m; i++) lum[i] = 0.299 * samples[3 * i] + 0.587 * samples[3 * i + 1] + 0.114 * samples[3 * i + 2];
  const sorted = Float32Array.from(lum).sort();
  const dark = sorted[Math.floor(m * 0.1)], hi = sorted[Math.floor(m * 0.7)];
  if (ink && !(dark < 110 && dark < hi * 0.5)) return null;
  const cut = ink ? sorted[Math.floor(m * 0.15)] : hi;
  let r = 0, g = 0, b = 0, c = 0;
  for (let i = 0; i < m; i++) {
    if (ink ? lum[i] <= cut : lum[i] >= cut) { r += samples[3 * i]; g += samples[3 * i + 1]; b += samples[3 * i + 2]; c++; }
  }
  return [Math.round(r / c), Math.round(g / c), Math.round(b / c)];
}

// 5x5 bilateral filter: flattens shading and texture, keeps the hard ink lines.
function bilateral(rgba, w, h) {
  const out = new Uint8ClampedArray(rgba.length);
  const sc = 2 * 40 * 40, ss = 2 * 3 * 3;
  const rangeW = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) rangeW[i] = Math.exp(-(i * 64) / sc);
  const spaceW = new Float32Array(25);
  for (let dy = -2, k = 0; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++, k++) spaceW[k] = Math.exp(-(dx * dx + dy * dy) / ss);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      const r0 = rgba[j], g0 = rgba[j + 1], b0 = rgba[j + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dy = -2, k = 0; dy <= 2; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -2; dx <= 2; dx++, k++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const q = (yy * w + xx) * 4;
          const dr = rgba[q] - r0, dg = rgba[q + 1] - g0, db = rgba[q + 2] - b0;
          const d2 = (dr * dr + dg * dg + db * db) >> 6;
          const wt = spaceW[k] * (d2 < 1024 ? rangeW[d2] : 0);
          sr += rgba[q] * wt; sg += rgba[q + 1] * wt; sb += rgba[q + 2] * wt; sw += wt;
        }
      }
      out[j] = sr / sw; out[j + 1] = sg / sw; out[j + 2] = sb / sw; out[j + 3] = 255;
    }
  }
  return out;
}

// sRGB -> CIE Lab scaled to 8 bits the way OpenCV does (L*2.55, a+128, b+128).
const GAMMA = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; GAMMA[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function toLab(rgba, n) {
  const L = new Uint8Array(n), A = new Uint8Array(n), B = new Uint8Array(n);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = GAMMA[rgba[j]], g = GAMMA[rgba[j + 1]], b = GAMMA[rgba[j + 2]];
    const X = (0.412453 * r + 0.35758 * g + 0.180423 * b) / 0.950456;
    const Y = 0.212671 * r + 0.71516 * g + 0.072169 * b;
    const Z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / 1.088754;
    const fx = f(X), fy = f(Y), fz = f(Z);
    L[i] = Math.round((Y > 0.008856 ? 116 * fy - 16 : 903.3 * Y) * 2.55);
    A[i] = Math.max(0, Math.min(255, Math.round(500 * (fx - fy) + 128)));
    B[i] = Math.max(0, Math.min(255, Math.round(200 * (fy - fz) + 128)));
  }
  return [L, A, B];
}

// Canny with a per-frame threshold: hi = max(pct-th percentile of gradient, 40), lo = 0.4 hi.
function canny(ch, w, h, pct, out) {
  const n = w * h;
  const mag = new Float32Array(n);
  const dir = new Uint8Array(n);
  const hist = new Uint32Array(2048);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = -ch[p - w - 1] - 2 * ch[p - 1] - ch[p + w - 1] + ch[p - w + 1] + 2 * ch[p + 1] + ch[p + w + 1];
      const gy = -ch[p - w - 1] - 2 * ch[p - w] - ch[p - w + 1] + ch[p + w - 1] + 2 * ch[p + w] + ch[p + w + 1];
      const m = Math.hypot(gx, gy);
      mag[p] = m;
      hist[Math.min(2047, m | 0)]++;
      const ax = Math.abs(gx), ay = Math.abs(gy);
      dir[p] = ay <= ax * 0.4142 ? 0 : ay >= ax * 2.4142 ? 2 : (gx > 0) === (gy > 0) ? 1 : 3;
    }
  }
  let target = n * pct / 100, cum = 0, pv = 0;
  for (let i = 0; i < 2048; i++) { cum += hist[i]; if (cum >= target) { pv = i; break; } }
  const hi = Math.max(pv, 40), lo = hi * 0.4;
  const nms = new Uint8Array(n);
  const stack = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x, m = mag[p];
      if (m < lo) continue;
      let a, b;
      switch (dir[p]) {
        case 0: a = mag[p - 1]; b = mag[p + 1]; break;
        case 2: a = mag[p - w]; b = mag[p + w]; break;
        case 1: a = mag[p - w - 1]; b = mag[p + w + 1]; break;
        default: a = mag[p - w + 1]; b = mag[p + w - 1];
      }
      if (m > a && m >= b) {
        nms[p] = m >= hi ? 2 : 1;
        if (m >= hi) stack.push(p);
      }
    }
  }
  while (stack.length) {
    const p = stack.pop();
    out[p] = 1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const q = p + dy * w + dx;
      if (nms[q] === 1) { nms[q] = 2; stack.push(q); }
    }
  }
}

// Zhang–Suen thinning to a 1px skeleton, in place.
function thin(img, w, h) {
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (!img[p]) continue;
          const p2 = img[p - w], p3 = img[p - w + 1], p4 = img[p + 1], p5 = img[p + w + 1];
          const p6 = img[p + w], p7 = img[p + w - 1], p8 = img[p - 1], p9 = img[p - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (step === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
          del.push(p);
        }
      }
      for (const p of del) img[p] = 0;
      if (del.length) changed = true;
    }
  }
}

// Walk a 1px skeleton into open polylines, starting from stroke endpoints.
const NB = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
function walk(img, w, h) {
  const on = img;
  const deg = (x, y) => {
    let c = 0;
    for (const [dx, dy] of NB) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && on[yy * w + xx]) c++;
    }
    return c;
  };
  const ends = [], rest = [];
  for (let p = 0; p < w * h; p++) {
    if (!on[p]) continue;
    (deg(p % w, (p / w) | 0) === 1 ? ends : rest).push(p);
  }
  const paths = [];
  for (const p0 of ends.concat(rest)) {
    if (!on[p0]) continue;
    let x = p0 % w, y = (p0 / w) | 0;
    const path = [x, y];
    on[p0] = 0;
    for (;;) {
      let moved = false;
      for (const [dx, dy] of NB) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && on[yy * w + xx]) {
          on[yy * w + xx] = 0; x = xx; y = yy; path.push(x, y); moved = true; break;
        }
      }
      if (!moved) break;
    }
    paths.push(path);
  }
  return paths;
}
