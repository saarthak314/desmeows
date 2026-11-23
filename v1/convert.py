#!/usr/bin/env python3
"""Turn an mp4 into per-frame polylines that the Desmos player can draw.

Usage:
  .venv/bin/python convert.py input.mp4 [--fps 12] [--width 640] [--mode edges|silhouette] [--detail 90] [--colors 12]
                                        [--epsilon 1.0] [--min-len 10] [--max-points 6000]
                                        [--start 0] [--duration 0] [--out <name>.js]

Writes <name>.js (window.DESMOS_FRAMES = {...}); view it at player.html?clip=<name>.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from skimage.morphology import skeletonize


def probe_size(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", path,
    ]).decode().strip().split(",")
    return int(out[0]), int(out[1])


def read_frames(path, fps, width, start, duration):
    src_w, src_h = probe_size(path)
    height = round(src_h * width / src_w / 2) * 2
    cmd = ["ffmpeg", "-v", "error"]
    if start:
        cmd += ["-ss", str(start)]
    cmd += ["-i", path]
    if duration:
        cmd += ["-t", str(duration)]
    cmd += ["-vf", f"fps={fps},scale={width}:{height}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = width * height * 3
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        yield np.frombuffer(buf, np.uint8).reshape(height, width, 3)
    proc.wait()


# 8-neighbourhood, orthogonal first so walks prefer straight steps over diagonals.
NEIGHBOURS = [(0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)]


def edge_map(bgr, pct=90):
    """1px-wide edge skeleton. Edges are found per Lab channel so colour boundaries
    (red on black) count, not just brightness, with thresholds adapted to each frame."""
    # Bilateral smoothing flattens shading/texture but keeps the hard ink lines of animation.
    smooth = cv2.bilateralFilter(bgr, 7, 40, 7)
    out = np.zeros(bgr.shape[:2], bool)
    for ch in cv2.split(cv2.cvtColor(smooth, cv2.COLOR_BGR2LAB)):
        mag = np.hypot(cv2.Sobel(ch, cv2.CV_32F, 1, 0), cv2.Sobel(ch, cv2.CV_32F, 0, 1))
        hi = max(float(np.percentile(mag, pct)), 40)
        out |= cv2.Canny(ch, hi * 0.4, hi, L2gradient=True) > 0
    # Canny is mostly 1px wide but has 2px blobs at corners; skeletonize makes every line 1px.
    return skeletonize(out)


def trace_paths(skel):
    """Walk a 1px skeleton into open polylines (centerlines), one per stroke segment."""
    h, w = skel.shape
    on = skel.copy()

    def nbrs(y, x):
        for dy, dx in NEIGHBOURS:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and on[ny, nx]:
                yield ny, nx

    def walk(y, x):
        path = [(x, y)]
        on[y, x] = False
        while True:
            nxt = next(nbrs(y, x), None)
            if nxt is None:
                return path
            y, x = nxt
            on[y, x] = False
            path.append((x, y))

    ys, xs = np.nonzero(skel)
    pixels = list(zip(ys.tolist(), xs.tolist()))
    # Start from stroke endpoints first so open lines come out as one piece, not split mid-way.
    degree = {p: sum(1 for _ in nbrs(*p)) for p in pixels}
    paths = []
    for p in sorted(pixels, key=lambda p: degree[p] != 1):
        if on[p]:
            paths.append(walk(*p))
    return paths


def frame_paths(bgr, mode, pct):
    """Return a list of (Nx2 int array, closed) curves in image coordinates."""
    if mode == "edges":
        return [(np.array(p, np.int32), False) for p in trace_paths(edge_map(bgr, pct))]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, img = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Draw the minority colour as the shape so backgrounds don't become one big outline.
    if np.count_nonzero(img) > img.size / 2:
        img = 255 - img
    contours, _ = cv2.findContours(img, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    return [(c.reshape(-1, 2), True) for c in contours]


# 5x5 neighbourhood offsets used to look at both sides of a line when picking its colour.
_OFF = np.array([(dx, dy) for dy in range(-2, 3) for dx in range(-2, 3)])


def curve_color(bgr, c):
    """Colour of the thing a line outlines: the brighter pixels around it, since the
    other side is usually dark background or ink."""
    h, w = bgr.shape[:2]
    pts = c[:: max(1, len(c) // 100)]
    xy = (pts[:, None, :] + _OFF[None]).reshape(-1, 2)
    cols = bgr[np.clip(xy[:, 1], 0, h - 1), np.clip(xy[:, 0], 0, w - 1)].astype(np.float32)
    lum = cols @ np.array([0.114, 0.587, 0.299], np.float32)
    top = cols[lum >= np.percentile(lum, 70)]
    return top.mean(axis=0)


def simplify(curves, bgr, epsilon, min_len, max_points):
    """Return [(points in Desmos coords, bgr colour)], longest first, within the point budget."""
    height = bgr.shape[0]
    polys = []
    for c, closed in curves:
        c3 = c.reshape(-1, 1, 2)
        if cv2.arcLength(c3, closed) < min_len:
            continue
        approx = cv2.approxPolyDP(c3, epsilon, closed).reshape(-1, 2)
        if len(approx) < 2:
            continue
        pts = [[int(x), int(height - y)] for x, y in approx]
        if closed or (len(pts) > 2 and abs(pts[0][0] - pts[-1][0]) <= 1 and abs(pts[0][1] - pts[-1][1]) <= 1):
            pts.append(pts[0])  # close the loop
        polys.append((pts, curve_color(bgr, c)))
    # Keep the longest curves if we're over the per-frame point budget.
    polys.sort(key=lambda p: len(p[0]), reverse=True)
    kept, total = [], 0
    for p in polys:
        if total + len(p[0]) > max_points:
            break
        kept.append(p)
        total += len(p[0])
    return kept


def build_palette(colors, k):
    """Cluster every curve colour in the clip into k shared colours (one Desmos expression
    each), then lift dark ones so they read on a black background. Returns (hex list, labels)."""
    lab = cv2.cvtColor(np.array(colors, np.float32)[None] / 255, cv2.COLOR_BGR2LAB)[0]
    k = min(k, len(lab))
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.5)
    _, labels, centers = cv2.kmeans(lab, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    bgr = cv2.cvtColor(centers[None].astype(np.float32), cv2.COLOR_LAB2BGR)[0]
    hsv = cv2.cvtColor(np.clip(bgr, 0, 1)[None], cv2.COLOR_BGR2HSV)[0]
    hsv[:, 1] = np.clip(hsv[:, 1] * 1.25, 0, 1)
    hsv[:, 2] = np.maximum(hsv[:, 2], 0.6)
    out = cv2.cvtColor(hsv[None], cv2.COLOR_HSV2BGR)[0]
    hexes = ["#%02x%02x%02x" % tuple(int(round(v * 255)) for v in c[::-1]) for c in out]
    return hexes, labels.ravel().tolist()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("--fps", type=float, default=12)
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--mode", choices=["edges", "silhouette"], default="edges")
    ap.add_argument("--detail", type=float, default=90, help="edge threshold percentile (lower = more lines)")
    ap.add_argument("--epsilon", type=float, default=1.0, help="simplification tolerance in px (higher = fewer points)")
    ap.add_argument("--min-len", type=float, default=10, help="drop contours shorter than this (px)")
    ap.add_argument("--max-points", type=int, default=6000, help="point budget per frame")
    ap.add_argument("--colors", type=int, default=12, help="palette size for coloured lines (0 = black only)")
    ap.add_argument("--start", type=float, default=0, help="start time in seconds")
    ap.add_argument("--duration", type=float, default=0, help="seconds to convert (0 = all)")
    ap.add_argument("--out", help="output .js (default: <input name>.js, played with player.html?clip=<input name>)")
    args = ap.parse_args()
    args.out = args.out or str(Path(args.input).with_suffix(".js").name)

    frames, curve_colors, height = [], [], None
    for i, bgr in enumerate(read_frames(args.input, args.fps, args.width, args.start, args.duration)):
        height = bgr.shape[0]
        polys = simplify(frame_paths(bgr, args.mode, args.detail), bgr, args.epsilon, args.min_len, args.max_points)
        frames.append([p for p, _ in polys])
        curve_colors.extend(c for _, c in polys)
        npts = sum(len(p) for p in polys)
        print(f"\rframe {i + 1}: {len(polys)} curves, {npts} points   ", end="", file=sys.stderr)
    print(file=sys.stderr)
    if not frames:
        sys.exit("no frames decoded")

    data = {"fps": args.fps, "width": args.width, "height": height,
            "source": args.input, "start": args.start, "frames": frames}
    if args.colors and curve_colors:
        # Per frame, a palette index for each curve (parallel to frames[i]).
        data["palette"], labels = build_palette(curve_colors, args.colors)
        it = iter(labels)
        data["colors"] = [[next(it) for _ in f] for f in frames]
    with open(args.out, "w") as f:
        f.write("window.DESMOS_FRAMES = ")
        json.dump(data, f, separators=(",", ":"))
        f.write(";\n")
    print(f"wrote {len(frames)} frames to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
