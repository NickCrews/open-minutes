import { describe, expect, test } from "vite-plus/test";
import { extractSql, githubApiUrl, inferMeeting } from "./source";

const ISSUE = `Meeting 5.

\`\`\`sh
pnpm changeset check changeset.sql --meeting 5 --db prod
\`\`\`

\`\`\`sql
-- a note
SELECT om.replace_words('5', '1:40:27.97', 'a 192-2026', 'AM 192-2026');
\`\`\`

To review: ...`;

describe("sources", () => {
  test("takes the SQL from a Markdown sql block", () => {
    expect(extractSql(ISSUE)).toBe(
      "-- a note\nSELECT om.replace_words('5', '1:40:27.97', 'a 192-2026', 'AM 192-2026');\n",
    );
    expect(extractSql("SELECT 1;")).toBeNull();
  });

  test("finds the meeting named by --meeting", () => {
    expect(inferMeeting(ISSUE)).toBe("5");
    expect(inferMeeting("--meeting=gbos-2026-03-23")).toBe("gbos-2026-03-23");
    expect(inferMeeting("SELECT 1;")).toBeNull();
  });

  test("reads GitHub issues and comments through the API", () => {
    expect(
      githubApiUrl("https://github.com/NickCrews/open-minutes/issues/215"),
    ).toBe("https://api.github.com/repos/NickCrews/open-minutes/issues/215");
    expect(
      githubApiUrl(
        "https://github.com/NickCrews/open-minutes/issues/215#issuecomment-42",
      ),
    ).toBe(
      "https://api.github.com/repos/NickCrews/open-minutes/issues/comments/42",
    );
    expect(githubApiUrl("https://example.com/changeset.sql")).toBeNull();
  });
});
