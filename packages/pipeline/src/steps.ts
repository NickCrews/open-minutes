import type { AudioProvider } from "@open-minutes/core/audio-provider";
import {
  alignSpeakers,
  cleanSpeechSegments,
  type DiarizationTurn,
  segmentsToTurns,
  type SpeechSegment,
  type TranscriptSegment,
} from "@open-minutes/core/transcription";
import { transcribeAudio } from "@open-minutes/audio/transcribe";
import { computeSpeakerEmbeddings } from "@open-minutes/audio/embed";
import { diarizeAudio } from "@open-minutes/audio/diarize";
import {
  artifactPath,
  readArtifact,
  requireAudio,
  writeArtifact,
} from "./work-dir";

// The steps that turn a meeting's audio into a transcript, each reading the
// artifacts of the steps before it from the meeting's work directory and
// writing its own there:
//
//   downloadAudio → transcribe → clean ─┐
//                 → diarize ────────────┴→ align → embedSpeakers
//
// then recognizeSpeakers (./recognize.ts) and saveTranscript (./save.ts).
// Each one runs when called, replacing its artifact; nothing chains them. A
// missing artifact names the function that writes it.

/** On-disk shape of diarization.json. */
export interface DiarizationArtifact {
  turns: DiarizationTurn[];
}

/**
 * On-disk shape of embeddings.json: one voiceprint centroid per speaker
 * number. An array rather than a keyed object so the speaker number stays a
 * number; JSON object keys are always strings.
 */
export type EmbeddingsArtifact = Array<{ speaker: number; centroid: number[] }>;

const wordCount = (segments: ReadonlyArray<{ words: unknown[] }>) =>
  segments.reduce((n, s) => n + s.words.length, 0);

const speakerCount = (items: ReadonlyArray<{ speakerNum: number | null }>) =>
  new Set(items.flatMap((i) => (i.speakerNum === null ? [] : [i.speakerNum])))
    .size;

/**
 * Download a meeting's audio from its site into `dir` as 16 kHz mono WAV. An
 * existing file is kept unless `overwrite` is set.
 */
export async function downloadAudio(
  site: AudioProvider,
  siteId: string,
  dir: string,
  options: { overwrite?: boolean } = {},
): Promise<{ path: string; downloaded: boolean }> {
  const path = artifactPath(dir, "audio");
  const { downloaded } = await site.ensureAudioDownloaded(
    siteId,
    path,
    options,
  );
  return { path, downloaded };
}

/**
 * Recognize the words in the audio: transcription.json, the recognizer's
 * verbatim output, one speech segment per VAD run.
 */
export async function transcribe(
  dir: string,
): Promise<{ speechSegments: number; words: number }> {
  const segments = await transcribeAudio(requireAudio(dir));
  await writeArtifact(dir, "transcription", segments);
  return { speechSegments: segments.length, words: wordCount(segments) };
}

/**
 * Strip disfluencies (fillers, stutters, ...) from transcription.json into
 * cleaned.json. transcription.json stays verbatim, so a changed cleaning rule
 * applies by running this again, without transcribing again.
 */
export async function clean(
  dir: string,
): Promise<{ wordsBefore: number; wordsAfter: number }> {
  const raw = await readArtifact<SpeechSegment[]>(
    dir,
    "transcription",
    "transcribe",
  );
  const cleaned = cleanSpeechSegments(raw);
  await writeArtifact(dir, "cleaned", cleaned);
  return { wordsBefore: wordCount(raw), wordsAfter: wordCount(cleaned) };
}

/**
 * Split the audio into diarization turns and cluster them by voice:
 * diarization.json. Knows nothing about words or who anyone is.
 */
export async function diarize(
  dir: string,
): Promise<{ turns: number; speakers: number }> {
  const turns = diarizeAudio(requireAudio(dir));
  await writeArtifact(dir, "diarization", { turns });
  return { turns: turns.length, speakers: speakerCount(turns) };
}

/**
 * Assign each cleaned word to the diarization turn it overlaps most, and
 * group consecutive same-speaker words into segments: segments.json.
 */
export async function align(
  dir: string,
): Promise<{ segments: number; speakers: number }> {
  const cleaned = await readArtifact<SpeechSegment[]>(dir, "cleaned", "clean");
  const { turns } = await readArtifact<DiarizationArtifact>(
    dir,
    "diarization",
    "diarize",
  );
  const segments = alignSpeakers(cleaned, turns).filter(
    (segment) => segment.words.length > 0,
  );
  await writeArtifact(dir, "segments", segments);
  return { segments: segments.length, speakers: speakerCount(segments) };
}

/**
 * One voiceprint per speaker number, from the audio of their aligned
 * segments: embeddings.json. A speaker with too little speech gets none.
 */
export async function embedSpeakers(
  dir: string,
): Promise<{ speakers: number; embedded: number }> {
  const audio = requireAudio(dir);
  const segments = await readArtifact<TranscriptSegment[]>(
    dir,
    "segments",
    "align",
  );
  const embeddings: EmbeddingsArtifact = [
    ...computeSpeakerEmbeddings(audio, segmentsToTurns(segments)),
  ].map(([speaker, centroid]) => ({ speaker, centroid: Array.from(centroid) }));
  await writeArtifact(dir, "embeddings", embeddings);
  return { speakers: speakerCount(segments), embedded: embeddings.length };
}
