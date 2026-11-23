// Export renderer, run as a module Web Worker: draws one traced frame onto an OffscreenCanvas
// at the output size and hands it back as a zero-copy ImageBitmap. Several of these run at
// once so drawing keeps up with the video encoder, which is the one serial step left.
import { rasterize } from './render.js';

let canvas = null, ctx = null;

self.onmessage = ({ data }) => {
  const { i, frame, style, W, H, outW, outH } = data;
  if (!canvas || canvas.width !== outW || canvas.height !== outH) {
    canvas = new OffscreenCanvas(outW, outH);
    ctx = canvas.getContext('2d', { alpha: false });
  }
  rasterize(ctx, frame, style, W, H, outW / W);
  const bitmap = canvas.transferToImageBitmap();
  self.postMessage({ i, bitmap }, [bitmap]);
};
