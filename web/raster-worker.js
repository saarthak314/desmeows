// Export renderer, run as a module Web Worker: draws traced frames at the output size, stamps
// the credit, and hands each back as an NV12 VideoFrame ready for the encoder, or as an
// ImageBitmap where workers have no WebCodecs. Several of these run at once, so drawing and
// colour conversion keep up with the video encoder.
//
// A worker draws on the GPU or, with cpu set, on its own thread. Chrome replays every GPU canvas
// on one thread of its GPU process, so GPU workers alone stall at a few dozen detailed frames a
// second, while CPU workers scale with cores. Either way the frame is converted to YUV here:
// an encoder fed RGB frames from memory writes full-range video, which some players show
// washed out, and one fed a mix of GPU and memory frames restarts with new settings mid-stream.
//
// Live playback (reel.js) uses the same worker with `bitmaps` set: frames come back as
// ImageBitmaps at the screen's size, to be shown as they are.
import { rasterize } from './render.js';

let ctx = null, mem = null, job = null, pixels = null;
const asFrames = typeof VideoFrame === 'function';

// what the encoder writes into the file: BT.709, limited range, as Chrome tags canvas frames
const COLOR = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false };

// a failure is rethrown outside the promise so it reaches the pool as a worker error
self.onmessage = ({ data }) => { draw(data).catch((err) => setTimeout(() => { throw err; })); };

async function draw(data) {
  if (data.type === 'init') {
    // { W, H, style, outW, outH, fps, cpu, credit: { light, dark, x, y } | null, bitmaps }
    job = data;
    job.asBitmaps = !!job.bitmaps || !asFrames;
    ctx = new OffscreenCanvas(job.outW, job.outH).getContext('2d', { alpha: false, willReadFrequently: job.cpu });
    // GPU frames are read back through a CPU canvas: reading a GPU canvas directly every frame
    // makes Chrome move it to the CPU for good
    mem = job.cpu || job.asBitmaps ? ctx : new OffscreenCanvas(job.outW, job.outH).getContext('2d', { alpha: false, willReadFrequently: true });
    self.postMessage({ frames: !job.asBitmaps });
    return;
  }
  const { i, frame, bright } = data;
  const { outW, outH, credit } = job;
  rasterize(ctx, frame, job.style, job.W, job.H, outW / job.W);
  if (credit) ctx.drawImage(bright ? credit.dark : credit.light, credit.x, credit.y);
  if (job.asBitmaps) {
    const bitmap = ctx.canvas.transferToImageBitmap();
    self.postMessage({ i, bitmap }, [bitmap]);
    return;
  }
  if (mem !== ctx) mem.drawImage(ctx.canvas, 0, 0);
  // copied into one buffer kept for every frame (getImageData would allocate a new one each time)
  const snap = new VideoFrame(mem.canvas, { timestamp: 0 });
  pixels ||= new Uint8Array(snap.allocationSize());
  await snap.copyTo(pixels);
  const bgr = /^BGR/.test(snap.format);
  snap.close();
  const nv12 = toNV12(pixels, outW, outH, bgr);
  const out = new VideoFrame(nv12, {
    format: 'NV12', codedWidth: outW, codedHeight: outH, colorSpace: COLOR,
    timestamp: Math.round(i * 1e6 / job.fps), duration: Math.round(1e6 / job.fps), transfer: [nv12.buffer],
  });
  self.postMessage({ i, frame: out }, [out]);
}

// RGBA or BGRA -> NV12 (a Y plane, then interleaved U and V at half size), BT.709 limited range,
// in 16-bit fixed point. w and h are even (the export sizes are). Pixels are read as one
// little-endian word each.
const YR = 11966, YG = 40254, YB = 4064;     // 0.2126, 0.7152, 0.0722 of 219/255
const UR = -6596, UG = -22188, UB = 28784;   // Cb: (B - Y) / 1.8556, of 224/255
const VR = 28784, VG = -26145, VB = -2639;   // Cr: (R - Y) / 1.5748, of 224/255
function toNV12(bytes, w, h, bgr) {
  const px = new Uint32Array(bytes.buffer, bytes.byteOffset, w * h);
  const rs = bgr ? 16 : 0, bs = bgr ? 0 : 16;
  const out = new Uint8Array(w * h * 3 / 2);
  let uv = w * h;
  for (let y = 0; y < h; y += 2) {
    for (let a = y * w, b = a + w, end = a + w; a < end; a += 2, b += 2) {
      const p0 = px[a], p1 = px[a + 1], p2 = px[b], p3 = px[b + 1];
      const r0 = (p0 >> rs) & 255, g0 = (p0 >> 8) & 255, b0 = (p0 >> bs) & 255;
      const r1 = (p1 >> rs) & 255, g1 = (p1 >> 8) & 255, b1 = (p1 >> bs) & 255;
      const r2 = (p2 >> rs) & 255, g2 = (p2 >> 8) & 255, b2 = (p2 >> bs) & 255;
      const r3 = (p3 >> rs) & 255, g3 = (p3 >> 8) & 255, b3 = (p3 >> bs) & 255;
      out[a] = (YR * r0 + YG * g0 + YB * b0 + 0x108000) >> 16;
      out[a + 1] = (YR * r1 + YG * g1 + YB * b1 + 0x108000) >> 16;
      out[b] = (YR * r2 + YG * g2 + YB * b2 + 0x108000) >> 16;
      out[b + 1] = (YR * r3 + YG * g3 + YB * b3 + 0x108000) >> 16;
      // chroma from the 2x2 block's mean
      const R = r0 + r1 + r2 + r3, G = g0 + g1 + g2 + g3, B = b0 + b1 + b2 + b3;
      out[uv++] = (UR * R + UG * G + UB * B + 0x2020000) >> 18;
      out[uv++] = (VR * R + VG * G + VB * B + 0x2020000) >> 18;
    }
  }
  return out;
}
