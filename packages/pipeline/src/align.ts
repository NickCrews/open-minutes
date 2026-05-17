import type { TranscriptSegment, TranscriptWord, DiarizationTurn } from "./types.ts";

export interface AlignedSegment {
  text: string;
  start: number;
  end: number;
  speaker: number;
  words: TranscriptWord[];
}

// Assign each transcript segment to the diarization speaker with the most overlap.
// When a transcript segment spans multiple speakers, split it at the speaker boundary
// using word-level timestamps.
export function alignTranscriptWithSpeakers(
  transcriptSegments: TranscriptSegment[],
  diarizationTurns: DiarizationTurn[],
): AlignedSegment[] {
  const aligned: AlignedSegment[] = [];

  for (const seg of transcriptSegments) {
    const wordGroups = groupWordsBySpeaker(seg.words, diarizationTurns);

    for (const group of wordGroups) {
      const text = group.words
        .map((w) => w.text)
        .join("")
        .trim();
      if (!text) continue;
      aligned.push({
        text,
        start: group.words[0]!.start,
        end: group.words.at(-1)!.end,
        speaker: group.speaker,
        words: group.words,
      });
    }
  }

  return aligned;
}

function groupWordsBySpeaker(
  words: TranscriptSegment["words"],
  turns: DiarizationTurn[],
): Array<{ speaker: number; words: TranscriptSegment["words"] }> {
  const groups: Array<{ speaker: number; words: TranscriptSegment["words"] }> =
    [];

  for (const word of words) {
    const midpoint = (word.start + word.end) / 2;
    const speaker = speakerAt(midpoint, turns);

    const last = groups.at(-1);
    if (last && last.speaker === speaker) {
      last.words.push(word);
    } else {
      groups.push({ speaker, words: [word] });
    }
  }

  return groups;
}

function speakerAt(time: number, turns: DiarizationTurn[]): number {
  for (const turn of turns) {
    if (time >= turn.start && time < turn.end) return turn.speaker;
  }
  // Fall back to nearest turn
  let nearest = turns[0];
  let minDist = Infinity;
  for (const turn of turns) {
    const dist = Math.min(
      Math.abs(time - turn.start),
      Math.abs(time - turn.end),
    );
    if (dist < minDist) {
      minDist = dist;
      nearest = turn;
    }
  }
  return nearest?.speaker ?? 0;
}
