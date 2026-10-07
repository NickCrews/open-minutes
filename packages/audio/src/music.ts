/// <reference path="./sherpa-onnx-node.d.ts" />
import sherpa, { type AudioTagging, type WaveForm } from "sherpa-onnx-node";
import { ensureDownloaded, type ModelSpec } from "./model.js";
import { EXPECTED_SAMPLE_RATE } from "./embed.js";
import type { Span } from "./speech-runs.js";

// Where in the audio music plays: before a meeting, during a break, after it
// adjourns. VAD hears singing as speech and the recognizer transcribes it as
// lyrics, so the transcriber skips these stretches and marks them as music.
//
// CED (an audio transformer trained on AudioSet) scores each 10 s clip for
// AudioSet's 527 sound classes. A clip is music when "Music" is likely and
// "Speech" isn't: someone talking over music is speech, and is transcribed.
// Measured on the golden meetings, a music clip scores Music 0.4-0.9 and
// Speech under 0.3; a speech clip scores Music under 0.2, and a clip of
// talking over music scores Speech over 0.4.

export const MUSIC_MODEL_SPEC = {
  name: "sherpa-onnx-ced-tiny-audio-tagging-2024-04-19",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2",
  files: {
    "model.int8.onnx": true,
    "class_labels_indices.csv": true,
  },
} as const satisfies ModelSpec;

/** The clip length CED was trained on. */
const CLIP_SEC = 10;
/** A trailing clip shorter than this is too little to classify. */
const MIN_CLIP_SEC = 1;
const MIN_MUSIC_PROB = 0.3;
const MAX_SPEECH_PROB = 0.4;
/** How many AudioSet classes the model scores; compute() returns them all. */
const N_CLASSES = 527;

/** The probability of each class we look at, for one clip. */
export interface ClipScores {
  start: number;
  end: number;
  music: number;
  speech: number;
}

/** Every clip of `wave`, in time order, with its music and speech scores. */
export function scoreClips(wave: WaveForm): ClipScores[] {
  assertSampleRate(wave.sampleRate);
  const tagger = getTagger();
  const rate = wave.sampleRate;
  const clipSamples = CLIP_SEC * rate;
  const clips: ClipScores[] = [];
  for (let from = 0; from < wave.samples.length; from += clipSamples) {
    const to = Math.min(from + clipSamples, wave.samples.length);
    if (to - from < MIN_CLIP_SEC * rate) break;
    const stream = tagger.createStream();
    stream.acceptWaveform({
      sampleRate: rate,
      samples: wave.samples.subarray(from, to),
    });
    const events = tagger.compute(stream, N_CLASSES);
    const prob = (name: string) =>
      events.find((e) => e.name === name)?.prob ?? 0;
    clips.push({
      start: from / rate,
      end: to / rate,
      music: prob("Music"),
      speech: prob("Speech"),
    });
  }
  return clips;
}

export function isMusicClip(clip: ClipScores): boolean {
  return clip.music >= MIN_MUSIC_PROB && clip.speech < MAX_SPEECH_PROB;
}

/**
 * Every stretch of music in `wave`, in time order: runs of consecutive music
 * clips, so each starts and ends on a multiple of 10 s (or the audio's end).
 */
export function detectMusic(wave: WaveForm): Span[] {
  const spans: Span[] = [];
  for (const clip of scoreClips(wave)) {
    if (!isMusicClip(clip)) continue;
    const last = spans.at(-1);
    if (last && last.end === clip.start) last.end = clip.end;
    else spans.push({ start: clip.start, end: clip.end });
  }
  return spans;
}

let _tagger: AudioTagging | null = null;

function getTagger(): AudioTagging {
  if (_tagger) return _tagger;
  const files = ensureDownloaded(MUSIC_MODEL_SPEC).files;
  _tagger = new sherpa.AudioTagging({
    model: {
      ced: files["model.int8.onnx"],
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
    labels: files["class_labels_indices.csv"],
    topK: N_CLASSES,
  });
  return _tagger;
}

function assertSampleRate(actual: number): void {
  if (actual !== EXPECTED_SAMPLE_RATE) {
    throw new Error(
      `Music detection expects ${EXPECTED_SAMPLE_RATE} Hz mono audio, got ${actual} Hz.`,
    );
  }
}
