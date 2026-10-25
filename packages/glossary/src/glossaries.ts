import type { Glossary } from "./index";

// Each glossary lists only words an agent is unlikely to know: local
// acronyms, committees, places and events. Words any English speaker or any
// model knows (culvert, Chugach, Iditarod) stay out, even when speech
// recognition mishears them. A word goes in the glossary of the region
// everyone likely to say it is in: the Assembly talks about GBOS, so "GBOS" is
// in Anchorage's glossary, while Girdwood's own committees are in Girdwood's.
// People's names aren't here; they are in the people records.

const alaska: Glossary = {
  slug: "alaska",
  appliesTo: { jurisdictions: ["ak"] },
  entries: [
    {
      headword: "Dena'ina",
      meaning: "The Alaska Native people of the Cook Inlet region",
      misheard: ["Denina"],
    },
    {
      headword: "Alutiiq",
      meaning: "The Alaska Native people of the Gulf of Alaska coast",
      misheard: ["Elkick"],
    },
  ],
};

const anchorage: Glossary = {
  slug: "moa",
  extends: ["alaska"],
  appliesTo: { jurisdictions: ["moa"] },
  entries: [
    {
      headword: "AMC",
      meaning: "Anchorage Municipal Code",
      variants: ["Anchorage Municipal Code"],
      misheard: ["anchor municipal code"],
    },
    { headword: "AO", meaning: "Assembly Ordinance", misheard: ["A o"] },
    { headword: "AR", meaning: "Assembly Resolution", misheard: ["Error"] },
    { headword: "AM", meaning: "Assembly Memorandum" },
    { headword: "AIM", meaning: "Assembly Information Memorandum" },
    {
      headword: "PZC",
      meaning: "Planning and Zoning Commission",
      misheard: ["PCC", "PC C"],
    },
    { headword: "FCC", meaning: "Federation of Community Councils" },
    {
      headword: "GBOS",
      meaning: "Girdwood Board of Supervisors",
      misheard: [
        "G Boss",
        "GBoss",
        "GBUS",
        "Gibos",
        "DBoss",
        "G Voss",
        "JBOS",
        "CBAS",
        "GPS",
        "Goss",
      ],
    },
    {
      headword: "Chugiak",
      misheard: ["Touge", "Chugyak", "Chugia", "Shuyak"],
    },
    {
      headword: "Rondy",
      meaning: "Fur Rendezvous, Anchorage's winter festival",
      misheard: ["Rondi"],
    },
    {
      headword: "Bowl",
      meaning: "The Anchorage Bowl, the basin most of the city is in",
      misheard: ["bull"],
    },
    {
      headword: "Trackless",
      meaning: "A small tractor that clears snow from sidewalks",
      misheard: ["track list"],
    },
  ],
};

const girdwood: Glossary = {
  slug: "girdwood",
  extends: ["moa"],
  appliesTo: { bodies: ["gbos", "luc"] },
  entries: [
    {
      headword: "GHEC",
      meaning: "Girdwood Housing and Economic Committee",
      misheard: [
        "GHC",
        "GHTC",
        "GATC",
        "GACC",
        "GAGEC",
        "GHBC",
        "TTC",
        "H C C",
      ],
    },
    {
      headword: "PSAC",
      meaning: "Public Safety Advisory Committee",
      misheard: ["Peace AC", "Peace Act", "P SEC"],
    },
    {
      headword: "GVSA",
      meaning: "Girdwood Valley Service Area",
      misheard: ["GDSA", "GBSA"],
    },
    {
      headword: "LUC",
      meaning: "Girdwood Land Use Committee",
      misheard: ["OUC", "OEC", "LEC", "LC"],
    },
    { headword: "GTC", meaning: "Girdwood Trails Committee" },
    {
      headword: "Herbal Cache",
      misheard: ["verbal cash", "purple cash", "Oval Catch"],
    },
    {
      headword: "Forest Fair",
      meaning: "Girdwood's summer arts and music festival",
      misheard: ["forest fare", "force fair", "four sphere", "for spare"],
    },
    { headword: "Holtan Hills", misheard: ["Hulting", "Holton"] },
    { headword: "Winner Creek", misheard: ["Winter Creek"] },
  ],
};

/** Every glossary, the most general first. */
export const GLOSSARIES: readonly Glossary[] = [alaska, anchorage, girdwood];
