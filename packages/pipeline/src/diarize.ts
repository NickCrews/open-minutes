import { execSync } from "node:child_process";
import type { DiarizationTurn } from "./types.ts";
import sherpa from "sherpa-onnx-node";
import { ensureDownloaded } from "./model.js";

// Four-stage pipeline following OpenWhispr's local diarization architecture:
//   1. Silero VAD     — filter silence before expensive stages (~2MB model)
//   2. pyannote-3.0   — identify speaker boundaries + overlaps (~6.6MB ONNX)
//   3. CAM++          — 512-dim voice embeddings, half the params of ECAPA-TDNN (~28MB ONNX)
//   4. Agglomerative clustering — group embeddings at 0.5 cosine-similarity threshold

function ensurePyannote() {
  return ensureDownloaded(
    {
      name: "sherpa-onnx-pyannote-segmentation-3-0",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
      files: {
        "model.onnx": true,
      },
    }
  );
}

function ensureCamp() {
  return ensureDownloaded(
    {
      name: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recog-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.tar.bz2",
      files: {
        "model.onnx": true,
      },
    });
}

// function ensureSileroVAD() {
//   return ensureDownloaded({
//     name: "silero_vad",
//     url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
//     single_file: true,
//     files: {
//       "silero_vad.onnx": true,
//     },
//   });
// }

const SAMPLE_RATE = 16000;
const MIN_SEGMENT_SECS = 0.8; // below this, CAM++ embeddings are unreliable
const EMBEDDING_DIM = 512;

export interface DiarizationResult {
  turns: DiarizationTurn[];
  speakerEmbeddings: Map<number, Float32Array>; // local speaker id → 512-dim CAM++ fingerprint
}

export async function diarizeAudio(
  audioPath: string,
): Promise<DiarizationResult> {

  // Stages 1–4: VAD → segmentation → embedding → clustering (all within OfflineSpeakerDiarization)
  const sd = sherpa.createOfflineSpeakerDiarization({
    segmentation: {
      pyannote: {
        model: ensurePyannote().files["model.onnx"],
      },
    },
    embedding: {
      model: ensureCamp().files["model.onnx"],
    },
    clustering: {
      numClusters: -1,
      threshold: 0.5,
    },
    minDurationOn: MIN_SEGMENT_SECS,
    minDurationOff: 0.5,
  });

  const samples = loadAudioAt16kHz(audioPath);
  const sdResult = sd.process(samples);

  const turns: DiarizationTurn[] = sdResult.map(
    (s: { start: number; end: number; speaker: number }) => ({
      start: s.start,
      end: s.end,
      speaker: s.speaker,
    }),
  );

  // Extract per-speaker voice fingerprints via CAM++ (512-dim, mean-pooled over segments)
  const speakerEmbeddings = new Map<number, Float32Array>();
  const ExtractorCtor = (sherpa as {
    SpeakerEmbeddingExtractor?: new (config: { model: string; numThreads: number }) => {
      createStream: () => {
        acceptWaveform: (sampleRate: number, samples: Float32Array) => void;
        inputFinished: () => void;
      };
      compute: (stream: unknown) => Float32Array;
    }
  }).SpeakerEmbeddingExtractor;
  if (!ExtractorCtor) {
    return { turns, speakerEmbeddings };
  }

  const extractor = new ExtractorCtor({
    model: ensureCamp().files["model.onnx"],
    numThreads: 1,
  });

  const speakerSegments = new Map<number, DiarizationTurn[]>();
  for (const turn of turns) {
    const list = speakerSegments.get(turn.speaker) ?? [];
    list.push(turn);
    speakerSegments.set(turn.speaker, list);
  }

  for (const [speakerId, segs] of speakerSegments) {
    const embeddings: Float32Array[] = [];

    for (const seg of segs) {
      const startSample = Math.floor(seg.start * SAMPLE_RATE);
      const endSample = Math.floor(seg.end * SAMPLE_RATE);
      const segSamples = samples.slice(startSample, endSample);

      if (segSamples.length < MIN_SEGMENT_SECS * SAMPLE_RATE) continue;

      const stream = extractor.createStream();
      stream.acceptWaveform(SAMPLE_RATE, segSamples);
      stream.inputFinished();
      embeddings.push(extractor.compute(stream));
    }

    if (embeddings.length === 0) continue;

    // Mean pooling over all of this speaker's segments
    const mean = new Float32Array(EMBEDDING_DIM);
    for (const emb of embeddings) {
      for (let i = 0; i < EMBEDDING_DIM; i++) mean[i] = mean[i]! + emb[i]!;
    }
    for (let i = 0; i < EMBEDDING_DIM; i++) mean[i] = mean[i]! / embeddings.length;
    speakerEmbeddings.set(speakerId, mean);
  }

  return { turns, speakerEmbeddings };
}

function loadAudioAt16kHz(audioPath: string): Float32Array {
  const pcm = execSync(
    `ffmpeg -i "${audioPath}" -ac 1 -ar ${SAMPLE_RATE} -f f32le -loglevel error pipe:1`,
    { maxBuffer: 500 * 1024 * 1024 },
  );
  return new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
}
