import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { renderPage } from "./render";
import { samples } from "./samples";

const CLIENT = readFileSync(new URL("./client.js", import.meta.url), "utf8");

describe("samples", () => {
  const all = samples();

  test("have distinct names", () => {
    expect(new Set(all.map((s) => s.name)).size).toBe(all.length);
  });

  test.each(all.map((s) => [s.name, s] as const))("%s renders", (_, s) => {
    const page = renderPage(s.diff, CLIENT);
    expect(page).toContain(`${s.diff.statements.length} statements`);
  });

  test("cleanup shows a change of every kind", () => {
    const diff = all.find((s) => s.name === "cleanup")!.diff;
    const kinds = new Set(
      diff.statements.flatMap((s) =>
        s.meetings.flatMap((m) => m.changes.map((c) => c.kind)),
      ),
    );
    expect([...kinds].sort()).toEqual(["boundary", "speaker", "words"]);
    expect(diff.error).toBeNull();
    expect(diff.meetings.map((m) => m.id)).toEqual([12, 13, 14]);
  });

  test("failing stops at its failed statement", () => {
    const diff = all.find((s) => s.name === "failing")!.diff;
    expect(diff.statements.map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "failed",
      "not-run",
    ]);
  });
});
