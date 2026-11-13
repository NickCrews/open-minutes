// What a changeset does, as data and as HTML, with nothing that needs a
// database or Node: the website imports this. "./build" computes a diff from
// a database; "./client.js" is the page's review form.
export {
  describeChange,
  describeRows,
  DIFF_ELEMENT_ID,
  renderPage,
  renderReport,
  STYLES,
} from "./render";
export { splitStatements, type Statement } from "./statements";
export type * from "./types";
export { diffSequences, diffTranscripts, type Op } from "./words";
