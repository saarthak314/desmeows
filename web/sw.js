// desmeows service worker: repeat visits start from a stored copy of the app and of Desmos,
// instead of waiting on the network (README, "Loading").
//
// A copy is whole: index.html and every file in APP, fetched twice in a row and kept only if
// both rounds agree, so it never holds files from two deploys. Each page, and each worker it
// starts, is served from the copy the page started with; a page that loaded from the network
// (the first visit) stays on the network, unless the copy is what it loaded. After a visit the
// copy is compared with the site; if anything changed, a new whole copy is taken and the next
// visit starts from it. The Desmos script the app loads is kept beside it and refreshed after
// each visit.
//
// To turn it off, set OFF to true and deploy. Each browser's next visit replaces this worker
// with one that deletes its caches and unregisters, and everything loads from the network again.
const OFF = false;

// The app's own files, compared with the site after each visit. A new file the app loads
// belongs here; one left out still works, from the network.
const APP = ['./', 'app.css', 'tokens.css', 'base.css', 'app.js', 'render.js', 'palette.js', 'tracer.js', 'frame-worker.js', 'raster-worker.js'];
// Files whose content never changes under the same name (vercel.json caches them for a year).
const FIXED = [
  'fonts/instrument-serif-400.woff2', 'fonts/ibm-plex-mono-400.woff2', 'fonts/ibm-plex-mono-600.woff2',
  'fonts/jetbrains-mono-symbols.woff2', 'vendor/mediabunny-1.65.2/mediabunny.min.mjs',
];

// Caches are named PREFIX + what they hold. A worker deletes desmeows caches with any other
// prefix when it takes over, so changing PREFIX (as a change to what is stored should) starts
// every browser afresh.
const PREFIX = 'desmeows-1-';
const META = PREFIX + 'meta', FIXED_CACHE = PREFIX + 'fixed', DESMOS_CACHE = PREFIX + 'desmos';
const abs = (p) => new URL(p, self.registration.scope).href;
const APP_URLS = new Set(APP.map(abs)), FIXED_URLS = new Set(FIXED.map(abs));
const ROOT = abs('./'), INDEX = abs('index.html');
// The Desmos script is whatever the copy's index.html and app.js load from desmos.com/api, so
// its URL and key live in one place only.
const DESMOS_RE = /https:\/\/www\.desmos\.com\/api\/[^"'\s<>]+/g;

// ---------------------------------------------------------------- state

// { current, next, previous: copy cache names; pins: { client id: copy }; desmos: [urls] }
let state = null;
async function current() {
  if (state) return state;
  const res = await (await caches.open(META)).match('state');
  const s = res ? await res.json() : {};
  s.pins ||= {};
  s.desmos ||= [];
  return (state ||= s);
}
let saving = Promise.resolve();
function save() {
  const json = JSON.stringify(state);
  return (saving = saving.then(async () => (await caches.open(META)).put('state', new Response(json))).catch(() => {}));
}

// ---------------------------------------------------------------- copies

// headers that describe the network transfer, not the stored body
const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

async function take() {
  // every APP file, revalidated with the site (each answer is usually a 304); throws if one fails
  const out = new Map();
  await Promise.all(APP.map(async (p) => {
    const res = await fetch(abs(p), { cache: 'no-cache' });
    if (!res.ok || res.redirected) throw new Error(`${p}: ${res.status}`);
    out.set(abs(p), { body: await res.arrayBuffer(), headers: [...res.headers].filter(([k]) => !DROP.has(k)) });
  }));
  return out;
}

const same = (a, b) => {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};
const sameCopy = (a, b) => [...a].every(([k, v]) => b.has(k) && same(v.body, b.get(k).body));

async function takeWhole() {
  // two rounds that agree, so a deploy landing mid-round can't leave a mixed copy
  const a = await take();
  if (!sameCopy(a, await take())) throw new Error('the site changed while it was being copied');
  return a;
}

async function loadedByPage() {
  // the APP files the browser cache holds, unrevalidated: what the open page loaded
  const out = new Map();
  await Promise.all(APP.map(async (p) => {
    const res = await fetch(abs(p), { cache: 'only-if-cached', mode: 'same-origin' }).catch(() => null);
    if (res?.ok) out.set(abs(p), { body: await res.arrayBuffer() });
  }));
  return out;
}

async function store(copy) {
  const name = PREFIX + 'app-' + Date.now().toString(36);
  const c = await caches.open(name);
  await Promise.all([...copy].map(([u, v]) => c.put(u, new Response(v.body, { headers: v.headers }))));
  return name;
}

async function matches(name, copy) {
  if (!name || !(await caches.has(name))) return false;
  const c = await caches.open(name);
  for (const [u, v] of copy) {
    const res = await c.match(u);
    if (!res || !same(await res.arrayBuffer(), v.body)) return false;
  }
  return true;
}

async function desmosUrls(name) {
  const c = await caches.open(name);
  const urls = new Set();
  for (const p of [ROOT, abs('app.js')]) {
    const res = await c.match(p);
    if (res) for (const m of (await res.text()).match(DESMOS_RE) || []) urls.add(m.replace(/&amp;/g, '&'));
  }
  return [...urls];
}

async function keepDesmos(url) {
  // fetched with CORS (desmos.com allows any origin) so the status and type can be checked; the
  // browser's HTTP cache usually answers, since the page has just loaded the same script
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !/javascript/.test(type)) return;
  const body = await res.arrayBuffer();
  if (body.byteLength < 100000) return; // not the calculator, whatever it is
  const c = await caches.open(DESMOS_CACHE);
  const old = await c.match(url, { ignoreVary: true });
  if (old && same(await old.arrayBuffer(), body)) return;
  await c.put(url, new Response(body, { headers: { 'content-type': type } }));
}

async function refreshDesmos() {
  const latest = state.next || state.current;
  const urls = latest ? await desmosUrls(latest) : [];
  state.desmos = urls;
  await save();
  const c = await caches.open(DESMOS_CACHE);
  for (const req of await c.keys()) if (!urls.includes(req.url)) await c.delete(req);
  await Promise.all(urls.map((u) => keepDesmos(u).catch(() => {})));
}

// ---------------------------------------------------------------- lifecycle

self.addEventListener('install', (event) => {
  if (OFF) { self.skipWaiting(); return; }
  event.waitUntil((async () => {
    await (await caches.open(FIXED_CACHE)).addAll(FIXED);
    await current();
    // the first install takes the first copy; a newer worker keeps the copies it finds
    if (!state.current || !(await caches.has(state.current))) {
      const loaded = await loadedByPage();
      const copy = await takeWhole();
      state.current = await store(copy);
      // The page that registered the worker may be taken over at once, so that a trace it starts
      // loads its workers' modules from the copy instead of revalidating each with the site
      // (Vercel's Age header leaves them stale in the browser cache), but only if every script
      // and stylesheet it loaded (still in the browser cache) is the same in the copy.
      state.takeOver = loaded.has(abs('app.js')) && sameCopy(loaded, copy);
      await save();
    }
    await refreshDesmos().catch(() => {});
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('desmeows-') && (OFF || !k.startsWith(PREFIX))) await caches.delete(k);
    if (OFF) return self.registration.unregister();
    state = null; // whatever an older worker wrote while this one waited
    await current();
    if (state.takeOver) {
      delete state.takeOver;
      // only when that page is the only one open: another may have loaded an older deploy
      const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (pages.length === 1) {
        state.pins[pages[0].id] = state.current;
        await self.clients.claim();
      }
      await save();
    }
    const fixed = await caches.open(FIXED_CACHE);
    for (const req of await fixed.keys()) if (!FIXED_URLS.has(req.url)) await fixed.delete(req);
  })());
});

// ---------------------------------------------------------------- requests

let lastWorkerCopy = null;

self.addEventListener('fetch', (event) => {
  if (OFF) return;
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const path = url.origin + url.pathname;
  const fallback = () => fetch(req);
  if (req.mode === 'navigate') {
    if (path === ROOT || path === INDEX) event.respondWith(page(event).catch(fallback));
  } else if (!url.search && (APP_URLS.has(path) || FIXED_URLS.has(path))) {
    event.respondWith(file(event, path).catch(fallback));
  } else if (url.origin === 'https://www.desmos.com' && url.pathname.startsWith('/api/')) {
    event.respondWith(desmos(event).catch(fallback));
  }
});

async function page(event) {
  await current();
  if (state.next) {
    state.previous = state.current;
    state.current = state.next;
    state.next = null;
  }
  const res = state.current && (await (await caches.open(state.current)).match(ROOT));
  if (!res) return fetch(event.request);
  if (event.resultingClientId) state.pins[event.resultingClientId] = state.current;
  event.waitUntil(save().then(afterVisit));
  return res;
}

async function file(event, key) {
  const req = event.request;
  if (FIXED_URLS.has(key)) return (await (await caches.open(FIXED_CACHE)).match(key)) || fetch(req);
  await current();
  const name = await copyFor(event.clientId);
  if (req.destination === 'worker') lastWorkerCopy = name;
  // a worker is pinned when its script is requested, if the browser says which client that
  // request creates
  if (event.resultingClientId) {
    state.pins[event.resultingClientId] = name;
    event.waitUntil(save());
  }
  if (name === NETWORK) return fetch(req);
  return (await (await caches.open(name)).match(key)) || fetch(req);
}

// a client this worker doesn't serve from a copy
const NETWORK = 'network';

async function copyFor(id) {
  if (state.pins[id]) return state.pins[id];
  const client = id && (await self.clients.get(id));
  if (client?.type === 'window') {
    // A page this worker doesn't control still sends it its workers' requests (they are matched
    // by URL); like the page, they go to the network. A page it does control has lost its pin.
    const controlled = (await self.clients.matchAll({ type: 'window' })).some((c) => c.id === id);
    return controlled ? state.current : NETWORK;
  }
  // a worker whose browser didn't say which client its script request created: most likely
  // started a moment ago, by whoever last started one
  return lastWorkerCopy || state.current;
}

async function desmos(event) {
  await current();
  const hit = state.desmos.includes(event.request.url) && (await (await caches.open(DESMOS_CACHE)).match(event.request.url, { ignoreVary: true }));
  return hit || fetch(event.request);
}

// ---------------------------------------------------------------- after a visit

let checking = null;
function afterVisit() {
  return (checking ||= (async () => {
    try {
      await new Promise((r) => setTimeout(r, 2000)); // let the page start first
      // forget clients that are gone, and the copies nothing uses any more
      const live = new Set((await self.clients.matchAll({ type: 'all' })).map((c) => c.id));
      for (const id of Object.keys(state.pins)) if (!live.has(id)) delete state.pins[id];
      await save();
      const keep = new Set([state.current, state.next, state.previous, ...Object.values(state.pins)]);
      for (const k of await caches.keys()) if (k.startsWith(PREFIX + 'app-') && !keep.has(k)) await caches.delete(k);
      // has the site changed since the newest copy was taken?
      const copy = await take();
      if (!(await matches(state.next || state.current, copy))) {
        if (!sameCopy(copy, await take())) return;
        state.next = await store(copy);
        await save();
      }
      await refreshDesmos();
    } catch {
      // offline, or the site answered oddly: try again after the next visit
    } finally {
      checking = null;
    }
  })());
}
