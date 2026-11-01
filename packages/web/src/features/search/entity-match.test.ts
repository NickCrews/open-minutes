import { describe, expect, test } from "vite-plus/test";
import { MatchStrength, matchStrength, rankMatches } from "./entity-match";

describe("matchStrength", () => {
  test("a whole name is exact, ignoring case", () => {
    expect(
      matchStrength(["Girdwood Board of Supervisors", "GBOS"], "gbos"),
    ).toBe(MatchStrength.Exact);
  });

  test("the start of a name is a prefix", () => {
    expect(
      matchStrength(["Girdwood Board of Supervisors"], "girdwood bo"),
    ).toBe(MatchStrength.Prefix);
  });

  test("each word may start any word of any name", () => {
    expect(matchStrength(["Kyle Kelley"], "kel ky")).toBe(
      MatchStrength.WordPrefixes,
    );
    expect(
      matchStrength(["Regular Meeting March 23, 2026", "GBOS"], "gbos march"),
    ).toBe(MatchStrength.WordPrefixes);
  });

  test("ignores diacritics", () => {
    expect(matchStrength(["José Ortiz"], "jose")).toBe(MatchStrength.Prefix);
  });

  test("text inside a word doesn't match", () => {
    expect(matchStrength(["Kyle Kelley"], "elley")).toBeNull();
  });

  test("a query with no words matches nothing", () => {
    expect(matchStrength(["Kyle Kelley"], " - ")).toBeNull();
  });
});

describe("rankMatches", () => {
  const strong = MatchStrength.Exact;
  const weak = MatchStrength.WordPrefixes;

  test("strongest first, then group order, then order within a group", () => {
    expect(
      rankMatches([
        [{ item: "body", strength: weak }],
        [
          { item: "person a", strength: strong },
          { item: "person b", strength: weak },
        ],
      ]),
    ).toEqual(["person a", "body", "person b"]);
  });

  test("keeps at most `limit`", () => {
    const many = ["a", "b", "c"].map((item) => ({ item, strength: weak }));
    expect(rankMatches([many], 2)).toEqual(["a", "b"]);
  });
});
