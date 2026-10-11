import { describe, expect, it } from "vitest";
import { voteWords } from "./vote";

/** Words one second apart, starting at `t0`. */
function words(text: string, t0 = 0) {
  return text
    .split(" ")
    .filter(Boolean)
    .map((t, i) => ({ text: t, start: t0 + i }));
}
const said = (ws: { text: string }[]) => ws.map((w) => w.text).join(" ");

describe("voteWords", () => {
  it("returns a single decode as is", () => {
    const vote = voteWords([words("a b c")]);
    expect(said(vote.words)).toBe("a b c");
    expect(vote.disagreements).toEqual([]);
  });

  it("takes the majority word where decodes differ", () => {
    const vote = voteWords([
      words("the dry hydrant"),
      words("the dry hydrant"),
      words("the drive hydrant"),
    ]);
    expect(said(vote.words)).toBe("the dry hydrant");
    expect(vote.disagreements).toEqual([
      { start: 1, end: 1, chosen: "dry", readings: ["dry", "drive"] },
    ]);
  });

  it("keeps words most decodes heard and one decode dropped", () => {
    const vote = voteWords([
      words("or we could wait another meeting"),
      words("or meeting"),
      words("or we could wait another meeting"),
    ]);
    expect(said(vote.words)).toBe("or we could wait another meeting");
    expect(vote.disagreements).toHaveLength(1);
    expect(vote.disagreements[0]!.readings).toEqual([
      "we could wait another",
      "",
    ]);
  });

  it("drops a word only one decode heard", () => {
    const vote = voteWords([words("a b c"), words("a x b c"), words("a b c")]);
    expect(said(vote.words)).toBe("a b c");
    expect(vote.disagreements[0]!.chosen).toBe("");
  });

  it("ignores case and punctuation when comparing", () => {
    const vote = voteWords([words("Thank you."), words("thank you")]);
    expect(vote.disagreements).toEqual([]);
  });

  it("joins neighbouring disagreements into one stretch", () => {
    const vote = voteWords([
      words("Ms. Baldwin Day. Thank you"),
      words("Ms. Baldund. Thank you"),
      words("Ms. Ballon Day. Thank you"),
    ]);
    expect(vote.disagreements).toHaveLength(1);
    expect(vote.disagreements[0]!.readings).toHaveLength(3);
  });
});
