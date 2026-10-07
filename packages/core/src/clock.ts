/**
 * Seconds as "H:MM:SS.ss", rounded to the hundredth: how golden PSV files,
 * psvtool.py, the agent tools and their messages write times.
 */
export function formatClock(secs: number): string {
  const totalCs = Math.round(secs * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  return `${Math.floor(totalMin / 60)}:${pad2(totalMin % 60)}:${pad2(s)}.${pad2(cs)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
