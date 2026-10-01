// Spotting a speaker who says who they are ("my name is Bryan Burnett",
// "this is Brianna"), to catch segments labelled as the wrong person. Speech
// recognition misspells names, so matching is fuzzy; see selfIntroductions.

/** Someone a speaker could introduce themselves as. */
export interface NamedPerson {
  slug: string;
  /** Display name; a parenthetical like "(GBOS co-chair)" is ignored. */
  name: string;
}

/** A self-introduction found in a run of words. */
export interface SelfIntroduction<P extends NamedPerson = NamedPerson> {
  /** Index of the word the phrase starts at. */
  word: number;
  /** The words as spoken, eg "this is uh Brian Burnett". */
  phrase: string;
  person: P;
}

// "my name is Bryan Burnett", "this is Brianna", "I'm Nick Crews"
const INTRO_PATTERNS = [
  ["my", "name", "is"],
  ["this", "is"],
  ["im"],
  ["i", "am"],
];
const FILLERS = new Set(["uh", "um", "and", "so", "here", "again"]);

/**
 * Known people a run of words (one speaker's turn) introduces as the speaker.
 * A bare first name only counts at the end of the turn or before a filler, so
 * "this is Kyle's report" doesn't read as Kyle introducing himself.
 */
export function selfIntroductions<P extends NamedPerson>(
  words: readonly { text: string }[],
  people: readonly P[],
): SelfIntroduction<P>[] {
  const tokens = words.map((w) => w.text.toLowerCase().replace(/[^a-z]/g, ""));
  const names = people.map((p) => {
    const [first = "", ...rest] = p.name
      .replace(/\(.*?\)/g, "")
      .trim()
      .toLowerCase()
      .split(/\s+/);
    return { person: p, first, last: rest.at(-1) ?? "" };
  });
  const found: SelfIntroduction<P>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const pattern of INTRO_PATTERNS) {
      if (!pattern.every((t, k) => tokens[i + k] === t)) continue;
      let j = i + pattern.length;
      while (FILLERS.has(tokens[j] ?? "")) j++; // "this is uh Bryan"
      const a = tokens[j];
      const b = tokens[j + 1];
      if (!a) continue;
      const match = names.find(
        (n) =>
          n.first.length > 2 &&
          editDistance(a, n.first) <= 1 &&
          // Surnames are where speech recognition goes wrong ("Nick Cruz"),
          // so an exact first name only needs the surname's initial.
          (b === undefined ||
            FILLERS.has(b) ||
            (n.last !== "" &&
              (editDistance(b, n.last) <= 2 ||
                (a === n.first && b[0] === n.last[0])))),
      );
      if (match) {
        const end = j + (b && !FILLERS.has(b) ? 2 : 1);
        found.push({
          word: i,
          phrase: words
            .slice(i, end)
            .map((w) => w.text)
            .join(" "),
          person: match.person,
        });
      }
    }
  }
  return found;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = Math.min(
        up + 1,
        row[j - 1]! + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return row[b.length]!;
}
