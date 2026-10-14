// How a transcript writes numbers, times, money and the identifiers a
// legislature uses. The recognizer writes these several ways ("AO twenty
// twenty six dash twenty", "AR 2026 48", "10 B1", "11 15 AM", "five thousand
// dollar"); a transcript reads and searches better with one.
//
// The style, in brief. Anywhere:
//
//   - Numbers: words for zero to nine, numerals from 10 up, and numerals for
//     every year, time, date, sum of money, percentage, tally, address and
//     identifier. A sentence may start with a spelled-out number.
//   - Numbers with a spoken separator in digits: "3.70.190", "2026-23", "4.3",
//     not "three dot seventy" or "six dash two".
//   - Times: "7 p.m.", "11:30 a.m.", "7:30".
//   - Money: "$10", "$36,000", "$1.2 million", "$130,331.31".
//   - Percentages: "1%", "3.79%".
//   - Dates: "February 17, 2026", "March 19"; "the 27th" when the month
//     isn't said. Months capitalized: "in July".
//   - Tallies: "passes 5-0", "on a vote of 12 to 0".
//
// And in Anchorage, which a jurisdiction opts into (see LOCAL_STYLE_RULE_SPECS
// in ./index.ts), since other places number their bills, code and agendas
// their own way:
//
//   - Bills: "AO 2026-20", "AR 2026-7", "AO 2025-144(S)", "AO 2025-74(S-2)",
//     "AM 142-2026", "AIM 25-2026"; "AO 2026 unnumbered" before it has one.
//   - Code: "AMC 3.70.190", "AMC 25.35.060C", "21.05.040G.2.b", "Title 21",
//     "chapter 21.05", "AS 44.62.310".
//   - Agenda items: "item 10.B.1", "14.C", "9.A".
//   - Zoning districts: "R-4", "R-2M", "B-3", "CE-R-10", "gR-1", "gC-8".
//
// Each rule is its own module, named for its code; this one holds the
// helpers they share. Two kinds of finding. Most rules match only text that
// is wrong wherever it appears, like "AR 2026 48" or "ten dollars", and
// report errors. The spelled-number and split-numeral rules report warnings:
// number words the style writes as numerals, and numerals said as two
// numbers, which can be right in a phrase they don't know ("a hundred and
// ten percent sure" is caught, but "one of the twenty" may be a name).

import type { AtWord, RuleMeeting, Violation } from "./common";

/** A word without its leading and trailing punctuation ("$" and "%" stay). */
export function core(text: string): string {
  return text.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "");
}

const ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
export const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
export const MULTIPLIERS: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1e6,
  billion: 1e9,
};
/** Ordinals by the cardinal they come from: "twentieth" is 20. */
const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
  hundredth: 100,
  thousandth: 1000,
};

/**
 * The value of one spelled-out number word, hyphenated compounds included
 * ("twenty-five", "forty-ninth"), or undefined.
 */
export function wordValue(text: string): number | undefined {
  const parts = core(text).toLowerCase().split("-");
  if (parts.length > 2) return undefined;
  let total = 0;
  for (const p of parts) {
    const v = ONES[p] ?? TENS[p] ?? MULTIPLIERS[p] ?? ORDINALS[p];
    if (v === undefined) return undefined;
    total += v;
  }
  return total;
}

export function isNumberWord(text: string): boolean {
  return wordValue(text) !== undefined;
}

export function isOrdinalWord(text: string): boolean {
  const last = core(text).toLowerCase().split("-").at(-1)!;
  return last in ORDINALS;
}

/** A word written in digits, "$" and "%" aside: "12", "3.5", "36,000", "11:30". */
export function isNumeral(text: string): boolean {
  return /^\$?\d[\d,.:]*%?$/.test(core(text));
}

export function isNumber(text: string): boolean {
  return isNumeral(text) || isNumberWord(text);
}

/** Whether a sentence ends after `text`. */
export function endsSentence(text: string): boolean {
  return /[.?!]["')\]]*$/.test(text);
}

/** Whether `text` carries punctuation that separates it from the next word. */
export function endsPhrase(text: string): boolean {
  return /[.,;:?!]["')\]]*$/.test(text);
}

/** Whether `words[i]` ends a spoken amount: "ten", "36,000", "five million". */
export function endsAmount(words: readonly string[], i: number): boolean {
  const w = words[i];
  return w !== undefined && !endsPhrase(w) && isNumber(w);
}

export const MONTHS =
  /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i;

/** Some words at fault, found by a rule in one speaker's words. */
export interface Finding {
  /** Index of the first word. */
  index: number;
  /** The words, joined by spaces. */
  text: string;
  /** What to write instead. */
  message: string;
}

/** The finding for `count` words from `index`. */
export function finding(
  index: number,
  words: readonly string[],
  count: number,
  message: string,
): Finding {
  return { index, text: words.slice(index, index + count).join(" "), message };
}

/** A number, time, sum, date or identifier not written the transcript's way. */
export type WrittenForm<Code extends string> = Violation<Code> &
  AtWord & {
    /** The words at fault. */
    text: string;
  };

/**
 * A rule from what `find` reports in each segment's word texts, at the word
 * each finding starts at.
 */
export function wordRule<Code extends string>(
  code: Code,
  find: (words: readonly string[]) => Finding[],
): (meeting: RuleMeeting) => WrittenForm<Code>[] {
  return (meeting) =>
    meeting.segments.flatMap(({ words }, segmentIndex) =>
      find(words.map((w) => w.text)).map((f) => ({
        code,
        message: `${JSON.stringify(f.text)}: ${f.message}`,
        segmentIndex,
        wordIndex: f.index,
        atSecs: words[f.index]!.start,
        text: f.text,
      })),
    );
}
