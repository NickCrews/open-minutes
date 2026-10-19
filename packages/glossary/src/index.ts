// Glossaries: the local words a body's meetings use, what they mean and how
// speech recognition mishears them. A glossary covers a region (Anchorage,
// Girdwood) rather than one body, and builds on the glossaries of the regions
// around it, so a word is listed once for everyone likely to say it. A
// meeting's glossary merges the glossaries of every body that held it.
//
// For now the glossaries are static data in ./glossaries.ts. They are plain
// objects shaped like the rows they would be in a database, and callers only
// see them through the async glossaryFor, so they can move into the database
// without the callers changing.

import { GLOSSARIES } from "./glossaries";

/** One word or phrase in a glossary. */
export interface GlossaryEntry {
  /** The correct spelling, eg "GHEC" or "Herbal Cache". */
  headword: string;
  /** What it stands for or refers to, for a reader who doesn't know. */
  meaning?: string;
  /** Other correct ways of writing it, eg "Anchorage Municipal Code" for "AMC". */
  variants?: string[];
  /** How speech recognition has heard it, eg "G Boss" for "GBOS". */
  misheard?: string[];
}

/** The words of one region. */
export interface Glossary {
  /** Eg "girdwood". */
  slug: string;
  /** Slugs of the glossaries this one builds on, which apply wherever it does. */
  extends?: string[];
  /** Where it applies: everywhere, or in these jurisdictions and bodies, by slug. */
  appliesTo: "everywhere" | { jurisdictions?: string[]; bodies?: string[] };
  entries: GlossaryEntry[];
}

/** A body a meeting was held by, as glossaries pick their bodies. */
export interface GlossaryBody {
  slug: string;
  jurisdictionSlug: string;
}

/** Everything that applies to a meeting, from the glossaries of its bodies. */
export interface MeetingGlossary {
  /** Slugs of the glossaries that apply, the most general first. */
  glossaries: string[];
  entries: GlossaryEntry[];
}

/**
 * The glossary of a meeting held by `bodies`: every glossary that applies to
 * any of them, and every glossary those build on, merged.
 */
export async function glossaryFor(
  bodies: readonly GlossaryBody[],
): Promise<MeetingGlossary> {
  return mergeGlossaries(GLOSSARIES, bodies);
}

/** {@link glossaryFor} over the given glossaries. */
export function mergeGlossaries(
  glossaries: readonly Glossary[],
  bodies: readonly GlossaryBody[],
): MeetingGlossary {
  const bySlug = new Map(glossaries.map((g) => [g.slug, g]));
  const applied: Glossary[] = [];
  // Depth-first, a glossary after the ones it builds on.
  const add = (glossary: Glossary) => {
    if (applied.includes(glossary)) return;
    for (const slug of glossary.extends ?? []) {
      const base = bySlug.get(slug);
      if (!base)
        throw new Error(`Glossary ${glossary.slug} extends unknown ${slug}`);
      add(base);
    }
    applied.push(glossary);
  };
  for (const glossary of glossaries)
    if (bodies.some((body) => appliesTo(glossary, body))) add(glossary);
  return {
    glossaries: applied.map((g) => g.slug),
    entries: applied.flatMap((g) => g.entries),
  };
}

function appliesTo(glossary: Glossary, body: GlossaryBody): boolean {
  const where = glossary.appliesTo;
  if (where === "everywhere") return true;
  return (
    !!where.jurisdictions?.includes(body.jurisdictionSlug) ||
    !!where.bodies?.includes(body.slug)
  );
}

export { GLOSSARIES };
