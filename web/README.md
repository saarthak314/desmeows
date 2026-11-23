# desmeows web app

A static site with no build step: plain ES modules, one stylesheet, self-hosted fonts.
Everything runs in the browser; the only network requests are for the page itself,
the Desmos API and the mediabunny module from jsDelivr.

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
| `raster-worker.js` | the export's drawing worker: draws a frame at the output size, stamps the credit, converts it to the encoder's YUV |
| `app.css`, `tokens.css`, `base.css` | styles: page rules, the design tokens, shared base rules |
| `fonts/` | IBM Plex Mono, Instrument Serif and a JetBrains Mono symbol subset, with their licences |
| `vercel.json`, `.vercelignore` | cache and security headers, and what stays out of a deploy |

## Loading

The first screen needs none of the heavy parts. Desmos (about 1 MB) is loaded after the
page has painted, or as soon as a file is chosen if that comes first; mediabunny is a
dynamic import, preloaded. The tracing workers' modules are preloaded too, and JS and CSS
may be cached for five minutes (`vercel.json`), so a trace's workers all start from the
browser cache instead of revalidating one after another.

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
- Playback is clocked: a late frame is skipped, never queued. While playing, the live
  graph draws each frame's largest 600 shapes (300 on touch devices); paused and
  exported frames get every shape.

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
