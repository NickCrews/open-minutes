import { z } from "zod";
import { ToolError } from "../tool";
import { formatClock, parseClock } from "./clock";

// Inputs the audio tools share. The meeting is `meetingRef`, as for every tool.

export { meetingRef } from "../meeting-ref";

/** A time: seconds, or a clock string as psvtool.py prints ("1:02:03.45"). */
export const time = z
  .union([z.number().nonnegative(), z.string()])
  .transform((v, ctx) => {
    if (typeof v === "number") return v;
    const secs = parseClock(v);
    if (secs === null) {
      ctx.addIssue({ code: "custom", message: `Not a time: ${v}` });
      return z.NEVER;
    }
    return secs;
  })
  .describe('Seconds (eg 3723.4) or "H:MM:SS.ss" (eg "1:02:03.40").');

/** Check a [from, to] range and that it fits in `maxSecs`. */
export function checkRange(from: number, to: number, maxSecs: number): void {
  if (to <= from)
    throw new ToolError(
      `"to" (${formatClock(to)}) must be after "from" (${formatClock(from)})`,
    );
  if (to - from > maxSecs)
    throw new ToolError(
      `Range is ${Math.round(to - from)} s; this tool takes at most ${maxSecs} s at a time.`,
    );
}
