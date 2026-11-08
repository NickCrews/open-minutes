import { describe, expect } from "vite-plus/test";
import type postgres from "postgres";
import { sqlData } from "./testing";
import { dbTest } from "./testing/vitest";

// Two meetings, and three people: two known, one anonymous. Meeting 1 reads
//   chair:  Thank@1 you.@1.5 Kyle.@2 I@3 agree.@3.5
//   spk 2:  Second.@5
//   chair:  Good@7 wood@7.5 is@8 great.@8.5
const voiceprint = "array_fill(0::real, ARRAY[192])::vector";
const test = dbTest({
  data: sqlData(
    "om-functions",
    `
    INSERT INTO recordings (id, site, external_id, permalink, duration_secs) VALUES
      (1, 'youtube', 'a', 'https://www.youtube.com/watch?v=a', '0'),
      (2, 'youtube', 'b', 'https://www.youtube.com/watch?v=b', '0');
    INSERT INTO meetings (id, slug, recording_id, timezone) VALUES
      (1, 'test-meeting', 1, 'America/Anchorage'),
      (2, 'other-meeting', 2, 'America/Anchorage');
    INSERT INTO people (id, slug, name, voice_embedding) VALUES
      (1, 'chair', 'Chair', ${voiceprint}),
      (2, 'kyle-kelley', 'Kyle Kelley', ${voiceprint}),
      (3, NULL, NULL, ${voiceprint});
    SELECT setval('people_id_seq', 3);
    INSERT INTO segments (meeting_id, person_id, speaker_number, words) VALUES
      (1, 1, NULL, '[{"text":"Thank","start":1},{"text":"you.","start":1.5},{"text":"Kyle.","start":2},{"text":"I","start":3},{"text":"agree.","start":3.5}]'),
      (1, NULL, 2, '[{"text":"Second.","start":5}]'),
      (1, 1, NULL, '[{"text":"Good","start":7},{"text":"wood","start":7.5},{"text":"is","start":8},{"text":"great.","start":8.5}]'),
      (2, 1, NULL, '[{"text":"Kyle","start":1}]');
    `,
  ),
});

/** Meeting 1's segments, each as "<speaker>: word@onset ...". */
async function transcript(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ line: string }[]>`
    SELECT coalesce('person ' || person_id, 'spk ' || speaker_number, 'unlabeled')
      || ': ' || (SELECT string_agg((w->>'text') || '@' || (w->>'start'), ' ')
                  FROM jsonb_array_elements(words) w) AS line
    FROM segments WHERE meeting_id = 1 ORDER BY start_secs, id`;
  return rows.map((r) => r.line);
}

describe("om.split_segment", () => {
  test("splits a segment at a word, giving the rest a new speaker", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.split_segment('test-meeting', '0:00:03.00', 'I', 'identified:kyle-kelley')`;
    expect(await transcript(sql)).toEqual([
      "person 1: Thank@1 you.@1.5 Kyle.@2",
      "person 2: I@3 agree.@3.5",
      "spk 2: Second.@5",
      "person 1: Good@7 wood@7.5 is@8 great.@8.5",
    ]);
  });

  test("relabels a whole segment when the word starts it", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.split_segment('1', '0:00:05.00', NULL, 'person:3')`;
    expect((await transcript(sql))[1]).toBe("person 3: Second.@5");
  });

  test("refuses a word that doesn't match", async ({
    testDb: { client: sql },
  }) => {
    await expect(
      sql`SELECT om.split_segment('test-meeting', '0:00:03.00', 'agree.', 'unlabeled')`,
    ).rejects.toThrow(
      /^no word "agree\." at 0:00:03\.00; nearby: 0:00:01\.00=Thank/,
    );
  });
});

describe("om.relabel", () => {
  test("merges neighbours left with the same speaker", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.relabel('test-meeting', '0:00:05', 'identified:chair')`;
    expect(await transcript(sql)).toEqual([
      "person 1: Thank@1 you.@1.5 Kyle.@2 I@3 agree.@3.5 Second.@5 Good@7 wood@7.5 is@8 great.@8.5",
    ]);
  });

  test("sets a speaker number and clears the person", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.relabel('test-meeting', '0:00:08.00', 'segmented:spk-4')`;
    expect((await transcript(sql))[2]).toBe(
      "spk 4: Good@7 wood@7.5 is@8 great.@8.5",
    );
  });

  test("says what words are near an onset it can't find", async ({
    testDb: { client: sql },
  }) => {
    await expect(
      sql`SELECT om.relabel('test-meeting', '0:00:06.00', 'unlabeled')`,
    ).rejects.toThrow(
      /^no word at 0:00:06\.00; nearby: 0:00:03\.50=agree\. 0:00:05\.00=Second\. 0:00:07\.00=Good/,
    );
  });

  test("refuses a person who doesn't exist", async ({
    testDb: { client: sql },
  }) => {
    await expect(
      sql`SELECT om.relabel('test-meeting', '0:00:05.00', 'identified:nobody')`,
    ).rejects.toThrow(/no person with slug "nobody"/);
    await expect(
      sql`SELECT om.relabel('no-such-meeting', '0:00:05.00', 'unlabeled')`,
    ).rejects.toThrow('no meeting "no-such-meeting"');
  });
});

describe("om.replace_words", () => {
  test("replaces words, keeping their onsets", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.replace_words('test-meeting', '0:00:07.00', 'Good wood', 'Girdwood')`;
    expect((await transcript(sql))[2]).toBe(
      "person 1: Girdwood@7 is@8 great.@8.5",
    );
  });

  test("gives extra words the last old word's onset", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.replace_words('test-meeting', '0:00:08.50', 'great.', 'very great.')`;
    expect((await transcript(sql))[2]).toBe(
      "person 1: Good@7 wood@7.5 is@8 very@8.5 great.@8.5",
    );
  });

  test("refuses words that don't match", async ({
    testDb: { client: sql },
  }) => {
    await expect(
      sql`SELECT om.replace_words('test-meeting', '0:00:07.00', 'Bad wood', 'Girdwood')`,
    ).rejects.toThrow('expected "Bad wood" at 0:00:07.00, found "Good wood"');
  });

  test("deleting a segment's only word deletes it and merges its neighbours", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.replace_words('test-meeting', '0:00:05.00', 'Second.', '')`;
    expect(await transcript(sql)).toEqual([
      "person 1: Thank@1 you.@1.5 Kyle.@2 I@3 agree.@3.5 Good@7 wood@7.5 is@8 great.@8.5",
    ]);
  });
});

describe("om.insert_words", () => {
  test("inserts a turn and gives the words after it back", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.insert_words('test-meeting', ARRAY['0:00:02.50 Yes.'], 'identified:kyle-kelley')`;
    expect(await transcript(sql)).toEqual([
      "person 1: Thank@1 you.@1.5 Kyle.@2",
      "person 2: Yes.@2.5",
      "person 1: I@3 agree.@3.5",
      "spk 2: Second.@5",
      "person 1: Good@7 wood@7.5 is@8 great.@8.5",
    ]);
  });

  test("inserts a word into the segment it falls in", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.insert_words('test-meeting', ARRAY['0:00:08.20 very'])`;
    expect((await transcript(sql))[2]).toBe(
      "person 1: Good@7 wood@7.5 is@8 very@8.2 great.@8.5",
    );
  });

  test("inserts before every word", async ({ testDb: { client: sql } }) => {
    await sql`SELECT om.insert_words('test-meeting', ARRAY['0:00:00.50 Okay.', '0:00:00.70 So'], 'segmented:spk-2')`;
    expect((await transcript(sql))[0]).toBe("spk 2: Okay.@0.5 So@0.7");
    await sql`SELECT om.insert_words('test-meeting', ARRAY['0:00:00.20 Um'])`;
    expect((await transcript(sql))[0]).toBe("spk 2: Um@0.2 Okay.@0.5 So@0.7");
  });

  test("refuses an onset a word already has", async ({
    testDb: { client: sql },
  }) => {
    await expect(
      sql`SELECT om.insert_words('test-meeting', ARRAY['0:00:08.00 very'])`,
    ).rejects.toThrow(/already starts at 0:00:08\.00/);
    await expect(
      sql`SELECT om.insert_words('test-meeting', ARRAY['0:00:08.10 two words'])`,
    ).rejects.toThrow(/not one word/);
  });
});

describe("om.replace_all_words", () => {
  test("replaces every occurrence, keeping trailing punctuation", async ({
    testDb: { client: sql },
  }) => {
    const [row] = await sql<{ n: number }[]>`
      SELECT om.replace_all_words('test-meeting', 'kyle', 'Kyle Kelley') AS n`;
    expect(row!.n).toBe(1);
    expect((await transcript(sql))[0]).toBe(
      "person 1: Thank@1 you.@1.5 Kyle@2 Kelley.@2 I@3 agree.@3.5",
    );
    // Only in the meeting named.
    const [other] = await sql`SELECT text FROM segments WHERE meeting_id = 2`;
    expect(other!.text).toBe("Kyle");
  });

  test("matches several words, and deletes", async ({
    testDb: { client: sql },
  }) => {
    const [row] = await sql<{ n: number }[]>`
      SELECT om.replace_all_words('test-meeting', 'GOOD wood', '') AS n`;
    expect(row!.n).toBe(1);
    expect((await transcript(sql))[2]).toBe("person 1: is@8 great.@8.5");
  });
});

describe("om.assert", () => {
  test("raises its message with SQLSTATE OM001 unless true", async ({
    testDb: { client: sql },
  }) => {
    await sql`SELECT om.assert(true, 'fine')`;
    for (const cond of [false, null])
      await expect(
        sql`SELECT om.assert(${cond}, 'not so')`,
      ).rejects.toMatchObject({ code: "OM001", message: "not so" });
  });
});
