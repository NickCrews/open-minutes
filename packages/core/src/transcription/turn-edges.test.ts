import { describe, expect, it } from "vitest";
import { splitSentences } from "./turn-edges";
import type { TranscriptWord } from "./types";

/** Words at the given onsets: "word@onset" pairs separated by spaces. */
function words(spec: string): TranscriptWord[] {
  return spec.split(" ").map((pair) => {
    const [text, start] = pair.split("@");
    return { text: text!, start: Number(start) };
  });
}

function texts(ws: readonly TranscriptWord[]): string {
  return ws.map((w) => w.text).join(" ");
}

describe("splitSentences", () => {
  it("finds a sentence's first word left on the previous speaker", () => {
    const [found, ...rest] = splitSentences([
      { words: words("of@5.49 Allegiance?@5.65 I@9.33") },
      { words: words("pledge@9.49 allegiance@9.97 to@10.61") },
    ]);
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      segment: 1,
      start: 9.49,
      pause: 0.16,
      edgeStart: 9.33,
      edgePause: 3.68,
    });
    expect(texts(found!.misplaced)).toBe("I");
  });

  it("finds a sentence's last word given to the next speaker", () => {
    const [found] = splitSentences([
      { words: words("Thank@1.0") },
      { words: words("you.@1.4 I@6.28 have@6.5 a@6.6 question.@6.8") },
    ]);
    expect(found).toMatchObject({ segment: 1, edgeStart: 6.28 });
    expect(texts(found!.misplaced)).toBe("you.");
  });

  it("accepts a boundary at a sentence edge", () => {
    expect(
      splitSentences([
        { words: words("Thank@1.0 you.@1.2") },
        { words: words("Sure.@1.3") },
      ]),
    ).toEqual([]);
  });

  it("accepts a boundary already at a long pause", () => {
    expect(
      splitSentences([
        { words: words("call@1.0 the@1.2 roll@1.4") },
        { words: words("and@2.5 Myers.@2.8 Member@7.2 Johnson.@7.5") },
      ]),
    ).toEqual([]);
  });

  it("accepts a boundary where recognition started a new sentence", () => {
    expect(
      splitSentences([
        { words: words("want@1.0 to@1.2 do@1.4 in@1.6 the@1.8") },
        { words: words("Thanks.@1.9 Yeah,@2.5 just@2.7") },
      ]),
    ).toEqual([]);
  });

  it("still checks a boundary before I", () => {
    expect(
      splitSentences([
        { words: words("authority.@1.0 So@2.3") },
        { words: words("I'm@2.4 calling@2.6") },
      ]),
    ).toHaveLength(1);
  });

  it("never moves a question across a boundary", () => {
    expect(
      splitSentences([
        { words: words("call@1.0 the@1.2 roll@1.4") },
        { words: words("member@1.6 Myers?@1.9 Member@6.3 Johnson?@6.6") },
      ]),
    ).toEqual([]);
  });

  it("ignores a pause that is only slightly longer", () => {
    expect(
      splitSentences([
        { words: words("done.@1.0 So@1.4") },
        { words: words("I@1.6 think@1.8") },
      ]),
    ).toEqual([]);
  });
});
