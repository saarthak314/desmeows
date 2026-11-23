// Frame tracer, run as a module Web Worker. One message in per frame, one out.
//
//   paint: quantise to the clip's palette, clean speckle, split into 4-connected regions,
//          merge regions under minArea, trace each region's outer boundary exactly (pixel
//          cracks), simplify, colour it with the region's true mean colour. Drawn largest
//          enclosing area first, so a region's holes are painted by what sits inside them.
//   lines: per-channel Lab Canny, thinned to 1px, walked into centerlines, simplified,
//          coloured from the bright side (line art) or the dark side (ink over paint).
//
// Output per layer: verts Int16Array (x, y pairs, y up, in half trace pixels), counts
// Uint32Array (vertices per shape), rgb Uint8Array (3 per shape).

import { kmeans, buildLUT } from './palette.js';

let LUTS = []; // per scene: Uint8Array(32768), 5-bit RGB -> palette index

let lastTransfer = [];
if (typeof self !== 'undefined') self.onmessage = ({ data }) => {
  // one scene's palette, sent ahead of that scene's frames; no reply
  if (data.type === 'palette-add') { LUTS[data.index] = data.lut; return; }
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

// Working memory kept across frames (a worker traces one frame per message), grown when a
// bigger frame arrives. Contents are garbage on entry unless a function clears what it reads.
const SCRATCH = new Map();
function scratch(name, Type, n) {
  let a = SCRATCH.get(name);
  if (!a || a.length < n) { a = new Type(Math.max(n, 16)); SCRATCH.set(name, a); }
  return a;
}

function meanColor(rgba) {
  let r = 0, g = 0, b = 0;
  const n = rgba.length >> 2, px = new Int32Array(rgba.buffer, rgba.byteOffset, n);
  for (let i = 0; i < n; i++) { const v = px[i]; r += v & 255; g += (v >> 8) & 255; b += (v >> 16) & 255; }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

// Every coordinate the tracer makes is a multiple of half a pixel (crack midpoints, pixel
// corners, pixel centres), so storing half-pixel units in 16 bits is exact and half the size
// of Float32: less memory per clip, smaller transfers, and integer latex for Desmos.
class Layer {
  constructor() { this.v = []; this.c = []; this.rgb = []; }
  push(pts, r, g, b) { for (const p of pts) this.v.push(p * 2); this.c.push(pts.length >> 1); this.rgb.push(r, g, b); }
  done() {
    return { verts: Int16Array.from(this.v), counts: Uint32Array.from(this.c), rgb: Uint8Array.from(this.rgb) };
  }
}

// Ramer–Douglas–Peucker on the flat points P[2i], P[2i+1]. Marks kept points in keep[], which
// the caller zeroes over [0, n) first. Closed loops split at the start and the vertex farthest
// from it; the second half runs from there back to the start, so P needs room for point n,
// which is set to a copy of point 0.
let RDP_STACK = new Int32Array(1024);
function rdp(P, n, eps, closed, keep) {
  if (n < 3) { for (let k = 0; k < n; k++) keep[k] = 1; return; }
  const e2 = eps * eps;
  if (RDP_STACK.length < 2 * n + 4) RDP_STACK = new Int32Array(2 * n + 4);
  if (!closed) { keep[0] = keep[n - 1] = 1; rdpSeg(P, 0, n - 1, e2, keep, RDP_STACK); return; }
  const x0 = P[0], y0 = P[1];
  let far = 0, fd = -1;
  for (let k = 1; k < n; k++) {
    const dx = P[2 * k] - x0, dy = P[2 * k + 1] - y0, d = dx * dx + dy * dy;
    if (d > fd) { fd = d; far = k; }
  }
  keep[0] = keep[far] = 1;
  rdpSeg(P, 0, far, e2, keep, RDP_STACK);
  P[2 * n] = x0; P[2 * n + 1] = y0;
  if (n - far >= 2) rdpSeg(P, far, n, e2, keep, RDP_STACK);
}

// Points sit on the half-pixel grid (whole pixels for lines). While the squared length L is
// under RDP_EXACT_L (2^48 over the frame's squared diagonal), squared cross products are exact
// multiples of 1/16, too far apart for two different ones to round to the same quotient by L:
// the farthest point is the first with the largest squared cross product, and only that one
// needs the division.
let RDP_EXACT_L = 0;
function rdpSeg(P, i0, j0, e2, keep, stack) {
  let top = 0;
  stack[top++] = i0; stack[top++] = j0;
  while (top) {
    const j = stack[--top], i = stack[--top];
    if (j - i < 2) continue;
    const ax = P[2 * i], ay = P[2 * i + 1], bx = P[2 * j], by = P[2 * j + 1];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let best = -1, bi = -1;
    if (L === 0) {
      for (let k = i + 1; k < j; k++) {
        const px = P[2 * k] - ax, py = P[2 * k + 1] - ay, d = px * px + py * py;
        if (d > best) { best = d; bi = k; }
      }
    } else if (L < RDP_EXACT_L) {
      // the largest, then the first point with it: two plain loops beat one branchy one
      for (let k = i + 1; k < j; k++) {
        const cr = (P[2 * k] - ax) * dy - (P[2 * k + 1] - ay) * dx;
        best = Math.max(best, cr * cr);
      }
      for (let k = i + 1; ; k++) {
        const cr = (P[2 * k] - ax) * dy - (P[2 * k + 1] - ay) * dx;
        if (cr * cr === best) { bi = k; break; }
      }
      best /= L;
    } else {
      for (let k = i + 1; k < j; k++) {
        const cr = (P[2 * k] - ax) * dy - (P[2 * k + 1] - ay) * dx, d = cr * cr / L;
        if (d > best) { best = d; bi = k; }
      }
    }
    if (best > e2) { keep[bi] = 1; stack[top++] = i; stack[top++] = bi; stack[top++] = bi; stack[top++] = j; }
  }
}

// ---------------------------------------------------------------- paint

function paint(rgba, w, h, o) {
  const n = w * h;
  RDP_EXACT_L = 2 ** 48 / (w * w + h * h);
  const LUT = LUTS[o.scene || 0];
  const px = new Int32Array(rgba.buffer, rgba.byteOffset, n);
  let lab = scratch('pLab', Uint8Array, n), alt = scratch('pLab2', Uint8Array, n);
  for (let i = 0; i < n; i++) {
    const v = px[i]; // little-endian RGBA: 5-bit r, g, b into a 15-bit index
    lab[i] = LUT[((v & 0xf8) << 7) | ((v >> 6) & 0x3e0) | ((v >> 19) & 0x1f)];
  }
  for (let pass = 0; pass < o.smooth; pass++) { modeFilter(lab, alt, w, h); const t = lab; lab = alt; alt = t; }

  // 4-connected components of equal palette index, from horizontal runs: runs touching across
  // rows join (union-find, the root is always the earliest run), so numbering roots in run
  // order numbers components by their first pixel in raster order.
  const rx = scratch('pRunX', Int32Array, n + 1); // where each run starts; rx[nr] = n ends the last
  const rowRun = scratch('pRowRun', Int32Array, h + 1);
  let nr = 0;
  for (let y = 0; y < h; y++) {
    const o0 = y * w, end = o0 + w;
    rowRun[y] = nr;
    rx[nr++] = o0;
    let v = lab[o0];
    for (let p = o0 + 1; p < end; p++) if (lab[p] !== v) { rx[nr++] = p; v = lab[p]; }
  }
  rowRun[h] = nr; rx[nr] = n;
  const rp = scratch('pRunParent', Int32Array, nr);
  for (let r = 0; r < nr; r++) rp[r] = r;
  for (let y = 1; y < h; y++) {
    // runs of the row above and this row, walked together by column
    let a = rowRun[y - 1], b = rowRun[y];
    const aEnd = rowRun[y], bEnd = rowRun[y + 1], off = w;
    while (a < aEnd && b < bEnd) {
      const a0 = rx[a] + off, a1 = rx[a + 1] + off, b0 = rx[b], b1 = rx[b + 1];
      if (a0 < b1 && b0 < a1 && lab[b0] === lab[rx[a]]) {
        let ra = a, rb = b;
        while (rp[ra] !== ra) ra = rp[ra] = rp[rp[ra]];
        while (rp[rb] !== rb) rb = rp[rb] = rp[rp[rb]];
        if (ra < rb) rp[rb] = ra; else if (rb < ra) rp[ra] = rb;
      }
      if (a1 <= b1) a++; else b++;
    }
  }
  const runComp = scratch('pRunComp', Int32Array, nr);
  const comp = scratch('pComp', Int32Array, n);
  const sizeBuf = scratch('pSize', Int32Array, nr);
  let nc = 0;
  for (let r = 0; r < nr; r++) {
    let root = rp[r];
    while (rp[root] !== root) root = rp[root];
    rp[r] = root;
    let c;
    if (root === r) { c = nc++; sizeBuf[c] = 0; } else c = runComp[root];
    runComp[r] = c;
    const p0 = rx[r], p1 = rx[r + 1];
    sizeBuf[c] += p1 - p0;
    for (let p = p0; p < p1; p++) comp[p] = c; // runs are short: a loop beats fill()
  }

  // Merge regions under minArea into the neighbour they share the most border with, smallest
  // first (ties in index order), counting each small region's own pixels in raster order.
  const parent = scratch('pParent', Int32Array, nc);
  for (let i = 0; i < nc; i++) parent[i] = i;
  const size = sizeBuf;
  const minArea = Math.ceil(o.minArea); // sizes are whole, so this splits them the same way
  let nSmall = 0, nSmallPix = 0;
  for (let i = 0; i < nc; i++) if (size[i] < minArea) { nSmall++; nSmallPix += size[i]; }
  if (nSmall) {
    // each small region's pixels, in raster order
    const at = scratch('pAt', Int32Array, nc);
    const sStart = scratch('pSmallStart', Int32Array, nc + 1);
    const pix = scratch('pSmallPix', Int32Array, nSmallPix);
    for (let i = 0, s = 0; i < nc; i++) { sStart[i] = s; at[i] = s; if (size[i] < minArea) s += size[i]; }
    for (let r = 0; r < nr; r++) {
      const c = runComp[r];
      if (size[c] >= minArea) continue;
      for (let p = rx[r], e = rx[r + 1]; p < e; p++) pix[at[c]++] = p;
    }
    // small regions by size, then index (a stable counting sort)
    const order = scratch('pOrder', Int32Array, nSmall);
    const bucket = scratch('pBucket', Int32Array, minArea + 1);
    bucket.fill(0, 0, minArea + 1);
    for (let i = 0; i < nc; i++) if (size[i] < minArea) bucket[size[i] + 1]++;
    for (let s = 1; s <= minArea; s++) bucket[s] += bucket[s - 1];
    for (let i = 0; i < nc; i++) if (size[i] < minArea) order[bucket[size[i]]++] = i;
    // votes: a count per neighbour, and the neighbours in the order first seen
    const cnt = scratch('pVotes', Int32Array, nc);
    cnt.fill(0, 0, nc);
    const seen = scratch('pSeen', Int32Array, 4 * minArea + 4);
    for (let t = 0; t < nSmall; t++) {
      const c = order[t];
      if (parent[c] !== c || size[c] >= minArea) continue;
      let ns = 0;
      for (let k = sStart[c], e = at[c]; k < e; k++) {
        const p = pix[k], x = p % w;
        for (let side = 0; side < 4; side++) {
          let q;
          if (side === 0) { if (x === 0) continue; q = p - 1; }
          else if (side === 1) { if (x === w - 1) continue; q = p + 1; }
          else if (side === 2) { if (p < w) continue; q = p - w; }
          else { if (p >= n - w) continue; q = p + w; }
          let r = comp[q];
          while (parent[r] !== r) r = parent[r] = parent[parent[r]];
          if (r === c) continue;
          if (cnt[r]++ === 0) seen[ns++] = r;
        }
      }
      let best = -1, bv = 0;
      for (let i = 0; i < ns; i++) { const r = seen[i], v = cnt[r]; cnt[r] = 0; if (v > bv) { bv = v; best = r; } }
      if (best >= 0) { parent[c] = best; size[best] += size[c]; }
    }
  }

  // Final labels, compacted, with exact mean colour and first (top-left) pixel. Labels go in a
  // frame padded by one pixel of -1 so the boundary walk needs no bounds checks.
  const W2 = w + 2, LP = scratch('pLabels', Int32Array, W2 * (h + 2));
  LP.fill(-1, 0, W2); LP.fill(-1, (h + 1) * W2, (h + 2) * W2);
  for (let y = 1; y <= h; y++) { LP[y * W2] = -1; LP[y * W2 + w + 1] = -1; }
  const id = scratch('pId', Int32Array, nc);
  id.fill(-1, 0, nc);
  const first = scratch('pFirst', Int32Array, nc), npx = scratch('pPixels', Int32Array, nc);
  const sr = scratch('pSumR', Float64Array, nc), sg = scratch('pSumG', Float64Array, nc), sb = scratch('pSumB', Float64Array, nc);
  let m = 0;
  for (let y = 0, r = 0; y < h; y++) {
    const lo = (y + 1) * W2 + 1 - y * w;
    for (const re = rowRun[y + 1]; r < re; r++) {
      let c = runComp[r];
      while (parent[c] !== c) c = parent[c];
      let f = id[c];
      const p0 = rx[r], p1 = rx[r + 1];
      if (f === -1) { f = id[c] = m++; first[f] = p0; npx[f] = 0; sr[f] = 0; sg[f] = 0; sb[f] = 0; }
      let R = 0, G = 0, B = 0;
      for (let p = p0; p < p1; p++) { LP[p + lo] = f; const v = px[p]; R += v & 255; G += (v >> 8) & 255; B += (v >> 16) & 255; }
      npx[f] += p1 - p0; sr[f] += R; sg[f] += G; sb[f] += B;
    }
  }

  // Trace, simplify and keep each region; simplified loops pile up in one buffer.
  let pool = scratch('pPool', Float64Array, 1 << 16), used = 0;
  const shapeAt = scratch('pShapeAt', Int32Array, m + 1), shapeArea = scratch('pShapeArea', Float64Array, m);
  const shapeF = scratch('pShapeF', Int32Array, m);
  let ns = 0;
  for (let f = 0; f < m; f++) {
    const a = first[f];
    const nm = traceOuter(LP, W2, w, h, f, a % w, (a / w) | 0), M = MID;
    const keep = keepFor(nm + 1);
    rdp(M, nm, o.epsilon, true, keep);
    if (pool.length < used + 2 * nm + 2) {
      const bigger = new Float64Array(Math.max(pool.length * 2, used + 2 * nm + 2));
      bigger.set(pool.subarray(0, used)); pool = bigger; SCRATCH.set('pPool', pool);
    }
    const start = used;
    for (let k = 0; k < nm; k++) { pool[used] = M[2 * k]; pool[used + 1] = M[2 * k + 1]; used += 2 * keep[k]; keep[k] = 0; }
    if (used - start < 6) { used = start; continue; }
    shapeAt[ns] = start; shapeArea[ns] = Math.abs(MID_AREA); shapeF[ns] = f; ns++;
  }
  shapeAt[ns] = used;
  // Painter's order: a region that encloses another has the larger enclosed area. Shoelace sums
  // of half-pixel points are exact multiples of 1/4, so area and index pack into one number
  // that sorts natively, largest area first and ties in order.
  const out = new Layer();
  const K = 2 ** Math.ceil(Math.log2(ns + 1)), top = 8 * w * h;
  let order;
  if (top * K < 2 ** 53) {
    order = scratch('pSortKey', Float64Array, ns).subarray(0, ns);
    for (let i = 0; i < ns; i++) order[i] = (top - 4 * shapeArea[i]) * K + i;
    order.sort();
    for (let i = 0; i < ns; i++) { const v = order[i]; order[i] = v - Math.floor(v / K) * K; }
  } else {
    order = Array.from({ length: ns }, (_, i) => i);
    order.sort((s, t) => shapeArea[t] - shapeArea[s] || s - t);
  }
  for (const s of order) {
    const f = shapeF[s], cnt = npx[f], a = shapeAt[s], e = shapeAt[s + 1];
    const pts = new Array(e - a);
    for (let k = a; k < e; k += 2) { pts[k - a] = pool[k]; pts[k - a + 1] = h - pool[k + 1]; }
    out.push(pts, Math.round(sr[f] / cnt), Math.round(sg[f] / cnt), Math.round(sb[f] / cnt));
  }
  return out.done();
}

// 3x3 majority: keep the centre unless a strict majority (5 of 9) is another label. The window
// slides along the row, loading one new column per pixel.
function modeFilter(src, dst, w, h) {
  for (let y = 0; y < h; y++) {
    const r0 = (y > 0 ? y - 1 : 0) * w, r1 = y * w, r2 = (y < h - 1 ? y + 1 : h - 1) * w;
    // columns x - 1 (a), x (b), x + 1 (c); rows above (0), this (1), below (2)
    let a0 = src[r0], a1 = src[r1], a2 = src[r2], b0 = a0, b1 = a1, b2 = a2;
    for (let x = 0; x < w; x++) {
      const xp = x < w - 1 ? x + 1 : x;
      const c0 = src[r0 + xp], c1 = src[r1 + xp], c2 = src[r2 + xp], c = b1;
      // two labels can't both reach 5, so a centre that already holds 5 is the answer
      const k = 1 + (a0 === c) + (b0 === c) + (c0 === c) + (a1 === c) + (c1 === c) + (a2 === c) + (b2 === c) + (c2 === c);
      let out = c;
      if (k < 5) {
        // a majority value must sit in any five slots: try the first five (the fifth is the centre)
        for (let i = 0; i < 4; i++) {
          const v = i === 0 ? a0 : i === 1 ? b0 : i === 2 ? c0 : a1;
          if (v === c) continue;
          const m = (a0 === v) + (b0 === v) + (c0 === v) + (a1 === v) + (c1 === v) + (a2 === v) + (b2 === v) + (c2 === v);
          if (m >= 5) { out = v; break; }
        }
      }
      dst[r1 + x] = out;
      a0 = b0; a1 = b1; a2 = b2; b0 = c0; b1 = c1; b2 = c2;
    }
  }
}

// Walk a region's outer boundary along pixel cracks, region on the right, 4-connected,
// then replace the staircase with the midpoints of its unit edges: steps become diagonals,
// and neighbouring regions, which share the same cracks, share the same midpoints.
// Leaves the midpoint loop in MID (room for one more point), its shoelace sum in MID_AREA, and
// returns its length.
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1]; // E S W N (y down)
const TURN = [1, 1, 0, 3]; // by (ahead-right inside) * 2 + (ahead-left inside)
const WALK = new Int32Array(12);
function traceOuter(LP, W2, w, h, f, sx, sy) {
  let C = CORNER, cap = C.length;
  C[0] = sx; C[1] = sy;
  let nc = 2;
  // c indexes the pixel whose top-left corner is (x, y). Per heading d: T[d] is the step,
  // T[4 + d] and T[8 + d] the pixels ahead-right and ahead-left of the new corner.
  const T = WALK, c0 = (sy + 1) * W2 + sx + 1;
  T[0] = 1; T[1] = W2; T[2] = -1; T[3] = -W2;
  T[4] = 0; T[5] = -1; T[6] = -W2 - 1; T[7] = -W2;
  T[8] = -W2; T[9] = 0; T[10] = -1; T[11] = -W2 - 1;
  let x = sx, y = sy, d = 0, c = c0, guard = 4 * (w + 1) * (h + 1);
  do {
    c += T[d]; x += DX[d]; y += DY[d];
    const t = (LP[c + T[4 + d]] === f ? 2 : 0) | (LP[c + T[8 + d]] === f ? 1 : 0);
    d = (d + TURN[t]) & 3;
    if (c !== c0) {
      if (nc + 2 > cap) { const B = new Int32Array(cap * 2); B.set(C); C = CORNER = B; cap = C.length; }
      C[nc++] = x; C[nc++] = y;
    }
  } while (!(c === c0 && d === 0) && --guard > 0);
  const n = nc >> 1;
  // Keep frame-edge corners exact so the picture still meets the frame's border. The shoelace
  // sum over the loop goes along for the painter's order.
  if (MID.length < 2 * n + 10) MID = new Float64Array(4 * n + 10);
  const M = MID;
  let k = 0, ar = 0, px = 0, py = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ax = C[2 * i], ay = C[2 * i + 1], bx = C[2 * j], by = C[2 * j + 1];
    if ((ax === 0 || ax === w) && (ay === 0 || ay === h)) {
      if (k) ar += px * ay - ax * py;
      M[k++] = px = ax; M[k++] = py = ay;
    }
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    if (k) ar += px * my - mx * py;
    M[k++] = px = mx; M[k++] = py = my;
  }
  MID_AREA = ar + (px * M[1] - M[0] * py);
  return k >> 1;
}
let CORNER = new Int32Array(4096), MID = new Float64Array(1024), MID_AREA = 0;

// A zeroed Uint8Array of at least n; callers zero what they set before the next call.
let KEEP = new Uint8Array(1024);
function keepFor(n) {
  if (KEEP.length < n) KEEP = new Uint8Array(2 * n);
  return KEEP;
}

// ---------------------------------------------------------------- lines

function lines(rgba, w, h, o, ink) {
  const n = w * h;
  RDP_EXACT_L = 2 ** 48 / (w * w + h * h);
  const sm = bilateral(rgba, w, h);
  const L = scratch('lL', Uint8Array, n), A = scratch('lA', Uint8Array, n), B = scratch('lB', Uint8Array, n);
  toLab(sm, n, L, A, B);
  const edges = scratch('lEdges', Uint8Array, n);
  edges.fill(0, 0, n);
  canny(L, w, h, o.detail, edges);
  canny(A, w, h, o.detail, edges);
  canny(B, w, h, o.detail, edges);
  const nLive = thin(edges, w, h);
  const np = walk(edges, w, h, nLive);
  const PP = SCRATCH.get('wPts'), PS = SCRATCH.get('wStarts');

  const shapes = [];
  for (let i = 0; i < np; i++) {
    const a = PS[i], e = PS[i + 1], cnt = (e - a) >> 1;
    if (pathLength(PP, a, e) < o.minLen) continue;
    if (PATH.length < e - a + 2) PATH = new Float64Array(2 * (e - a) + 2);
    const P = PATH, keep = keepFor(cnt + 1);
    for (let k = a; k < e; k++) P[k - a] = PP[k];
    rdp(P, cnt, o.lineEpsilon, false, keep);
    let kept = 0;
    for (let k = 0; k < cnt; k++) kept += keep[k];
    const col = kept < 2 ? null : sideColor(rgba, w, h, PP, a, e, ink);
    if (!col) { for (let k = 0; k < cnt; k++) keep[k] = 0; continue; }
    const s = new Array(2 * kept);
    for (let k = 0, j = 0; k < cnt; k++) if (keep[k]) { keep[k] = 0; s[j++] = P[2 * k]; s[j++] = P[2 * k + 1]; }
    shapes.push({ s, col, len: s.length });
  }
  shapes.sort((a, b) => b.len - a.len);
  const out = new Layer();
  let total = 0;
  for (const { s, col } of shapes) {
    if (total + s.length > o.maxLinePoints * 2) break;
    total += s.length;
    // Out and back: a zero-area polygon whose outline is the open line.
    const loop = new Array(2 * s.length - 4);
    for (let k = 0; k < s.length; k += 2) { loop[k] = s[k]; loop[k + 1] = h - s[k + 1]; }
    for (let k = s.length - 4, j = s.length; k >= 2; k -= 2, j += 2) { loop[j] = s[k]; loop[j + 1] = h - s[k + 1]; }
    out.push(loop, col[0], col[1], col[2]);
  }
  return out.done();
}

let PATH = new Float64Array(1024);
const DIAG = Math.hypot(1, 1);
// Path steps are unit moves to one of the 8 neighbours.
function pathLength(PP, a, e) {
  let d = 0;
  for (let k = a + 2; k < e; k += 2) d += PP[k] !== PP[k - 2] && PP[k + 1] !== PP[k - 1] ? DIAG : 1;
  return d;
}

// Colour of a line from the pixels around it: the bright side for line art (the thing it
// outlines), the dark side for ink over paint (the ink itself). As ink, a line has to be
// real ink, clearly darker than what it borders; edges between two shades are left to the
// fills, which already draw them, and return null.
function sideColor(rgba, w, h, PP, a, e, ink) {
  const len = e - a;
  const step = Math.max(2, ((len >> 1) / 60 | 0) * 2);
  const m = Math.ceil(len / step) * 25;
  if (SC_LUM.length < m) { SC_LUM = new Float32Array(2 * m); SC_TMP = new Float32Array(2 * m); SC_RGB = new Uint8Array(6 * m); }
  const lum = SC_LUM, tmp = SC_TMP, rgb = SC_RGB;
  // luminance histogram by whole value, for rank()
  const hist = SC_HIST;
  hist.fill(0);
  let n = 0;
  for (let k = a; k < e; k += step) {
    const cx = PP[k], cy = PP[k + 1];
    if (cx >= 2 && cy >= 2 && cx < w - 2 && cy < h - 2) {
      for (let j0 = ((cy - 2) * w + cx - 2) * 4, r = 0; r < 5; r++, j0 += 4 * w) {
        for (let j = j0; j < j0 + 20; j += 4) {
          const R = rgba[j], G = rgba[j + 1], B = rgba[j + 2];
          rgb[3 * n] = R; rgb[3 * n + 1] = G; rgb[3 * n + 2] = B;
          const v = Math.fround(0.299 * R + 0.587 * G + 0.114 * B);
          lum[n++] = v; hist[v | 0]++;
        }
      }
      continue;
    }
    for (let dy = -2; dy <= 2; dy++) {
      const y = Math.min(h - 1, Math.max(0, cy + dy));
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.min(w - 1, Math.max(0, cx + dx));
        const j = (y * w + x) * 4;
        const R = rgba[j], G = rgba[j + 1], B = rgba[j + 2];
        rgb[3 * n] = R; rgb[3 * n + 1] = G; rgb[3 * n + 2] = B;
        const v = Math.fround(0.299 * R + 0.587 * G + 0.114 * B);
        lum[n++] = v; hist[v | 0]++;
      }
    }
  }
  const k70 = Math.floor(n * 0.7);
  let cut;
  if (ink) {
    const k10 = Math.floor(n * 0.1);
    // dark < 110 needs more than k10 values under 110, which the histogram already counts
    let under = 0;
    for (let i = 0; i < 110; i++) under += hist[i];
    if (under <= k10) return null;
    const dark = rank(lum, n, hist, k10, tmp);
    const hi = rank(lum, n, hist, k70, tmp);
    if (!(dark < 110 && dark < hi * 0.5)) return null;
    cut = rank(lum, n, hist, Math.floor(n * 0.15), tmp);
  } else cut = rank(lum, n, hist, k70, tmp);
  let r = 0, g = 0, b = 0, c = 0;
  if (ink) {
    for (let i = 0; i < n; i++) if (lum[i] <= cut) { r += rgb[3 * i]; g += rgb[3 * i + 1]; b += rgb[3 * i + 2]; c++; }
  } else {
    for (let i = 0; i < n; i++) if (lum[i] >= cut) { r += rgb[3 * i]; g += rgb[3 * i + 1]; b += rgb[3 * i + 2]; c++; }
  }
  return [Math.round(r / c), Math.round(g / c), Math.round(b / c)];
}
const SC_HIST = new Int32Array(257);
let SC_LUM = new Float32Array(4096), SC_TMP = new Float32Array(4096), SC_RGB = new Uint8Array(3 * 4096);

// The k-th smallest of lum[0..n), exactly as sorting would give it: find its whole-number
// bucket from the histogram, then select among that bucket's values only.
function rank(lum, n, hist, k, tmp) {
  let b = 0, below = 0;
  while (below + hist[b] <= k) below += hist[b++];
  let m = 0;
  for (let i = 0; i < n; i++) { const v = lum[i]; if ((v | 0) === b) tmp[m++] = v; }
  return select(tmp, m, k - below);
}

// Quickselect (Hoare partition): the value that would sit at index k of a[0..n) sorted.
function select(a, n, k) {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}

// 5x5 bilateral filter: flattens shading and texture, keeps the hard ink lines.
// A pair's weight is the same seen from either pixel, so each pixel works out the 12 weights to
// the neighbours after it in raster order, parks them in a 3-row ring, and reads the 12 before
// it from there. Weights past the range cutoff are 0, which adds exactly nothing. The weights
// are float32 values; the range table holds them as doubles to skip a conversion per use.
const RANGE_W = new Float64Array(3072), SPACE_W = new Float32Array(25);
for (let i = 0; i < 1024; i++) RANGE_W[i] = Math.fround(Math.exp(-(i * 64) / (2 * 40 * 40)));
for (let dy = -2, k = 0; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++, k++) SPACE_W[k] = Math.exp(-(dx * dx + dy * dy) / (2 * 3 * 3));
const FDX = [1, 2, -2, -1, 0, 1, 2, -2, -1, 0, 1, 2], FDY = [0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2];
const FW = Float64Array.from(SPACE_W.subarray(13)); // space weight of each forward offset
function bilateral(rgba, w, h) {
  const out = scratch('bilOut', Uint8ClampedArray, rgba.length);
  const px = new Int32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
  const R = 12 * w, wb = scratch('bilRing', Float64Array, 3 * R);
  const run = scratch('bilRun', Int32Array, w);
  const RW = RANGE_W;
  const f0 = FW[0], f1 = FW[1], f2 = FW[2], f3 = FW[3], f4 = FW[4], f7 = FW[7], f8 = FW[8], f9 = FW[9];
  let runRow = -1;
  for (let y = 0; y < h; y++) {
    const cur = (y % 3) * R, m1 = ((y + 2) % 3) * R, m2 = ((y + 1) % 3) * R;
    if (y < 2 || y >= h - 2 || w < 5) {
      for (let x = 0; x < w; x++) bilateralEdge(px, out, w, h, x, y, wb, cur + 12 * x);
      continue;
    }
    // run[x]: rows in a row, ending at y + 2, where column x holds one pixel value
    while (runRow < y + 2) {
      const o = ++runRow * w;
      if (runRow === 0) run.fill(1, 0, w);
      else for (let x = 0; x < w; x++) run[x] = px[o + x] === px[o - w + x] ? run[x] + 1 : 1;
    }
    bilateralEdge(px, out, w, h, 0, y, wb, cur);
    bilateralEdge(px, out, w, h, 1, y, wb, cur + 12);
    // streak: columns in a row, ending at x + 2, uniform down the window and equal across;
    // 5 of them make a window of one colour, which averages to that colour
    const yw = y * w;
    let streak = 0;
    for (let col = 0; col < 4; col++) streak = run[col] < 5 ? 0 : col > 0 && px[yw + col] === px[yw + col - 1] ? streak + 1 : 1;
    for (let x = 2; x < w - 2; x++) {
      streak = run[x + 2] < 5 ? 0 : px[yw + x + 2] === px[yw + x + 1] ? streak + 1 : 1;
      const p = yw + x, j = p * 4, c = px[p], e = cur + 12 * x;
      if (streak >= 5) {
        out[j] = c & 255; out[j + 1] = (c >> 8) & 255; out[j + 2] = (c >> 16) & 255;
        for (let i = 0; i < 12; i++) wb[e + i] = FW[i];
        continue;
      }
      const r0 = c & 255, g0 = (c >> 8) & 255, b0 = (c >> 16) & 255;
      let sr = 0, sg = 0, sb = 0, sw = 0, v, r, g, b, dr, dg, db, wt;
      // the 12 before: stored by each of those neighbours
      let q = p - 2 * w - 2, s = m2 + 12 * x;
      wt = wb[s - 13]; v = px[q]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      wt = wb[s - 2]; v = px[q + 1]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      wt = wb[s + 9]; v = px[q + 2]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      wt = wb[s + 20]; v = px[q + 3]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      wt = wb[s + 31]; v = px[q + 4]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      q += w; s = m1 + 12 * x;
      wt = wb[s - 18]; v = px[q]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      wt = wb[s - 7]; v = px[q + 1]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      wt = wb[s + 4]; v = px[q + 2]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      wt = wb[s + 15]; v = px[q + 3]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      wt = wb[s + 26]; v = px[q + 4]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      q += w;
      wt = wb[e - 23]; v = px[q]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      wt = wb[e - 12]; v = px[q + 1]; sr += (v & 255) * wt; sg += ((v >> 8) & 255) * wt; sb += ((v >> 16) & 255) * wt; sw += wt;
      sr += r0; sg += g0; sb += b0; sw += 1;
      // the 12 after: weighed here, and stored for them
      v = px[q + 3]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e] = f0 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      v = px[q + 4]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 1] = f1 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      q += w;
      v = px[q]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 2] = f2 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      v = px[q + 1]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 3] = f3 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      v = px[q + 2]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 4] = f4 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      v = px[q + 3]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 5] = f3 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      v = px[q + 4]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 6] = f2 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      q += w;
      v = px[q]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 7] = f7 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      v = px[q + 1]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 8] = f8 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      v = px[q + 2]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 9] = f9 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      v = px[q + 3]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 10] = f8 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      v = px[q + 4]; r = v & 255; g = (v >> 8) & 255; b = (v >> 16) & 255; dr = r - r0; dg = g - g0; db = b - b0;
      wt = wb[e + 11] = f7 * RW[(dr * dr + dg * dg + db * db) >> 6]; sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
      out[j] = sr / sw; out[j + 1] = sg / sw; out[j + 2] = sb / sw;
    }
    bilateralEdge(px, out, w, h, w - 2, y, wb, cur + 12 * (w - 2));
    bilateralEdge(px, out, w, h, w - 1, y, wb, cur + 12 * (w - 1));
  }
  return out;
}

// Within 2px of the frame edge the window is clamped, so weigh it in full; then store the
// forward weights for the in-frame neighbours that will read them.
function bilateralEdge(px, out, w, h, x, y, wb, e) {
  const c = px[y * w + x], r0 = c & 255, g0 = (c >> 8) & 255, b0 = (c >> 16) & 255;
  let sr = 0, sg = 0, sb = 0, sw = 0;
  for (let dy = -2, k = 0; dy <= 2; dy++) {
    const yy = y + dy, row = (yy < 0 ? 0 : yy >= h ? h - 1 : yy) * w;
    for (let dx = -2; dx <= 2; dx++, k++) {
      const xx = x + dx, v = px[row + (xx < 0 ? 0 : xx >= w ? w - 1 : xx)];
      const r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255;
      const dr = r - r0, dg = g - g0, db = b - b0;
      const wt = SPACE_W[k] * RANGE_W[(dr * dr + dg * dg + db * db) >> 6];
      sr += r * wt; sg += g * wt; sb += b * wt; sw += wt;
    }
  }
  const j = (y * w + x) * 4;
  out[j] = sr / sw; out[j + 1] = sg / sw; out[j + 2] = sb / sw;
  for (let i = 0; i < 12; i++) {
    const xx = x + FDX[i], yy = y + FDY[i];
    if (xx < 0 || xx >= w || yy >= h) continue;
    const v = px[yy * w + xx];
    const dr = (v & 255) - r0, dg = ((v >> 8) & 255) - g0, db = ((v >> 16) & 255) - b0;
    wb[e + i] = FW[i] * RANGE_W[(dr * dr + dg * dg + db * db) >> 6];
  }
}

// sRGB -> CIE Lab scaled to 8 bits the way OpenCV does (L*2.55, a+128, b+128).
const GAMMA = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; GAMMA[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
// Frames repeat the same colours constantly, within a frame and from frame to frame, so a
// direct-mapped cache of rgb -> packed Lab, kept for the worker's life, skips most cube roots.
const LAB_BITS = 17, LAB_CACHE = new Int32Array(2 << LAB_BITS).fill(-1); // key, value pairs
function toLab(rgba, n, L, A, B) {
  const px = new Int32Array(rgba.buffer, rgba.byteOffset, n);
  const kv = LAB_CACHE;
  for (let i = 0; i < n; i++) {
    const key = px[i] & 0xffffff;
    const slot = (Math.imul(key, 0x9e3779b1) >>> (32 - LAB_BITS)) << 1;
    let v;
    if (kv[slot] === key) v = kv[slot + 1];
    else {
      const r = GAMMA[key & 255], g = GAMMA[(key >> 8) & 255], b = GAMMA[key >> 16];
      const X = (0.412453 * r + 0.35758 * g + 0.180423 * b) / 0.950456;
      const Y = 0.212671 * r + 0.71516 * g + 0.072169 * b;
      const Z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / 1.088754;
      const fx = labF(X), fy = labF(Y), fz = labF(Z);
      const l = Math.round((Y > 0.008856 ? 116 * fy - 16 : 903.3 * Y) * 2.55) & 255;
      const a = Math.max(0, Math.min(255, Math.round(500 * (fx - fy) + 128)));
      const bb = Math.max(0, Math.min(255, Math.round(200 * (fy - fz) + 128)));
      v = (l << 16) | (a << 8) | bb;
      kv[slot] = key; kv[slot + 1] = v;
    }
    L[i] = v >> 16; A[i] = v >> 8; B[i] = v;
  }
}

// Canny with a per-frame threshold: hi = max(pct-th percentile of gradient, 40), lo = 0.4 hi.
// The gradient's float32 magnitude rises strictly with the integer gx² + gy² over every value
// 8-bit input can give, so all magnitude comparisons run on that integer instead.
function canny(ch, w, h, pct, out) {
  const n = w * h;
  const S = scratch('cS', Int32Array, n);
  const cand = scratch('cCand', Int32Array, n), off = scratch('cOff', Int32Array, n);
  const hist = scratch('cHist', Uint32Array, 2048); // gradient magnitudes of 40 and up
  hist.fill(0, 0, 2048);
  S.fill(0, 0, w); S.fill(0, n - w, n);
  let nc = 0, above = 0;
  for (let y = 1; y < h - 1; y++) {
    const up = (y - 1) * w, mid = y * w, dn = (y + 1) * w;
    S[mid] = 0; S[mid + w - 1] = 0;
    // Sobel, separably: V smooths down a column, H differences down it
    let a = ch[up], b = ch[mid], c = ch[dn];
    let V0 = a + 2 * b + c, H0 = c - a;
    a = ch[up + 1]; b = ch[mid + 1]; c = ch[dn + 1];
    let V1 = a + 2 * b + c, H1 = c - a;
    for (let p = mid + 1, end = mid + w - 1; p < end; p++) {
      a = ch[p - w + 1]; b = ch[p + 1]; c = ch[p + w + 1];
      const V2 = a + 2 * b + c, H2 = c - a;
      const gx = V2 - V0, gy = H0 + 2 * H1 + H2;
      const s = gx * gx + gy * gy;
      S[p] = s;
      // lo is never under 16, so only these can pass; note which neighbours they compare with
      if (s >= 256) {
        const ax = Math.abs(gx), ay = Math.abs(gy);
        cand[nc] = p;
        off[nc++] = ay <= ax * 0.4142 ? 1 : ay >= ax * 2.4142 ? w : (gx > 0) === (gy > 0) ? w + 1 : w - 1;
        // hi is at least 40, so the percentile only needs counting by value from there up
        if (s >= 1600) { hist[Math.sqrt(s) | 0]++; above++; }
      }
      V0 = V1; V1 = V2; H0 = H1; H1 = H2;
    }
  }
  let target = n * pct / 100, cum = Math.max(0, w - 2) * Math.max(0, h - 2) - above, pv = 0;
  if (cum < target) for (let i = 40; i < 2048; i++) { cum += hist[i]; if (cum >= target) { pv = i; break; } }
  const hi = Math.max(pv, 40), lo = hi * 0.4;
  const sLo = sqAtLeast(lo), sHi = sqAtLeast(hi);
  const nms = scratch('cNms', Uint8Array, n); // all zero between calls
  const stack = scratch('cStack', Int32Array, n);
  let top = 0;
  for (let i = 0; i < nc; i++) {
    const p = cand[i], s = S[p];
    if (s < sLo) continue;
    const d = off[i];
    if (s > S[p - d] && s >= S[p + d]) {
      if (s >= sHi) { nms[p] = 2; stack[top++] = p; } else nms[p] = 1;
    }
  }
  while (top) {
    const p = stack[--top];
    out[p] = 1;
    let q;
    q = p - w - 1; if (nms[q] === 1) { nms[q] = 2; stack[top++] = q; }
    q = p - w; if (nms[q] === 1) { nms[q] = 2; stack[top++] = q; }
    q = p - w + 1; if (nms[q] === 1) { nms[q] = 2; stack[top++] = q; }
    q = p - 1; if (nms[q] === 1) { nms[q] = 2; stack[top++] = q; }
    q = p + 1; if (nms[q] === 1) { nms[q] = 2; stack[top++] = q; }
    q = p + w - 1; if (nms[q] === 1) { nms[q] = 2; stack[top++] = q; }
    q = p + w; if (nms[q] === 1) { nms[q] = 2; stack[top++] = q; }
    q = p + w + 1; if (nms[q] === 1) { nms[q] = 2; stack[top++] = q; }
  }
  for (let i = 0; i < nc; i++) nms[cand[i]] = 0;
}

// The least integer s whose float32 square root is at least t.
function sqAtLeast(t) {
  let s = Math.max(0, Math.floor(t * t) - 2);
  while (Math.fround(Math.sqrt(s)) < t) s++;
  while (s > 0 && Math.fround(Math.sqrt(s - 1)) >= t) s--;
  return s;
}

// Zhang–Suen thinning to a 1px skeleton, in place. Each sub-step decides all its deletions
// before applying any. Whether a pixel goes depends only on its 8 neighbours, looked up as one
// byte, so a pixel already kept by a sub-step only needs another look from that sub-step once
// a neighbour has gone: after a first full pass each, the sub-steps work through queues of the
// neighbours of deleted pixels, which gives the same deletions as rescanning everything.
// Returns the count of survivors, left in raster order in scratch 'tLive'.
const THIN = new Uint8Array(256); // bit 0: delete in the first sub-step, bit 1: in the second
for (let i = 0; i < 256; i++) {
  const p2 = i & 1, p3 = (i >> 1) & 1, p4 = (i >> 2) & 1, p5 = (i >> 3) & 1;
  const p6 = (i >> 4) & 1, p7 = (i >> 5) & 1, p8 = (i >> 6) & 1, p9 = (i >> 7) & 1;
  const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
  if (B < 2 || B > 6) continue;
  const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
  if (A !== 1) continue;
  if (!(p2 * p4 * p6 || p4 * p6 * p8)) THIN[i] |= 1;
  if (!(p2 * p4 * p8 || p2 * p6 * p8)) THIN[i] |= 2;
}
function thin(img, w, h) {
  const n = w * h;
  const live = scratch('tLive', Int32Array, n);
  let len = 0;
  for (let y = 1; y < h - 1; y++) for (let p = y * w + 1, e = y * w + w - 1; p < e; p++) if (img[p]) live[len++] = p;
  // queue[0] for the first sub-step, queue[1] for the second; queued[p] has bit s set while p
  // waits in queue s. Both start with every pixel.
  const q0 = scratch('tQ0', Int32Array, len), q1 = scratch('tQ1', Int32Array, len);
  const del = scratch('tDel', Int32Array, len), queued = scratch('tQueued', Uint8Array, n);
  q0.set(live.subarray(0, len)); q1.set(live.subarray(0, len));
  for (let i = 0; i < len; i++) queued[live[i]] = 3;
  let n0 = len, n1 = len;
  const nb = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  while (n0 || n1) {
    for (let bit = 1; bit <= 2; bit++) {
      const q = bit === 1 ? q0 : q1, m = bit === 1 ? n0 : n1;
      let nd = 0;
      for (let i = 0; i < m; i++) {
        const p = q[i];
        queued[p] &= ~bit;
        if (!img[p]) continue;
        const u = p - w, d = p + w;
        const k = img[u] | (img[u + 1] << 1) | (img[p + 1] << 2) | (img[d + 1] << 3) |
          (img[d] << 4) | (img[d - 1] << 5) | (img[p - 1] << 6) | (img[u - 1] << 7);
        if (THIN[k] & bit) del[nd++] = p;
      }
      if (bit === 1) n0 = 0; else n1 = 0;
      for (let i = 0; i < nd; i++) img[del[i]] = 0;
      for (let i = 0; i < nd; i++) {
        const p = del[i];
        for (let j = 0; j < 8; j++) {
          const r = p + nb[j];
          if (!img[r]) continue;
          const f = queued[r];
          if (!(f & 1)) q0[n0++] = r;
          if (!(f & 2)) q1[n1++] = r;
          queued[r] = 3;
        }
      }
    }
  }
  let j = 0;
  for (let i = 0; i < len; i++) { const p = live[i]; queued[p] = 0; if (img[p]) live[j++] = p; }
  return j;
}

// Walk a 1px skeleton into open polylines, starting from stroke endpoints. Every skeleton pixel
// sits at least 1px inside the frame (Canny only marks interior pixels), so neighbours need no
// bounds checks. Paths go to scratch 'wPts' (x, y pairs), path i spanning 'wStarts'[i..i+1).
const NBX = [1, 0, -1, 0, 1, -1, 1, -1], NBY = [0, 1, 0, -1, 1, 1, -1, -1];
function walk(on, w, h, nLive) {
  const live = SCRATCH.get('tLive');
  const nb = [1, w, -1, -w, w + 1, w - 1, -w + 1, -w - 1];
  const order = scratch('wOrder', Int32Array, nLive);
  let ne = 0;
  for (let i = 0; i < nLive; i++) {
    const p = live[i];
    if (on[p - w - 1] + on[p - w] + on[p - w + 1] + on[p - 1] + on[p + 1] + on[p + w - 1] + on[p + w] + on[p + w + 1] === 1) order[ne++] = p;
  }
  for (let i = 0, k = ne; i < nLive; i++) {
    const p = live[i];
    if (on[p - w - 1] + on[p - w] + on[p - w + 1] + on[p - 1] + on[p + 1] + on[p + w - 1] + on[p + w] + on[p + w + 1] !== 1) order[k++] = p;
  }
  const pts = scratch('wPts', Int32Array, 2 * nLive), starts = scratch('wStarts', Int32Array, nLive + 1);
  let np = 0, k = 0;
  for (let i = 0; i < nLive; i++) {
    let p = order[i];
    if (!on[p]) continue;
    let x = p % w, y = (p / w) | 0;
    starts[np++] = k;
    pts[k++] = x; pts[k++] = y;
    on[p] = 0;
    for (;;) {
      let d = 0;
      while (d < 8 && !on[p + nb[d]]) d++;
      if (d === 8) break;
      p += nb[d]; x += NBX[d]; y += NBY[d];
      on[p] = 0;
      pts[k++] = x; pts[k++] = y;
    }
  }
  starts[np] = k;
  return np;
}
