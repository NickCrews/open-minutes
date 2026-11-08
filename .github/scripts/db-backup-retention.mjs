// Which database backups to keep, by when each was taken:
//   - every backup from the last 14 days,
//   - the first backup of each week (Monday to Sunday, UTC) from the last
//     6 months,
//   - the first backup of each month (UTC), forever.
// "First" rather than a fixed weekday, so a missed day doesn't lose a week's
// or a month's backup.
//
// Run as a script, reads release tags (one per line) on stdin and prints the
// backup tags to delete. Tags that aren't backups are never printed.
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const TAG_PREFIX = "db-backup-";
const DAY_MS = 24 * 60 * 60 * 1000;

// db-backup-20261108T101700Z -> Date
export function tagTime(tag) {
  const m = /^db-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    tag,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

export function backupTag(date) {
  const iso = date.toISOString(); // 2026-11-08T10:17:00.123Z
  return `${TAG_PREFIX}${iso.slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function weekKey(date) {
  const monday = new Date(
    date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS,
  );
  return monday.toISOString().slice(0, 10);
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

export function tagsToDelete(tags, now) {
  const backups = tags
    .map((tag) => ({ tag, time: tagTime(tag) }))
    .filter((b) => b.time !== null)
    .sort((a, b) => a.time - b.time);

  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);

  const keep = new Set();
  const seenWeeks = new Set();
  const seenMonths = new Set();
  for (const { tag, time } of backups) {
    if (now - time < 14 * DAY_MS) keep.add(tag);
    const week = weekKey(time);
    if (!seenWeeks.has(week)) {
      seenWeeks.add(week);
      if (time >= sixMonthsAgo) keep.add(tag);
    }
    const month = monthKey(time);
    if (!seenMonths.has(month)) {
      seenMonths.add(month);
      keep.add(tag);
    }
  }
  return backups.map((b) => b.tag).filter((tag) => !keep.has(tag));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tags = readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const tag of tagsToDelete(tags, new Date()))
    process.stdout.write(`${tag}\n`);
}
