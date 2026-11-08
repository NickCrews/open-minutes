import type { Span } from "../span";

// 3D-Speaker CAM++ (zh_en-common_advanced, via sherpa-onnx-node) produces
// 192-dimensional voice embeddings. This is the voice space only; text/lexical
// embeddings live in their own (different-dimensional) space — see schema.ts.
export const N_DIMENSIONS = 192;

/** A span and the voice embedding of the audio in it. */
export interface SpanWithEmbedding extends Span {
  /** 192-dim CAM++ (3D-Speaker common_advanced) embedding. */
  vector: Float32Array;
}

/**
 * Element-wise mean of the vectors of the spans in `embedded` that lie
 * inside `span`, such as a diarization turn's voiceprint from the sliding
 * windows in it. Null when no span lies inside it.
 */
export function centroid(
  embedded: readonly SpanWithEmbedding[],
  span: Span,
): Float32Array | null {
  const inside = embedded.filter(
    (e) => e.start >= span.start && e.end <= span.end,
  );
  const first = inside[0];
  if (!first) return null;
  const mean = new Float32Array(first.vector.length);
  for (const { vector } of inside) {
    for (let i = 0; i < mean.length; i++) mean[i]! += vector[i]!;
  }
  for (let i = 0; i < mean.length; i++) mean[i]! /= inside.length;
  return mean;
}
