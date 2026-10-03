/**
 * Seconds as "H:MM:SS.ss", the way golden PSV files and psvtool.py write
 * times, so a time from an audio tool can go straight into a psvtool op.
 */
export function formatClock(secs: number): string {
  const totalCs = Math.round(secs * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  return `${Math.floor(totalMin / 60)}:${pad2(totalMin % 60)}:${pad2(s)}.${pad2(cs)}`;
}

/** "H:MM:SS(.ss)", "MM:SS(.ss)" or "SS(.ss)" as seconds; null if malformed. */
export function parseClock(text: string): number | null {
  const m = /^(?:(?:(\d+):)?(\d{1,2}):)?(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3]);
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
