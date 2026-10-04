/**
 * `/llms.txt`: the entry point for AI agents (chat assistants with only a web
 * fetch tool) that were given nothing but the site's URL. It says what Open
 * Minutes is, what it covers right now, and which URLs to fetch next, since
 * those fetchers only open URLs they've been shown. See
 * https://llmstxt.org and issue #120.
 */
import { type DB, meetingsTable } from "@open-minutes/db";
import { max } from "drizzle-orm";
import { getAllBodies } from "../bodies";

/** The DuckDB export's public URL; see skills/open-minutes-data/SKILL.md. */
export const DUCKDB_EXPORT_URL =
  "https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev/exports/open-minutes.duckdb";

export type LlmsTxtBody = {
  id: number;
  name: string;
  jurisdiction: string;
  meetings: number;
  first: string | null;
  last: string | null;
};

export type LlmsTxtData = {
  bodies: LlmsTxtBody[];
  /** When the newest meeting was added, as an ISO date, or null if none. */
  dataAsOf: string | null;
};

export async function getLlmsTxtData(db: DB): Promise<LlmsTxtData> {
  const [bodies, [latest]] = await Promise.all([
    getAllBodies(db),
    db.select({ at: max(meetingsTable.created_at) }).from(meetingsTable),
  ]);
  return {
    bodies: bodies.map((body) => ({
      id: body.id,
      name: body.name,
      jurisdiction: body.jurisdiction.name,
      ...body.coverage,
    })),
    dataAsOf: latest?.at ? latest.at.toISOString().slice(0, 10) : null,
  };
}

function coverageLine(origin: string, body: LlmsTxtBody): string {
  const where = body.jurisdiction ? ` (${body.jurisdiction})` : "";
  const count = `${body.meetings} meeting${body.meetings === 1 ? "" : "s"}`;
  const span =
    body.first && body.last
      ? body.first === body.last
        ? `, on ${body.first}`
        : `, ${body.first} to ${body.last}`
      : "";
  return `- [${body.name}](${origin}/bodies/${body.id})${where}: ${count}${span}`;
}

/** The text of `/llms.txt`, for a site served at `origin` (no trailing slash). */
export function renderLlmsTxt(origin: string, data: LlmsTxtData): string {
  const covered = data.bodies.filter((b) => b.meetings > 0);
  const coverage = covered.length
    ? covered.map((b) => coverageLine(origin, b)).join("\n")
    : "- No meetings yet.";
  return `# Open Minutes

> Searchable transcripts of recorded public meetings of local governments in Alaska (the Anchorage Assembly, the Girdwood Board of Supervisors, Alaska Legislature committees and others), showing who said what, and when, with links to the moment in the video. Not official minutes.

Data as of: ${data.dataAsOf ?? "unknown"}. New meetings are added about once a day.

## Coverage

Only these bodies and dates are covered, and not every meeting in each span has been processed. Tell the person which bodies and dates you searched, and that something not being found doesn't mean it wasn't said.

${coverage}

## How to answer questions

1. Search for what was said: \`${origin}/search?q=<words>\`. Search matches the exact words in the transcript (case-insensitive substring), and shows only the 50 most recent matching passages. So search several wordings and spellings, e.g. for short-term rentals try "short-term rental", "short term rental", "STR", "Airbnb" and "vacation rental". Shorter words find more.
2. Open a meeting to read around a match: \`${origin}/meetings/<id>\`. Its page lists the meeting's chapters (one per agenda item or stretch of public comment, with a summary), then its full transcript, with each passage's speaker and its time into the recording (as h:mm:ss or m:ss).
3. A person's page lists the meetings they spoke in and what they said: \`${origin}/people/<id>\`. All people: ${origin}/people
4. A body's page lists its meetings, newest first: \`${origin}/bodies/<id>\`. All bodies: ${origin}/bodies

## Citing

Cite every claim with a link to the moment it was said: \`${origin}/meetings/<id>?t=<seconds>\`, where \`<seconds>\` is how far into the recording it starts, in whole seconds (25:06 is 1506). Quote the transcript, not chapter summaries, and name the meeting and its date.

## Limits of the data

- Transcripts come from speech recognition, so they have mistakes, especially in names, places and quiet or overlapping speech. Say so when a quote looks garbled, and link to the video.
- Who is speaking is worked out from people's voices, and can be wrong. Many speakers have no name yet and show as placeholder names like "Anonymous Beaver": call them an unidentified speaker, and never guess who they are.
- Chapters, their titles and summaries are written by an AI model, and may be missing or wrong.
- Some meetings have no date yet; their title usually says when they were.

## Optional

- [About Open Minutes](${origin}/about): what it is, and its limits, for people.
- [All meetings](${origin}/meetings)
- [DuckDB export](${DUCKDB_EXPORT_URL}): all of the data in one file, rebuilt nightly, for agents that can run SQL. Its tables and example queries: https://github.com/nickcrews/open-minutes/blob/main/skills/open-minutes-data/SKILL.md
`;
}
