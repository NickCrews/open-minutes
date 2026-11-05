import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { type DB, peopleTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { DATUMS_ROOT } from "@open-minutes/datasets/datums";
import { datasetState, placeholderVoiceprint } from "@open-minutes/seed";
import { toGolden, writeGolden } from "./export";
import { findMeetingId, loadMeeting } from "./meeting";
import { publishGolden, type VoiceprintSource } from "./publish";

const GOLDENS = readdirSync(join(DATUMS_ROOT, "meetings"));

const placeholders: VoiceprintSource = async (slugs) =>
  new Map(slugs.map((s) => [s, placeholderVoiceprint(s)]));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

/** A copy of the datums to export into. */
function datumsCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "datums-"));
  roots.push(root);
  cpSync(DATUMS_ROOT, root, { recursive: true });
  return root;
}

async function exportAll(db: DB, root: string): Promise<void> {
  for (const slug of GOLDENS) {
    const meeting = await loadMeeting(db, await findMeetingId(db, slug));
    await writeGolden(toGolden(meeting), {
      root,
      sha256: () => Promise.reject(new Error("meeting.json has the hash")),
    });
  }
}

/** Every file under `root` that differs from the datums', by path. */
function changedFiles(root: string): string[] {
  const files = readdirSync(root, { recursive: true, encoding: "utf8" });
  return files
    .filter((f) => {
      const path = join(root, f);
      try {
        return (
          readFileSync(path, "utf8") !==
          readFileSync(join(DATUMS_ROOT, f), "utf8")
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EISDIR") return false;
        return true;
      }
    })
    .map((f) => relative(root, join(root, f)));
}

describe("goldens", () => {
  const seeded = dbTest({ data: datasetState("all") });

  seeded(
    "export a seeded database's meetings as the files it was seeded from",
    async ({ db }) => {
      const root = datumsCopy();
      await exportAll(db, root);
      expect(changedFiles(root)).toEqual([]);
    },
    120_000,
  );

  seeded("refuses to export someone with no slug", async ({ db }) => {
    await db
      .update(peopleTable)
      .set({ slug: null })
      .where(eq(peopleTable.slug, "kyle-kelley"));
    const meeting = await loadMeeting(
      db,
      await findMeetingId(db, "gbos-2026-03-23"),
    );
    expect(() => toGolden(meeting)).toThrow(/\(Kyle Kelley\).* has no slug/);
  });

  const bodies = dbTest({ data: datasetState("bodies") });

  bodies(
    "publish goldens into a database, which then exports them unchanged",
    async ({ db }) => {
      for (const slug of GOLDENS)
        await publishGolden(db, slug, { voiceprints: placeholders });
      const root = datumsCopy();
      await exportAll(db, root);
      expect(changedFiles(root)).toEqual([]);
    },
    120_000,
  );

  bodies("publish again replaces, and finds people by name", async ({ db }) => {
    const slug = "pzc-2026-06-08";
    await publishGolden(db, slug, { voiceprints: placeholders });
    const [someone] = await db
      .update(peopleTable)
      .set({ slug: null })
      .returning({ id: peopleTable.id, name: peopleTable.name });
    const notes = await publishGolden(db, slug, {
      voiceprints: () => Promise.reject(new Error("everyone is known")),
    });
    expect(notes).toContain(
      `person ${someone!.id}: named ${JSON.stringify(someone!.name)}, given slug ${(await db.select().from(peopleTable).where(eq(peopleTable.id, someone!.id)))[0]!.slug}`,
    );
    expect(notes).toContainEqual(
      expect.stringMatching(/^meeting \d+: updated$/),
    );
  });

  bodies("a dry run saves nothing", async ({ db }) => {
    const notes = await publishGolden(db, "pzc-2026-06-08", {
      voiceprints: placeholders,
      dryRun: true,
    });
    expect(notes).toContainEqual(expect.stringMatching(/^meeting \d+: added$/));
    await expect(findMeetingId(db, "pzc-2026-06-08")).rejects.toThrow(
      /No meeting/,
    );
  });
});
