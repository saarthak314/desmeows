// Temporal stabiliser: the one stage that sees every frame, in order, before it is traced.
// Traced alone, each frame re-cuts its regions and edges from scratch, so compression noise
// and slight drift make still parts of the picture boil from frame to frame. This holds them:
//
//   pixels  a pixel keeps the value it was last given until the picture around it really
//           changes (the mean change over its 5x5 neighbourhood passes HOLD_AREA, or its own
//           passes HOLD_PIXEL; changes summed over r, g, b); then it takes the new frame's
//           value. Still areas stay exactly still, moving ones pass straight through.
//   labels  (paint) each pixel's palette colour, from the scene's lookup table, except that a
//           pixel keeps last frame's colour while that is within LABEL_HOLD (Lab units) of
//           being as close as the best one, so contours in gradients stop crawling.
//
// State resets at every scene cut. Same frames in the same order give the same output.

import { cellLab } from './palette.js';

const R = 2; // the hold's neighbourhood: (2R + 1) squared
// Compression noise on still anime frames is mostly within a few levels a channel; real
// change, even a slow pan, soon sums past these.
const HOLD_AREA = 12, HOLD_PIXEL = 80, LABEL_HOLD = 4;

export class Stabiliser {
  constructor() { this.w = 0; this.h = 0; this.scene = -1; this.luts = []; this.centres = []; }

  palette(index, lut, centres) { this.luts[index] = lut; this.centres[index] = centres; }
  has(index) { return !!this.luts[index]; }

  // Holds rgba (RGBA bytes, w x h) in place. Returns the palette labels for paint.
  push(rgba, w, h, scene, style) {
    const n = w * h;
    if (w !== this.w || h !== this.h) {
      this.w = w; this.h = h; this.scene = -1;
      this.held = new Int32Array(n);  // the pixels as last given out
      this.diff = new Uint16Array(n); // this frame's change against them
      this.rows = new Int32Array(n + w); // those summed along each row's window, and a zero row
      this.cols = new Int32Array(w);  // and down each column's
      this.labs = new Uint8Array(n);  // the labels as last given out
      this.lim = Int32Array.from({ length: w }, (_, x) => Math.min(w - 1, x + R) - Math.max(0, x - R) + 1);
    }
    const px = new Int32Array(rgba.buffer, rgba.byteOffset, n);
    // a frame too small for the window is passed through as it is
    const fresh = scene !== this.scene || w <= 2 * R + 1 || h <= 2 * R + 1;
    this.scene = scene;
    const lut = style === 'paint' ? this.luts[scene] : null;
    if (fresh) {
      this.held.set(px);
      if (lut) for (let p = 0; p < n; p++) this.labs[p] = lut[cell(px[p])];
    } else {
      this.hold(px, w, h, lut, this.centres[scene]);
    }
    return lut ? this.labs.slice() : null;
  }

  hold(px, w, h, lut, C) {
    const held = this.held, D = this.diff, rows = this.rows, cols = this.cols, labs = this.labs, lim = this.lim;
    // each pixel's change (summed over its channels; no branches, the data is noise), then its
    // sums over each row's window and, running down the rows, each column's
    for (let y = 0; y < h; y++) {
      const o = y * w, e = o + w;
      for (let p = o; p < e; p++) {
        const v = px[p], q = held[p];
        let a = (v & 255) - (q & 255), b = ((v >> 8) & 255) - ((q >> 8) & 255), c = ((v >> 16) & 255) - ((q >> 16) & 255);
        a = (a ^ (a >> 31)) - (a >> 31); b = (b ^ (b >> 31)) - (b >> 31); c = (c ^ (c >> 31)) - (c >> 31);
        D[p] = a + b + c;
      }
      let s = 0, x = 0;
      for (let k = 0; k < R; k++) s += D[o + k];
      for (; x <= R; x++) { s += D[o + x + R]; rows[o + x] = s; }
      for (; x < w - R; x++) { s += D[o + x + R] - D[o + x - R - 1]; rows[o + x] = s; }
      for (; x < w; x++) { s -= D[o + x - R - 1]; rows[o + x] = s; }
    }
    cols.fill(0);
    for (let y = 0; y < R; y++) for (let x = 0, o = y * w; x < w; x++) cols[x] += rows[o + x];
    const G = cellLab();
    // denser palettes have closer colours: the margin shrinks with them (4 at 64 colours)
    const margin = C ? LABEL_HOLD * Math.sqrt(64 / (C.length / 3)) : 0;
    for (let y = 0; y < h; y++) {
      // rows past either edge read the zero row kept after the last
      const add = (y + R < h ? y + R : h) * w, sub = (y > R ? y - R - 1 : h) * w;
      const ny = Math.min(h - 1, y + R) - Math.max(0, y - R) + 1, k0 = HOLD_AREA * ny;
      for (let x = 0, p = y * w; x < w; x++, p++) {
        const c = cols[x] + rows[add + x] - rows[sub + x];
        cols[x] = c;
        if (c <= k0 * lim[x] && D[p] <= HOLD_PIXEL) { px[p] = held[p]; continue; }
        const v = px[p];
        held[p] = v;
        if (!lut) continue;
        // a held pixel keeps its label; a new value gets the nearest, or keeps the old one
        // while that is still nearly as close
        const cl = cell(v), l = lut[cl], k = labs[p];
        if (l === k) continue;
        const L = G[3 * cl], A = G[3 * cl + 1], B = G[3 * cl + 2];
        let d0 = L - C[3 * l], d1 = A - C[3 * l + 1], d2 = B - C[3 * l + 2];
        const dl = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
        d0 = L - C[3 * k]; d1 = A - C[3 * k + 1]; d2 = B - C[3 * k + 2];
        labs[p] = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) <= dl + margin ? k : l;
      }
    }
  }
}

// little-endian RGBA: 5-bit r, g, b into the lookup table's 15-bit index
const cell = (v) => ((v & 0xf8) << 7) | ((v >> 6) & 0x3e0) | ((v >> 19) & 0x1f);
