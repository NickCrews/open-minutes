/** Mono samples in [-1, 1] and their sample rate, as the audio models take them. */
export interface WaveForm {
  samples: Float32Array;
  /** In Hz. */
  sampleRate: number;
}

/** All of `samples`, as one array. */
export async function readAllSamples(
  samples: AsyncIterable<Float32Array> | Iterable<Float32Array>,
): Promise<Float32Array> {
  const chunks: Float32Array[] = [];
  for await (const chunk of samples) chunks.push(chunk);
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}
