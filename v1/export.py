#!/usr/bin/env python3
"""Render <clip>.js through Desmos and encode the result as an mp4 (with the source audio).

Usage:
  python3 export.py [--clip source] [--out <clip>_desmos.mp4] [--width 1280] [--height 720] [--invert] [--no-audio] [--no-open]

Starts a local server, opens player.html in export mode in your browser, receives one
Desmos screenshot per frame, then runs ffmpeg. Keep the browser tab visible while it runs.
"""
import argparse
import json
import shutil
import subprocess
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent


def load_meta(path):
    s = path.read_text()
    d = json.loads(s[s.index("=") + 1:s.rindex(";")])
    return {k: d.get(k) for k in ("fps", "width", "height", "source", "start")} | {
        "n": len(d["frames"]), "color": bool(d.get("palette"))}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clip", default="source", help="clip name: reads <clip>.js from convert.py")
    ap.add_argument("--out", help="output mp4 (default: <clip>_desmos.mp4)")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--invert", action="store_true", help="white lines on black")
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser; just print the URL")
    ap.add_argument("--port", type=int, default=8766)
    args = ap.parse_args()

    args.out = args.out or f"{args.clip}_desmos.mp4"
    meta = load_meta(ROOT / f"{args.clip}.js")
    frames_dir = ROOT / "export_frames"
    shutil.rmtree(frames_dir, ignore_errors=True)
    frames_dir.mkdir()
    done = threading.Event()
    received = set()

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            url = urlparse(self.path)
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if url.path == "/frame":
                i = int(parse_qs(url.query)["i"][0])
                (frames_dir / f"{i:05d}.png").write_bytes(body)
                received.add(i)
                print(f"\rframe {len(received)}/{meta['n']}", end="", flush=True)
            elif url.path == "/done":
                done.set()
            self.send_response(204)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    q = f"clip={args.clip}&export=1&w={args.width}&h={args.height}" + ("&invert=1" if args.invert else "")
    url = f"http://localhost:{args.port}/player.html?{q}"
    print(f"rendering {meta['n']} frames via {url}")
    if not args.no_open:
        webbrowser.open(url)
    done.wait()
    server.shutdown()
    print()
    if len(received) != meta["n"]:
        sys.exit(f"only got {len(received)}/{meta['n']} frames")

    cmd = ["ffmpeg", "-v", "error", "-y", "-framerate", str(meta["fps"]), "-i", str(frames_dir / "%05d.png")]
    src = meta.get("source")
    audio = not args.no_audio and src and (ROOT / src).exists()
    if audio:
        cmd += ["-ss", str(meta.get("start") or 0), "-i", str(ROOT / src)]
    # Desmos screenshots are always on white. Dark output (colour mode, or --invert) is made by
    # negating the frames; for colour the player drew the inverted palette so colours come out right.
    vf = f"scale={args.width}:{args.height}" + (",negate" if meta["color"] or args.invert else "")
    cmd += ["-map", "0:v", "-vf", vf, "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p"]
    if audio:
        cmd += ["-map", "1:a?", "-shortest", "-c:a", "aac", "-b:a", "160k"]
    cmd += ["-movflags", "+faststart", args.out]
    subprocess.run(cmd, check=True)
    shutil.rmtree(frames_dir)
    print(f"wrote {args.out}" + (" (with audio)" if audio else ""))


if __name__ == "__main__":
    main()
