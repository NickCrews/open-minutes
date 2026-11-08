// Run with `node --test .github/scripts/db-backup-retention.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { backupTag, tagTime, tagsToDelete } from "./db-backup-retention.mjs";

const DAY = 24 * 60 * 60 * 1000;

// A backup at 10:17 UTC every day from `from` to `now`, minus `skip`ped days.
function dailyTags(from, now, skip = new Set()) {
  const tags = [];
  for (let t = from.getTime(); t <= now.getTime(); t += DAY) {
    const date = new Date(t);
    if (!skip.has(date.toISOString().slice(0, 10))) tags.push(backupTag(date));
  }
  return tags;
}

function kept(tags, now) {
  const deleted = new Set(tagsToDelete(tags, now));
  return tags.filter((t) => !deleted.has(t));
}

test("tags round-trip", () => {
  const date = new Date("2026-11-08T10:17:05Z");
  assert.equal(backupTag(date), "db-backup-20261108T101705Z");
  assert.deepEqual(tagTime(backupTag(date)), date);
  assert.equal(tagTime("v1.0.0"), null);
  assert.equal(tagTime("db-backup-2026-11-08"), null);
});

test("ignores tags that aren't backups", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  assert.deepEqual(tagsToDelete(["v1.0.0", "db-backup-latest"], now), []);
});

test("keeps dailies for 14 days, weeklies for 6 months, monthlies forever", () => {
  const now = new Date("2026-11-08T10:17:00Z");
  const tags = dailyTags(new Date("2024-01-01T10:17:00Z"), now);
  const days = kept(tags, now).map((t) => {
    const s = t.slice("db-backup-".length);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  });

  // All of the last 14 days.
  for (let i = 0; i < 14; i++) {
    const day = new Date(now.getTime() - i * DAY).toISOString().slice(0, 10);
    assert.ok(days.includes(day), `daily ${day}`);
  }
  assert.ok(!days.includes("2026-10-25"), "15 days old, a Sunday");

  // Mondays from the last 6 months, not before.
  assert.ok(days.includes("2026-05-11"), "weekly");
  assert.ok(days.includes("2026-10-19"), "weekly");
  assert.ok(!days.includes("2026-05-04"), "a Monday more than 6 months old");
  assert.ok(!days.includes("2026-10-20"), "a Tuesday 19 days old");

  // Every 1st of the month.
  for (const day of ["2024-01-01", "2024-02-01", "2025-06-01", "2026-04-01"])
    assert.ok(days.includes(day), `monthly ${day}`);
  assert.ok(!days.includes("2024-01-02"));

  // 14 dailies, 24 weeklies (2026-05-11 to 2026-10-19) and 35 monthlies
  // (2024-01 to 2026-11), less 2026-11-01 (also a daily) and 2026-06-01 (also
  // a weekly).
  assert.equal(days.length, 14 + 24 + 35 - 2);
});

test("a missed day keeps the next backup as that week's and month's", () => {
  const now = new Date("2026-11-08T10:17:00Z");
  const skip = new Set(["2026-06-01", "2026-08-03"]); // a 1st, and a Monday
  const tags = dailyTags(new Date("2026-01-01T10:17:00Z"), now, skip);
  const days = kept(tags, now).map((t) => t.slice(10, 18));
  assert.ok(days.includes("20260602"), "first of June");
  assert.ok(days.includes("20260804"), "first of that week");
});

test("a second backup on the same day is kept while daily, then dropped", () => {
  const first = "db-backup-20261101T101700Z";
  const second = "db-backup-20261101T153000Z";
  assert.deepEqual(
    tagsToDelete([first, second], new Date("2026-11-08T12:00:00Z")),
    [],
  );
  assert.deepEqual(
    tagsToDelete([first, second], new Date("2026-11-20T12:00:00Z")),
    [second],
  );
});

test("is idempotent", () => {
  const now = new Date("2026-11-08T10:17:00Z");
  const tags = dailyTags(new Date("2025-01-01T10:17:00Z"), now);
  const once = kept(tags, now);
  assert.deepEqual(tagsToDelete(once, now), []);
});
