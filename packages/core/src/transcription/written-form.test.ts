import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "./types";
import {
  findWrittenFormIssues,
  spelledNumbers,
  splitNumerals,
} from "./written-form";

/** Words from a sentence, a third of a second apart. */
function words(sentence: string): TranscriptWord[] {
  return sentence.split(" ").map((text, i) => ({ text, start: i / 3 }));
}

/** `rule: text` for each issue in a sentence. */
const found = (sentence: string) =>
  findWrittenFormIssues(words(sentence)).map((i) => `${i.rule}: ${i.text}`);

const spelled = (sentence: string) =>
  [...spelledNumbers(words(sentence)), ...splitNumerals(words(sentence))].map(
    (i) => i.text,
  );

describe("findWrittenFormIssues", () => {
  it("accepts the house style", () => {
    for (const s of [
      "Item 14.C is AO 2026-18, an ordinance amending AMC 3.70.190.",
      "AO 2025-144(S) and AO 2025-74(S-2) and AR 2026-7.",
      "AO 2026 unnumbered, an ordinance amending chapter 21.05.",
      "Assembly memorandum AM 142-2026 has passed.",
      "AMC 25.35.060C and 21.05.040G.2.b and AS 44.62.310.",
      "Rezone from R-4 SL to R-4, near B-3 and GR-1 and CE-R-10.",
      "We meet at 7 p.m. or 11:30 a.m. tomorrow.",
      "It costs $10, or $36,000, or $1.5 million, or 6 cents.",
      "An increase of 1% or 3.79% a year.",
      "On February 17, 2026, and again on the 27th.",
      "The February one isn't out. May one of you second?",
      "Passes 5-0 on a vote of 12 to 0.",
      "We need a second, one more time.",
    ])
      expect(found(s), s).toEqual([]);
  });

  it("finds bill numbers the recognizer wrote its own way", () => {
    expect(found("AR 2026 48 and AO2026-23 and A02026-27.")).toEqual([
      "bill-number: AR 2026",
      "bill-number: AO2026-23",
      "bill-number: A02026-27.",
    ]);
    expect(found("AO 2025-144S and AR 26-36 and AM 145.")).toEqual([
      "bill-number: AO 2025-144S",
      "bill-number: AR 26-36",
      "bill-number: AM 145.",
    ]);
  });

  it("finds code sections with a dot missing, extra or spoken", () => {
    expect(found("sections 21.09050, 3.3.144 and section 2103050.")).toEqual([
      "code-section: 21.09050,",
      "code-section: 3.3.144",
      "code-section: 2103050.",
    ]);
    expect(found("section three dot seventy and six dash two")).toEqual([
      "code-section: three dot seventy",
      "code-section: six dash two",
    ]);
  });

  it("finds agenda items without dots", () => {
    expect(found("item 10 B1, then 10A1, then 14B.")).toEqual([
      "agenda-item: 10 B1,",
      "agenda-item: 10A1,",
      "agenda-item: 14B.",
    ]);
  });

  it("finds zoning districts without a hyphen", () => {
    expect(found("from R4 to R2M and GC8 but not R19.")).toEqual([
      "zoning-district: R4",
      "zoning-district: R2M",
      "zoning-district: GC8",
    ]);
  });

  it("finds times not written as 7 p.m.", () => {
    expect(found("at eleven AM, at 7 pm and at 504 p.m.")).toEqual([
      "time: eleven AM,",
      "time: 7 pm",
      "time: 504 p.m.",
    ]);
    expect(found("I am here at 10 a m sharp.")).toEqual(["time: 10 a"]);
  });

  it("finds money, percentages and dates said in words", () => {
    expect(
      found("ten dollars and 5,000 dollar and a million dollars, six cents"),
    ).toEqual([
      "money: ten dollars",
      "money: 5,000 dollar",
      "money: million dollars,",
      "money: six cents",
    ]);
    expect(found("up one percent, 50 percent")).toEqual([
      "percent: one percent,",
      "percent: 50 percent",
    ]);
    expect(found("on March 24th and February nineteenth.")).toEqual([
      "date: March 24th",
      "date: February nineteenth.",
    ]);
  });
});

describe("spelledNumbers and splitNumerals", () => {
  it("finds numbers of 10 or more, and runs of number words", () => {
    expect(
      spelled(
        "AO twenty twenty six dash twenty passed on a vote of eleven to zero, five zero.",
      ),
    ).toEqual(["twenty twenty six", "twenty", "eleven", "five zero."]);
    expect(spelled("on the twenty fourth, room one fifty five.")).toEqual([
      "twenty fourth,",
      "one fifty five.",
    ]);
  });

  it("leaves small numbers, sentence starts and plain words alone", () => {
    expect(
      spelled(
        "Twenty is a lot. The first three hours, one second, one third, a few hundred people, the second one.",
      ),
    ).toEqual([]);
  });

  it("finds two numerals said as one", () => {
    expect(spelled("AR 2026 48 at 11 15 for 100 000")).toEqual([
      "2026 48",
      "11 15",
      "100 000",
    ]);
    expect(spelled("February 17, 2026 and 72, 84, 96 hours")).toEqual([]);
  });
});
