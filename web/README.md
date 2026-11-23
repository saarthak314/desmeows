# desmeows web app

A static site with no build step: plain ES modules, one stylesheet, self-hosted fonts.
Everything runs in the browser; the only network requests are for the page itself,
the Desmos API and the mediabunny module from jsDelivr.

## Files

| File | What it holds |
| --- | --- |
| `index.html` | the one screen: drop zone, stage, transport and the settings sheet |
| `app.js` | the app: decoding, the worker pool, the two tracing passes, the live player, export, save as page |
| `tracer.js` | the tracer, run as a module Web Worker, one frame per message |
| `palette.js` | scene-cut detection, k-means palettes in Lab, the 32×32×32 colour lookup |
| `render.js` | turns a traced frame into Desmos expressions; shared by the player, the exporter and saved pages |
| `app.css`, `tokens.css`, `base.css` | styles: page rules, the design tokens, shared base rules |
| `fonts/` | IBM Plex Mono, Instrument Serif and a JetBrains Mono symbol subset, with their licences |
| `vercel.json`, `.vercelignore` | cache and security headers, and what stays out of a deploy |

## Pipeline

**Pass 1, scenes and palettes.** Every frame is decoded at 160 px wide. A cut is a jump
in both the colour histogram and the pixels between neighbouring frames. Each scene
gets its own k-means palette in Lab colour space, computed in the workers and turned
into a 5-bit RGB lookup table. One palette per scene keeps region boundaries steady
from frame to frame instead of flickering.

**Pass 2, tracing.** Frames are decoded at trace size and sent to a pool of workers
(one fewer than the CPU's cores, at most eight), a few in flight per worker.

- *Paint*: quantise to the scene's palette, a 3×3 majority filter against speckle,
  4-connected regions, regions under the minimum area merged into the neighbour they
  share the most border with. Each region's outer boundary is walked along pixel cracks,
  smoothed by taking the midpoints of its unit edges (neighbours share cracks, so they
  share midpoints), and simplified with Douglas–Peucker. Each region is filled with
  its true mean colour, not the palette colour. Shapes are stored largest enclosing area
  first, so drawing them in order paints every hole with whatever sits inside it.
- *Ink*: a bilateral filter, Canny edges on each Lab channel, Zhang–Suen thinning,
  then the skeleton is walked into centerlines from stroke endpoints. Over paint, a line
  is kept only if it is clearly darker than what it borders, so shading edges are
  left to the fills.
- *Lines*: the same edges, coloured from their bright side, on black.

## Drawing in Desmos

Every shape is one element of a polygon list, coloured from a parallel `rgb()` list.
Lines are zero-area polygons that go out and back, so only their outline shows. Notes
that shaped `render.js`:

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

Each frame is drawn in a hidden calculator and captured with `asyncScreenshot` at the
output size. The graph is vector, so it can render above the source resolution: the
size picker offers 720p to 4K, whichever the browser can encode. Frames are encoded
to H.264 through WebCodecs at about 0.16 bits per pixel, the source's audio packets
are copied across without re-encoding, and mediabunny writes the mp4.

*Save as page* writes a single HTML file: the traced frames at half-pixel precision,
`render.js` inlined, and a small player.

## Settings in the URL

`style` (`paint`, `lines`), `fidelity` (`draft`, `fine`, `max`, `limit`), `fps`
(`source`, `24`, `12`), `ink=off`, `size` (`720p` … `4K`). The defaults are left out.

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
