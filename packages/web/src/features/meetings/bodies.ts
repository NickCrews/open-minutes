/**
 * The bodies that held a meeting, as a `with` on a meetings query: what a page
 * needs to name, link and draw them, in a stable order (alphabetical), since
 * none of them comes first.
 */
export const meetingBodiesColumns = {
  columns: { id: true, name: true, name_short: true },
  orderBy: { name: "asc" },
} as const;
