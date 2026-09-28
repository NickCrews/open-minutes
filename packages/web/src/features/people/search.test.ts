import { describe, expect, test } from "vitest";
import { matchesName } from "./search";

describe("matchesName", () => {
  test("matches everyone on a blank query", () => {
    expect(matchesName("Alice", "")).toBe(true);
    expect(matchesName("Alice", "   ")).toBe(true);
    expect(matchesName(null, "")).toBe(true);
  });

  test("ignores case and diacritics", () => {
    expect(matchesName("José Ramírez", "jose ramirez")).toBe(true);
    expect(matchesName("alice", "ALI")).toBe(true);
  });

  test("requires every term, in any order or position", () => {
    expect(matchesName("Jane Q. Doe", "doe jane")).toBe(true);
    expect(matchesName("Jane Q. Doe", "jane smith")).toBe(false);
  });

  test("never matches an anonymous person on a real query", () => {
    expect(matchesName(null, "unnamed")).toBe(false);
  });
});
