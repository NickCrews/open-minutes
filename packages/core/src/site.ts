/**
 * The sites recordings are published on. A recording's ID on its site is a
 * YouTube video ID, or an akleg.gov meeting ID ("HRES 2018-09-10 14:00:00").
 */
export const SITES = ["youtube", "akleg"] as const;
export type Site = (typeof SITES)[number];
