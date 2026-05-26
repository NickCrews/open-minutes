declare module 'sherpa-onnx-node' {
    // These are best guesses of the types/interfaces based on the usage in our codebase and the sherpa-onnx documentation. Please adjust as needed.
    export interface WaveForm {
        sampleRate: number;
        samples: Float32Array;
    }
    export function readWave(path: string): WaveForm;

    export interface Stream {
        acceptWaveform(options: WaveForm): void;
    };

    export interface OfflineRecognizerResult {
        text: string;
        tokens?: string[];
        timestamps?: number[];
        lang?: string;
        emotion?: string;
        event?: string;
    }

    export class OfflineRecognizer {
        constructor(config: unknown);
        createStream(): Stream;
        decodeAsync(stream: Stream): Promise<OfflineRecognizerResult>;
    }

    // inferred from https://github.com/k2-fsa/sherpa-onnx/blob/a703cf6560bf1b617be33734e2c7b980bada0903/nodejs-examples/test-offline-speaker-diarization.js
    export interface OfflineSpeakerDiarizationConfig {
        segmentation: {
            pyannote: {
                model: string;
            },
            numThreads?: number;
            provider?: string;
            debug?: number;
        };
        embedding: {
            model: string;
            numThreads?: number;
            provider?: string;
            debug?: number;
        };
        clustering: {
            /** Number of clusters for speaker diarization. If set to -1, the number of clusters will be determined automatically. */
            numClusters: number;
            /** Threshold for merging segments into clusters. A larger threshold leads to fewer clusters, a smaller threshold leads to more clusters.
             *
             * Only used if numClusters is -1.
            */
            threshold: number;
        };
        /** Minimum seconds for a segment to be considered as speech. Segments shorter than this will be discarded. */
        minDurationOn: number;
        /** Minimum seconds for a gap between segments to be considered as silence. Gaps shorter than this will be merged with adjacent segments. */
        minDurationOff: number;
    };

    // https://github.com/k2-fsa/sherpa-onnx/blob/a703cf6560bf1b617be33734e2c7b980bada0903/sherpa-onnx/c-api/c-api.h#L3944
    export interface OfflineSpeakerDiarizationSegment {
        start: number;
        end: number;
        speaker: number;
    }

    export class OfflineSpeakerDiarization {
        constructor(config: OfflineSpeakerDiarizationConfig);
        /** The sample rate the segmentation model expects; samples passed to process() must match. */
        readonly sampleRate: number;
        /** @param samples 1-D float32 array in [-1, 1] at this.sampleRate */
        process(samples: Float32Array): OfflineSpeakerDiarizationSegment[];
    }

    // The speaker-embedding extractor reuses the OnlineStream from the streaming
    // ASR module: feed it audio, mark input finished, then compute().
    export interface OnlineStream {
        acceptWaveform(obj: WaveForm): void;
        inputFinished(): void;
    }

    export interface SpeakerEmbeddingExtractorConfig {
        model: string;
        numThreads?: number;
        provider?: string;
        debug?: number;
    }

    export class SpeakerEmbeddingExtractor {
        constructor(config: SpeakerEmbeddingExtractorConfig);
        /** Embedding dimension (192 for the 3D-Speaker CAM++ zh_en-common_advanced model). */
        readonly dim: number;
        createStream(): OnlineStream;
        isReady(stream: OnlineStream): boolean;
        /** Returns the speaker embedding as a Float32Array of length `dim`. */
        compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
    }

    // --- Voice activity detection (Silero VAD) ---
    // Inferred from sherpa-onnx-node's vad.js and types.js (v1.12.39).

    export interface SileroVadModelConfig {
        /** Path to the silero_vad.onnx model file. */
        model: string;
        /** Speech-probability threshold above which a frame counts as speech (default ~0.5). */
        threshold?: number;
        /** Seconds of sub-threshold audio that ends a speech run (the cut points). */
        minSilenceDuration?: number;
        /** Speech runs shorter than this (seconds) are discarded. */
        minSpeechDuration?: number;
        /** Samples per VAD window (512 for 16 kHz Silero). */
        windowSize?: number;
        /** A speech run longer than this (seconds) is force-split, preferring the last silence. */
        maxSpeechDuration?: number;
    }

    export interface VadConfig {
        sileroVad?: SileroVadModelConfig;
        sampleRate?: number;
        numThreads?: number;
        provider?: string;
        debug?: boolean | number;
    }

    /**
     * A detected speech run. `start` is the sample index (at the VAD's sampleRate)
     * where the run begins; `samples` are that run's audio. The run's end sample
     * index is `start + samples.length`.
     */
    export interface VadSpeechSegment {
        start: number;
        samples: Float32Array;
    }

    export class Vad {
        /** @param bufferSizeInSeconds size of the internal circular buffer. */
        constructor(config: VadConfig, bufferSizeInSeconds: number);
        /** Feed raw float32 samples (in [-1, 1]) at the configured sampleRate. */
        acceptWaveform(samples: Float32Array): void;
        /** True when there are no completed speech segments queued. */
        isEmpty(): boolean;
        /** True while speech is currently being detected. */
        isDetected(): boolean;
        /** Pop (discard) the earliest queued speech segment. */
        pop(): void;
        /** Clear all queued segments. */
        clear(): void;
        /** The earliest queued speech segment without removing it. */
        front(enableExternalBuffer?: boolean): VadSpeechSegment;
        /** Reset detector state. */
        reset(): void;
        /** Flush the internal buffer, emitting any trailing speech as a final segment. */
        flush(): void;
    }

}
