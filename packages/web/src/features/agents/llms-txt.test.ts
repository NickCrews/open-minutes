import {
  bodiesTable,
  jurisdictionsTable,
  meetingBodiesTable,
  meetingsTable,
} from "@open-minutes/db";
import { test } from "@open-minutes/db/testing/vitest";
import { describe, expect, it } from "vitest";
import { getLlmsTxtData, renderLlmsTxt, type LlmsTxtBody } from "./llms-txt";

const ORIGIN = "https://om.example";

function body(overrides: Partial<LlmsTxtBody>): LlmsTxtBody {
  return {
    id: 1,
    name: "Girdwood Board of Supervisors",
    jurisdiction: "Municipality of Anchorage",
    meetings: 2,
    first: "2025-01-06",
    last: "2026-03-23",
    ...overrides,
  };
}

describe("renderLlmsTxt", () => {
  it("lists each covered body with its meetings and dates", () => {
    const text = renderLlmsTxt(ORIGIN, {
      bodies: [body({}), body({ id: 2, name: "Empty", meetings: 0 })],
      dataAsOf: "2026-10-03",
    });
    expect(text).toContain(
      "- [Girdwood Board of Supervisors](https://om.example/bodies/1) (Municipality of Anchorage): 2 meetings, 2025-01-06 to 2026-03-23",
    );
    expect(text).not.toContain("Empty");
    expect(text).toContain("Data as of: 2026-10-03.");
  });

  it("handles a single meeting and unknown dates", () => {
    const text = renderLlmsTxt(ORIGIN, {
      bodies: [
        body({ meetings: 1, first: "2026-03-23", last: "2026-03-23" }),
        body({ id: 2, name: "Undated", meetings: 1, first: null, last: null }),
      ],
      dataAsOf: null,
    });
    expect(text).toContain("1 meeting, on 2026-03-23");
    expect(text).toContain("(Municipality of Anchorage): 1 meeting\n");
    expect(text).toContain("Data as of: unknown.");
  });

  it("says when nothing is covered", () => {
    const text = renderLlmsTxt(ORIGIN, { bodies: [], dataAsOf: null });
    expect(text).toContain("- No meetings yet.");
  });

  it("gives agents absolute URLs to fill in", () => {
    const text = renderLlmsTxt(ORIGIN, { bodies: [], dataAsOf: null });
    expect(text).toContain("https://om.example/search?q=<words>");
    expect(text).toContain("https://om.example/meetings/<id>?t=<seconds>");
    expect(text).toContain("https://om.example/people/<id>");
  });
});

describe("getLlmsTxtData", () => {
  test("reads coverage and when the newest meeting was added", async ({
    db,
  }) => {
    const [jurisdiction] = await db
      .insert(jurisdictionsTable)
      .values({ name: "Testville" })
      .returning({ id: jurisdictionsTable.id });
    const [gbos] = await db
      .insert(bodiesTable)
      .values({
        name: "GBOS",
        jurisdiction_id: jurisdiction!.id,
        timezone: "America/Anchorage",
      })
      .returning({ id: bodiesTable.id });
    const meetings = await db
      .insert(meetingsTable)
      .values([
        {
          timezone: "America/Anchorage",
          site_kind: "youtube",
          site_id: "a",
          date: "2026-03-23",
          created_at: new Date("2026-09-01T12:00:00Z"),
        },
        {
          timezone: "America/Anchorage",
          site_kind: "youtube",
          site_id: "b",
          date: "2025-01-06",
          created_at: new Date("2026-10-02T12:00:00Z"),
        },
      ])
      .returning({ id: meetingsTable.id });
    await db
      .insert(meetingBodiesTable)
      .values(meetings.map((m) => ({ meeting_id: m.id, body_id: gbos!.id })));

    expect(await getLlmsTxtData(db)).toEqual({
      bodies: [
        {
          id: gbos!.id,
          name: "GBOS",
          jurisdiction: "Testville",
          meetings: 2,
          first: "2025-01-06",
          last: "2026-03-23",
        },
      ],
      dataAsOf: "2026-10-02",
    });
  });
});
