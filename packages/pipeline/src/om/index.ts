// Programmatic API behind the `om` CLI. The CLI commands only parse arguments
// and wire stdio; scripts, tests, and future services should call these.
export { listMeetings, type MeetingStatus } from "./meetings";
export {
  listAvailable,
  scrapeAvailable,
  type AvailableVideo,
  type ListAvailableOptions,
} from "./available";
export { discoverMeetings, type DiscoveredMeeting } from "./discover";
export {
  processMeeting,
  processMeetings,
  listPending,
  DEFAULT_WORK_ROOT,
  type ProcessOptions,
  type ProcessResult,
  type ProcessBatchSummary,
  type PendingMeeting,
  type ListPendingOptions,
  type StepOutcome,
} from "./process";
export {
  ingestVideo,
  ingestVideos,
  type IngestOptions,
  type IngestResult,
  type IngestBatchSummary,
} from "./ingest";
export { STEPS, type Step } from "./steps";
export {
  stepState,
  describeState,
  HUMAN_VERSION,
  UNTRACKED_VERSION,
  MAX_ATTEMPTS,
  type StepState,
} from "./runs";
export { TRANSCRIPT_VERSION } from "./transcript";
