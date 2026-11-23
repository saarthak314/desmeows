// The tracing worker as the app runs it: tracer.js, plus reading frames out of ImageBitmaps.
// Frames arrive as GPU bitmaps (scaled by the decoder's canvas, transferred zero-copy) and are
// read back here, so the synchronous GPU -> CPU round trip (about a millisecond per frame,
// whatever the size) is paid in parallel across workers instead of on the main thread.
import './tracer.js';

const trace = self.onmessage; // installed by tracer.js on import
let canvas = null, ctx = null;

function pixels(bitmap, w, h) {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    // CPU-backed from the start: a 1:1 copy then a read, the same every run
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, w, h).data;
}

self.onmessage = (e) => {
  const d = e.data;
  if (d.bitmap) {
    const rgba = pixels(d.bitmap, d.w, d.h);
    if (d.type === 'pixels') { self.postMessage({ rgba }, [rgba.buffer]); return; }
    d.rgba = rgba;
    d.bitmap = null;
  }
  trace.call(self, { data: d });
};
