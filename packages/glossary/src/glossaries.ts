import type { Glossary } from "./index";

// Each glossary lists the words of a region that anyone meeting there is
// likely to say, not only the words of one body: the Assembly talks about
// Girdwood, so "Girdwood" is in Anchorage's glossary, while Girdwood's own
// committees are in Girdwood's. People's names aren't here; they are in the
// people records.

const common: Glossary = {
  slug: "common",
  appliesTo: "everywhere",
  entries: [
    {
      headword: "roll call",
      misheard: ["low cloud", "a local", "all course", "well quote"],
    },
    { headword: "I'll second", misheard: ["All seconds"] },
    { headword: "Mr. Chair", misheard: ["Mr. Terry", "Mr. Cheerio"] },
    {
      headword: "dais",
      meaning: "The raised platform the members sit at",
      misheard: ["the diet", "the diocese"],
    },
    { headword: "hydrant", misheard: ["hybrid"] },
    { headword: "culvert", misheard: ["covert"] },
    { headword: "levee", misheard: ["levy"] },
    {
      headword: "the Corps",
      meaning: "The U.S. Army Corps of Engineers",
      misheard: ["the core"],
    },
    { headword: "land use plan", misheard: ["language plan"] },
    { headword: "graders", misheard: ["creators"] },
    { headword: "berms", misheard: ["burns", "farms"] },
    {
      headword: "as-built",
      meaning: "A drawing of a project as it was actually built",
      misheard: ["As Bill"],
    },
  ],
};

const alaska: Glossary = {
  slug: "alaska",
  extends: ["common"],
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
    {
      headword: "Chugach",
      misheard: ["Tree Gatch", "Shu Gach", "Chu Getch", "Tugetch"],
    },
    {
      headword: "Turnagain",
      misheard: ["Turing", "Turning", "Tornigan", "turning an arm"],
    },
    { headword: "Iditarod", misheard: ["Diderot", "editor on"] },
    { headword: "Whittier", misheard: ["Woody", "wittier", "WIDIA"] },
    {
      headword: "Glenn Highway",
      misheard: ["Glen Highway", "old lane highway", "gun highway"],
    },
  ],
};

const anchorage: Glossary = {
  slug: "moa",
  extends: ["alaska"],
  appliesTo: { jurisdictions: ["moa"] },
  rules: ["bill-number", "code-section", "agenda-item", "zoning-district"],
  entries: [
    { headword: "Anchorage", misheard: ["acridge"] },
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
      headword: "Girdwood",
      misheard: [
        "Gridwood",
        "Goodwood",
        "good wood",
        "Girtwood",
        "Guardwood",
        "Gerwood",
        "Birdwood",
        "Gergher",
        "Grid",
        "Grim",
        "Girdle",
      ],
    },
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
    { headword: "Alyeska", misheard: ["Alias", "Aliaska", "LSC"] },
    {
      headword: "Chugiak",
      misheard: ["Touge", "Chugyak", "Chugia", "Shuyak"],
    },
    { headword: "Muldoon", misheard: ["Moldum"] },
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
export const GLOSSARIES: readonly Glossary[] = [
  common,
  alaska,
  anchorage,
  girdwood,
];
