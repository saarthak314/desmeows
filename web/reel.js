// Smooth playback. Desmos can't redraw thousands of shapes 30 times a second, so while a clip
// plays (or is scrubbed) its frames are drawn a little ahead of the playhead by a few workers
// running raster-worker.js, the export's renderer: the same polygons, colours and line widths
// the graph is given, at the screen's pixel size. They are shown on a canvas laid over the graph;
// when playback stops, the graph takes the frame over again (app.js).

const AHEAD = 12;    // frames drawn ahead of the playhead (0.4 s at 30 fps)
// Two workers draw on the GPU (Chrome replays every GPU canvas on one thread, so more don't
// help) and one on its own CPU thread, which adds throughput for very detailed frames.
const WORKERS = [false, false, true]; // cpu?
const PER_WORKER = 3;

export class Reel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.workers = [];
    this.cache = new Map();   // frame index -> ImageBitmap
    this.pending = new Set(); // frame indices being drawn
    this.key = '';
    this.clip = null;
    this.want = -1;           // the frame the screen should show
    this.shown = -1;          // the frame it does show
  }

  static supported() {
    return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function' && typeof Worker !== 'undefined';
  }

  // Start (or restart) for a clip at the canvas's current size in device pixels.
  setup(clip) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    const key = `${clip.W}x${clip.H}|${clip.style}|${w}x${h}`;
    if (key === this.key && this.clip === clip) return;
    this.reset();
    this.key = key;
    this.clip = clip;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const cpu of WORKERS) {
      const wk = new Worker(new URL('./raster-worker.js', import.meta.url), { type: 'module' });
      wk.busy = 0;
      wk.onmessage = ({ data }) => this.drawn(wk, data);
      wk.onerror = () => { wk.dead = true; };
      wk.postMessage({ type: 'init', W: clip.W, H: clip.H, style: clip.style, outW: w, outH: h, fps: clip.fps, cpu, credit: null, bitmaps: true });
      this.workers.push(wk);
    }
  }

  reset() {
    for (const wk of this.workers) wk.terminate();
    for (const b of this.cache.values()) b.close();
    this.workers = [];
    this.cache.clear();
    this.pending.clear();
    this.key = '';
    this.clip = null;
    this.want = this.shown = -1;
  }

  // Show frame i if it has been drawn (true), else ask for it and keep the last frame up.
  show(i) {
    this.want = i;
    const b = this.cache.get(i);
    if (b) {
      if (this.shown !== i) this.ctx.drawImage(b, 0, 0);
      this.shown = i;
      return true;
    }
    this.request(i);
    return false;
  }

  has(i) { return this.cache.has(i); }

  // Keep the next frames after i drawn, wrapping at n (the clip's length once known), and let
  // go of everything behind the playhead.
  prefetch(i, n) {
    if (!this.clip) return;
    for (const [k, b] of this.cache) {
      const ahead = (k - i + n) % n;
      if (ahead > AHEAD && k !== this.shown) { b.close(); this.cache.delete(k); }
    }
    for (let a = 0; a <= AHEAD; a++) this.request((i + a) % n);
  }

  request(i) {
    const fr = this.clip && this.clip.frames[i];
    if (!fr || this.cache.has(i) || this.pending.has(i)) return;
    let wk = null;
    for (const w of this.workers) if (!w.dead && w.busy < PER_WORKER && (!wk || w.busy < wk.busy)) wk = w;
    if (!wk) return;
    wk.busy++;
    this.pending.add(i);
    wk.postMessage({ i, frame: fr });
  }

  drawn(wk, data) {
    if (data.i === undefined) return; // the init reply
    wk.busy--;
    this.pending.delete(data.i);
    if (!data.bitmap) return;
    if (!this.clip) { data.bitmap.close(); return; }
    this.cache.set(data.i, data.bitmap);
    if (data.i === this.want) this.show(data.i);
  }
}
