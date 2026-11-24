// Smooth playback. Desmos can't redraw thousands of shapes 30 times a second, so while a clip
// plays (or is scrubbed) its frames are drawn a little ahead of the playhead by a few workers
// running raster-worker.js, the export's renderer: the same polygons, colours and line widths
// the graph is given, at the screen's pixel size. They are shown on a canvas laid over the graph;
// when playback stops, the graph takes the frame over again (app.js).
//
// Playback keeps time. When drawing can't keep up with the clip's frame rate (a very detailed
// trace, a busy machine, a trace still running beside it), frames are asked for as far ahead of
// the playhead as drawing one currently takes, and the newest frame drawn so far is shown, so the
// picture moves at whatever rate drawing manages instead of waiting on frames already passed.

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
    this.pending = new Map(); // frame index being drawn -> when it was asked for
    this.lag = 0;             // how long a frame takes to come back once asked for (ms, smoothed)
    this.shownCount = 0;      // frames put on screen, for app.js's frame rate note
    this.key = '';
    this.clip = null;
    this.want = -1;           // the frame the screen should show
    this.shown = -1;          // the frame it does show
    this.failed = '';         // why the reel gave up, if it did (app.js then plays through the graph)
    this.missSince = 0;       // when the wanted frame first wasn't there
    this.lastReply = 0;       // when a worker last answered
  }

  // Give up for good, say why in the console, and let app.js fall back to the graph.
  fail(why) {
    if (this.failed) return;
    this.failed = why;
    console.warn(`desmeows: smooth playback is off (${why}); playing through the Desmos graph instead.`);
    for (const wk of this.workers) wk.terminate();
    this.workers = [];
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
    this.lastReply = performance.now();
    this.lag = 0;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const cpu of WORKERS) {
      const wk = new Worker(new URL('./raster-worker.js', import.meta.url), { type: 'module' });
      wk.busy = 0;
      wk.onmessage = ({ data }) => this.drawn(wk, data);
      wk.onerror = (e) => { wk.dead = true; this.fail(`a drawing worker failed: ${e.message || 'unknown error'}${e.filename ? ` at ${e.filename.split('/').pop()}:${e.lineno}` : ''}`); };
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

  // Put frame i on screen if it has been drawn (true). If it hasn't, show the newest frame drawn
  // since the one on screen, up to a second before i: playback skips frames rather than freeze.
  show(i) {
    if (this.failed || !this.clip) return false;
    this.want = i;
    const k = this.cache.has(i) ? i : this.newest(i);
    if (k >= 0 && k !== this.shown) {
      this.ctx.drawImage(this.cache.get(k), 0, 0);
      this.shown = k;
      this.shownCount++;
    }
    if (k === i) { this.missSince = 0; return true; }
    // the wanted frame hasn't come for 2 s, and no worker has answered: the workers are stuck,
    // so don't leave the picture frozen
    const now = performance.now();
    if (!this.missSince) this.missSince = now;
    else if (now - this.missSince > 2000 && now - this.lastReply > 2000) this.fail('the drawing workers stopped answering');
    return false;
  }

  // the drawn frame nearest before i that is newer than the one on screen, or -1
  newest(i) {
    const n = this.clip.frames.length;
    let best = Math.min(Math.ceil(this.clip.fps), this.shown >= 0 ? (i - this.shown + n) % n : n), k = -1;
    for (const j of this.cache.keys()) {
      const d = (i - j + n) % n;
      if (d < best) { best = d; k = j; }
    }
    return k;
  }

  // Keep the frames after i drawn, wrapping at n (the clip's length once known), and let go of
  // everything behind the playhead. While it moves, a frame asked for now comes back `lead`
  // frames later, so nearer frames that aren't on the way already aren't asked for: they would
  // arrive after the playhead had passed them.
  prefetch(i, n, moving = false) {
    if (!this.clip) return;
    const lead = moving ? Math.min(Math.ceil(this.lag * this.clip.fps / 1000), Math.ceil(this.clip.fps)) : 0;
    for (const [k, b] of this.cache) {
      if ((k - i + n) % n > lead + AHEAD && k !== this.shown) { b.close(); this.cache.delete(k); }
    }
    for (let a = lead; a <= lead + AHEAD; a++) this.request((i + a) % n);
  }

  request(i) {
    const fr = this.clip && this.clip.frames[i];
    if (!fr || this.cache.has(i) || this.pending.has(i)) return;
    let wk = null;
    for (const w of this.workers) if (!w.dead && w.busy < PER_WORKER && (!wk || w.busy < wk.busy)) wk = w;
    if (!wk) return;
    wk.busy++;
    this.pending.set(i, performance.now());
    wk.postMessage({ i, frame: fr });
  }

  drawn(wk, data) {
    this.lastReply = performance.now();
    if (data.i === undefined) return; // the init reply
    wk.busy--;
    const asked = this.pending.get(data.i);
    this.pending.delete(data.i);
    if (asked !== undefined) this.lag += (this.lastReply - asked - this.lag) / 4;
    if (!data.bitmap) return;
    if (!this.clip) { data.bitmap.close(); return; }
    this.cache.set(data.i, data.bitmap);
    // the wanted frame, or one newer than the frame on screen
    if (this.want >= 0 && this.shown !== this.want) this.show(this.want);
  }
}
