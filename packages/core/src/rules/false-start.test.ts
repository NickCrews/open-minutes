import { describe, expect, it } from "vite-plus/test";
import * as falseStart from "./false-start";
import { fixWith, words } from "./testing";

describe("false-start", () => {
  const run = (s: string) => fixWith(falseStart, s);

  it("drops a broken-off fragment", () => {
    expect(run("about six- sixteen units")).toBe("about sixteen units");
    expect(run("Re- reconsider it")).toBe("Reconsider it");
  });

  it("keeps hyphens that are not an abandoned word", () => {
    expect(run("pre- and post-war")).toBe("pre- and post-war");
    expect(run("two- to three-year")).toBe("two- to three-year");
    expect(run("AO twenty twenty six- twenty-three")).toBe(
      "AO twenty twenty six- twenty-three",
    );
    expect(run("we just re- We just")).toBe("we just re- We just");
    expect(run("we were about to-")).toBe("we were about to-");
    expect(run("a well-known plan")).toBe("a well-known plan");
  });

  it("reports each word it would drop", () => {
    expect(
      falseStart.rule({
        segments: [{ speaker: null, words: words("about six- sixteen units") }],
      }),
    ).toEqual([
      {
        code: "false-start",
        message: 'false-start "six-" should not be in a transcript',
        segmentIndex: 0,
        wordIndex: 1,
        atSecs: 0.3,
        text: "six-",
      },
    ]);
  });
});
