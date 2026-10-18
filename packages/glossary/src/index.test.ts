import { describe, expect, it } from "vitest";
import { GLOSSARIES, glossaryFor, mergeGlossaries } from "./index";

const gbos = { slug: "gbos", jurisdictionSlug: "moa" };
const assembly = { slug: "assembly", jurisdictionSlug: "moa" };
const hres = { slug: "hres", jurisdictionSlug: "ak" };
const headwords = (g: { entries: { headword: string }[] }) =>
  g.entries.map((e) => e.headword);

describe("glossaryFor", () => {
  it("gives a Girdwood body every glossary from common to Girdwood's", async () => {
    const g = await glossaryFor([gbos]);
    expect(g.glossaries).toEqual(["common", "alaska", "moa", "girdwood"]);
    expect(g.rules).toEqual([
      "bill-number",
      "code-section",
      "agenda-item",
      "zoning-district",
    ]);
    expect(headwords(g)).toEqual(
      expect.arrayContaining(["roll call", "Dena'ina", "AMC", "GHEC"]),
    );
  });

  it("gives an Anchorage body Girdwood's name but not its committees", async () => {
    const g = await glossaryFor([assembly]);
    expect(g.glossaries).toEqual(["common", "alaska", "moa"]);
    expect(headwords(g)).toContain("Girdwood");
    expect(headwords(g)).not.toContain("GHEC");
  });

  it("gives a Legislature committee Alaska's words and no rules", async () => {
    const g = await glossaryFor([hres]);
    expect(g.glossaries).toEqual(["common", "alaska"]);
    expect(g.rules).toEqual([]);
  });

  it("gives a body no glossary names only the common one", async () => {
    const g = await glossaryFor([{ slug: "x", jurisdictionSlug: "y" }]);
    expect(g.glossaries).toEqual(["common"]);
  });

  it("merges a joint meeting's glossaries once each", async () => {
    const g = await glossaryFor([gbos, assembly]);
    expect(g.glossaries).toEqual(["common", "alaska", "moa", "girdwood"]);
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
