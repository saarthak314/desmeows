import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, BufferTarget,
  CanvasSource, EncodedPacketSink, EncodedAudioPacketSource, canEncodeVideo,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/dist/bundles/mediabunny.min.mjs';
import { detectScenes, sceneSamples } from './palette.js';
import { slotState, frameExprs, widthExprs, packLayer, Painter } from './render.js';

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
  credit: params.get('credit') !== 'off',
};

function syncSettingsUI() {
  for (const name of ['style', 'fidelity', 'fps']) {
    const input = document.querySelector(`input[name="${name}"][value="${settings[name]}"]`);
    if (input) input.checked = true;
  }
  $('ink').checked = settings.ink;
  $('credit').checked = settings.credit;
  body.classList.toggle('credited', settings.credit);
  body.dataset.style = settings.style;
  $('fidelity-note').textContent = media ? TIER_NOTE[settings.style][settings.fidelity](traceWidth()) : '';
  const q = new URLSearchParams();
  if (settings.style !== 'paint') q.set('style', settings.style);
  if (settings.fidelity !== 'fine') q.set('fidelity', settings.fidelity);
  if (settings.fps !== 'source') q.set('fps', settings.fps);
  if (!settings.ink) q.set('ink', 'off');
  if (settings.size) q.set('size', settings.size);
  if (!settings.credit) q.set('credit', 'off');
  history.replaceState(null, '', q.size ? `?${q}` : location.pathname);
  markStale();
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'style' || t.name === 'fidelity' || t.name === 'fps') settings[t.name] = t.value;
  else if (t.id === 'ink') settings.ink = t.checked;
  else if (t.name === 'size') { settings.size = t.value; syncSettingsUI(); return; }
  else if (t.id === 'credit') { settings.credit = t.checked; syncSettingsUI(); return; }
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
  $('screen').hidden = false; $('sheet').hidden = false; $('new-video').hidden = false;
  $('file-name').textContent = file.name;
  $('frame-label').textContent = 'source';
  $('frame-note').textContent = 'reading the file';
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
  constructor(n) {
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('./tracer.js', import.meta.url), { type: 'module' });
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
  terminate() { for (const w of this.workers) w.terminate(); }
}

// ---------------------------------------------------------------- tracing

$('trace').addEventListener('click', () => trace());
$('stop').addEventListener('click', () => { stopping = true; $('stop').disabled = true; });

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
  const pool = new Pool(Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)));
  let shown = -1, lastPreview = 0;

  try {
    // Pass 1: small thumbnails for scene cuts and palettes.
    progress('reading frames', 0, count);
    const TW = 160, TH = even(160 * H / W);
    const thumbSink = new CanvasSink(media.video, { width: TW, height: TH, fit: 'fill', poolSize: 1 });
    const thumbs = [];
    for await (const wrapped of thumbSink.canvasesAtTimestamps(times)) {
      if (stopping) throw new Stop();
      thumbs.push(readPixels(wrapped, TW, TH));
      if (thumbs.length % 8 === 0) progress('reading frames', thumbs.length, count);
    }
    const scene = detectScenes(thumbs);
    next.scenes = scene[scene.length - 1] + 1;
    const luts = [];
    if (style === 'paint') {
      progress(`mixing ${next.scenes} ${next.scenes === 1 ? 'palette' : 'palettes'}`, 0, next.scenes);
      let done = 0;
      await Promise.all(Array.from({ length: next.scenes }, (_, s) => {
        const samples = sceneSamples(thumbs, scene, s);
        return pool.run({ type: 'kmeans', samples, k: tier.k, iters: tier.iters }, [samples.buffer]).then((r) => {
          luts[s] = r.lut;
          progress(`mixing ${next.scenes} ${next.scenes === 1 ? 'palette' : 'palettes'}`, ++done, next.scenes);
        });
      }));
      if (stopping) throw new Stop();
      await pool.broadcast({ type: 'palettes', luts });
    }

    // Pass 2: full-size frames through the tracer, a few per worker in flight.
    clip = next;
    ensureCalc(W, H, style);
    $('frame-label').textContent = 'desmos';
    body.classList.remove('comparing');
    progress('tracing', 0, count);
    const sink = new CanvasSink(media.video, { width: W, height: H, fit: 'fill', poolSize: 1 });
    let i = 0, done = 0;
    const pending = new Set();
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (stopping) throw new Stop();
      const rgba = readPixels(wrapped, W, H);
      const id = i++;
      const job = pool.run({ id, w: W, h: H, rgba, opts: { ...opts, scene: scene[id] } }, [rgba.buffer]).then((r) => {
        next.frames[r.id] = { fill: r.fill, line: r.line, mean: r.mean };
        done++;
        pending.delete(job);
        progress('tracing', done, count);
        const now = performance.now();
        if (r.id > shown && now - lastPreview > 250) { shown = r.id; lastPreview = now; drawFrame(r.id, LIVE_CAP); }
      });
      pending.add(job);
      while (pool.inFlight >= pool.size * 2) await Promise.race(pending);
    }
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
    pool.terminate();
  }
}

class Stop extends Error {}

function readPixels(wrapped, w, h) {
  const ctx = wrapped.canvas.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, w, h).data;
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
  drawFrame(0);
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

function ensureCalc(W, H, style) {
  if (!calc) {
    calc = Desmos.GraphingCalculator($('calc'), { ...CALC_OPTIONS, backgroundColor: colorToken('--color-paper') });
    painter = new Painter(calc);
    new ResizeObserver(() => applyWidths()).observe($('calc'));
  }
  const key = `${W}x${H}|${style}`;
  if (key !== calcKey) {
    calc.setState(slotState(calc.getState(), W, H));
    calc.setMathBounds({ left: 0, right: W, bottom: 0, top: H });
    painter.reset();
    calcKey = key;
  }
  applyWidths();
}

function applyWidths() {
  if (!calc || !clip) return;
  calc.setMathBounds({ left: 0, right: clip.W, bottom: 0, top: clip.H });
  calc.setExpressions(widthExprs(clip.style, clip.W, $('calc').clientWidth / clip.W));
}

// While playing, the live graph draws only each frame's largest shapes (fills are stored
// largest first) so Desmos keeps up; paused, scrubbed and exported frames get every shape.
// phones get a lighter live cut; their graphics budget is smaller
const LIVE_CAP = matchMedia('(pointer: coarse)').matches ? 300 : 600;

function drawFrame(i, cap = Infinity) {
  const fr = clip?.frames[i];
  if (!fr) return;
  current = i;
  const t = performance.now();
  painter.draw(fr, clip.style, cap);
  drawCost = performance.now() - t;
  rendered++;
  if (body.dataset.state !== 'tracing') {
    $('scrub').value = i;
    $('time').textContent = `${fmtTime(i / clip.fps)} / ${fmtTime(clip.frames.length / clip.fps)}`;
  }
  if (body.classList.contains('comparing') && body.dataset.state !== 'tracing') showSource(media.start + i / clip.fps, i);
}

// Playback is clocked: a frame that is late is skipped, never queued, so heavy traces drop
// frames instead of slowing down.
let drawCost = 0, playing = false, raf = 0, t0 = 0, f0 = 0, rendered = 0, rateT = 0, liveFps = 0;

function setPlaying(on, redraw = true) {
  const wasPlaying = playing;
  playing = on && !!clip;
  body.classList.toggle('playing', playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  cancelAnimationFrame(raf);
  if (!playing && wasPlaying && redraw && current >= 0) drawFrame(current);
  if (playing) {
    t0 = rateT = performance.now(); f0 = Math.max(0, current); rendered = 0;
    raf = requestAnimationFrame(loop);
  }
}

function loop(now) {
  const n = clip.frames.length;
  const target = (f0 + Math.floor((now - t0) / 1000 * clip.fps)) % n;
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
$('scrub').addEventListener('input', (e) => { const i = +e.target.value; setPlaying(false, false); drawFrame(i); });

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
  if (!clip || body.dataset.state !== 'ready' || t.matches('input:not([type=range]), textarea')) return;
  if (e.key === ' ' && !t.matches('button')) { e.preventDefault(); setPlaying(!playing); }
  else if ((e.key === 'c' || e.key === 'C') && !e.repeat) comparing(true);
  else if (e.key === 'ArrowRight' && t.id !== 'scrub') { setPlaying(false, false); drawFrame(Math.min(clip.frames.length - 1, current + 1)); }
  else if (e.key === 'ArrowLeft' && t.id !== 'scrub') { setPlaying(false, false); drawFrame(Math.max(0, current - 1)); }
});
addEventListener('keyup', (e) => { if (e.key === 'c' || e.key === 'C') comparing(false); });

function layoutFrame() {
  const fr = $('frame');
  document.documentElement.style.setProperty('--frame-h', `${fr.clientHeight}px`);
}
new ResizeObserver(layoutFrame).observe($('frame'));

// ---------------------------------------------------------------- export

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
    mathBounds: { left: 0, right: W, bottom: 0, top: H },
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
  let onBright = false;
  return {
    // stamp onto a frame already drawn into ctx
    draw(ctx) {
      const d = ctx.getImageData(x + pad, y + pad, light.width - 2 * pad, light.height - 2 * pad).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 16) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const lum = sum / (d.length / 16) / 255;
      // hysteresis, so a corner hovering near the middle doesn't flicker between the two
      if (onBright ? lum < 0.5 : lum > 0.62) onBright = !onBright;
      ctx.drawImage(onBright ? dark : light, x, y);
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
  const el = $('export-calc');
  el.style.width = `${W}px`; el.style.height = `${H}px`;
  if (!exportCalc) exportCalc = Desmos.GraphingCalculator(el, CALC_OPTIONS);
  exportCalc.setState(slotState(exportCalc.getState(), W, H));
  const exportPainter = new Painter(exportCalc);
  exportCalc.setMathBounds({ left: 0, right: W, bottom: 0, top: H });
  exportCalc.setExpressions(widthExprs(style, W, 1));

  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  const credit = settings.credit ? await creditStamp(outW, outH) : null;
  let output = null;
  try {
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    // ~0.16 bits a pixel: flat fills and hard edges compress well, so this stays sharp at a sane size.
    const video = new CanvasSource(canvas, { codec: 'avc', bitrate: Math.round(outW * outH * fps * 0.16), keyFrameInterval: 2 });
    output.addVideoTrack(video, { frameRate: fps });
    let audio = null;
    if (media.audio && media.audio.codec) {
      audio = new EncodedAudioPacketSource(media.audio.codec);
      output.addAudioTrack(audio);
    }
    await output.start();

    const started = performance.now();
    for (let i = 0; i < frames.length; i++) {
      if (exportCancel) throw new Stop();
      exportPainter.draw(frames[i], style);
      const url = await screenshot(exportCalc, W, H, outW / W);
      const img = new Image();
      img.src = url;
      await img.decode();
      ctx.drawImage(img, 0, 0, outW, outH);
      if (credit) credit.draw(ctx);
      await video.add(i / fps, 1 / fps);
      const left = (performance.now() - started) / (i + 1) * (frames.length - i - 1);
      $('export-figure').textContent = `${i + 1} / ${frames.length}`;
      $('export-label').textContent = i < 3 ? 'drawing frames in desmos' : `drawing in desmos, about ${fmtDuration(left)} left`;
      $('export-meter').style.setProperty('--progress', (i + 1) / frames.length);
    }

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
  const html = standalonePage(title, JSON.stringify(data), renderSrc, settings.credit);
  offerDownload(new Blob([html], { type: 'text/html' }), `${baseName()}-desmos.html`);
}

function standalonePage(title, json, renderSrc, credit) {
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
<div id="stage"><div id="frame"><div id="calc"></div>${credit ? '<p id="credit">desmeows</p>' : ''}</div></div>
<div id="bar"><button id="play" type="button">pause</button><input id="seek" type="range" min="0" value="0" aria-label="Frame"><span id="t"></span></div>
<script>
${renderSrc}
const D = JSON.parse(${JSON.stringify(esc(json))});
const frames = D.frames.map((f) => ({ fill: unpackLayer(f.f), line: unpackLayer(f.l), mean: f.m }));
const el = document.getElementById('calc');
const calc = Desmos.GraphingCalculator(el, { expressions: false, settingsMenu: false, zoomButtons: false, lockViewport: true, border: false, showGrid: false, showXAxis: false, showYAxis: false, keypad: false, pointsOfInterest: false, trace: false, backgroundColor: '#0e1016' });
const painter = new Painter(calc);
calc.setState(slotState(calc.getState(), D.W, D.H));
calc.setMathBounds({ left: 0, right: D.W, bottom: 0, top: D.H });
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
