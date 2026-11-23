# desmeows v1: the python prototype

The first version of desmeows: a command-line pipeline that traces a video's edges
into coloured line art and plays it in a local Desmos page. It is kept here as the
starting point; the [web app](../web) replaced it and goes much further (filled
regions, per-scene palettes, in-browser export).

## What it does

1. `convert.py` reads the video with `ffmpeg`, finds edges per Lab colour channel
   (Canny with a per-frame threshold), thins them to 1 px centerlines, simplifies them,
   gives each line a colour from a clip-wide k-means palette, and writes
   `<name>.js`.
2. `player.html` loads that file into the Desmos API and plays it, one Desmos
   expression per palette colour per frame.
3. `export.py` serves the player in export mode, collects one Desmos screenshot per
   frame and stitches them into an mp4 with the original audio.

## Requirements

- Python 3.11 or newer
- `ffmpeg` and `ffprobe` on your `PATH`
- the packages in `requirements.txt`

```bash
cd v1
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Use

Run everything from inside `v1/`, where the player and exporter look for clips.

```bash
.venv/bin/python convert.py myclip.mp4 --fps 24 --colors 16
```

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765/player.html?clip=myclip`. Space plays and pauses,
the arrow keys step a frame.

To render the clip back to video through Desmos:

```bash
python3 export.py --clip myclip
```

It opens your browser, draws every frame, and writes `myclip_desmos.mp4`.

### convert.py options

| Option | Default | What it changes |
| --- | --- | --- |
| `--fps` | 12 | frames per second to trace |
| `--width` | 640 | trace width in pixels |
| `--mode` | `edges` | `edges` for centerlines, `silhouette` for filled-shape outlines |
| `--detail` | 90 | edge threshold percentile: lower draws more lines |
| `--colors` | 12 | palette size; `0` draws black lines |
| `--epsilon` | 1.0 | simplification tolerance in pixels |
| `--min-len` | 10 | drops lines shorter than this |
| `--max-points` | 6000 | point budget per frame |
| `--start`, `--duration` | whole clip | the part of the clip to trace |

### export.py options

`--clip`, `--width`/`--height` (default 1280×720), `--invert` for white lines on black
when there is no palette, `--no-audio`, `--no-open` to print the URL instead of opening
a browser.

## Notes

- Clips, traced `.js` files and exports in this folder are ignored by git.
- The player uses the public demo key from the Desmos API docs, which is meant for
  local testing.
