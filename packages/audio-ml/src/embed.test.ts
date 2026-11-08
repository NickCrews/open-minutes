import { beforeAll, describe, expect, it } from "vite-plus/test";
import { halfUntranscribedRollCall } from "@open-minutes/datasets/clips";
import { slidingWindows } from "@open-minutes/core/span";
import { centroid, N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { readWav, type WaveForm } from "@open-minutes/codecs";
import { cosineSimilarity, embedSpans } from "./embed";

// CAM++ on a checked-in minute of a real meeting. In the golden, Brian
// Burnett reads the land acknowledgement until 0:06.4, and Mike Edgington
// talks from 0:28.7 to 0:50.

describe("embedSpans on the GBOS roll call", () => {
  let wave: WaveForm;

  // Downloading the embedding model on a cold cache takes longer than a
  // test's default timeout.
  beforeAll(async () => {
    wave = await readWav(halfUntranscribedRollCall().wavPath);
    await embedSpans(wave, [{ start: 0, end: 1 }]);
  }, 10 * 60_000);

  it("returns one vector per span, in the same order", async () => {
    const spans = [
      { start: 30, end: 31.5 },
      { start: 0.5, end: 2 },
      { start: 1, end: 6 },
    ];
    const embedded = await embedSpans(wave, spans);
    expect(embedded.map(({ start, end }) => ({ start, end }))).toEqual(spans);
    for (const { vector } of embedded) {
      expect(vector).toHaveLength(N_DIMENSIONS);
    }
  });

  it("gives the same result for the same audio", async () => {
    const span = [{ start: 2, end: 4 }];
    const [a] = await embedSpans(wave, span);
    const [b] = await embedSpans(wave, span);
    expect(a!.vector).toEqual(b!.vector);
  });

  it("tells two speakers apart by the centroids of their windows", async () => {
    const brian = { start: 0.2, end: 6.4 };
    const mike = { start: 30, end: 45 };
    const windows = await embedSpans(wave, slidingWindows([brian, mike]));
    const brianPrint = centroid(windows, brian)!;
    const mikePrint = centroid(windows, mike)!;
    const sims = (print: Float32Array, span: typeof brian) =>
      windows
        .filter((w) => w.start >= span.start && w.end <= span.end)
        .map((w) => cosineSimilarity(w.vector, print));
    const crossSim = cosineSimilarity(brianPrint, mikePrint);
    const ownSims = [...sims(brianPrint, brian), ...sims(mikePrint, mike)];
    // Every window is closer to its own speaker's centroid than the two
    // centroids are to each other.
    expect(Math.min(...ownSims)).toBeGreaterThan(crossSim);
  });

  it("rejects a span outside the audio or empty", async () => {
    await expect(embedSpans(wave, [{ start: 59, end: 61 }])).rejects.toThrow(
      RangeError,
    );
    await expect(embedSpans(wave, [{ start: 3, end: 3 }])).rejects.toThrow(
      RangeError,
    );
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      embedSpans(wave, [{ start: 0, end: 2 }], { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
