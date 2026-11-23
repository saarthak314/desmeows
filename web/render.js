// Turns a traced frame into Desmos expressions. No DOM here: the app, the exporter and the
// saved standalone page all share it.
//
// Every shape is one element of a polygon list, coloured from a parallel rgb() list:
//   bg      one polygon, the frame rectangle in the frame's mean colour (paint) or black (lines)
//   f0..fN  filled regions, largest enclosing area first
//   l0..lN  lines: zero-area out-and-back polygons, so only the outline shows
// A Desmos list holds at most 10,000 items, so each layer is split into chunks.
// Per-element colours only work through colorLatex set in the graph state, so the slots
// are created once with setState and only their latex changes per frame.

export const CHUNK = 8000;
export const FILL_SLOTS = 8;
export const LINE_SLOTS = 4;

const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function slotState(state, W, H) {
  const list = [];
  list.push({ type: 'expression', id: 'cbg', latex: 'C_{0}=\\operatorname{rgb}(0,0,0)' });
  list.push({ type: 'expression', id: 'bg', latex: rect(W, H), colorLatex: 'C_{0}', fillOpacity: '1', lineOpacity: '1', lineWidth: '1' });
  for (let k = 0; k < FILL_SLOTS; k++) {
    list.push({ type: 'expression', id: `cf${k}`, latex: `C_{1${k}}=\\operatorname{rgb}(0,0,0)` });
    list.push({ type: 'expression', id: `f${k}`, latex: '', colorLatex: `C_{1${k}}`, fillOpacity: '1', lineOpacity: '1', lineWidth: '1' });
  }
  for (let k = 0; k < LINE_SLOTS; k++) {
    list.push({ type: 'expression', id: `cl${k}`, latex: `C_{2${k}}=\\operatorname{rgb}(0,0,0)` });
    list.push({ type: 'expression', id: `l${k}`, latex: '', colorLatex: `C_{2${k}}`, fillOpacity: '0', lineOpacity: '1', lineWidth: '1.5' });
  }
  state.expressions = { list };
  return state;
}

function rect(W, H) {
  return `\\operatorname{polygon}((0,0),(${W},0),(${W},${H}),(0,${H}))`;
}

function layerExprs(layer, prefix, colorBase, slots, out, cap = Infinity) {
  const n = layer ? Math.min(cap, layer.counts.length) : 0;
  let v = 0;
  for (let k = 0; k < slots; k++) {
    const from = k * CHUNK, to = Math.min(n, from + CHUNK);
    if (from >= to) {
      out.push({ id: `${prefix}${k}`, latex: '' });
      continue;
    }
    const polys = [], R = [], G = [], B = [];
    for (let s = from; s < to; s++) {
      const c = layer.counts[s];
      const pts = new Array(c);
      for (let i = 0; i < c; i++, v++) pts[i] = `(${num(layer.verts[2 * v])},${num(layer.verts[2 * v + 1])})`;
      polys.push(`\\operatorname{polygon}(${pts.join(',')})`);
      R.push(layer.rgb[3 * s]); G.push(layer.rgb[3 * s + 1]); B.push(layer.rgb[3 * s + 2]);
    }
    out.push({ id: `c${prefix}${k}`, latex: `C_{${colorBase}${k}}=\\operatorname{rgb}(\\left[${R}\\right],\\left[${G}\\right],\\left[${B}\\right])` });
    out.push({ id: `${prefix}${k}`, latex: `\\left[${polys.join(',')}\\right]` });
  }
  return out;
}

// frame: { fill?, line?, mean: [r,g,b] }; style: 'paint' | 'lines'
// cap: at most this many shapes per layer. Fills are stored largest first, so a capped frame
// keeps the big regions and lets the ones beneath show through where small ones are dropped.
export function frameExprs(frame, style, cap = Infinity) {
  const out = [];
  const bg = style === 'paint' && frame.mean ? frame.mean : [0, 0, 0];
  out.push({ id: 'cbg', latex: `C_{0}=\\operatorname{rgb}(${bg[0]},${bg[1]},${bg[2]})` });
  layerExprs(frame.fill, 'f', 1, FILL_SLOTS, out, cap);
  layerExprs(frame.line, 'l', 2, LINE_SLOTS, out, cap);
  return out;
}

// Line widths in trace pixels, scaled by how many screen pixels one trace pixel covers.
export function widthExprs(style, W, scale) {
  const out = [];
  const seal = Math.max(0.5, scale);                  // closes cracks between neighbouring regions
  const line = (style === 'lines' ? 1.6 : 1.1) * Math.max(1, W / 640) * scale;
  out.push({ id: 'bg', lineWidth: seal });
  for (let k = 0; k < FILL_SLOTS; k++) out.push({ id: `f${k}`, lineWidth: seal });
  for (let k = 0; k < LINE_SLOTS; k++) out.push({ id: `l${k}`, lineWidth: Math.max(0.6, line) });
  return out;
}

// Compact storage for the saved page: coordinates as Int16 at half-pixel precision.
export function packLayer(L) {
  if (!L) return null;
  const v = new Int16Array(L.verts.length);
  for (let i = 0; i < v.length; i++) v[i] = Math.round(L.verts[i] * 2);
  return { v: b64(new Uint8Array(v.buffer)), c: b64(new Uint8Array(new Uint32Array(L.counts).buffer)), r: b64(L.rgb) };
}

export function unpackLayer(P) {
  if (!P) return null;
  const v16 = new Int16Array(unb64(P.v).buffer);
  const verts = new Float32Array(v16.length);
  for (let i = 0; i < v16.length; i++) verts[i] = v16[i] / 2;
  return { verts, counts: new Uint32Array(unb64(P.c).buffer), rgb: unb64(P.r) };
}

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Sends only the expressions whose latex changed since the last frame (empty slots stay
// empty, so most frames touch four or five expressions instead of all of them).
export class Painter {
  constructor(calc) { this.calc = calc; this.last = new Map(); }
  reset() { this.last.clear(); }
  draw(frame, style, cap) {
    const changed = [];
    for (const e of frameExprs(frame, style, cap)) {
      if (this.last.get(e.id) === e.latex) continue;
      this.last.set(e.id, e.latex);
      changed.push(e);
    }
    if (changed.length) this.calc.setExpressions(changed);
  }
}
