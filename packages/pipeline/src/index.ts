// The pipeline's steps, each its own function: discover meetings on bodies'
// meeting sources, add one to the database, and turn its audio into a saved
// transcript one step at a time (see ./steps.ts for the order). The agent
// tools in @open-minutes/agents call these; nothing here runs one step after
// another.
export {
  discoverMeetings,
  type DiscoverOptions,
  type DiscoveredMeeting,
} from "./discover";
export { addMeeting, type AddedMeeting } from "./add";
export type { Db } from "./db";
export {
  align,
  clean,
  diarize,
  type DiarizationArtifact,
  downloadAudio,
  embedSpeakers,
  type EmbeddingsArtifact,
  transcribe,
} from "./steps";
export { recognizeSpeakers, type RecognitionArtifact } from "./recognize";
export { saveTranscript } from "./save";
export {
  listerFor,
  parseMeetingRef,
  type SiteMeeting,
  type Sites,
  withDefaultSites,
} from "./sites";
export {
  ARTIFACTS,
  artifactPath,
  DEFAULT_WORK_ROOT,
  meetingWorkDir,
  PipelineError,
  workDirName,
} from "./work-dir";
