import { parentPort } from "worker_threads";
import jpeg from "jpeg-js";

interface DecodeRequest {
  camera: 1 | 2;
  jpeg: Uint8Array;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbaToI420(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const ySize = width * height;
  const uvSize = ySize / 4;
  const output = new Uint8Array(ySize + uvSize * 2);
  const uOffset = ySize;
  const vOffset = ySize + uvSize;

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const rgbaOffset = (row * width + column) * 4;
      const red = rgba[rgbaOffset];
      const green = rgba[rgbaOffset + 1];
      const blue = rgba[rgbaOffset + 2];
      output[row * width + column] = clampByte(16 + 0.257 * red + 0.504 * green + 0.098 * blue);
    }
  }

  for (let row = 0; row < height; row += 2) {
    for (let column = 0; column < width; column += 2) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const offset = ((row + dy) * width + column + dx) * 4;
          red += rgba[offset];
          green += rgba[offset + 1];
          blue += rgba[offset + 2];
        }
      }
      red /= 4;
      green /= 4;
      blue /= 4;
      const uvOffset = (row / 2) * (width / 2) + column / 2;
      output[uOffset + uvOffset] = clampByte(128 - 0.148 * red - 0.291 * green + 0.439 * blue);
      output[vOffset + uvOffset] = clampByte(128 + 0.439 * red - 0.368 * green - 0.071 * blue);
    }
  }
  return output;
}

if (!parentPort) throw new Error("videoFrameDecoder must run in a worker thread");

parentPort.on("message", ({ camera, jpeg: jpegFrame }: DecodeRequest) => {
  try {
    const decoded = jpeg.decode(jpegFrame, { useTArray: true, formatAsRGBA: true });
    const width = decoded.width - (decoded.width % 2);
    const height = decoded.height - (decoded.height % 2);
    if (width < 2 || height < 2) throw new Error("decoded frame is empty");

    let rgba = decoded.data;
    if (width !== decoded.width || height !== decoded.height) {
      rgba = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row += 1) {
        const sourceStart = row * decoded.width * 4;
        rgba.set(decoded.data.subarray(sourceStart, sourceStart + width * 4), row * width * 4);
      }
    }
    const data = rgbaToI420(rgba, width, height);
    parentPort?.postMessage({ camera, width, height, data }, [data.buffer]);
  } catch {
    parentPort?.postMessage({ camera, error: true });
  }
});
