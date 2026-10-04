/// <reference path="./sherpa-onnx-node.d.ts" />
// Reading and writing WAV files, so packages that hand audio to this one don't
// need sherpa-onnx themselves.
import sherpa_onnx, { type WaveForm } from "sherpa-onnx-node";

export type { WaveForm };
export const readWave = sherpa_onnx.readWave;
export const writeWave = sherpa_onnx.writeWave;
