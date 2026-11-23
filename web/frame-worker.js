// The tracing worker as the app runs it: tracer.js, plus reading frames out of ImageBitmaps.
// Frames arrive as GPU bitmaps (scaled by the decoder's canvas, transferred zero-copy) and are
// read back here, so the synchronous GPU -> CPU round trip (about a millisecond per frame,
// whatever the size) is paid in parallel across workers instead of on the main thread.
//
// A frame is held still by the stabiliser (stabilise.js) before it is traced. That has to see
// every frame in order, so a few of these workers are stabilisers, each for one horizontal
// strip of every frame. A tracing worker reads its frame back, sends each strip to its
// stabiliser on a channel of their own, and traces the frame once all the strips are back.
import './tracer.js';
import { Stabiliser } from './stabilise.js';

const trace = self.onmessage; // installed by tracer.js on import
let canvas = null, ctx = null;

function draw(bitmap, w, h) {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    // CPU-backed from the start: a 1:1 copy then a read, the same every run
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
}

// ---------------------------------------------------------------- tracing

let ports = null;            // to each strip's stabiliser
const waiting = new Map();   // frame id -> { d, parts, left }

function send(d) {
  const parts = [];
  if (d.bitmap) {
    draw(d.bitmap, d.w, d.h);
    for (let k = 0, y = 0; k < d.strips.length; y += d.strips[k++]) parts.push(ctx.getImageData(0, y, d.w, d.strips[k]).data);
    d.bitmap = null;
  } else {
    for (let k = 0, o = 0; k < d.strips.length; o += 4 * d.w * d.strips[k++]) parts.push(d.rgba.slice(o, o + 4 * d.w * d.strips[k]));
    d.rgba = null;
  }
  waiting.set(d.id, { d, parts: [], left: parts.length });
  parts.forEach((rgba, k) => ports[k].postMessage({ id: d.id, w: d.w, h: d.strips[k], scene: d.opts.scene, style: d.opts.style, rgba }, [rgba.buffer]));
}

function back(k, r) {
  const job = waiting.get(r.id);
  job.parts[k] = r;
  if (--job.left) return;
  waiting.delete(r.id);
  const d = job.d;
  d.rgba = join(job.parts, 'rgba', Uint8ClampedArray, 4 * d.w * d.h);
  if (job.parts[0].labels) d.labels = join(job.parts, 'labels', Uint8Array, d.w * d.h);
  trace.call(self, { data: d });
}

function join(parts, key, Type, n) {
  const out = new Type(n);
  for (let k = 0, o = 0; k < parts.length; k++) { out.set(parts[k][key], o); o += parts[k][key].length; }
  return out;
}

// ---------------------------------------------------------------- stabilising one strip

let stable = null, next = 0;
const queue = new Map(); // frame id -> strip, until every frame before it has been held

function drain() {
  for (let f; (f = queue.get(next)); next++) {
    if (f.style === 'paint' && !stable.has(f.scene)) return; // its palette is still on the way
    queue.delete(next);
    const labels = stable.push(f.rgba, f.w, f.h, f.scene, f.style);
    f.port.postMessage({ id: f.id, rgba: f.rgba, labels }, labels ? [f.rgba.buffer, labels.buffer] : [f.rgba.buffer]);
  }
}

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'stable-ports') {
    ports = d.ports;
    ports.forEach((port, k) => { port.onmessage = (m) => back(k, m.data); });
    return;
  }
  if (d.type === 'stable-strip') {
    stable = new Stabiliser();
    for (const port of d.ports) port.onmessage = (m) => { m.data.port = port; queue.set(m.data.id, m.data); drain(); };
    return;
  }
  if (d.type === 'stable-palette') { stable.palette(d.index, d.lut, d.centres); drain(); return; }
  if (d.strips) { send(d); return; }
  if (d.bitmap) {
    draw(d.bitmap, d.w, d.h);
    d.rgba = ctx.getImageData(0, 0, d.w, d.h).data;
    d.bitmap = null;
    if (d.type === 'pixels') { self.postMessage({ rgba: d.rgba }, [d.rgba.buffer]); return; }
  }
  trace.call(self, { data: d });
};
