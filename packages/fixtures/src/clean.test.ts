import { describe, expect, it } from "vitest";
import { cleanGoldenSegments } from "./clean";

describe("cleanGoldenSegments", () => {
  it("cleans each speaker separately and drops emptied segments", () => {
    const { segments } = cleanGoldenSegments([
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
  });
});
