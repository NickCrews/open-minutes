import { describe, expect, test } from "vitest";
import {
  localMigrations,
  migrationsFingerprint,
  migrationsUpTo,
  resolveSchemaVersion,
} from "./migrations";

const all = [
  { name: "20260101000000_init", hash: "a" },
  { name: "20260102000000_add-bio", hash: "b" },
  { name: "20260103000000_add-bio-index", hash: "c" },
];

describe("resolveSchemaVersion", () => {
  test("accepts the full name, the timestamp, or the tag", () => {
    expect(resolveSchemaVersion("20260102000000_add-bio", all)).toBe(
      "20260102000000_add-bio",
    );
    expect(resolveSchemaVersion("20260102000000", all)).toBe(
      "20260102000000_add-bio",
    );
    expect(resolveSchemaVersion("add-bio", all)).toBe("20260102000000_add-bio");
  });

  test('"latest" is the last migration', () => {
    expect(resolveSchemaVersion("latest", all)).toBe(
      "20260103000000_add-bio-index",
    );
  });

  test("rejects unknown versions, listing the real ones", () => {
    expect(() => resolveSchemaVersion("nope", all)).toThrow(
      /Unknown schema version "nope"[\s\S]*20260101000000_init/,
    );
  });

  test("resolves every migration in this checkout by its tag", () => {
    for (const m of localMigrations()) {
      expect(resolveSchemaVersion(m.name.slice(15))).toBe(m.name);
    }
  });
});

describe("migrationsUpTo", () => {
  test("includes the named migration and everything before it", () => {
    expect(migrationsUpTo("add-bio", all).map((m) => m.hash)).toEqual([
      "a",
      "b",
    ]);
    expect(migrationsUpTo("latest", all)).toHaveLength(3);
  });

  test("each version has its own schema fingerprint", () => {
    const prints = new Set(
      all.map((_, i) => migrationsFingerprint(all.slice(0, i + 1))),
    );
    expect(prints.size).toBe(3);
  });
});
