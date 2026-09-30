import { describe, expect, test } from "vitest";
import {
  compareMigrations,
  describeStatus,
  isDiverged,
} from "./migration-status";

const local = [
  { name: "001_init", hash: "h1" },
  { name: "002_add", hash: "h2" },
  { name: "003_more", hash: "h3" },
];

describe("compareMigrations", () => {
  test("a never-migrated database has everything pending", () => {
    const status = compareMigrations(local, []);
    expect(status).toEqual({
      pending: ["001_init", "002_add", "003_more"],
      unknown: [],
      modified: [],
    });
    expect(isDiverged(status)).toBe(false);
  });

  test("a database behind the code has the rest pending", () => {
    expect(compareMigrations(local, local.slice(0, 2)).pending).toEqual([
      "003_more",
    ]);
  });

  test("migrations from another branch are unknown, and diverge", () => {
    const status = compareMigrations(local.slice(0, 2), [
      ...local.slice(0, 2),
      { name: "002b_other_branch", hash: "hx" },
    ]);
    expect(status.unknown).toEqual(["002b_other_branch"]);
    expect(isDiverged(status)).toBe(true);
    expect(describeStatus(status)).toContain("002b_other_branch");
  });

  test("an edited, already-applied migration is modified", () => {
    const status = compareMigrations(local, [
      { name: "001_init", hash: "old" },
    ]);
    expect(status.modified).toEqual(["001_init"]);
    expect(status.pending).toEqual(["002_add", "003_more"]);
    expect(isDiverged(status)).toBe(true);
  });

  test("unnamed journal rows (older drizzle) match by hash", () => {
    const status = compareMigrations(local, [
      { name: null, hash: "h1" },
      { name: null, hash: "zzzzzzzzzzzzzzzz" },
    ]);
    expect(status.unknown).toEqual(["<unnamed zzzzzzzzzzzz>"]);
  });

  test("describes a clean status as up to date", () => {
    expect(describeStatus(compareMigrations(local, local))).toBe("Up to date.");
  });
});
