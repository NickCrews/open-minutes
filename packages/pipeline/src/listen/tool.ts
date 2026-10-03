import { z } from "zod";
import type { DB } from "@open-minutes/db";
import { formatClock, parseClock } from "./clock";
import { ListenError, type ListenMeeting, openMeeting } from "./meeting";

// The audio tools share @open-minutes/tools' shape (a name, a description
// written for a model, a zod input schema, a run function), but run against a
// meeting's audio rather than only its rows, so they live with the models in
// the pipeline package. See ./cli.ts for the shell interface.

/** What a tool runs against: meetings, opened once per process. */
export interface ListenContext {
  meeting(ref: string): Promise<ListenMeeting>;
}

export function listenContext(getDb: () => Promise<DB>): ListenContext {
  const open = new Map<string, Promise<ListenMeeting>>();
  return {
    meeting(ref) {
      let m = open.get(ref);
      if (!m) {
        m = openMeeting(ref, getDb);
        open.set(ref, m);
      }
      return m;
    },
  };
}

export interface ListenTool<I extends z.ZodType = z.ZodType, O = unknown> {
  /** snake_case, as models expect tool names. */
  name: string;
  /** What it does and when to use it, written for the model calling it. */
  description: string;
  input: I;
  run: (ctx: ListenContext, input: z.infer<I>) => Promise<O>;
}

export function defineListenTool<I extends z.ZodType, O>(
  tool: ListenTool<I, O>,
) {
  return tool;
}

/** A tool's input as JSON Schema, for tool-calling APIs. */
export function parametersOf(tool: ListenTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: "input" }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema;
}

/** Validate raw input (eg a model's tool-call arguments) and run the tool. */
export async function callListenTool<O>(
  ctx: ListenContext,
  tool: ListenTool<z.ZodType, O>,
  raw: unknown,
): Promise<O> {
  const parsed = tool.input.safeParse(raw ?? {});
  if (!parsed.success)
    throw new ListenError(
      `Invalid input for ${tool.name}:\n${z.prettifyError(parsed.error)}`,
    );
  return tool.run(ctx, parsed.data);
}

// --- Shared input fields ---

export const meetingRef = z
  .string()
  .describe(
    'A golden fixture name (a directory under packages/fixtures/test-data/meetings/, eg "gbos_9HoIM5INxpI") or a database meeting id (eg "12").',
  );

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
    throw new ListenError(
      `"to" (${formatClock(to)}) must be after "from" (${formatClock(from)})`,
    );
  if (to - from > maxSecs)
    throw new ListenError(
      `Range is ${Math.round(to - from)} s; this tool takes at most ${maxSecs} s at a time.`,
    );
}
