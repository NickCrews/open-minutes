import type { RuleMeeting, Severity } from "./common";
import {
  cardinal,
  core,
  digits,
  endsPhrase,
  type Finding,
  finding,
  isNumber,
  rewrite,
  wordRule,
  type WrittenForm,
} from "./numbers";

export const code = "spoken-separator";

export type SpokenSeparator = WrittenForm<typeof code>;

export const defaultSeverity = "error" satisfies Severity;

const SEPARATORS: Record<string, string> = {
  dot: ".",
  dots: ".",
  point: ".",
  dash: "-",
  slash: "/",
};

/** A number word or numeral that can be part of a number with separators. */
function isPart(text: string): boolean {
  return isNumber(text) && !/^(million|billion)$/i.test(core(text));
}

function isSeparator(words: readonly string[], i: number): boolean {
  const w = words[i];
  return (
    w !== undefined &&
    core(w).toLowerCase() in SEPARATORS &&
    !endsPhrase(w) &&
    i > 0 &&
    isPart(words[i - 1]!) &&
    !endsPhrase(words[i - 1]!) &&
    isPart(words[i + 1] ?? "")
  );
}

/** One part between separators in digits: "seventy" is "70", "one ninety" "190". */
function partDigits(texts: readonly string[]): string | undefined {
  if (texts.length === 1 && /^\d([\d.\-/]*\d)?$/.test(core(texts[0]!)))
    return core(texts[0]!);
  if (texts.some((t) => /^(hundred|thousand)$/i.test(core(t)))) {
    const read = cardinal(texts);
    return read && !read.ordinal && Number.isInteger(read.value)
      ? String(read.value)
      : undefined;
  }
  return digits(texts);
}

/**
 * A number with "dot", "dash", "slash" or "point" spoken in it: "3.70.190",
 * "2026-23", "4.3", not "three dot seventy", "six dash two" or "four point
 * three". Reported once for the whole number, from the first number word
 * before the first separator to the last after the last.
 */
function find(words: readonly string[]): Finding[] {
  const found: Finding[] = [];
  let i = 0;
  while (i < words.length) {
    if (!isSeparator(words, i)) {
      i++;
      continue;
    }
    let start = i - 1;
    while (
      start > 0 &&
      isPart(words[start - 1]!) &&
      !endsPhrase(words[start - 1]!)
    )
      start--;
    const parts = [words.slice(start, i)];
    const separators: string[] = [];
    let end = i;
    while (isSeparator(words, end)) {
      separators.push(SEPARATORS[core(words[end]!).toLowerCase()]!);
      let k = end + 1;
      while (
        k < words.length &&
        isPart(words[k]!) &&
        (k === end + 1 || !endsPhrase(words[k - 1]!))
      )
        k++;
      parts.push(words.slice(end + 1, k));
      end = k;
    }
    const written = parts.map(partDigits);
    const replacement = written.every((d) => d !== undefined)
      ? [written.map((d, k) => (k ? separators[k - 1]! : "") + d).join("")]
      : undefined;
    found.push(
      finding(
        start,
        words,
        end - start,
        `write a number with a spoken separator in digits, eg "3.70.190", "2026-23", "4.3"`,
        replacement,
      ),
    );
    i = end;
  }
  return found;
}

export const rule: (meeting: RuleMeeting) => SpokenSeparator[] = wordRule(
  code,
  find,
);

/** Writes the number in digits: "three dot seventy" as "3.70". */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly SpokenSeparator[],
) {
  return rewrite(meeting, violations);
}
