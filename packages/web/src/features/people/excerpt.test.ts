import { describe, expect, test } from "vitest";
import { excerptItems, type Reveal, visibleIndices } from "./excerpt";

/** The excerpt as a compact string: own segments as "[i]", others as "i", gaps as "(hidden/size)". */
function layout(
  total: number,
  own: number[],
  reveals: Record<number, Reveal> = {},
): string {
  return excerptItems(
    total,
    own,
    new Map(Object.entries(reveals).map(([k, v]) => [Number(k), v])),
  )
    .map((item) =>
      item.kind === "gap"
        ? `(${item.gap.hidden}/${item.gap.size})`
        : item.own
          ? `[${item.index}]`
          : String(item.index),
    )
    .join(" ");
}

describe("excerptItems", () => {
  test("folds everything around the person's segments", () => {
    expect(layout(10, [3, 6])).toBe("(3/3) [3] (2/2) [6] (3/3)");
  });

  test("adjacent own segments have no gap between them", () => {
    expect(layout(3, [0, 1, 2])).toBe("[0] [1] [2]");
  });

  test("accepts own indices in any order", () => {
    expect(layout(5, [4, 1])).toBe("(1/1) [1] (2/2) [4]");
  });

  test("opens a between gap from both edges", () => {
    expect(layout(10, [0, 9], { 1: { head: 2, tail: 3 } })).toBe(
      "[0] 1 2 (3/8) 6 7 8 [9]",
    );
  });

  test("a fully opened gap keeps its control, just above the next segment", () => {
    expect(layout(5, [0, 4], { 1: { head: 2, tail: 5 } })).toBe(
      "[0] 1 2 3 (0/3) [4]",
    );
  });

  test("the gap before the first segment only opens upward from it", () => {
    expect(layout(6, [5], { 0: { head: 4, tail: 2 } })).toBe("(3/5) 3 4 [5]");
    expect(layout(6, [5], { 0: { head: 0, tail: 9 } })).toBe(
      "(0/5) 0 1 2 3 4 [5]",
    );
  });

  test("the gap after the last segment only opens downward from it", () => {
    expect(layout(6, [0], { 1: { head: 2, tail: 4 } })).toBe("[0] 1 2 (3/5)");
  });

  test("with no own segments there is nothing to show", () => {
    expect(layout(4, [])).toBe("");
  });
});

test("visibleIndices lists the shown segments", () => {
  const items = excerptItems(8, [2, 5], new Map([[3, { head: 1, tail: 0 }]]));
  expect([...visibleIndices(items)].sort()).toEqual([2, 3, 5]);
});
