import { expect } from "vitest";
import { isNull } from "drizzle-orm";
import { peopleTable } from "@open-minutes/db";
import { test } from "@open-minutes/db/testing/vitest";
import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { identifyAndInsertSegments } from "./identify";

const voice = () => {
  const vec = new Float32Array(N_DIMENSIONS);
  vec[0] = 1;
  return vec;
};

test("recognizes a speaker by an existing person's voiceprint", async ({
  db,
}) => {
  await db
    .insert(peopleTable)
    .values({ slug: "margaret-tyler", voice_embedding: Array.from(voice()) });
  await identifyAndInsertSegments(db, 0, [], new Map([[0, voice()]]));
  expect(await db.select().from(peopleTable)).toHaveLength(1);
});

test("skips people with no voiceprint yet", async ({ db }) => {
  await db.insert(peopleTable).values({ slug: "margaret-tyler" });
  await identifyAndInsertSegments(db, 0, [], new Map([[0, voice()]]));
  const people = await db.select().from(peopleTable);
  expect(people).toHaveLength(2);
  // The one without a voiceprint is untouched; the speaker became a new person.
  expect(
    await db
      .select()
      .from(peopleTable)
      .where(isNull(peopleTable.voice_embedding)),
  ).toEqual([expect.objectContaining({ slug: "margaret-tyler" })]);
});
