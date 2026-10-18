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
// And in Anchorage, whose glossary names these as body-specific rules (see
// BODY_RULE_SPECS in ./index.ts), since other places number their bills, code
// and agendas their own way:
//
//   - Bills: "AO 2026-20", "AR 2026-7", "AO 2025-144(S)", "AO 2025-74(S-2)",
//     "AM 142-2026", "AIM 25-2026"; "AO 2026 unnumbered" before it has one.
//   - Code: "AMC 3.70.190", "AMC 25.35.060C", "21.05.040G.2.b", "Title 21",
//     "chapter 21.05", "AS 44.62.310".
//   - Agenda items: "item 10.B.1", "14.C", "9.A".
//   - Zoning districts: "R-4", "R-2M", "B-3", "CE-R-10", "gR-1", "gC-8".
//
// Each rule is its own module, named for its code; this one holds the
// helpers they share. A rule's fix writes what it found the style's way
// when the words alone say how, and leaves the rest for a person. Two kinds
// of finding. Most rules match only text that
// is wrong wherever it appears, like "AR 2026 48" or "ten dollars", and
// report errors. The spelled-number and split-numeral rules report warnings:
// number words the style writes as numerals, and numerals said as two
// numbers, which can be right in a phrase they don't know ("a hundred and
// ten percent sure" is caught, but "one of the twenty" may be a name).

import type { AtWord, Fixed, RuleMeeting, Violation } from "./common";

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
  /** The words to write in their place, if the words alone say what they are. */
  replacement?: string[];
}

/**
 * The finding for `count` words from `index`, and the words to write in
 * their place, if known. A replacement leaves out the punctuation before
 * the first word and after the last, which the fix keeps.
 */
export function finding(
  index: number,
  words: readonly string[],
  count: number,
  message: string,
  replacement?: string[],
): Finding {
  return {
    index,
    text: words.slice(index, index + count).join(" "),
    message,
    ...(replacement && { replacement }),
  };
}

/** A number, time, sum, date or identifier not written the transcript's way. */
export type WrittenForm<Code extends string> = Violation<Code> &
  AtWord & {
    /** The words at fault. */
    text: string;
    /**
     * The words to write in their place, punctuation around them aside,
     * when the words alone say what they are.
     */
    replacement?: string[];
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
        ...(f.replacement && { replacement: f.replacement }),
      })),
    );
}

/** The punctuation before a word and after it, as `core` strips it. */
function surrounding(text: string): [string, string] {
  const c = core(text);
  const start = text.indexOf(c);
  return [text.slice(0, start), text.slice(start + c.length)];
}

/**
 * A written-form rule's fix: writes each violation's replacement in place of
 * its words, keeping the punctuation before the first and after the last
 * (one period serves both "p.m." and the sentence's end). The first new word
 * takes the first old word's onset and other properties, the second the
 * second's, and any beyond the last old word's. Violations without a
 * replacement, or overlapping one written before them, are left.
 */
export function rewrite<M extends RuleMeeting, V extends WrittenForm<string>>(
  meeting: M,
  violations: readonly V[],
): Fixed<M, V> {
  const bySegment = new Map<number, V[]>();
  for (const v of violations)
    if (v.replacement?.length)
      bySegment.set(v.segmentIndex, [
        ...(bySegment.get(v.segmentIndex) ?? []),
        v,
      ]);
  if (bySegment.size === 0) return { meeting, fixed: [] };
  const fixed: V[] = [];
  const segments = meeting.segments.map((seg, segmentIndex) => {
    const found = bySegment.get(segmentIndex);
    if (!found) return seg;
    const words = [...seg.words];
    // From the end, so earlier indices stay put.
    let next = Infinity;
    for (const v of [...found].sort((a, b) => b.wordIndex - a.wordIndex)) {
      const count = v.text.split(" ").length;
      const old = words.slice(v.wordIndex, v.wordIndex + count);
      if (
        v.wordIndex + count > next ||
        old.map((w) => w.text).join(" ") !== v.text
      )
        continue;
      const [before] = surrounding(old[0]!.text);
      const [, after] = surrounding(old.at(-1)!.text);
      const texts = [...v.replacement!];
      texts[0] = before + texts[0];
      const last = texts.at(-1)!;
      texts[texts.length - 1] =
        last +
        (last.endsWith(".") && after.startsWith(".") ? after.slice(1) : after);
      words.splice(
        v.wordIndex,
        count,
        ...texts.map((text, k) => ({ ...old[Math.min(k, count - 1)]!, text })),
      );
      next = v.wordIndex;
      fixed.push(v);
    }
    return { ...seg, words };
  });
  if (fixed.length === 0) return { meeting, fixed };
  return { meeting: { ...meeting, segments }, fixed: fixed.reverse() };
}

// Reading spoken numbers. Each reader takes a run of words (number words and
// numerals, punctuation around them aside) and gives its value only when the
// words allow one reading, so a fix never guesses.

type Part =
  | { kind: "ones" | "teen" | "tens" | "hundred" | "multiplier"; value: number }
  | { kind: "numeral"; value: number };

/** One word's parts: "twenty-five" is a tens and a ones. */
function parts(text: string): { parts: Part[]; ordinal: boolean } | undefined {
  const c = core(text)
    .toLowerCase()
    .replace(/^\$|%$/g, "");
  if (/^\d+(\.\d+)?$/.test(c) || /^\d{1,3}(,\d{3})+$/.test(c))
    return {
      parts: [{ kind: "numeral", value: Number(c.replaceAll(",", "")) }],
      ordinal: false,
    };
  const out: Part[] = [];
  for (const p of c.split("-")) {
    const v = wordValue(p);
    if (v === undefined) return undefined;
    out.push({
      kind:
        v === 100
          ? "hundred"
          : v >= 1000
            ? "multiplier"
            : v >= 20
              ? "tens"
              : v >= 10
                ? "teen"
                : "ones",
      value: v,
    });
  }
  return out.length ? { parts: out, ordinal: isOrdinalWord(c) } : undefined;
}

/** What a run of words reads as: its value, and whether it ends in an ordinal. */
export interface Reading {
  value: number;
  ordinal: boolean;
}

/**
 * A number said the usual way: "thirty-six thousand", "two hundred fifty",
 * "one hundred and" aside (no "and"), "1.2 million", "twenty fourth". Not
 * "twenty twenty six" or "one fifty five", which say digits.
 */
export function cardinal(texts: readonly string[]): Reading | undefined {
  const all: Part[] = [];
  let ordinal = false;
  for (const [i, t] of texts.entries()) {
    const p = parts(t);
    if (!p || (p.ordinal && i < texts.length - 1)) return undefined;
    all.push(...p.parts);
    ordinal = p.ordinal;
  }
  if (all.length === 1 && all[0]!.value === 0) return { value: 0, ordinal };
  // The group below 1000 being built, and what it has had: ones, teens,
  // tens, hundred. A multiplier closes it.
  let total = 0;
  let group = 0;
  let state: "none" | "ones" | "teen" | "tens" | "hundred" | "done" = "none";
  let lastMultiplier = Infinity;
  for (const p of all) {
    if (p.value === 0 && p.kind !== "numeral") return undefined;
    switch (p.kind) {
      case "numeral":
        if (state !== "none") return undefined;
        group = p.value;
        state = "done";
        break;
      case "ones":
        if (state === "none") state = "ones";
        else if (state === "tens" || state === "hundred") state = "done";
        else return undefined;
        group += p.value;
        break;
      case "teen":
      case "tens":
        if (state !== "none" && state !== "hundred") return undefined;
        group += p.value;
        state = p.kind === "teen" ? "done" : "tens";
        break;
      case "hundred":
        if (state !== "ones") return undefined;
        group *= 100;
        state = "hundred";
        break;
      case "multiplier":
        if (state === "none" || p.value >= lastMultiplier) return undefined;
        total += group * p.value;
        group = 0;
        lastMultiplier = p.value;
        state = "none";
        break;
    }
  }
  if (state === "none" && lastMultiplier === Infinity) return undefined;
  return { value: total + group, ordinal };
}

/**
 * A number said as groups of digits: "one ninety" is 190, "twenty twenty
 * six" 2026, "oh six oh" 060. Only ones, teens, tens and numerals of digits;
 * a tens word takes the ones word after it ("twenty six" is 26).
 */
export function digits(texts: readonly string[]): string | undefined {
  if (texts.length === 1 && /^\d+$/.test(core(texts[0]!)))
    return core(texts[0]!);
  const all: Part[] = [];
  for (const t of texts) {
    if (core(t).toLowerCase() === "oh") {
      all.push({ kind: "ones", value: 0 });
      continue;
    }
    const p = parts(t);
    if (!p || p.ordinal) return undefined;
    all.push(...p.parts);
  }
  let out = "";
  for (let i = 0; i < all.length; i++) {
    const p = all[i]!;
    const after = all[i + 1];
    if (p.kind === "tens" && after?.kind === "ones" && after.value > 0) {
      out += String(p.value + after.value);
      i++;
    } else if (p.kind === "ones" || p.kind === "teen" || p.kind === "tens")
      out += String(p.value);
    else return undefined;
  }
  return out || undefined;
}

/**
 * A year said as two pairs of digits: "nineteen ninety", "twenty twenty
 * six", "twenty oh five", "nineteen hundred".
 */
export function year(texts: readonly string[]): number | undefined {
  const first = core(texts[0] ?? "").toLowerCase();
  if (first !== "nineteen" && first !== "twenty") return undefined;
  const century = first === "nineteen" ? 1900 : 2000;
  const rest = texts.slice(1).map((t) => core(t).toLowerCase());
  if (rest.length === 1 && rest[0] === "hundred") return century;
  const d = digits(texts.slice(1));
  if (d === undefined || d.length !== 2) return undefined;
  // "twenty five" alone is 25, and "twenty oh" nothing.
  if (rest[0] !== "oh" && d[0] === "0") return undefined;
  if (rest[0] === "oh" && rest.length !== 2) return undefined;
  if (rest[0] !== "oh" && Number(d) < 10) return undefined;
  return century + Number(d);
}

/** "1st", "2nd", "3rd", "11th", "22nd". */
export function ordinalSuffix(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/** A number in numerals, with commas from 1,000 up: "36,000", "1.5". */
export function numeral(n: number): string {
  const [whole, fraction] = String(n).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+$)/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * An amount as written before a unit: "36,000", "1.2 million", "5 billion".
 * A whole number of millions or billions keeps the word.
 */
export function amount(n: number): string[] {
  for (const [word, size] of [
    ["billion", 1e9],
    ["million", 1e6],
  ] as const) {
    if (n < size) continue;
    // "1.25 million", but "1,250,300".
    const scaled = Math.round((n / size) * 100) / 100;
    if (Math.abs(scaled * size - n) < 1e-6) return [numeral(scaled), word];
  }
  return [numeral(n)];
}

/**
 * Where the spoken amount that ends at `words[end]` starts: back over
 * numbers, to the start of the phrase. "a" before a leading "hundred",
 * "thousand" or "million" counts, as one.
 */
export function amountStart(words: readonly string[], end: number): number {
  let i = end;
  while (i > 0 && endsAmount(words, i - 1)) i--;
  if (
    i > 0 &&
    core(words[i - 1]!) === "a" &&
    !endsPhrase(words[i - 1]!) &&
    core(words[i]!).toLowerCase() in MULTIPLIERS
  )
    i--;
  return i;
}

/** The value of the amount in `texts`, as `amountStart` bounds it. */
export function amountValue(texts: readonly string[]): number | undefined {
  const t = core(texts[0] ?? "") === "a" ? ["one", ...texts.slice(1)] : texts;
  return cardinal(t)?.value;
}
