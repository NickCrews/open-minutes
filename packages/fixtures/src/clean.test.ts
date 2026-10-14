import { describe, expect, it } from "vitest";
import { cleanGoldenSegments } from "./clean";

describe("cleanGoldenSegments", () => {
  it("cleans each speaker separately and drops emptied segments", async () => {
    const { segments, fixed } = await cleanGoldenSegments([
      {
        speaker: { kind: "identified", person: "a" },
        words: [{ text: "Um.", start: 1 }],
      },
      {
        speaker: { kind: "segmented", cluster: 2 },
        words: [
          { text: "Uh,", start: 2 },
          { text: "the", start: 2.2 },
          { text: "the", start: 2.4 },
          { text: "budget.", start: 2.6 },
        ],
      },
    ]);
    expect(segments).toEqual([
      {
        speaker: { kind: "segmented", cluster: 2 },
        words: [
          { text: "The", start: 2.4 },
          { text: "budget.", start: 2.6 },
        ],
      },
    ]);
    expect(fixed.map((v) => v.code)).toEqual([
      "unclean-word",
      "unclean-word",
      "unclean-word",
    ]);
  });

  it("returns clean segments as given", async () => {
    const given = [
      {
        speaker: { kind: "unlabeled" } as const,
        words: [{ text: "Yes.", start: 1 }],
      },
    ];
    expect(await cleanGoldenSegments(given)).toEqual({
      segments: given,
      fixed: [],
    });
    expect((await cleanGoldenSegments(given)).segments).toBe(given);
  });
});
