// Programmatic API behind the `om` CLI. The CLI commands only parse arguments
// and wire stdio; scripts, tests, and future services should call these.
export { listIngested, type IngestedMeeting } from "./ingested";
export { listAvailable, type ListAvailableOptions } from "./available";
export {
  ingestVideo,
  ingestVideos,
  DEFAULT_WORK_ROOT,
  type IngestOptions,
  type IngestResult,
  type IngestBatchSummary,
} from "./ingest";
