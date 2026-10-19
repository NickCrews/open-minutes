import type { RuleMeeting, Severity } from "./common";
import {
  core,
  type Finding,
  finding,
  rewrite,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "code-section";

export type CodeSection = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

/**
 * A section with its dots, when the digits say where they go: a 1- or
 * 2-digit title, a 2-digit chapter and a 3-digit section, as "21.09050" or
 * "2103050" for 21.09.050.
 */
function sectionDots(c: string): string | undefined {
  const m =
    /^(\d{1,2})\.(\d{2})(\d{3})$/.exec(c) ??
    /^(\d{1,2})(\d{2})(\d{3})$/.exec(c);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined;
}

/**
 * Anchorage Municipal Code sections, title.chapter.section: "AMC 3.70.190",
 * "25.35.060C", "21.05.040G.2.b". Catches a dropped or extra dot
 * ("21.09050", "2103050", "3.3.144"). Alaska Statutes share the shape
 * ("AS 44.62.310").
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  words.forEach((w, i) => {
    const c = core(w);
    if (/^\d+\.\d+\.\d+/.test(c)) {
      if (!/^\d{1,2}\.\d{2}\.\d{3}([A-Z](\.\d+(\.[a-z])?)?)?$/.test(c))
        found.push(
          finding(
            i,
            words,
            1,
            `write a code section as "21.05.040", with any subsection after it as "21.05.040G.2.b"`,
          ),
        );
      return;
    }
    const before = core(words[i - 1] ?? "").toLowerCase();
    if (
      ["amc", "section", "sections", "chapter", "chapters"].includes(before) &&
      (/^\d{5,}$/.test(c) || /^\d+\.\d{4,}$/.test(c))
    ) {
      const section = sectionDots(c);
      found.push(
        finding(
          i,
          words,
          1,
          `write a code section as "21.05.040" and a chapter as "21.05"`,
          section === undefined ? undefined : [section],
        ),
      );
    }
  });
  return found;
}

export const rule: (meeting: RuleMeeting) => CodeSection[] = wordRule(
  code,
  find,
);

/** Writes the section with its dots, when the digits say where they go. */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly CodeSection[],
) {
  return rewrite(meeting, violations);
}
