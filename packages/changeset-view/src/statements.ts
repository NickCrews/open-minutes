// A changeset's SQL as its statements, each with the comment written above
// it, so they can be run, shown and reviewed one at a time.

import { parseClock } from "@open-minutes/core/clock";

export interface Statement {
  /** The statement's SQL, without the comment above it, ending in ";". */
  sql: string;
  /**
   * The comment above it, and any on the rest of its last line, without the
   * comment markers; null when there's none.
   */
  comment: string | null;
  /** The line its SQL starts on, from 1. */
  line: number;
  /**
   * The om function it calls, such as "replace_words" or "assert", for a
   * `SELECT om.<function>(...)`; else its first keyword in upper case, such
   * as "UPDATE".
   */
  kind: string;
  /** The first onset among its string arguments, in seconds; null if none. */
  at: number | null;
}

/**
 * Split SQL into statements at the semicolons outside strings, quoted
 * identifiers and comments. Text after the last semicolon that is only
 * comments and whitespace is dropped; any other text after it is a statement
 * of its own, without a semicolon.
 */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let comments: string[] = [];
  let start = -1; // where the current statement's code starts
  let i = 0;
  const finish = (end: number) => {
    const text = sql.slice(start, end).trim();
    statements.push({
      sql: text,
      comment: comments.length ? comments.join("\n") : null,
      line: lineOf(sql, start),
      ...describe(text),
    });
    comments = [];
    start = -1;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const end = indexOrEnd(sql, "\n", i);
      const text = sql.slice(i + 2, end).replace(/^ /, "");
      if (start === -1) {
        // A comment on the line a statement ended on belongs to it.
        const last = statements.at(-1);
        const lineStart = sql.lastIndexOf("\n", i - 1) + 1;
        if (last && sql.slice(lineStart, i).includes(";"))
          last.comment = last.comment ? `${last.comment}\n${text}` : text;
        else comments.push(text);
      }
      i = end;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = blockCommentEnd(sql, i);
      if (start === -1)
        comments.push(
          sql
            .slice(i + 2, end - 2)
            .split("\n")
            .map((l) => l.replace(/^\s*\*? ?/, ""))
            .join("\n")
            .trim(),
        );
      i = end;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      if (start === -1) start = i;
      if (c === ";") {
        finish(i + 1);
        i++;
      } else if (c === "'") {
        const escapes =
          /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? "");
        i = quotedEnd(sql, i, "'", escapes);
      } else if (c === '"') {
        i = quotedEnd(sql, i, '"', false);
      } else if (c === "$") {
        const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
        if (tag && !/\w/.test(sql[i - 1] ?? "")) {
          i = indexOrEnd(sql, tag[0], i + tag[0].length) + tag[0].length;
        } else i++;
      } else i++;
    }
  }
  if (start !== -1) finish(sql.length);
  return statements;
}

function indexOrEnd(text: string, search: string, from: number): number {
  const at = text.indexOf(search, from);
  return at === -1 ? text.length : at;
}

/** Just past the end of the /* comment at `from`; Postgres nests them. */
function blockCommentEnd(sql: string, from: number): number {
  let depth = 0;
  for (let i = from; i < sql.length; i++) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth++;
      i++;
    } else if (sql[i] === "*" && sql[i + 1] === "/") {
      depth--;
      i++;
      if (!depth) return i + 1;
    }
  }
  return sql.length;
}

/** Just past the end of the string or identifier quoted with `q` at `from`. */
function quotedEnd(
  sql: string,
  from: number,
  q: string,
  backslashEscapes: boolean,
): number {
  for (let i = from + 1; i < sql.length; i++) {
    if (backslashEscapes && sql[i] === "\\") i++;
    else if (sql[i] === q) {
      if (sql[i + 1] === q) i++;
      else return i + 1;
    }
  }
  return sql.length;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

function describe(sql: string): Pick<Statement, "kind" | "at"> {
  const call = /^select\s+om\.(\w+)\s*\(/i.exec(sql);
  const kind = call
    ? call[1]!.toLowerCase()
    : (/^\w+/.exec(sql)?.[0].toUpperCase() ?? "SQL");
  let at: number | null = null;
  for (const [, literal] of sql.matchAll(/'((?:[^']|'')*)'/g)) {
    if (/^\d+:\d{2}:\d{2}(\.\d+)?$/.test(literal!)) {
      at = parseClock(literal!);
      break;
    }
  }
  return { kind, at };
}
