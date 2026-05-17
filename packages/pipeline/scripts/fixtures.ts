import { loadAllFixtures } from "../src/test-utils/fixtures";
import { meetingCacheDir, isCached } from "../src/test-utils/audio-cache";

function status() {
  const fixtures = loadAllFixtures();
  if (fixtures.length === 0) {
    console.log("No fixtures found. Add municipalities.jsonl/people.jsonl/meetings.jsonl/segments.jsonl under test-fixtures/<municipality>/<meeting_dir>/");
    return;
  }
  console.log(`${fixtures.length} fixture(s):`);
  for (const f of fixtures) {
    const dir = meetingCacheDir(f.meeting.youtube_id);
    const cached = isCached(f.meeting.youtube_id);
    const curated = f.segments.filter((s) => s._curated).length;
    const total = f.segments.length;
    const statusLabel = cached ? "cached" : `would download from youtube:${f.meeting.youtube_id}`;
    console.log(
      `  ${f.municipality_slug}/${f.meeting_dir}: ${statusLabel}` +
      `\n    youtube: ${f.meeting.youtube_id}` +
      `\n    cache:   ${dir}` +
      `\n    fixture: ${f.fixtureDir}/` +
      `\n    segments: ${total} total, ${curated} curated`,
    );
  }
}

const cmd = process.argv[2];
switch (cmd) {
  case "status":
  case undefined:
    status();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error("Usage: pnpm pipeline:fixtures status");
    process.exit(1);
}
