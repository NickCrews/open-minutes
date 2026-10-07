export { formatClock } from "@open-minutes/core/clock";

/** "H:MM:SS(.ss)", "MM:SS(.ss)" or "SS(.ss)" as seconds; null if malformed. */
export function parseClock(text: string): number | null {
  const m = /^(?:(?:(\d+):)?(\d{1,2}):)?(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3]);
}
