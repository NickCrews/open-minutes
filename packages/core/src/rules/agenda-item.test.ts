import { describe, expect, it } from "vitest";
import * as agendaItem from "./agenda-item";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(agendaItem.rule, sentence);

describe("agenda-item", () => {
  it("finds agenda items without dots", () => {
    expect(found("item 10 B1, then 10A1, then 14B.")).toEqual([
      "10 B1,",
      "10A1,",
      "14B.",
    ]);
  });

  it("accepts agenda items written the house way", () => {
    expect(found("Item 14.C is AO 2026-18.")).toEqual([]);
  });
  it("writes the item with dots", () => {
    expect(fixWith(agendaItem, "item 10 B1, then 10A1, then 14B.")).toBe(
      "item 10.B.1, then 10.A.1, then 14.B.",
    );
  });
});
