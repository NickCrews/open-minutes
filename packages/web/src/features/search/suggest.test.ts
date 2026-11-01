import { describe, expect, test } from "vite-plus/test";
import { suggestCompletions } from "./suggest";

describe("suggestCompletions", () => {
  test("finishes the last word and extends it, most frequent first", () => {
    const texts = [
      "The budget hearing is Tuesday.",
      "We moved the budget hearing.",
      "Budgets are due.",
    ];
    expect(suggestCompletions(texts, "budg")).toEqual([
      "budget",
      "budget hearing",
      "budgets",
      "budgets are due",
    ]);
  });

  test("matches earlier query words exactly", () => {
    expect(
      suggestCompletions(["school board meeting", "school bus"], "school bo"),
    ).toEqual(["school board", "school board meeting"]);
  });

  test("does not cross clause breaks or end on a stopword", () => {
    expect(suggestCompletions(["Zoning, then the vote"], "zon")).toEqual([
      "zoning",
    ]);
    expect(suggestCompletions(["zoning for the park"], "zon")).toEqual([
      "zoning",
    ]);
  });

  test("ignores case and punctuation in the query", () => {
    expect(suggestCompletions(["Dog park"], "  DOG  P")).toEqual(["dog park"]);
  });

  test("returns nothing for a query with no words", () => {
    expect(suggestCompletions(["anything"], " ?! ")).toEqual([]);
  });
});
