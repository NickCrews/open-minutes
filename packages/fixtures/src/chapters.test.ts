import { describe, expect, it } from "vitest";
import { parseGoldenChapters } from "./test-data";

describe("parseGoldenChapters", () => {
  const valid = {
    generation: { model: "human", prompt_version: "", reviewed_by_human: true },
    chapters: [
      {
        start: "0:00:01.50",
        end: "1:00:00.00",
        title: "All of it",
        summary: "Everything happened.",
        bullets: [],
      },
    ],
  };

  it("converts times to seconds", () => {
    expect(parseGoldenChapters(valid, "c.json").chapters[0]).toMatchObject({
      start: 1.5,
      end: 3600,
    });
  });

  it("rejects a malformed file, naming the field", () => {
    expect(() =>
      parseGoldenChapters(
        { ...valid, chapters: [{ ...valid.chapters[0], bullets: "x" }] },
        "c.json",
      ),
    ).toThrow(/c.json: chapters\[0\].bullets/);
    expect(() => parseGoldenChapters({ chapters: [] }, "c.json")).toThrow(
      /missing generation/,
    );
  });
});
