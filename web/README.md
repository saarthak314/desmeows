# desmeows web app

A static site with no build step: plain ES modules, one stylesheet, self-hosted fonts.
Everything runs in the browser; the only network requests are for the page's own files
(mediabunny included, vendored under `vendor/`) and the Desmos API.

## Files

| File | What it holds |
| --- | --- |
| `index.html` | the one screen: drop zone, stage, transport and the settings sheet |
| `app.js` | the app: decoding, the worker pool, the two tracing passes, the live player, export, save as page |
| `frame-worker.js` | the tracing worker: reads a frame out of the GPU bitmap it is sent, has it held by the stabiliser, then runs `tracer.js`; also the stabiliser's own worker |
| `stabilise.js` | the stabiliser: holds still parts of each frame exactly as they were, and keeps palette labels from crawling |
| `tracer.js` | the tracer, one frame per message |
| `palette.js` | scene-cut detection, k-means palettes in Lab, the 32×32×32 colour lookup |
| `render.js` | turns a traced frame into Desmos expressions, or draws it straight onto a canvas; shared by the player, the exporter and saved pages |
| `raster-worker.js` | the drawing worker: draws a frame at the output size; for the export it stamps the credit and converts to the encoder's YUV, for playback it returns a bitmap |
| `reel.js` | smooth playback: frames drawn ahead of the playhead by drawing workers, shown over the graph |
| `sw.js` | the service worker: later visits start from a stored copy of the app and Desmos (see Loading) |
| `vendor/` | mediabunny 1.65.2, as published, with its licence |
| `app.css`, `tokens.css`, `base.css` | styles: page rules, the design tokens, shared base rules |
| `fonts/` | IBM Plex Mono, Instrument Serif and a JetBrains Mono symbol subset, with their licences |
| `vercel.json`, `.vercelignore` | cache and security headers, and what stays out of a deploy |

## Loading

The first screen needs index.html, the three stylesheets, three fonts and app.js with its two
imports, all from this origin and all preloaded; nothing heavy holds it up.

- **mediabunny** is vendored: `vendor/mediabunny-1.65.2/mediabunny.min.mjs` is the npm
  package's `dist/bundles/mediabunny.min.mjs`, byte for byte, with its MPL-2.0 licence beside
  it. It comes over the page's own connection and is cached for a year (the version is in the
  path). It is preloaded and imported dynamically, and nothing may import it statically: a
  static import makes app.js, and so the file picker, wait for its 150 KB.
- **Desmos** (about 1 MB, behind a redirect to the current v1.11.x) is the longest download
  and a trace waits for it, so index.html preloads it at low priority from the start; app.js
  runs it once the page and mediabunny are in, or as soon as a file is chosen. Its URL (with
  the API key) is in both files and must match, or it is fetched twice.
- The tracing workers' modules are preloaded too. `vercel.json` lets JS and CSS stay fresh
  for five minutes, but in production that rarely holds: Vercel's CDN sends an `Age` header
  (often hours), so the browser counts them stale on arrival and revalidates every use,
  including each trace worker's three module imports, one after another.

Everything after the first page load comes from `sw.js`, a service worker registered once the
first visit has fetched Desmos (so installing it copies from the browser cache instead of
downloading again). It keeps a whole copy of the app (every file in its `APP` list, fetched
twice and kept only if both rounds agree), the fonts and mediabunny (`FIXED`, whose names never
change), and the Desmos script, and serves pages and their workers from them without waiting
on the network; it works offline too. Each page, and every worker it starts, stays on the copy
it opened with. The first page is taken over as soon as the worker is installed, but only if
every script and stylesheet it loaded is the same in the copy and no other page is open;
otherwise it and its workers stay on the network. After each visit the worker compares the
copy with the site, and if anything changed takes a new whole copy for the next visit: the
first visit after a deploy still runs the previous version, never a mix of the two. A new file
the app loads belongs in `APP` (left out, it still loads, from the network). To turn the
worker off, set `OFF = true` in `sw.js` and deploy: each browser's next visit deletes its
caches and unregisters it; the registration at the end of index.html can then go too.

Measured in headless Chrome against the bench's Vercel-like server (Desmos from desmos.com),
cold, with DevTools' network profiles and the CPU slowed 4x; medians of 2 to 4 runs:

| | Fast 4G | Slow 4G |
| --- | --- | --- |
| first paint | 0.46 → 0.50 s | 1.48 → 1.50 s |
| file picker works | 0.72 → 0.45 s | 2.51 → 1.72 s |
| Desmos ready | 2.86 → 2.42 s | 10.2 → 8.7 s |
| file chosen and Trace clicked at once: first traced frame | 3.0 → 2.6 s | 10.4 → 9.0 s |
| Trace clicked once everything is in, production caching: click to first traced frame | 3.3 → 0.7 s | 10.8 → 0.6 s |
| repeat visit: first paint | 0.22 → 0.07 s | 0.64 → 0.08 s |
| repeat visit: Desmos ready | 0.61 → 0.42 s | 1.01 → 0.43 s |

## Pipeline

Two passes run at the same time and meet at scene boundaries.

**Reading: scenes and palettes.** Every frame is decoded at 160 px wide. A cut is a jump
in both the colour histogram and the pixels between neighbouring frames. As soon as a
scene's last frame is read, its k-means palette in Lab colour space is mixed in the
worker pool and sent to the stabilisers as a 5-bit RGB lookup table. One palette per
scene keeps region boundaries steady from frame to frame instead of flickering. These
thumbnails are decoded in software: the tracing pass waits on the scenes this pass
finds, and if both drew on the GPU's limited decoder surfaces they could starve each
other.

**Tracing.** Frames are decoded at trace size, scaled on the GPU, snapshotted as
`ImageBitmap`s and transferred to a pool of workers (every core but one, at most 16), a
few in flight per worker. Each worker reads its frame back itself, so the GPU round trip
(about a millisecond a frame) never blocks the page. A frame waits only until its
scene's palette is out. If no frame is read or traced for 30 seconds (a decoder that
stopped answering), the trace ends with an error instead of waiting forever. The same
video traces to the same shapes every time.

**Stabilising.** Traced alone, every frame re-cuts its regions and edges from scratch,
so compression noise and slight drift make still parts of the picture boil: boundaries
jitter, small regions pop, colours shimmer, ink comes and goes. So before a frame is
traced, it goes through the stabiliser (`stabilise.js`), which sees every frame in order
and remembers the last:

- A pixel keeps the value it was last given until the picture around it really changes
  (the mean change over its 5×5 neighbourhood, or its own change, passes a threshold);
  then it takes the new value. Still areas reach the tracer exactly as they were, so they
  trace exactly the same; moving ones pass straight through. It starts afresh at every
  scene cut.
- For paint, it also gives each pixel its palette colour, and a pixel keeps last
  frame's colour while that is still nearly as close as the best one, so contours in
  gradients stop crawling.

It has to see frames in order, so it can't be spread over the pool by frame; it is
spread by strip instead: two stabiliser workers each hold one half of every frame (the
halves are fixed by the frame size, so every machine gives the same output). A tracing
worker sends its frame's halves to them on channels of their own and traces the frame
once both are back. All this costs about 10% of tracing time.

- *Paint*: quantise to the scene's palette, a 3×3 majority filter against speckle,
  4-connected regions, regions under the minimum area merged into the neighbour they
  share the most border with. Each region's outer boundary is walked along pixel cracks,
  smoothed by taking the midpoints of its unit edges (neighbours share cracks, so they
  share midpoints), and simplified with Douglas–Peucker. Each region is filled with
  the median of its true colours, channel by channel, not the palette colour: as true as
  the mean, and it holds still while a few pixels at the region's edge come and go.
  Shapes are stored largest enclosing area first, so drawing them in order paints every
  hole with whatever sits inside it.
- *Ink*: a bilateral filter, Canny edges on each Lab channel, Zhang–Suen thinning,
  then the skeleton is walked into centerlines from stroke endpoints and simplified 16 px
  cell by cell (so a change at one end of a line doesn't shift vertices all along it).
  Over paint, a line is kept only if it is clearly darker than what it borders, so
  shading edges are left to the fills.
- *Lines*: the same edges, coloured from their bright side, on black.

Every coordinate this produces is a multiple of half a pixel, so shapes are stored as
16-bit integers in half-pixel units: exact, and half the memory of floats.

## Drawing in Desmos

Every shape is one element of a polygon list, coloured from a parallel `rgb()` list.
Lines are zero-area polygons that go out and back, so only their outline shows. Notes
that shaped `render.js`:

- The graph's axes are set in half-pixel units (`bounds()` in `render.js`), so Desmos is
  given plain integers.
- Per-element colours only work through `colorLatex` set in the graph state, so the
  slots are created once with `setState` and only their latex changes per frame.
- A Desmos list holds at most 10,000 items, so each layer is split into chunks of 8,000
  across fixed slots: 8 for fills, 4 for lines.
- The API build has no `segment()`, hence the out-and-back polygons.
- `Painter` sends only expressions whose latex changed since the last frame.
- Desmos can't redraw thousands of shapes 30 times a second, so playback doesn't ask it
  to. While a clip plays or is scrubbed, `reel.js` has three drawing workers (two on the
  GPU, one on a CPU thread) draw the next frames at the screen's pixel size, every shape,
  with the same renderer as the export, and shows them on a canvas over the graph. When
  playback stops, the frame goes back to the graph, and the canvas is taken away only
  once Desmos has drawn it. Playback is clocked: a late frame is skipped, never queued.
  A clip can be played while it traces; playback starts once half a second is traced
  and holds at the last traced frame if it catches up. Browsers without `OffscreenCanvas`
  play through the graph itself, which then draws each frame's largest 600 shapes (300
  on touch devices).

## Export

The graph is vector, so it can render above the source resolution: the size picker
offers 720p to 4K, whichever the browser can encode. Two renderers, chosen under
*drawn by*:

- *direct* (the default) draws the same polygons, colours and line widths Desmos is
  given straight onto a canvas, with no Desmos parse, evaluate and screenshot round
  trip. Several `raster-worker.js` workers draw at once, a few on the GPU and the rest on
  CPU threads (Chrome replays every GPU canvas on one thread, so CPU workers are what
  scale with cores). Each stamps the credit and converts its frame to the encoder's YUV
  itself, so the page only hands frames to the encoder, in order. Its frames match
  Desmos's own to within anti-aliasing.
- *desmos* draws each frame in a hidden calculator and captures it with
  `asyncScreenshot`, for a video drawn by the calculator itself. It is much slower.

Frames are encoded to H.264 through WebCodecs at about 0.16 bits per pixel, the
source's audio packets are copied across without re-encoding, and mediabunny writes the
mp4. Every export and saved page carries the "desmeows" credit, bottom right, which
switches to dark ink over bright corners.

*Save as page* writes a single HTML file: the traced frames as stored,
`render.js` inlined, and a small player.

## Settings in the URL

`style` (`paint`, `lines`), `fidelity` (`draft`, `fine`, `max`, `limit`), `fps`
(`source`, `24`, `12`), `ink=off`, `size` (`720p` … `4K`), `renderer=desmos`. The
defaults are left out. `debug` exposes the app's state on
`window.__desmeows`, for benchmarking.

| Fidelity | Trace width | Colours a scene | Smallest region | Simplify (px) |
| --- | --- | --- | --- | --- |
| draft | 480 | 32 | 16 px | 0.9 |
| fine | 640 | 64 | 8 px | 0.7 |
| max | 960 | 128 | 4 px | 0.6 |
| limit | 1280 | 255 | 2 px | 0.5 |

The trace width never exceeds the source's width.

## Run it

Module workers need a server; opening `index.html` from disk will not work.

```bash
python3 -m http.server 8780 --directory web
```

Then open `http://localhost:8780`.

## Browser support

Decoding needs WebCodecs (a current Chrome, Edge, Firefox or Safari). The mp4 export
also needs an H.264 encoder in WebCodecs; where there is none, the export button is
off and *save as page* still works.
