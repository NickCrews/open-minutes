/**
 * Reading and writing the Opus track of a WebM file. Only what Opus audio
 * needs: one track, unlaced blocks.
 */

/** One Opus track's packets and the fields needed to decode them exactly. */
export interface OpusTrack {
  /** The OpusHead (RFC 7845), the track's CodecPrivate. */
  opusHead: Uint8Array;
  packets: Uint8Array[];
  /** Nanoseconds to drop from the end of the decoded audio. */
  discardPaddingNs: number;
}

// Matroska element IDs (https://www.matroska.org/technical/elements.html).
const EBML = 0x1a45dfa3;
const EBML_VERSION = 0x4286;
const EBML_READ_VERSION = 0x42f7;
const EBML_MAX_ID_LENGTH = 0x42f2;
const EBML_MAX_SIZE_LENGTH = 0x42f3;
const DOC_TYPE = 0x4282;
const DOC_TYPE_VERSION = 0x4287;
const DOC_TYPE_READ_VERSION = 0x4285;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const SEEK_POSITION = 0x53ac;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const MUXING_APP = 0x4d80;
const WRITING_APP = 0x5741;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_UID = 0x73c5;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const CODEC_DELAY = 0x56aa;
const SEEK_PRE_ROLL = 0x56bb;
const AUDIO = 0xe1;
const SAMPLING_FREQUENCY = 0xb5;
const CHANNELS = 0x9f;
const CLUSTER = 0x1f43b675;
const TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const DISCARD_PADDING = 0x75a2;
const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;

/** Elements whose children are read; every other element's body is skipped. */
const DESCEND = new Set([SEGMENT, CLUSTER, BLOCK_GROUP, TRACKS, TRACK_ENTRY]);

/**
 * The first Opus track of a WebM file. Reads the elements in one flat pass,
 * stepping into container elements rather than over them, so clusters of
 * unknown size (as in streamed WebM) work too.
 */
export function readOpusTrack(webm: Uint8Array): OpusTrack {
  const packets: Uint8Array[] = [];
  const codecPrivate = new Map<number | undefined, Uint8Array>();
  let opusTrack: number | undefined;
  let trackNumber: number | undefined;
  let discardPaddingNs = 0;
  let pos = 0;
  while (pos < webm.length) {
    const id = readVint(webm, pos, true);
    pos += id.length;
    const size = readVint(webm, pos, false);
    pos += size.length;
    if (DESCEND.has(id.value)) continue;
    if (size.unknown) throw new Error(`WebM element ${id.value} has no size`);
    const end = pos + size.value;
    const body = webm.subarray(pos, end);
    switch (id.value) {
      case TRACK_NUMBER:
        trackNumber = readUint(body);
        break;
      case CODEC_ID:
        if (readAscii(body) === "A_OPUS" && opusTrack === undefined) {
          opusTrack = trackNumber;
        }
        break;
      case CODEC_PRIVATE:
        codecPrivate.set(trackNumber, body);
        break;
      case SIMPLE_BLOCK:
      case BLOCK: {
        const track = readVint(body, 0, false);
        if (track.value !== opusTrack) break;
        const flags = body[track.length + 2]!;
        if (flags & 0x06) throw new Error("Laced WebM blocks are unsupported");
        packets.push(body.subarray(track.length + 3));
        break;
      }
      case DISCARD_PADDING:
        discardPaddingNs += readInt(body);
        break;
    }
    pos = end;
  }
  const opusHead = codecPrivate.get(opusTrack);
  if (opusTrack === undefined || !opusHead) {
    throw new Error("No Opus track in the WebM file");
  }
  return { opusHead, packets, discardPaddingNs };
}

/** What {@link writeOpusTrack} needs beyond the track itself. */
export interface OpusTrackTiming {
  /** Each packet's duration in milliseconds; all packets are the same. */
  packetMs: number;
  /** The decoded audio's duration, for the file's Duration. */
  durationMs: number;
  /** The encoder's delay (the OpusHead's pre-skip), for CodecDelay. */
  codecDelayNs: number;
}

/** A new cluster starts every this many milliseconds. */
const CLUSTER_MS = 5_000;
/** 80 ms, what RFC 7845 recommends decoders pre-roll after a seek. */
const SEEK_PRE_ROLL_NS = 80_000_000;
const APP = "open-minutes";

/**
 * A WebM file holding one Opus track. It has what a browser needs to play and
 * seek it: a Duration, a cue for each cluster, and a SeekHead pointing at the
 * Cues. The Opus track's channel count is read from its OpusHead.
 */
export function writeOpusTrack(
  track: OpusTrack,
  timing: OpusTrackTiming,
): Uint8Array<ArrayBuffer> {
  const { opusHead, packets, discardPaddingNs } = track;
  const { packetMs, durationMs, codecDelayNs } = timing;
  const perCluster = Math.floor(CLUSTER_MS / packetMs);

  const clusters: Uint8Array[] = [];
  for (let first = 0; first < packets.length; first += perCluster) {
    const blocks: Uint8Array[] = [];
    const last = Math.min(packets.length, first + perCluster);
    for (let i = first; i < last; i++) {
      // Track 1, timestamp relative to the cluster's, then flags.
      const relative = (i - first) * packetMs;
      const header = Uint8Array.of(0x81, relative >> 8, relative & 0xff, 0);
      if (i === packets.length - 1 && discardPaddingNs > 0) {
        blocks.push(
          element(
            BLOCK_GROUP,
            element(BLOCK, header, packets[i]!),
            int(DISCARD_PADDING, discardPaddingNs),
          ),
        );
      } else {
        header[3] = 0x80; // keyframe: every Opus packet decodes on its own
        blocks.push(element(SIMPLE_BLOCK, header, packets[i]!));
      }
    }
    clusters.push(
      element(CLUSTER, uint(TIMESTAMP, first * packetMs), ...blocks),
    );
  }

  const info = element(
    INFO,
    uint(TIMESTAMP_SCALE, 1_000_000), // timestamps in milliseconds
    float(DURATION, durationMs),
    string(MUXING_APP, APP),
    string(WRITING_APP, APP),
  );
  const tracks = element(
    TRACKS,
    element(
      TRACK_ENTRY,
      uint(TRACK_NUMBER, 1),
      uint(TRACK_UID, 1),
      uint(TRACK_TYPE, 2), // audio
      string(CODEC_ID, "A_OPUS"),
      element(CODEC_PRIVATE, opusHead),
      uint(CODEC_DELAY, codecDelayNs),
      uint(SEEK_PRE_ROLL, SEEK_PRE_ROLL_NS),
      // Opus always plays at 48 kHz, whatever rate it was encoded from.
      element(
        AUDIO,
        float(SAMPLING_FREQUENCY, 48_000),
        uint(CHANNELS, opusHead[9]!),
      ),
    ),
  );

  // Positions are from the start of the Segment's body. The SeekHead writes
  // them in a fixed 8 bytes, so its size doesn't depend on them.
  const seekHead = (positions: [id: number, position: number][]) =>
    element(
      SEEK_HEAD,
      ...positions.map(([id, position]) =>
        element(
          SEEK,
          element(SEEK_ID, idBytes(id)),
          fixedUint(SEEK_POSITION, position),
        ),
      ),
    );
  const seekHeadLength = seekHead([
    [INFO, 0],
    [TRACKS, 0],
    [CUES, 0],
  ]).length;
  let position = seekHeadLength + info.length + tracks.length;
  const cuePoints: Uint8Array[] = [];
  clusters.forEach((cluster, c) => {
    cuePoints.push(
      element(
        CUE_POINT,
        uint(CUE_TIME, c * perCluster * packetMs),
        element(
          CUE_TRACK_POSITIONS,
          uint(CUE_TRACK, 1),
          uint(CUE_CLUSTER_POSITION, position),
        ),
      ),
    );
    position += cluster.length;
  });
  const cues = element(CUES, ...cuePoints);

  const header = element(
    EBML,
    uint(EBML_VERSION, 1),
    uint(EBML_READ_VERSION, 1),
    uint(EBML_MAX_ID_LENGTH, 4),
    uint(EBML_MAX_SIZE_LENGTH, 8),
    string(DOC_TYPE, "webm"),
    // CodecDelay, SeekPreRoll and DiscardPadding are version 4 elements.
    uint(DOC_TYPE_VERSION, 4),
    uint(DOC_TYPE_READ_VERSION, 2),
  );
  const segment = element(
    SEGMENT,
    seekHead([
      [INFO, seekHeadLength],
      [TRACKS, seekHeadLength + info.length],
      [CUES, position],
    ]),
    info,
    tracks,
    ...clusters,
    cues,
  );
  return concat([header, segment]);
}

/**
 * An EBML variable-length integer. IDs keep their length-marker bit; sizes
 * drop it, and an all-ones size means "unknown".
 */
function readVint(buf: Uint8Array, pos: number, isId: boolean) {
  const first = buf[pos];
  if (first === undefined || first === 0) {
    throw new Error(`Malformed WebM at byte ${pos}`);
  }
  const length = Math.clz32(first) - 23;
  const mask = 0xff >> length;
  let value = isId ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    const byte = buf[pos + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !isId && allOnes };
}

function readUint(body: Uint8Array): number {
  let value = 0;
  for (const byte of body) value = value * 256 + byte;
  return value;
}

function readInt(body: Uint8Array): number {
  const unsigned = readUint(body);
  const signBit = 2 ** (body.length * 8 - 1);
  return body.length > 0 && unsigned >= signBit
    ? unsigned - 2 * signBit
    : unsigned;
}

function readAscii(body: Uint8Array): string {
  return String.fromCharCode(...body);
}

/** An element: its ID, its body's size, and its body. */
function element(id: number, ...body: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const content = concat(body);
  return concat([idBytes(id), sizeBytes(content.length), content]);
}

/** An element ID's bytes; IDs carry their own length marker. */
function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  for (; id > 0; id = Math.floor(id / 256)) bytes.unshift(id & 0xff);
  return Uint8Array.from(bytes);
}

/** A size as the shortest variable-length integer that isn't all ones. */
function sizeBytes(size: number): Uint8Array {
  for (let length = 1; length <= 8; length++) {
    if (size < 2 ** (7 * length) - 1) {
      const bytes = bigEndian(size, length);
      bytes[0]! |= 0x80 >> (length - 1);
      return bytes;
    }
  }
  throw new Error(`WebM element too large (${size} bytes)`);
}

function bigEndian(value: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--, value = Math.floor(value / 256)) {
    bytes[i] = value % 256;
  }
  return bytes;
}

function uint(id: number, value: number) {
  let length = 1;
  while (value >= 2 ** (8 * length)) length++;
  return element(id, bigEndian(value, length));
}

function fixedUint(id: number, value: number) {
  return element(id, bigEndian(value, 8));
}

function int(id: number, value: number) {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setBigInt64(0, BigInt(value));
  return element(id, body);
}

function float(id: number, value: number) {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setFloat64(0, value);
  return element(id, body);
}

function string(id: number, value: string) {
  return element(id, new TextEncoder().encode(value));
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
