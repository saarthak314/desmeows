import { SceneCutter, sceneSamples } from './palette.js';
import { slotState, frameExprs, widthExprs, packLayer, Painter, rasterize, bounds } from './render.js';
import { Reel } from './reel.js';

// ---------------------------------------------------------------- dependencies

// Neither is needed to show the first screen, so neither holds it up. mediabunny reads and
// writes the video: index.html preloads it, and load() waits for it (a failed module import
// stays failed, so that takes a reload). Desmos is about 1 MB of script: it is fetched once
// the page and mediabunny are in, or as soon as a file is chosen if that is sooner, awaited
// before the first calculator is made, and fetched again by the next trace if it failed.
let Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, BufferTarget,
  CanvasSource, EncodedPacketSink, EncodedAudioPacketSource, canEncodeVideo;
const mediabunny = import('https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/dist/bundles/mediabunny.min.mjs').then((m) => {
  ({ Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, BufferTarget,
    CanvasSource, EncodedPacketSink, EncodedAudioPacketSource, canEncodeVideo } = m);
});
mediabunny.catch(() => {}); // reported by load()

// The key is the public demo key from the Desmos API docs: fine for running this locally,
// replace it with your own (desmos.com/api) before putting the page online.
const DESMOS_API = 'https://www.desmos.com/api/v1.11/calculator.js?apiKey=dcb31709b452b1cf9dc26972add0fda6';
let desmosLoad = null;
function desmos() {
  return desmosLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const failed = () => {
      s.remove();
      desmosLoad = null;
      reject(new Error('could not load the desmos calculator. check the connection and try again.'));
    };
    s.onload = () => (window.Desmos ? resolve(window.Desmos) : failed());
    s.onerror = failed;
    s.src = DESMOS_API;
    document.head.append(s);
  });
}

const pageLoaded = new Promise((r) => (document.readyState === 'complete' ? r() : addEventListener('load', r, { once: true })));
Promise.allSettled([mediabunny, pageLoaded]).then(() => desmos().catch(() => {}));

// ---------------------------------------------------------------- settings

// Each step up roughly doubles the shapes per frame. Limit is as far as the tracer goes:
// near-full resolution, a 255-colour palette for every scene, regions down to 2 pixels.
const TIERS = {
  draft: { width: 480, k: 32, minArea: 16, epsilon: 0.9, smooth: 1, detail: 92, lineEpsilon: 1.2, minLen: 12, maxLinePoints: 4000, iters: 10 },
  fine: { width: 640, k: 64, minArea: 8, epsilon: 0.7, smooth: 1, detail: 90, lineEpsilon: 1.0, minLen: 10, maxLinePoints: 6000, iters: 10 },
  max: { width: 960, k: 128, minArea: 4, epsilon: 0.6, smooth: 1, detail: 88, lineEpsilon: 0.8, minLen: 10, maxLinePoints: 12000, iters: 8 },
  limit: { width: 1280, k: 255, minArea: 2, epsilon: 0.5, smooth: 1, detail: 86, lineEpsilon: 0.6, minLen: 8, maxLinePoints: 24000, iters: 8 },
};
const TIER_NOTE = {
  paint: {
    draft: (w) => `${w} px wide, 32 colours a scene. plays live at full speed.`,
    fine: (w) => `${w} px wide, 64 colours a scene, regions from 8 px.`,
    max: (w) => `${w} px wide, 128 colours a scene, regions from 4 px.`,
    limit: (w) => `${w} px wide, 255 colours a scene, regions from 2 px. the export takes a while.`,
  },
  lines: {
    draft: (w) => `${w} px wide, the strongest edges only.`,
    fine: (w) => `${w} px wide, the main edges.`,
    max: (w) => `${w} px wide, fine edges.`,
    limit: (w) => `${w} px wide, every edge the tracer finds.`,
  },
};

const $ = (id) => document.getElementById(id);
const body = document.body;
const params = new URLSearchParams(location.search);
const settings = {
  style: ['paint', 'lines'].includes(params.get('style')) ? params.get('style') : 'paint',
  fidelity: TIERS[params.get('fidelity')] ? params.get('fidelity') : 'fine',
  fps: ['source', '24', '12'].includes(params.get('fps')) ? params.get('fps') : 'source',
  ink: params.get('ink') !== 'off',
  size: params.get('size') || '',
  renderer: params.get('renderer') === 'desmos' ? 'desmos' : 'direct',
};

function syncSettingsUI() {
  for (const name of ['style', 'fidelity', 'fps']) {
    const input = document.querySelector(`input[name="${name}"][value="${settings[name]}"]`);
    if (input) input.checked = true;
  }
  $('ink').checked = settings.ink;
  const rin = document.querySelector(`input[name="renderer"][value="${settings.renderer}"]`);
  if (rin) rin.checked = true;
  $('renderer-note').textContent = settings.renderer === 'direct'
    ? 'the same polygons desmos is given, drawn straight by your gpu. several times faster.'
    : 'every frame drawn and screenshotted by the desmos calculator itself.';
  body.dataset.style = settings.style;
  $('fidelity-note').textContent = media ? TIER_NOTE[settings.style][settings.fidelity](traceWidth()) : '';
  const q = new URLSearchParams();
  if (settings.style !== 'paint') q.set('style', settings.style);
  if (settings.fidelity !== 'fine') q.set('fidelity', settings.fidelity);
  if (settings.fps !== 'source') q.set('fps', settings.fps);
  if (!settings.ink) q.set('ink', 'off');
  if (settings.size) q.set('size', settings.size);
  if (settings.renderer !== 'direct') q.set('renderer', settings.renderer);
  history.replaceState(null, '', q.size ? `?${q}` : location.pathname);
  markStale();
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'style' || t.name === 'fidelity' || t.name === 'fps') settings[t.name] = t.value;
  else if (t.id === 'ink') settings.ink = t.checked;
  else if (t.name === 'size') { settings.size = t.value; syncSettingsUI(); return; }
  else if (t.name === 'renderer') { settings.renderer = t.value; syncSettingsUI(); return; }
  else return;
  syncSettingsUI();
});

// ---------------------------------------------------------------- state

let media = null;   // { file, input, video, audio, srcW, srcH, start, duration, srcFps }
let clip = null;    // { W, H, fps, style, frames: [], scenes, key }
let stopping = false;

function setState(s) { body.dataset.state = s; }

function traceWidth() {
  if (!media) return TIERS[settings.fidelity].width;
  return even(Math.min(TIERS[settings.fidelity].width, media.srcW));
}
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const settingsKey = () => `${settings.style}|${settings.fidelity}|${settings.fps}|${settings.style === 'paint' && settings.ink}`;

function markStale() {
  if (!clip || body.dataset.state === 'tracing') return;
  $('trace').textContent = clip.key === settingsKey() ? 'trace video' : 'trace again';
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

// ---------------------------------------------------------------- loading

$('file').addEventListener('change', (e) => { if (e.target.files[0]) load(e.target.files[0]); });
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (hasFile(e)) { e.preventDefault(); dragDepth++; body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => { if (hasFile(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFile(e)) return;
  e.preventDefault();
  dragDepth = 0; body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f && body.dataset.state !== 'tracing' && body.dataset.state !== 'exporting') load(f);
});
const hasFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

$('new-video').addEventListener('click', () => {
  if (clip && !confirm('start over with a new video? the current trace is discarded.')) return;
  location.href = location.pathname + location.search;
});

async function load(file) {
  if (!('VideoDecoder' in window)) {
    return fail('this browser cannot decode video in the page. use a current chrome, edge, firefox or safari.');
  }
  setState('loaded');
  // Trace waits until the file is open: clicking it earlier would have done nothing
  $('trace').disabled = true;
  $('screen').hidden = false; $('sheet').hidden = false; $('new-video').hidden = false;
  $('file-name').textContent = file.name;
  $('frame-label').textContent = 'source';
  $('frame-note').textContent = 'reading the file';
  desmos().catch(() => {});
  try {
    await mediabunny;
  } catch {
    return fail('could not load the video reader. check the connection and reload the page.');
  }
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const video = await input.getPrimaryVideoTrack();
    if (!video) return fail('this file has no video track.');
    if (!(await video.canDecode())) return fail(`this browser cannot decode this video's codec (${video.codec || 'unknown'}). an h.264 mp4 works everywhere.`);
    const audio = await input.getPrimaryAudioTrack();
    const start = await video.getFirstTimestamp();
    const end = await video.computeDuration();
    const stats = await video.computePacketStats(120);
    media = {
      file, input, video, audio, start, duration: end - start,
      srcW: video.displayWidth, srcH: video.displayHeight,
      srcFps: Math.round(stats.averagePacketRate * 100) / 100,
    };
  } catch (err) {
    return fail(`could not read this file: ${err.message || err}`);
  }
  document.documentElement.style.setProperty('--aspect', `${media.srcW / media.srcH}`);
  $('fps-source').textContent = `source ${Math.round(media.srcFps)}`;
  media.sourceSink = new CanvasSink(media.video, { width: even(Math.min(media.srcW, 1280)), height: even(Math.min(media.srcW, 1280) * media.srcH / media.srcW), fit: 'fill' });
  await showSource(media.start);
  body.classList.add('comparing');
  $('frame-note').textContent = `${media.srcW} × ${media.srcH}, ${media.duration.toFixed(1)} s, ${Math.round(media.srcFps)} fps`;
  buildSizes();
  syncSettingsUI();
  layoutFrame();
  $('trace').disabled = false;
}

function fail(msg) {
  setState(media ? 'loaded' : 'empty');
  if (!media) {
    $('screen').hidden = true; $('sheet').hidden = true;
    alertEmpty(msg);
  } else {
    showError(msg);
  }
}

function alertEmpty(msg) {
  let p = document.querySelector('.drop-error');
  if (!p) {
    p = document.createElement('p');
    p.className = 'error drop-error';
    p.setAttribute('role', 'alert');
    $('drop').append(p);
  }
  p.textContent = msg;
}

let sourceIndex = -1;
async function showSource(t, index = -2) {
  if (index === sourceIndex) return;
  const wrapped = await media.sourceSink.getCanvas(t);
  if (!wrapped) return;
  const c = $('source');
  c.width = wrapped.canvas.width; c.height = wrapped.canvas.height;
  c.getContext('2d').drawImage(wrapped.canvas, 0, 0);
  sourceIndex = index;
}

// ---------------------------------------------------------------- worker pool

class Pool {
  constructor(n, script = './tracer.js') {
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL(script, import.meta.url), { type: 'module' });
      w.busy = null;
      w.onmessage = (e) => { const r = w.busy; w.busy = null; r.resolve(e.data); this.pump(); };
      w.onerror = (e) => { const r = w.busy; w.busy = null; if (r) r.reject(new Error(e.message || 'Tracer failed')); this.pump(); };
      return w;
    });
    this.queue = [];
  }
  get size() { return this.workers.length; }
  get inFlight() { return this.queue.length + this.workers.filter((w) => w.busy).length; }
  run(msg, transfer = []) {
    return new Promise((resolve, reject) => { this.queue.push({ msg, transfer, resolve, reject }); this.pump(); });
  }
  broadcast(msg) {
    return Promise.all(this.workers.map((w) => new Promise((resolve, reject) => {
      const send = () => {
        if (w.busy) return setTimeout(send, 5);
        w.busy = { resolve, reject };
        w.postMessage(msg);
      };
      send();
    })));
  }
  pump() {
    for (const w of this.workers) {
      if (w.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      w.busy = job;
      w.postMessage(job.msg, job.transfer);
    }
  }
  // to every worker, outside the request/reply flow (for messages that get no reply)
  post(msg) { for (const w of this.workers) w.postMessage(msg); }
  terminate() { for (const w of this.workers) w.terminate(); }
}

// ---------------------------------------------------------------- tracing

$('trace').addEventListener('click', () => trace());
// Stop also cuts every wait in a running trace short, even one on a decoder that has stalled
let stopTrace = () => {};
$('stop').addEventListener('click', () => { stopping = true; $('stop').disabled = true; stopTrace(); });

async function trace() {
  if (!media) return;
  showError('');
  stopping = false;
  setPlaying(false);
  setState('tracing');
  $('trace').hidden = true; $('stop').hidden = false; $('stop').disabled = false;
  $('progress').hidden = false;
  $('result').hidden = true; $('export').hidden = true;
  setSettingsDisabled(true);

  const tier = TIERS[settings.fidelity];
  const W = traceWidth(), H = even(W * media.srcH / media.srcW);
  const fps = settings.fps === 'source' ? media.srcFps : Math.min(+settings.fps, media.srcFps);
  const count = Math.max(1, Math.floor(media.duration * fps + 1e-6));
  const times = Array.from({ length: count }, (_, i) => media.start + i / fps);
  const style = settings.style;
  const opts = {
    style, smooth: tier.smooth, minArea: tier.minArea, epsilon: tier.epsilon, ink: settings.ink,
    detail: tier.detail, lineEpsilon: tier.lineEpsilon, minLen: tier.minLen, maxLinePoints: tier.maxLinePoints,
  };
  const next = { W, H, fps, style, frames: new Array(count), scenes: 1, key: settingsKey(), name: media.file.name };
  // every core but one, which is left for decoding and the page
  const pool = new Pool(Math.max(2, Math.min(16, (navigator.hardwareConcurrency || 4) - 1)), './frame-worker.js');
  // frames go to the workers as GPU bitmaps where the browser can (see frame-worker.js)
  const viaBitmap = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
  let stopReaders = () => {}, closeThumbs = () => {}, closeFrames = () => {};
  let shown = -1, lastPreview = 0;

  // Pass 1 (reader) and pass 2 (tracer) run at the same time. The reader decodes small
  // thumbnails, finds each cut as it reaches it, and mixes that scene's palette in the pool;
  // the tracer decodes full-size frames and only waits until its scene's palette is out.
  const scene = new Int32Array(count).fill(-1);
  const thumbs = [];
  const ready = [];
  const sceneReady = (s) => ready[s] || (ready[s] = (() => { let r; const p = new Promise((res) => (r = res)); p.done = r; return p; })());
  let read = 0, wake = null, abort = false;
  let fail;
  const failure = new Promise((_, rej) => (fail = rej));
  stopTrace = () => fail(new Stop());
  failure.catch(() => {});
  const waitRead = () => Promise.race([new Promise((r) => (wake = r)), failure]);
  // a decoder that stops answering (the GPU's decoders are shared with every other tab) would
  // otherwise leave tracing waiting forever; no frame read or traced for 30 s ends it instead
  let lastTick = performance.now();
  const tick = () => { lastTick = performance.now(); };
  const watchdog = setInterval(() => {
    if (performance.now() - lastTick > 30000) fail(new Error('the video decoder stopped responding. Close other tabs playing video and try again.'));
  }, 2000);

  const reader = (async () => {
    const TW = 160, TH = even(160 * H / W);
    // The thumbnails are decoded in software. The tracing pass waits on the scenes this pass
    // finds, and its hardware decoder holds decoded frames while it waits; if both passes drew
    // on the GPU's limited decoder surfaces, this one could starve and neither would move.
    const thumbSink = new CanvasSink(media.video, { width: TW, height: TH, fit: 'fill', poolSize: 1, decoderOptions: { hardwareAcceleration: 'prefer-software' } });
    const readThumb = frameReader(TW, TH);
    // thumbnails are read back in two small workers (a few in flight, taken in order), so the
    // main thread never waits on the GPU; without OffscreenCanvas they are read here instead
    const readers = viaBitmap ? new Pool(2, './frame-worker.js') : null;
    stopReaders = () => readers && readers.terminate();
    const ordered = [];
    const cutter = new SceneCutter();
    let cur = 0;
    const close = (s) => {
      if (style !== 'paint') { sceneReady(s).done(); return; }
      const samples = sceneSamples(thumbs, scene, s);
      pool.run({ type: 'kmeans', samples, k: tier.k, iters: tier.iters }, [samples.buffer]).then((r) => {
        pool.post({ type: 'palette-add', index: s, lut: r.lut });
        sceneReady(s).done();
      }, (e) => fail(e));
    };
    const take = (px) => {
      thumbs.push(px);
      const s = cutter.push(px);
      scene[read] = s;
      if (s !== cur) { close(cur); cur = s; }
      read++;
      tick();
      if (wake) { const w = wake; wake = null; w(); }
    };
    const it = thumbSink.canvasesAtTimestamps(times)[Symbol.asyncIterator]();
    closeThumbs = () => it.return && it.return().catch(() => {});
    for (;;) {
      const { value: wrapped, done: end } = await Promise.race([it.next(), failure]);
      if (end) break;
      if (stopping || abort) throw new Stop();
      if (!readers) { take(readThumb(wrapped)); continue; }
      const bitmap = await createImageBitmap(wrapped.canvas);
      ordered.push(readers.run({ type: 'pixels', bitmap, w: TW, h: TH }, [bitmap]));
      if (ordered.length >= 6) take((await ordered.shift()).rgba);
    }
    while (ordered.length) take((await ordered.shift()).rgba);
    if (readers) readers.terminate();
    close(cur);
    next.scenes = cur + 1;
    read = count;
    if (wake) { const w = wake; wake = null; w(); }
  })();
  reader.catch((e) => fail(e));

  try {
    clip = next;
    tracedPrefix = 0;
    current = -1;
    body.classList.remove('reeling');
    await Promise.race([ensureCalc(W, H, style), failure]);
    if (reel) reel.setup(clip);
    // the clip can be played while it traces: playback holds at the last frame traced so far
    $('scrub').max = count - 1; $('scrub').value = 0; $('scrub').disabled = false;
    $('play').disabled = false;
    let autoplay = !!reel;
    $('frame-label').textContent = 'desmos';
    body.classList.remove('comparing');
    progress('reading frames', 0, count);
    const sink = new CanvasSink(media.video, { width: W, height: H, fit: 'fill', poolSize: 1 });
    const readFrame = frameReader(W, H);
    let i = 0, done = 0;
    const pending = new Set();
    const frames = sink.canvasesAtTimestamps(times)[Symbol.asyncIterator]();
    closeFrames = () => frames.return && frames.return().catch(() => {});
    for (;;) {
      // raced against failure, so a stalled decoder can't hold the loop forever
      const { value: wrapped, done: end } = await Promise.race([frames.next(), failure]);
      if (end) break;
      if (stopping) throw new Stop();
      const id = i++;
      while (read <= id) await waitRead();
      await Promise.race([sceneReady(scene[id]), failure]);
      let job;
      const msg = { id, w: W, h: H, opts: { ...opts, scene: scene[id] } };
      if (viaBitmap) {
        msg.bitmap = await createImageBitmap(wrapped.canvas);
        job = pool.run(msg, [msg.bitmap]);
      } else {
        msg.rgba = readFrame(wrapped);
        job = pool.run(msg, [msg.rgba.buffer]);
      }
      job = job.then((r) => {
        next.frames[r.id] = { fill: r.fill, line: r.line, mean: r.mean };
        done++;
        tick();
        pending.delete(job);
        progress('tracing', done, count);
        while (tracedPrefix < count && next.frames[tracedPrefix]) tracedPrefix++;
        // once half a second of the clip is traced, start playing it; tracing stays ahead
        if (autoplay && tracedPrefix >= Math.min(count, Math.ceil(fps / 2))) { autoplay = false; if (!playing) setPlaying(true); }
        const now = performance.now();
        if (!playing && r.id > shown && now - lastPreview > 250) { shown = r.id; lastPreview = now; if (reel) showFrame(r.id); else drawFrame(r.id, LIVE_CAP); }
      });
      pending.add(job);
      while (pool.inFlight >= pool.size * 2) await Promise.race([...pending, failure]);
    }
    await reader;
    await Promise.all(pending);
    finishTrace();
  } catch (err) {
    if (err instanceof Stop) {
      const have = next.frames.findIndex((f) => !f);
      if (have > 0) { next.frames.length = have; clip = next; finishTrace(true); }
      else { clip = null; resetAfterTrace(); }
    } else {
      console.error(err);
      clip = null;
      resetAfterTrace();
      showError(`tracing stopped: ${err.message || err}`);
    }
  } finally {
    clearInterval(watchdog);
    abort = true;
    closeFrames();
    closeThumbs();
    stopReaders();
    pool.terminate();
  }
}

class Stop extends Error {}

// Frames are scaled on the GPU by the decoder's own canvas, then copied 1:1 into a canvas that
// is CPU-backed from the start (willReadFrequently) and read from there. The decoder's canvas
// is never read back itself: Chrome can quietly move a canvas it sees read often from GPU to
// CPU mid-run, and the two scale differently, so reading it directly made traces vary from
// run to run. Scaling first also keeps the GPU readback to the target size.
function frameReader(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  return (wrapped) => {
    ctx.drawImage(wrapped.canvas, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  };
}

function progress(label, n, total) {
  $('progress-label').textContent = label;
  $('progress-figure').textContent = total ? `${n} / ${total}` : `${n}`;
  $('meter').style.setProperty('--progress', total ? n / total : 0);
  if (label === 'tracing') $('frame-note').textContent = `tracing ${n} / ${total}`;
}

function setSettingsDisabled(on) {
  for (const el of document.querySelectorAll('#settings input')) el.disabled = on;
}

function resetAfterTrace() {
  setState(clip ? 'ready' : 'loaded');
  if (!clip) { setPlaying(false, false); $('play').disabled = true; $('scrub').disabled = true; body.classList.remove('reeling'); }
  $('trace').hidden = false; $('stop').hidden = true; $('progress').hidden = true;
  setSettingsDisabled(false);
  markStale();
}

function finishTrace(partial = false) {
  resetAfterTrace();
  const f = clip.frames;
  let shapes = 0, verts = 0;
  for (const fr of f) {
    for (const L of [fr.fill, fr.line]) if (L) { shapes += L.counts.length; verts += L.verts.length / 2; }
  }
  $('r-frames').textContent = fmtInt(f.length);
  $('r-scenes').textContent = fmtInt(clip.scenes);
  $('r-shapes').textContent = fmtInt(Math.round(shapes / f.length));
  $('r-verts').textContent = fmtInt(Math.round(verts / f.length));
  $('live-note').textContent = partial ? `stopped after ${f.length} frames.` : '';
  $('result').hidden = false; $('export').hidden = false; $('download').hidden = true;
  $('trace').textContent = 'trace video';
  $('frame-label').textContent = 'desmos';
  $('frame-note').textContent = `${clip.style}, ${settings.fidelity}, ${clip.W} px`;
  clip.note = $('frame-note').textContent;
  body.classList.remove('comparing');
  $('scrub').max = f.length - 1; $('scrub').disabled = false;
  $('play').disabled = false; $('compare').disabled = false;
  if (current < 0 || current >= f.length) current = 0;
  if (!playing) { if (reel) showFrame(current); settle(); }
}

// ---------------------------------------------------------------- live graph

let calc = null, painter = null, calcKey = '', current = -1;

function colorToken(name) {
  // Desmos wants a hex colour; resolve the token through a canvas.
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = v;
  return c.fillStyle;
}

const CALC_OPTIONS = {
  expressions: false, settingsMenu: false, zoomButtons: false, lockViewport: true, border: false,
  showGrid: false, showXAxis: false, showYAxis: false, keypad: false, pointsOfInterest: false, trace: false,
  links: false, images: false, folders: false, notes: false, sliders: false,
};

async function ensureCalc(W, H, style) {
  if (!calc) {
    const Desmos = await desmos();
    calc = Desmos.GraphingCalculator($('calc'), { ...CALC_OPTIONS, backgroundColor: colorToken('--color-paper') });
    painter = new Painter(calc);
    new ResizeObserver(() => {
      applyWidths();
      if (reel && clip) { reel.setup(clip); if (body.classList.contains('reeling') && current >= 0) showFrame(current); }
    }).observe($('calc'));
  }
  const key = `${W}x${H}|${style}`;
  if (key !== calcKey) {
    calc.setState(slotState(calc.getState(), W, H));
    calc.setMathBounds(bounds(W, H));
    painter.reset();
    calcKey = key;
  }
  applyWidths();
}

function applyWidths() {
  if (!calc || !clip) return;
  calc.setMathBounds(bounds(clip.W, clip.H));
  calc.setExpressions(widthExprs(clip.style, clip.W, $('calc').clientWidth / clip.W));
}

// While playing, the live graph draws only each frame's largest shapes (fills are stored
// largest first) so Desmos keeps up; paused, scrubbed and exported frames get every shape.
// phones get a lighter live cut; their graphics budget is smaller
const LIVE_CAP = matchMedia('(pointer: coarse)').matches ? 300 : 600;

// The graph draws frame i (capped while playing, in browsers without the reel).
function drawFrame(i, cap = Infinity) {
  const fr = clip?.frames[i];
  if (!fr) return;
  current = i;
  const t = performance.now();
  painter.draw(fr, clip.style, cap);
  drawCost = performance.now() - t;
  rendered++;
  updateClock(i);
  if (body.classList.contains('comparing') && body.dataset.state !== 'tracing') showSource(media.start + i / clip.fps, i);
}

function updateClock(i) {
  $('scrub').value = i;
  $('time').textContent = `${fmtTime(i / clip.fps)} / ${fmtTime(clip.frames.length / clip.fps)}`;
}

// Frame i on screen through the reel (playing, scrubbing, stepping); the graph catches up
// with settle() once things stop moving.
const reel = Reel.supported() ? new Reel($('reel')) : null;
let tracedPrefix = 0;
let settleToken = 0, settleTimer = 0;

function showFrame(i) {
  if (!clip || !clip.frames[i]) return;
  if (!reel) { drawFrame(i, playing ? LIVE_CAP : Infinity); return; }
  settleToken++;
  current = i;
  body.classList.add('reeling');
  reel.show(i);
  reel.prefetch(i, clip.frames.length);
  updateClock(i);
  if (body.classList.contains('comparing') && body.dataset.state !== 'tracing') showSource(media.start + i / clip.fps, i);
}

// Hand the paused frame to the graph, and take the reel away only once Desmos has drawn it
// (a 2x2 screenshot resolves after evaluation), so the swap never shows a half-drawn graph.
async function settle() {
  clearTimeout(settleTimer);
  if (!clip || current < 0 || !clip.frames[current]) return;
  const token = ++settleToken;
  drawFrame(current);
  if (!reel || !calc) return;
  await new Promise((r) => calc.asyncScreenshot({ width: 2, height: 2, targetPixelRatio: 1, showLabels: false, mathBounds: bounds(clip.W, clip.H) }, () => requestAnimationFrame(() => requestAnimationFrame(r))));
  if (token === settleToken && !playing) body.classList.remove('reeling');
}
const settleSoon = () => { clearTimeout(settleTimer); settleTimer = setTimeout(settle, 150); };

// Playback is clocked: a frame that is late is skipped, never queued, so heavy traces drop
// frames instead of slowing down.
let drawCost = 0, playing = false, raf = 0, t0 = 0, f0 = 0, rendered = 0, rateT = 0, liveFps = 0;

function setPlaying(on, redraw = true) {
  const wasPlaying = playing;
  playing = on && !!clip;
  body.classList.toggle('playing', playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  cancelAnimationFrame(raf);
  if (!playing && wasPlaying && redraw && current >= 0) settle();
  if (playing) {
    t0 = rateT = performance.now(); f0 = Math.max(0, current); rendered = 0;
    raf = requestAnimationFrame(loop);
  }
}

function loop(now) {
  const n = clip.frames.length;
  const limit = body.dataset.state === 'tracing' ? tracedPrefix : n;
  let target = f0 + Math.floor((now - t0) / 1000 * clip.fps);
  if (limit < n && target >= limit) {
    // caught up with the trace: hold the last traced frame and let the clock wait
    target = Math.max(0, limit - 1);
    t0 = now - (target - f0) * 1000 / clip.fps;
  }
  target %= n;
  if (reel) {
    if (target !== current || reel.shown !== target) showFrame(target);
    raf = requestAnimationFrame(loop);
    return;
  }
  if (target !== current) drawFrame(target, LIVE_CAP);
  if (now - rateT > 1500) {
    liveFps = rendered * 1000 / (now - rateT);
    rendered = 0; rateT = now;
    const capped = clip.frames[current] && (clip.frames[current].fill?.counts.length || 0) > LIVE_CAP;
    $('live-note').textContent = capped
      ? `playing draws the largest ${LIVE_CAP} shapes of each frame so the graph keeps up. pause to see every shape; the export draws them all.`
      : liveFps < clip.fps * 0.8 ? `the live graph is drawing about ${Math.round(liveFps)} of ${Math.round(clip.fps)} frames a second. the export draws every frame.` : '';
  }
  raf = requestAnimationFrame(loop);
}

$('play').addEventListener('click', () => setPlaying(!playing));
$('scrub').addEventListener('input', (e) => {
  const i = Math.min(+e.target.value, Math.max(0, (body.dataset.state === 'tracing' ? tracedPrefix : clip.frames.length) - 1));
  setPlaying(false, false);
  showFrame(i);
  if (reel) settleSoon();
});
$('scrub').addEventListener('change', () => { if (reel && !playing) settle(); });

// Hold to compare: the source frame over the graph, for as long as it is held.
function comparing(on) {
  if (!clip) return;
  body.classList.toggle('comparing', on);
  $('compare').setAttribute('aria-pressed', String(on));
  $('frame-label').textContent = on ? 'source' : 'desmos';
  $('frame-note').textContent = on ? `frame ${current + 1}` : clip.note || '';
  if (on) showSource(media.start + current / clip.fps, current);
}
$('compare').addEventListener('pointerdown', (e) => { e.preventDefault(); comparing(true); });
$('compare').addEventListener('contextmenu', (e) => e.preventDefault());
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('compare').addEventListener(ev, () => comparing(false));

addEventListener('keydown', (e) => {
  const t = e.target instanceof Element ? e.target : body;
  if (!clip || (body.dataset.state !== 'ready' && body.dataset.state !== 'tracing') || t.matches('input:not([type=range]), textarea')) return;
  if (e.key === ' ' && !t.matches('button')) { e.preventDefault(); setPlaying(!playing); }
  else if ((e.key === 'c' || e.key === 'C') && !e.repeat) comparing(true);
  else if (e.key === 'ArrowRight' && t.id !== 'scrub') { setPlaying(false, false); showFrame(Math.min(clip.frames.length - 1, current + 1)); if (reel) settleSoon(); }
  else if (e.key === 'ArrowLeft' && t.id !== 'scrub') { setPlaying(false, false); showFrame(Math.max(0, current - 1)); if (reel) settleSoon(); }
});
addEventListener('keyup', (e) => { if (e.key === 'c' || e.key === 'C') comparing(false); });

function layoutFrame() {
  const fr = $('frame');
  document.documentElement.style.setProperty('--frame-h', `${fr.clientHeight}px`);
}
new ResizeObserver(layoutFrame).observe($('frame'));

// ---------------------------------------------------------------- export

// imported here, beside the export code that uses them
import { VideoSampleSource, VideoSample } from 'https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/dist/bundles/mediabunny.min.mjs';

// The graph is vector, so it can be drawn larger than the source.
async function buildSizes() {
  const seg = $('size-seg');
  seg.textContent = '';
  const aspect = media.srcW / media.srcH;
  const portrait = aspect < 1;
  const heights = [720, 1080, 1440, 2160];
  const sizes = [];
  for (const short of heights) {
    const w = even(portrait ? short : short * aspect), h = even(portrait ? short / aspect : short);
    const ok = await canEncodeVideo('avc', { width: w, height: h }).catch(() => false);
    if (ok) sizes.push({ w, h, label: short === 2160 ? '4K' : `${short}p` });
  }
  if (!sizes.length) {
    $('export-mp4').disabled = true;
    $('export-label').textContent = '';
    showExportError('this browser cannot encode h.264 video, so mp4 export is off. save as page still works.');
    return;
  }
  const pick = sizes.find((s) => s.label === settings.size) || sizes.find((s) => s.label === '1080p') || sizes[sizes.length - 1];
  for (const s of sizes) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="size" value="${s.label}"><span>${s.label}</span>`;
    const input = label.querySelector('input');
    input.dataset.w = s.w; input.dataset.h = s.h;
    input.checked = s === pick;
    seg.append(label);
  }
}

function showExportError(msg) {
  const d = $('download');
  d.hidden = !msg;
  d.className = msg ? 'error' : 'download';
  d.textContent = msg;
}

let exportCancel = false;
$('export-cancel').addEventListener('click', () => { exportCancel = true; });
$('export-mp4').addEventListener('click', () => exportMp4());

function screenshot(c, W, H, ratio) {
  return new Promise((resolve) => c.asyncScreenshot({
    width: W, height: H, targetPixelRatio: ratio, showLabels: false, format: 'png',
    mathBounds: bounds(W, H),
  }, resolve));
}

// The credit: "desmeows" in the site's serif, bottom right, sized to the video's height so
// it reads the same at 720p and 4K. Two stamps are drawn once, light ink for dark corners
// and dark ink for bright ones; each frame picks one from how bright its corner is.
const CREDIT = { text: 'desmeows', size: 0.034, margin: 0.03, alpha: 0.85 };

async function creditStamp(outW, outH) {
  const px = Math.max(14, Math.round(outH * CREDIT.size));
  const font = `${px}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim()}`;
  await document.fonts.load(font);
  const pad = Math.ceil(px * 0.6);
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const m = probe.measureText(CREDIT.text);
  const stamp = (ink, shade) => {
    const c = document.createElement('canvas');
    c.width = Math.ceil(m.width) + pad * 2;
    c.height = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + pad * 2;
    const g = c.getContext('2d');
    g.font = font;
    g.globalAlpha = CREDIT.alpha;
    g.shadowColor = shade;
    g.shadowBlur = px * 0.25;
    g.fillStyle = ink;
    g.fillText(CREDIT.text, pad, pad + m.actualBoundingBoxAscent);
    return c;
  };
  const light = stamp(colorToken('--color-ink'), colorToken('--color-shade'));
  const dark = stamp(colorToken('--color-paper'), colorToken('--color-glow'));
  const margin = Math.round(outH * CREDIT.margin);
  const x = outW - margin - light.width + pad, y = outH - margin - light.height + pad;
  // the corner whose brightness picks the stamp: the box the text sits in
  const win = { x: x + pad, y: y + pad, w: light.width - 2 * pad, h: light.height - 2 * pad };
  let onBright = false;
  const onBrightCorner = (d) => {
    let sum = 0;
    for (let i = 0; i < d.length; i += 16) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const lum = sum / (d.length / 16) / 255;
    // hysteresis, so a corner hovering near the middle doesn't flicker between the two
    if (onBright ? lum < 0.5 : lum > 0.62) onBright = !onBright;
    return onBright;
  };
  let corner = null;
  return {
    // stamp onto a frame already drawn into ctx
    draw(ctx) {
      const bright = onBrightCorner(ctx.getImageData(win.x, win.y, win.w, win.h).data);
      ctx.drawImage(bright ? dark : light, x, y);
    },
    // For frames drawn and stamped in workers: which stamp frame i gets, from just its corner
    // drawn again here (a few shapes), so no full frame is ever read back. Call in frame order.
    pick(frame, style, W, H) {
      if (!corner) {
        const c = document.createElement('canvas');
        c.width = win.w; c.height = win.h;
        corner = c.getContext('2d', { willReadFrequently: true });
      }
      rasterize(corner, frame, style, W, H, outW / W, win);
      return onBrightCorner(corner.getImageData(0, 0, win.w, win.h).data);
    },
    // both stamps and where they go, for the workers
    async stamps() {
      return { light: await createImageBitmap(light), dark: await createImageBitmap(dark), x, y };
    },
  };
}

let exportCalc = null;
async function exportMp4() {
  const sel = document.querySelector('input[name="size"]:checked');
  if (!clip || !sel) return;
  const outW = +sel.dataset.w, outH = +sel.dataset.h;
  const { W, H, fps, style, frames } = clip;
  setPlaying(false);
  setState('exporting');
  exportCancel = false;
  showExportError('');
  $('export-progress').hidden = false;
  for (const b of ['export-mp4', 'save-page', 'trace']) $(b).disabled = true;
  const viaDesmos = settings.renderer === 'desmos';
  let exportPainter = null;
  if (viaDesmos) {
    const el = $('export-calc');
    el.style.width = `${W}px`; el.style.height = `${H}px`;
    if (!exportCalc) exportCalc = (await desmos()).GraphingCalculator(el, CALC_OPTIONS);
    exportCalc.setState(slotState(exportCalc.getState(), W, H));
    exportPainter = new Painter(exportCalc);
    exportCalc.setMathBounds(bounds(W, H));
    exportCalc.setExpressions(widthExprs(style, W, 1));
  }

  const credit = await creditStamp(outW, outH); // every export carries the credit
  // Direct export draws and stamps frames in parallel workers, a few ahead of the encoder, and
  // takes them back in order. Workers with WebCodecs hand back NV12 VideoFrames that go to the
  // encoder untouched; otherwise bitmaps, which go through a canvas here.
  const parallel = !viaDesmos && typeof OffscreenCanvas !== 'undefined';
  let pools = [], asFrames = false, output = null;
  const ahead = new Map();
  const stopWorkers = () => {
    for (const p of ahead.values()) p.then((r) => (r.frame || r.bitmap).close(), () => {});
    ahead.clear();
    for (const pool of pools) pool.terminate();
    pools = [];
  };
  try {
    if (parallel) {
      // Past three GPU workers the GPU process falls behind; the other cores draw on the CPU,
      // leaving two for this thread and the encoder.
      const cores = navigator.hardwareConcurrency || 4;
      const gpu = Math.max(2, Math.min(3, cores - 2));
      const cpu = Math.max(0, Math.min(12, cores - gpu - 2));
      const stamps = credit ? await credit.stamps() : null;
      const init = { type: 'init', W, H, style, outW, outH, fps, credit: stamps };
      const kinds = [{ n: gpu, cpu: false }, { n: cpu, cpu: true }].filter((k) => k.n > 0);
      pools = kinds.map((k) => new Pool(k.n, './raster-worker.js'));
      const replies = await Promise.all(pools.map((p, k) => p.broadcast({ ...init, cpu: kinds[k].cpu })));
      asFrames = replies.flat().every((r) => r.frames);
    }
    let canvas = null, ctx = null;
    if (!asFrames) {
      canvas = document.createElement('canvas');
      canvas.width = outW; canvas.height = outH;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
    }

    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    // ~0.16 bits a pixel: flat fills and hard edges compress well, so this stays sharp at a sane size.
    const encoding = { codec: 'avc', bitrate: Math.round(outW * outH * fps * 0.16), keyFrameInterval: 2 };
    const video = asFrames ? new VideoSampleSource(encoding) : new CanvasSource(canvas, encoding);
    output.addVideoTrack(video, { frameRate: fps });
    let audio = null;
    if (media.audio && media.audio.codec) {
      audio = new EncodedAudioPacketSource(media.audio.codec);
      output.addAudioTrack(audio);
    }
    await output.start();

    // Each frame goes to the first pool with an idle worker, GPU first: it is the quicker one,
    // and the next frame dealt is the one the encoder needs soonest. In-flight frames (drawn or
    // not, until the encoder takes them; NV12 or RGBA) stay under ~600 MB.
    const workers = pools.reduce((n, p) => n + p.size, 0);
    const depth = Math.max(2, Math.min(workers * 2, Math.floor(600e6 / (outW * outH * (asFrames ? 1.5 : 4)))));
    let sent = 0;
    const deal = () => {
      while (pools.length && sent < frames.length && ahead.size < depth) {
        const pool = pools.find((p) => p.inFlight < p.size);
        if (!pool) return;
        const i = sent++;
        const bright = credit ? credit.pick(frames[i], style, W, H) : false;
        const job = pool.run({ i, frame: frames[i], bright });
        job.then(deal, () => {});
        ahead.set(i, job);
      }
    };
    deal();
    const take = async (i) => {
      const r = await ahead.get(i);
      ahead.delete(i);
      deal();
      return r;
    };

    const started = performance.now();
    for (let i = 0; i < frames.length; i++) {
      if (exportCancel) throw new Stop();
      if (asFrames) {
        const { frame } = await take(i);
        const sample = new VideoSample(frame, { timestamp: i / fps, duration: 1 / fps });
        try { await video.add(sample); } finally { sample.close(); }
      } else {
        if (parallel) {
          const { bitmap } = await take(i);
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
        } else if (viaDesmos) {
          exportPainter.draw(frames[i], style);
          const url = await screenshot(exportCalc, W, H, outW / W);
          const img = new Image();
          img.src = url;
          await img.decode();
          ctx.drawImage(img, 0, 0, outW, outH);
        } else {
          rasterize(ctx, frames[i], style, W, H, outW / W);
        }
        if (credit && !parallel) credit.draw(ctx);
        await video.add(i / fps, 1 / fps);
      }
      const left = (performance.now() - started) / (i + 1) * (frames.length - i - 1);
      $('export-figure').textContent = `${i + 1} / ${frames.length}`;
      const verb = viaDesmos ? 'drawing in desmos' : 'drawing frames';
      $('export-label').textContent = i < 3 ? verb : `${verb}, about ${fmtDuration(left)} left`;
      $('export-meter').style.setProperty('--progress', (i + 1) / frames.length);
    }
    stopWorkers();

    if (audio) {
      $('export-label').textContent = 'adding the sound';
      const end = media.start + frames.length / fps;
      const config = await media.audio.getDecoderConfig();
      let first = true;
      for await (const packet of new EncodedPacketSink(media.audio).packets()) {
        if (packet.timestamp >= end) break;
        const t = packet.timestamp - media.start;
        if (t < 0) continue;
        await audio.add(packet.clone({ timestamp: t }), first ? { decoderConfig: config } : undefined);
        first = false;
      }
      audio.close();
    }
    video.close();
    $('export-label').textContent = 'writing the file';
    await output.finalize();
    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    offerDownload(blob, `${baseName()}-desmos-${sel.value}.mp4`);
  } catch (err) {
    if (output && output.state !== 'finalized') await output.cancel().catch(() => {});
    if (!(err instanceof Stop)) { console.error(err); showExportError(`export stopped: ${err.message || err}`); }
  } finally {
    stopWorkers();
    setState('ready');
    $('export-progress').hidden = true;
    for (const b of ['export-mp4', 'save-page', 'trace']) $(b).disabled = false;
  }
}

let lastUrl = null;
function offerDownload(blob, name) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  const d = $('download');
  d.className = 'download';
  d.textContent = '';
  const a = document.createElement('a');
  a.href = lastUrl; a.download = name; a.textContent = `download ${name}`;
  d.append(a, document.createTextNode(` (${fmtBytes(blob.size)})`));
  d.hidden = false;
  a.click();
}

const baseName = () => (clip?.name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'video';

// ---------------------------------------------------------------- save as page

$('save-page').addEventListener('click', savePage);

async function savePage() {
  if (!clip) return;
  const renderSrc = (await (await fetch(new URL('./render.js', import.meta.url))).text()).replace(/^export /gm, '');
  const data = {
    W: clip.W, H: clip.H, fps: clip.fps, style: clip.style,
    frames: clip.frames.map((f) => ({ f: packLayer(f.fill), l: packLayer(f.line), m: f.mean })),
  };
  const title = `${baseName()} in Desmos`;
  const html = standalonePage(title, JSON.stringify(data), renderSrc);
  offerDownload(new Blob([html], { type: 'text/html' }), `${baseName()}-desmos.html`);
}

function standalonePage(title, json, renderSrc) {
  const esc = (s) => s.replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<script src="https://www.desmos.com/api/v1.11/calculator.js?apiKey=dcb31709b452b1cf9dc26972add0fda6"></script>
<style>
:root { --paper: #0e1016; --ink: #eef1f6; --muted: #7f8592; --line: rgb(238 241 246 / 0.16); --accent: #6f8fcf; }
html, body { margin: 0; height: 100%; background: var(--paper); color: var(--ink); font: 13px/1.5 "IBM Plex Mono", ui-monospace, Menlo, monospace; }
body { display: grid; grid-template-rows: minmax(0, 1fr) auto; }
#stage { display: grid; place-items: center; min-height: 0; padding: 16px; }
#frame { position: relative; width: min(100%, calc((100dvh - 88px) * ${clip.W / clip.H})); aspect-ratio: ${clip.W / clip.H}; container-type: size; }
#calc { width: 100%; height: 100%; }
#credit { position: absolute; right: 3cqh; bottom: 3cqh; margin: 0; font: 3.4cqh/1 "Instrument Serif", Georgia, serif; color: var(--ink); opacity: 0.8; text-shadow: 0 0 0.25em rgb(0 0 0 / 0.55); pointer-events: none; }
#bar { display: flex; gap: 12px; align-items: center; padding: 12px 16px 16px; }
#bar input { flex: 1; accent-color: var(--accent); }
button { background: none; color: var(--ink); border: 1px solid var(--line); padding: 8px 14px; cursor: pointer; font: inherit; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
span { color: var(--muted); font-variant-numeric: tabular-nums; }
</style></head>
<body>
<div id="stage"><div id="frame"><div id="calc"></div><p id="credit">desmeows</p></div></div>
<div id="bar"><button id="play" type="button">pause</button><input id="seek" type="range" min="0" value="0" aria-label="Frame"><span id="t"></span></div>
<script>
${renderSrc}
const D = JSON.parse(${JSON.stringify(esc(json))});
const frames = D.frames.map((f) => ({ fill: unpackLayer(f.f), line: unpackLayer(f.l), mean: f.m }));
const el = document.getElementById('calc');
const calc = Desmos.GraphingCalculator(el, { expressions: false, settingsMenu: false, zoomButtons: false, lockViewport: true, border: false, showGrid: false, showXAxis: false, showYAxis: false, keypad: false, pointsOfInterest: false, trace: false, backgroundColor: '#0e1016' });
const painter = new Painter(calc);
calc.setState(slotState(calc.getState(), D.W, D.H));
calc.setMathBounds(bounds(D.W, D.H));
const widths = () => calc.setExpressions(widthExprs(D.style, D.W, el.clientWidth / D.W));
new ResizeObserver(widths).observe(el);
let cur = -1, playing = true, t0 = performance.now(), f0 = 0;
const seek = document.getElementById('seek'), t = document.getElementById('t'), play = document.getElementById('play');
seek.max = frames.length - 1;
function show(i, cap) { cur = i; painter.draw(frames[i], D.style, cap); seek.value = i; t.textContent = (i / D.fps).toFixed(1) + ' s'; }
function loop(now) { if (playing) { const i = (f0 + Math.floor((now - t0) / 1000 * D.fps)) % frames.length; if (i !== cur) show(i, 600); } requestAnimationFrame(loop); }
play.onclick = () => { playing = !playing; play.textContent = playing ? 'pause' : 'play'; t0 = performance.now(); f0 = Math.max(0, cur); if (!playing) show(cur); };
seek.oninput = () => { playing = false; play.textContent = 'play'; show(+seek.value); };
show(0); requestAnimationFrame(loop);
<\/script>
</body></html>`;
}

// ---------------------------------------------------------------- format

function fmtTime(s) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}
const fmtInt = (n) => n.toLocaleString('en-US');
function fmtBytes(b) {
  return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
}

syncSettingsUI();

// ?debug exposes the live state for benchmarking and diagnosis; nothing reads it otherwise.
if (params.has('debug')) window.__desmeows = { get clip() { return clip; }, get calc() { return calc; }, get media() { return media; }, settings };
