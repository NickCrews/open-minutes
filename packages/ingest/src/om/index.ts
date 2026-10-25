// The ingestion API. The `om` CLI in @open-minutes/cli is a thin development
// wrapper over it that only parses arguments and wires stdio; scripts, tests,
// and services call these directly.
export { listIngested, type IngestedMeeting } from "./ingested";
export {
  listAvailable,
  type AvailableMeeting,
  type ListAvailableOptions,
} from "./available";
export {
  ingestMeeting,
  ingestMeetings,
  DEFAULT_WORK_ROOT,
  type IngestOptions,
  parseMeetingLines,
  type MeetingToIngest,
  type IngestResult,
  type IngestBatchSummary,
} from "./ingest";
export {
  listerFor,
  parseMeetingRef,
  type SiteMeeting,
  type Sites,
} from "./sites";
