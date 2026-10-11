// How a transcript writes numbers, times, money and the identifiers a
// legislature uses: AO 2026-23, AMC 21.05.040G.2, item 10.B.1, 7:30 p.m.,
// $36,000, 3.79%, March 19, R-4. The recognizer writes these several ways
// ("AO twenty twenty six dash twenty", "AR 2026 48", "10 B1", "11 15 AM",
// "five thousand dollar"); a transcript reads and searches better with one.
//
// The style, in brief:
//
//   - Numbers: words for zero to nine, numerals from 10 up, and numerals for
//     every year, time, date, sum of money, percentage, tally, address and
//     identifier. A sentence may start with a spelled-out number.
//   - Bills: "AO 2026-20", "AR 2026-7", "AO 2025-144(S)", "AO 2025-74(S-2)",
//     "AM 142-2026", "AIM 25-2026"; "AO 2026 unnumbered" before it has one.
//   - Code: "AMC 3.70.190", "AMC 25.35.060C", "21.05.040G.2.b", "Title 21",
//     "chapter 21.05", "AS 44.62.310".
//   - Agenda items: "item 10.B.1", "14.C", "9.A".
//   - Zoning districts: "R-4", "R-2M", "B-3", "GR-1", "GC-8", "CE-R-10".
//   - Times: "7 p.m.", "11:30 a.m.", "7:30".
//   - Money: "$10", "$36,000", "$1.2 million", "$130,331.31".
//   - Percentages: "1%", "3.79%".
//   - Dates: "February 17, 2026", "March 19"; "the 27th" when the month
//     isn't said.
//   - Tallies: "passes 5-0", "on a vote of 12 to 0".
//
// Two kinds of finding. WRITTEN_FORM_RULES match only text that is wrong
// wherever it appears, like "AR 2026 48" or "ten dollars". spelledNumbers()
// finds number words that the style writes as numerals, which can be right in
// a phrase it doesn't know ("a hundred and ten percent sure" is caught, but
// "one of the twenty" may be a name).

import type { TranscriptWord } from "./types";

/** One word (or the first of a run of words) written the wrong way. */
export interface WrittenFormIssue {
  /** Index into the words passed in. */
  index: number;
  /** Name of the rule that found it, eg "bill-number". */
  rule: string;
  /** The words at fault, joined by spaces. */
  text: string;
  /** What to write instead. */
  message: string;
}

export interface WrittenFormRule {
  name: string;
  /** Issues in one speaker's words, in order. */
  find(words: readonly string[]): Omit<WrittenFormIssue, "rule">[];
}

// ---------------------------------------------------------------------------
// Word helpers

/** A word without its leading and trailing punctuation ("$" and "%" stay). */
function core(text: string): string {
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
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const MULTIPLIERS: Record<string, number> = {
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
function wordValue(text: string): number | undefined {
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

function isNumberWord(text: string): boolean {
  return wordValue(text) !== undefined;
}

function isOrdinalWord(text: string): boolean {
  const last = core(text).toLowerCase().split("-").at(-1)!;
  return last in ORDINALS;
}

/** A word written in digits, "$" and "%" aside: "12", "2026-23", "3.5". */
function isNumeral(text: string): boolean {
  return /^\$?\d[\d,.:]*%?$/.test(core(text));
}

function isNumber(text: string): boolean {
  return isNumeral(text) || isNumberWord(text);
}

/** Whether a sentence ends after `text`. */
function endsSentence(text: string): boolean {
  return /[.?!]["')\]]*$/.test(text);
}

/** Whether `text` carries punctuation that separates it from the next word. */
function endsPhrase(text: string): boolean {
  return /[.,;:?!]["')\]]*$/.test(text);
}

const issue = (
  index: number,
  words: readonly string[],
  count: number,
  message: string,
) => ({ index, text: words.slice(index, index + count).join(" "), message });

// ---------------------------------------------------------------------------
// Rules

/**
 * Anchorage bills: "AO 2026-20", "AR 2026-7", "AO 2025-144(S)", "AM 142-2026".
 * Catches the recognizer's "AR 2026 48", "AO2026-23", "A02026-27",
 * "AO 2025-144S" and "AR 26-36".
 */
export const billNumberRule: WrittenFormRule = {
  name: "bill-number",
  find(words) {
    const found: Omit<WrittenFormIssue, "rule">[] = [];
    words.forEach((w, i) => {
      const c = core(w);
      if (/^(AO|AR|AM|AIM|A0)\d/.test(c)) {
        found.push(
          issue(
            i,
            words,
            1,
            `write a bill as "AO 2026-23": a space after the prefix, and the letter O, not zero`,
          ),
        );
        return;
      }
      if (!/^(AO|AR|AIM|AM)$/.test(c) || endsPhrase(w)) return;
      const next = words[i + 1];
      if (next === undefined) return;
      const n = next.replace(/[.,;:?!]+$/, "");
      if (!/^\d/.test(n)) return;
      const ok =
        c === "AM" || c === "AIM"
          ? /^\d{1,4}-\d{4}$/.test(n)
          : /^\d{4}-\d{1,4}(\(S(-\d+)?\))?$/.test(n) ||
            (/^\d{4}$/.test(n) &&
              !endsPhrase(next) &&
              core(words[i + 2] ?? "").toLowerCase() === "unnumbered");
      if (!ok)
        found.push(
          issue(
            i,
            words,
            2,
            c === "AM" || c === "AIM"
              ? `write an assembly memorandum as "${c} 142-2026"`
              : `write a bill as "${c} 2026-23", a substitute as "${c} 2025-144(S)" or "(S-2)", and one not yet numbered as "${c} 2026 unnumbered"`,
          ),
        );
    });
    return found;
  },
};

/**
 * Code sections: "AMC 3.70.190", "25.35.060C", "21.05.040G.2.b". Catches
 * a dropped or extra dot ("21.09050", "2103050", "3.3.144") and "dot" or
 * "dash" or "slash" spoken between numbers.
 */
export const codeSectionRule: WrittenFormRule = {
  name: "code-section",
  find(words) {
    const found: Omit<WrittenFormIssue, "rule">[] = [];
    words.forEach((w, i) => {
      const c = core(w);
      const lower = c.toLowerCase();
      if (
        ["dot", "dots", "dash", "slash", "point"].includes(lower) &&
        !endsPhrase(w) &&
        i > 0 &&
        isNumber(words[i - 1]!) &&
        !endsPhrase(words[i - 1]!) &&
        i + 1 < words.length &&
        isNumber(words[i + 1]!)
      ) {
        found.push(
          issue(
            i - 1,
            words,
            3,
            `write a number with "${lower}" in it in digits, eg "3.70.190", "2026-23", "4.3"`,
          ),
        );
        return;
      }
      // Sections are title.chapter.section: "21.05.040", then any subsection.
      if (/^\d+\.\d+\.\d+/.test(c)) {
        if (!/^\d{1,2}\.\d{2}\.\d{3}([A-Z](\.\d+(\.[a-z])?)?)?$/.test(c))
          found.push(
            issue(
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
        ["amc", "section", "sections", "chapter", "chapters"].includes(
          before,
        ) &&
        (/^\d{5,}$/.test(c) || /^\d+\.\d{4,}$/.test(c))
      )
        found.push(
          issue(
            i,
            words,
            1,
            `write a code section as "21.05.040" and a chapter as "21.05"`,
          ),
        );
    });
    return found;
  },
};

/** Agenda items: "10.B.1", "14.C", not "10 B1", "10A1" or "14B". */
export const agendaItemRule: WrittenFormRule = {
  name: "agenda-item",
  find(words) {
    const found: Omit<WrittenFormIssue, "rule">[] = [];
    words.forEach((w, i) => {
      const c = core(w);
      if (/^\d{1,2}[A-H]\d{0,2}$/.test(c)) {
        found.push(
          issue(
            i,
            words,
            1,
            `write an agenda item with dots, as "10.B.1" or "14.C"`,
          ),
        );
        return;
      }
      const next = words[i + 1];
      if (
        /^\d{1,2}$/.test(c) &&
        !endsPhrase(w) &&
        next !== undefined &&
        /^[A-H]\d{0,2}$/.test(core(next))
      )
        found.push(
          issue(
            i,
            words,
            2,
            `write an agenda item with dots, as "10.B.1" or "14.C"`,
          ),
        );
    });
    return found;
  },
};

// Districts are numbered 1 to 10; "R19" is something else, like a permit.
const ZONING = /^(R|B|I|GR|GC|GT|CER|CEB|CE-R|CE-B)(([1-9]|10)[A-Z]?)$/;

/** Zoning districts: "R-4", "R-2M", "B-3", "GR-1", "GC-8", "CE-R-10". */
export const zoningDistrictRule: WrittenFormRule = {
  name: "zoning-district",
  find(words) {
    const found: Omit<WrittenFormIssue, "rule">[] = [];
    words.forEach((w, i) => {
      const m = ZONING.exec(core(w));
      // "10 B1" is an agenda item, found by agendaItemRule.
      if (m && !/^\d{1,2}$/.test(words[i - 1] ?? ""))
        found.push(
          issue(
            i,
            words,
            1,
            `write a zoning district with a hyphen, as "${m[1]!.replace(/^CE-?/, "CE-")}-${m[2]}"`,
          ),
        );
    });
    return found;
  },
};

/** Times: "7 p.m.", "11:30 a.m.", not "7 PM", "eleven AM", "504 p.m.". */
export const timeRule: WrittenFormRule = {
  name: "time",
  find(words) {
    const found: Omit<WrittenFormIssue, "rule">[] = [];
    words.forEach((w, i) => {
      if (i === 0) return;
      const prev = words[i - 1]!;
      if (endsPhrase(prev) || !isNumber(prev)) return;
      const c = core(w);
      const meridiem = /^(a\.m|p\.m)$/.test(c)
        ? "ok"
        : /^(AM|PM|am|pm|A\.M|P\.M)$/.test(c) ||
            (/^[ap]$/i.test(c) && /^m\b/i.test(words[i + 1] ?? ""))
          ? "bad"
          : null;
      if (meridiem === "bad")
        found.push(
          issue(
            i - 1,
            words,
            2,
            `write a time as "7 p.m." or "11:30 a.m.", in numerals with "a.m." or "p.m."`,
          ),
        );
      else if (meridiem === "ok" && !/^\d{1,2}(:\d{2})?$/.test(core(prev)))
        found.push(
          issue(
            i - 1,
            words,
            2,
            `write a time in numerals with a colon, as "5:04 p.m." or "11 a.m."`,
          ),
        );
    });
    return found;
  },
};

/** Whether `words[i]` ends a spoken amount: "ten", "36,000", "five million". */
function endsAmount(words: readonly string[], i: number): boolean {
  const w = words[i];
  return w !== undefined && !endsPhrase(w) && isNumber(w);
}

/** Money: "$10", "$36,000", "$1.5 million", not "ten dollars" or "5,000 dollar". */
export const moneyRule: WrittenFormRule = {
  name: "money",
  find(words) {
    const found: Omit<WrittenFormIssue, "rule">[] = [];
    words.forEach((w, i) => {
      const c = core(w).toLowerCase();
      if (/^dollars?$/.test(c) && endsAmount(words, i - 1))
        found.push(
          issue(
            i - 1,
            words,
            2,
            `write a sum of money as "$10", "$36,000" or "$1.5 million"`,
          ),
        );
      else if (/^cents?$/.test(c) && i > 0 && isNumberWord(words[i - 1]!))
        found.push(
          issue(i - 1, words, 2, `write cents in numerals, as "6 cents"`),
        );
    });
    return found;
  },
};

/** Percentages: "1%", "3.79%", "100%", not "one percent". */
export const percentRule: WrittenFormRule = {
  name: "percent",
  find(words) {
    const found: Omit<WrittenFormIssue, "rule">[] = [];
    words.forEach((w, i) => {
      if (/^percent$/i.test(core(w)) && endsAmount(words, i - 1))
        found.push(
          issue(i - 1, words, 2, `write a percentage as "1%" or "3.79%"`),
        );
    });
    return found;
  },
};

const MONTHS =
  /^(January|February|March|April|May|June|July|August|September|October|November|December)$/;

/** Dates: "March 19", not "March nineteenth", "March 19th" or "March nineteen". */
export const dateRule: WrittenFormRule = {
  name: "date",
  find(words) {
    const found: Omit<WrittenFormIssue, "rule">[] = [];
    words.forEach((w, i) => {
      const next = words[i + 1];
      if (!MONTHS.test(core(w)) || endsPhrase(w) || next === undefined) return;
      const n = core(next);
      // "the February one" is a pronoun, not a day.
      if (/^(the|this|that|next|last)$/i.test(core(words[i - 1] ?? ""))) return;
      // "May" is a verb as often as a month; only a day after it counts.
      if (
        /^\d{1,2}(st|nd|rd|th)$/.test(n) ||
        ((isNumberWord(next) || isOrdinalWord(next)) &&
          !(core(w) === "May" && !isOrdinalWord(next)))
      )
        found.push(
          issue(
            i,
            words,
            2,
            `write a date as "March 19", the day in numerals with no "th"`,
          ),
        );
    });
    return found;
  },
};

export const WRITTEN_FORM_RULES: readonly WrittenFormRule[] = [
  billNumberRule,
  codeSectionRule,
  agendaItemRule,
  zoningDistrictRule,
  timeRule,
  moneyRule,
  percentRule,
  dateRule,
];

/** What the rules find in one speaker's words, in word order. */
export function findWrittenFormIssues(
  words: readonly TranscriptWord[],
  rules: readonly WrittenFormRule[] = WRITTEN_FORM_RULES,
): WrittenFormIssue[] {
  const texts = words.map((w) => w.text);
  return rules
    .flatMap((rule) =>
      rule.find(texts).map((found) => ({ ...found, rule: rule.name })),
    )
    .sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Spelled-out numbers

/**
 * Number words the style writes as numerals: any run of two or more ("twenty
 * twenty six", "five zero", "one fifty five"), or one word worth 10 or more
 * ("eleven", "thirty-six", "fourteenth"). Not at the start of a sentence,
 * and not "hundred", "thousand" or "million" on their own ("a few hundred",
 * "a million reasons"). "oh" counts only between number words.
 */
export function spelledNumbers(
  words: readonly TranscriptWord[],
): WrittenFormIssue[] {
  const texts = words.map((w) => w.text);
  const found: WrittenFormIssue[] = [];
  const numeric = (i: number): boolean => {
    const t = texts[i];
    if (t === undefined) return false;
    const c = core(t).toLowerCase();
    if (c === "oh")
      return (
        i > 0 &&
        isNumberWord(texts[i - 1]!) &&
        !endsPhrase(texts[i - 1]!) &&
        isNumberWord(texts[i + 1] ?? "")
      );
    return isNumberWord(t);
  };
  let i = 0;
  while (i < texts.length) {
    if (!numeric(i)) {
      i++;
      continue;
    }
    let j = i + 1;
    // An ordinal ends a run, and only a tens word runs into one: "twenty
    // fourth", but "one second", "one third", "the first three".
    while (
      j < texts.length &&
      numeric(j) &&
      !endsPhrase(texts[j - 1]!) &&
      !isOrdinalWord(texts[j - 1]!) &&
      !(
        isOrdinalWord(texts[j]!) && !(core(texts[j - 1]!).toLowerCase() in TENS)
      )
    )
      j++;
    const run = texts.slice(i, j);
    const sentenceStart = i === 0 || endsSentence(texts[i - 1]!);
    const single = run.length === 1;
    const value = wordValue(run[0]!)!;
    const c = core(run[0]!).toLowerCase();
    const flagged =
      !single || (value >= 10 && !(c in MULTIPLIERS) && c !== "hundredth");
    if (flagged && !sentenceStart)
      found.push({
        index: i,
        rule: "spelled-number",
        text: run.join(" "),
        message: single
          ? `write a number of 10 or more in numerals ("11", "36", "14th")`
          : `write a spoken number in numerals ("2026", "155", "5-0", "907-243-VOTE")`,
      });
    i = j;
  }
  return found;
}

/**
 * Numerals said as two numbers but meant as one: "2026 48" (AR 2026-48),
 * "11 15" (11:15), "100 000" (100,000). Two numerals in a row with nothing
 * between them; a year then a count ("in 2024 30 people") is the exception
 * to look out for.
 */
export function splitNumerals(
  words: readonly TranscriptWord[],
): WrittenFormIssue[] {
  const texts = words.map((w) => w.text);
  const found: WrittenFormIssue[] = [];
  texts.forEach((t, i) => {
    const next = texts[i + 1];
    if (
      next !== undefined &&
      /^\d([\d,.]*\d)?$/.test(t) &&
      /^\d[\d,.]*[.,;:?!]?$/.test(next)
    )
      found.push({
        index: i,
        rule: "split-numeral",
        text: `${t} ${next}`,
        message: `two numerals in a row are usually one number: "2026-48", "11:15", "100,000"`,
      });
  });
  return found;
}
