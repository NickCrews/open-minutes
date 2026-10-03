import { z } from "zod";
import type { DB } from "@open-minutes/db";
import type { AudioMeeting } from "./audio/meeting";

// The shape every tool shares, kept free of any one agent framework: a name, a
// description written for a model, a zod input schema (exported as JSON
// Schema), and a function over a {@link ToolContext}. `toAgentTool` adapts one
// to the `AgentTool` shape pi (and similar loops) use; the CLI exposes the
// same list as JSON over a shell.

/** A database handle or an open transaction on one. */
export type Db = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * What a tool runs against. Each part is opened on first use, so a tool that
 * only listens to a golden's audio never needs the database, and one that only
 * edits rows never loads a model. Make one with `toolContext`.
 */
export interface ToolContext {
  /** The database. */
  db(): Promise<Db>;
  /**
   * A meeting's audio and transcript, by golden fixture name or database
   * meeting id. Opened once per context.
   */
  meeting(ref: string): Promise<AudioMeeting>;
}

export interface Tool<I extends z.ZodType = z.ZodType, O = unknown> {
  /** snake_case, as models expect tool names. */
  name: string;
  /** Short human-readable name, for UIs. */
  label: string;
  /** What it does and when to use it, written for the model calling it. */
  description: string;
  input: I;
  run: (ctx: ToolContext, input: z.infer<I>) => Promise<O>;
}

/** A tool that refuses a call: bad input, or a reference to nothing. */
export class ToolError extends Error {
  override name = "ToolError";
}

export function defineTool<I extends z.ZodType, O>(tool: Tool<I, O>) {
  return tool;
}

/** A tool's input as JSON Schema, for tool-calling APIs. */
export function parametersOf(tool: Tool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: "input" }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema;
}

/** Validate raw input (eg a model's tool-call arguments) and run the tool. */
export async function callTool<O>(
  ctx: ToolContext,
  tool: Tool<z.ZodType, O>,
  raw: unknown,
): Promise<O> {
  const parsed = tool.input.safeParse(raw ?? {});
  if (!parsed.success)
    throw new ToolError(
      `Invalid input for ${tool.name}:\n${z.prettifyError(parsed.error)}`,
    );
  return tool.run(ctx, parsed.data);
}

/**
 * The tool as a pi `AgentTool` (from `@mariozechner/pi-agent-core`), without
 * depending on pi: pi validates `parameters` as JSON Schema, and a thrown
 * error becomes a failed tool call the model sees.
 */
export function toAgentTool<O>(tool: Tool<z.ZodType, O>, ctx: ToolContext) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: parametersOf(tool),
    execute: async (_toolCallId: string, params: unknown) => {
      const details = await callTool(ctx, tool, params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      };
    },
  };
}
