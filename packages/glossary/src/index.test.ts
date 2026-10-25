import { describe, expect, it } from "vitest";
import { GLOSSARIES, glossaryFor, mergeGlossaries } from "./index";

const gbos = { slug: "gbos", jurisdictionSlug: "moa" };
const assembly = { slug: "assembly", jurisdictionSlug: "moa" };
const hres = { slug: "hres", jurisdictionSlug: "ak" };
const headwords = (g: { entries: { headword: string }[] }) =>
  g.entries.map((e) => e.headword);

describe("glossaryFor", () => {
  it("gives a Girdwood body every glossary from Alaska's to Girdwood's", async () => {
    const g = await glossaryFor([gbos]);
    expect(g.glossaries).toEqual(["alaska", "moa", "girdwood"]);
    expect(headwords(g)).toEqual(
      expect.arrayContaining(["Dena'ina", "AMC", "GHEC"]),
    );
  });

  it("gives an Anchorage body GBOS but not Girdwood's committees", async () => {
    const g = await glossaryFor([assembly]);
    expect(g.glossaries).toEqual(["alaska", "moa"]);
    expect(headwords(g)).toContain("GBOS");
    expect(headwords(g)).not.toContain("GHEC");
  });

  it("gives a Legislature committee Alaska's words", async () => {
    const g = await glossaryFor([hres]);
    expect(g.glossaries).toEqual(["alaska"]);
  });

  it("gives a body no glossary names no glossary", async () => {
    const g = await glossaryFor([{ slug: "x", jurisdictionSlug: "y" }]);
    expect(g).toEqual({ glossaries: [], entries: [] });
  });

  it("merges a joint meeting's glossaries once each", async () => {
    const g = await glossaryFor([gbos, assembly]);
    expect(g.glossaries).toEqual(["alaska", "moa", "girdwood"]);
  });

  it("applies the glossaries a glossary extends wherever it applies", () => {
    const g = mergeGlossaries(
      [
        { slug: "base", appliesTo: { bodies: [] }, entries: [] },
        {
          slug: "top",
          extends: ["base"],
          appliesTo: { bodies: ["gbos"] },
          entries: [],
        },
      ],
      [gbos],
    );
    expect(g.glossaries).toEqual(["base", "top"]);
  });
});

describe("GLOSSARIES", () => {
  it("have unique slugs and extend only glossaries that exist", () => {
    const slugs = GLOSSARIES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const g of GLOSSARIES)
      for (const base of g.extends ?? []) expect(slugs).toContain(base);
  });

  it("list each spelling once, as one entry's headword, variant or mishearing", () => {
    const forms = GLOSSARIES.flatMap((g) =>
      g.entries.flatMap((e) =>
        [e.headword, ...(e.variants ?? []), ...(e.misheard ?? [])].map((f) =>
          f.toLowerCase(),
        ),
      ),
    );
    expect(forms.filter((f, i) => forms.indexOf(f) !== i)).toEqual([]);
  });
});
