import { z } from "zod";
import type { DB } from "@open-minutes/db";

// The shape every tool shares, kept free of any one agent framework: a name, a
// description written for a model, a zod input schema (exported as JSON
// Schema), and a function over the database. `toAgentTool` adapts one to the
// `AgentTool` shape pi (and similar loops) use; the CLI exposes the same list
// as JSON over a shell.

/** A database handle or an open transaction on one. */
export type Db = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

export interface Tool<I extends z.ZodType = z.ZodType, O = unknown> {
  /** snake_case, as models expect tool names. */
  name: string;
  /** Short human-readable name, for UIs. */
  label: string;
  /** What it does and when to use it, written for the model calling it. */
  description: string;
  input: I;
  run: (db: Db, input: z.infer<I>) => Promise<O>;
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
  db: Db,
  tool: Tool<z.ZodType, O>,
  raw: unknown,
): Promise<O> {
  const parsed = tool.input.safeParse(raw ?? {});
  if (!parsed.success)
    throw new ToolError(
      `Invalid input for ${tool.name}:\n${z.prettifyError(parsed.error)}`,
    );
  return tool.run(db, parsed.data);
}

/**
 * The tool as a pi `AgentTool` (from `@mariozechner/pi-agent-core`), without
 * depending on pi: pi validates `parameters` as JSON Schema, and a thrown
 * error becomes a failed tool call the model sees.
 */
export function toAgentTool<O>(tool: Tool<z.ZodType, O>, db: Db) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: parametersOf(tool),
    execute: async (_toolCallId: string, params: unknown) => {
      const details = await callTool(db, tool, params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      };
    },
  };
}
