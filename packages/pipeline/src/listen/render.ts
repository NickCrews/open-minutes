import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { clip, speechRuns } from "./activity";
import { formatClock } from "./clock";
import {
  heat,
  Image,
  LABEL_COLORS,
  type Rgb,
  TEXT_HEIGHT,
  textWidth,
} from "./image";
import type { ListenMeeting } from "./meeting";
import { melPosition, melSpectrogram, pitchTrack } from "./signal";
import { checkRange, defineListenTool, meetingRef, time } from "./tool";
import { continuity, HOP_SEC } from "./voices";
import { sliceStart, windowVoices } from "./voice-tools";

/** Where render_audio writes its pictures (gitignored, by the root `data/` rule). */
export const VIEWS_DIR = fileURLToPath(
  new URL("../../data/audio-views/", import.meta.url),
);

const MAX_RENDER_SECS = 10 * 60;
const LEFT = 118; // row titles
const RIGHT = 12;
const MEL_BANDS = 96;
const SPECTROGRAM_HEIGHT = 2 * MEL_BANDS;
/** Show each word's text when there are at least this many pixels a second. */
const WORD_TEXT_MIN_PX_PER_SEC = 40;

const BLACK: Rgb = [0, 0, 0];
const GREY: Rgb = [150, 150, 150];
const LIGHT: Rgb = [232, 232, 232];
const PITCH: Rgb = [20, 20, 160];
const PITCH_HEIGHT = 64;
const PITCH_LOW_HZ = 60;
const PITCH_HIGH_HZ = 400;

/** A short name for a label, to fit in a band. */
const shortLabel = (label: string) =>
  label.replace(/^(identified|person):/, "").replace(/^segmented:/, "");

/**
 * Draw [from, to) of a meeting as rows sharing one time axis: the
 * transcript's speaker labels and words, who the audio sounds like, how much
 * the voice changes, where VAD hears speech, and a mel spectrogram with the
 * pitch track over it. Returns the PNG and the label colours used.
 */
export function renderAudio(
  meeting: ListenMeeting,
  from: number,
  to: number,
  plotWidth: number,
): { png: Buffer; legend: Record<string, string> } {
  const span = to - from;
  const pxPerSec = plotWidth / span;
  const xOf = (t: number) => LEFT + (t - from) * pxPerSec;
  const times = Array.from(
    { length: plotWidth },
    (_, c) => from + c / pxPerSec,
  );

  const colors = new Map<string, Rgb>();
  const colorOf = (label: string): Rgb => {
    if (!colors.has(label))
      colors.set(label, LABEL_COLORS[colors.size % LABEL_COLORS.length]!);
    return colors.get(label)!;
  };

  const segments = meeting.segments.filter((s) => s.end > from && s.start < to);
  const showWordText = pxPerSec >= WORD_TEXT_MIN_PX_PER_SEC;
  const rows = {
    title: 22,
    axis: 20,
    transcript: 22,
    words: showWordText ? 2 * TEXT_HEIGHT + 6 : 10,
    voice: 22,
    change: 46,
    speech: 10,
    pitch: PITCH_HEIGHT,
    spectrogram: SPECTROGRAM_HEIGHT,
    gap: 8,
  };
  let y = 0;
  const top = Object.fromEntries(
    Object.entries(rows).map(([name, h]) => {
      const at = y;
      y += h + (name === "title" ? 0 : 4);
      return [name, at];
    }),
  ) as Record<keyof typeof rows, number>;
  const legendTop = y + rows.gap;
  const legendRows = Math.ceil(
    new Set([...segments.map((s) => s.label)]).size / 3 + 1,
  );
  const img = new Image(
    LEFT + plotWidth + RIGHT,
    legendTop + (legendRows + 1) * (TEXT_HEIGHT + 6),
  );
  const rowTitle = (row: keyof typeof rows, title: string) =>
    img.text(
      4,
      top[row] + (rows[row] - TEXT_HEIGHT) / 2,
      title,
      BLACK,
      LEFT - 8,
    );

  // Title and time axis.
  img.text(
    4,
    4,
    `${meeting.ref}  ${formatClock(from)} - ${formatClock(to)}`,
    BLACK,
  );
  const tickEvery =
    [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pxPerSec >= 110) ??
    600;
  for (
    let t = Math.ceil(from / tickEvery) * tickEvery;
    t < to;
    t += tickEvery
  ) {
    const x = xOf(t);
    img.line(x, top.axis + 14, x, top.spectrogram + rows.spectrogram, LIGHT);
    img.text(
      x + 2,
      top.axis,
      formatClock(t).replace(/^0:/, "").replace(/\.00$/, ""),
      BLACK,
    );
  }
  // Redraw the gridlines' rows over them below, so they only show between.

  // Transcript: one bar per segment, coloured by label.
  rowTitle("transcript", "transcript");
  for (const s of segments) {
    const x0 = Math.max(xOf(s.start), LEFT);
    const x1 = Math.min(xOf(s.end), LEFT + plotWidth);
    img.fillRect(
      x0,
      top.transcript,
      x1 - x0,
      rows.transcript,
      colorOf(s.label),
    );
    img.text(
      x0 + 2,
      top.transcript + 4,
      `${s.id} ${shortLabel(s.label)}`,
      [255, 255, 255],
      x1 - x0 - 4,
    );
  }

  // Words: a tick at each onset, and the text when there's room.
  rowTitle("words", showWordText ? "words" : "word onsets");
  let lane = 0;
  const laneEnd = [-Infinity, -Infinity];
  for (const s of segments)
    for (const w of s.words) {
      if (w.start < from || w.start >= to) continue;
      const x = xOf(w.start);
      img.line(x, top.words, x, top.words + 5, colorOf(s.label));
      if (!showWordText) continue;
      lane = x > laneEnd[0]! ? 0 : x > laneEnd[1]! ? 1 : -1;
      if (lane < 0) continue;
      img.text(x, top.words + 4 + lane * (TEXT_HEIGHT + 1), w.text, BLACK);
      laneEnd[lane] = x + textWidth(w.text) + 3;
    }

  // Voice: the label each moment sounds like, from voiceprints.
  rowTitle("voice", "sounds like");
  const { windows, smoothed } = windowVoices(meeting, from, to);
  windows.forEach((w, i) => {
    const label = smoothed[i];
    if (!label) return;
    img.fillRect(
      xOf(sliceStart(w)),
      top.voice,
      HOP_SEC * pxPerSec + 1,
      rows.voice,
      colorOf(label),
    );
  });

  // Voice change: similarity across each moment, 1 at the top.
  rowTitle("change", "voice same?");
  img.fillRect(LEFT, top.change, plotWidth, rows.change, [248, 248, 248]);
  const yOfSim = (s: number) =>
    top.change + rows.change - Math.max(0, Math.min(1, s)) * rows.change;
  for (let x = LEFT; x < LEFT + plotWidth; x += 4)
    img.setPixel(x, yOfSim(0.4), GREY);
  let prev: { x: number; y: number } | null = null;
  for (const c of continuity(windows)) {
    if (c.similarity === null) {
      prev = null;
      continue;
    }
    const point = { x: xOf(c.at), y: yOfSim(c.similarity) };
    if (prev) img.line(prev.x, prev.y, point.x, point.y, [200, 30, 30]);
    else img.setPixel(point.x, point.y, [200, 30, 30]);
    prev = point;
  }

  // Speech, by VAD.
  rowTitle("speech", "speech (VAD)");
  img.fillRect(LEFT, top.speech, plotWidth, rows.speech, LIGHT);
  for (const r of clip(speechRuns(meeting), from, to))
    img.fillRect(
      xOf(r.start),
      top.speech,
      (r.end - r.start) * pxPerSec,
      rows.speech,
      BLACK,
    );

  // Spectrogram, with the pitch track over it.
  const wave = meeting.wave();
  const spec = melSpectrogram(wave.samples, wave.sampleRate, times, MEL_BANDS);
  const all = spec.flatMap((col) => [...col]).sort((a, b) => a - b);
  const lo = all[Math.floor(all.length * 0.05)]!;
  const hi = all[Math.floor(all.length * 0.995)]!;
  spec.forEach((col, c) =>
    col.forEach((db, b) =>
      img.fillRect(
        LEFT + c,
        top.spectrogram + SPECTROGRAM_HEIGHT - (b + 1) * 2,
        1,
        2,
        heat((db - lo) / (hi - lo)),
      ),
    ),
  );
  const yOfHz = (hz: number) =>
    top.spectrogram + SPECTROGRAM_HEIGHT * (1 - melPosition(hz));
  img.text(4, top.spectrogram, "spectrogram", BLACK);

  // Pitch, on a log scale: a voice keeps to its own band.
  rowTitle("pitch", "pitch (Hz)");
  img.fillRect(LEFT, top.pitch, plotWidth, rows.pitch, [248, 248, 248]);
  const yOfPitch = (hz: number) =>
    top.pitch +
    rows.pitch *
      (1 -
        Math.log(hz / PITCH_LOW_HZ) / Math.log(PITCH_HIGH_HZ / PITCH_LOW_HZ));
  for (const hz of [100, 150, 200, 300]) {
    const yy = yOfPitch(hz);
    for (let x = LEFT; x < LEFT + plotWidth; x += 3) img.setPixel(x, yy, LIGHT);
    img.text(
      LEFT - 8 - textWidth(`${hz}`),
      yy - TEXT_HEIGHT / 2,
      `${hz}`,
      GREY,
    );
  }
  const pitches = pitchTrack(wave.samples, wave.sampleRate, times);
  pitches.forEach((hz, c) => {
    if (hz === null || hz < PITCH_LOW_HZ || hz > PITCH_HIGH_HZ) return;
    img.fillRect(LEFT + c, yOfPitch(hz) - 1, 1, 2, PITCH);
  });
  for (const hz of [100, 200, 400, 1000, 2000, 4000]) {
    const yy = yOfHz(hz);
    img.line(LEFT - 6, yy, LEFT - 1, yy, BLACK);
    const text = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
    img.text(LEFT - 8 - textWidth(text), yy - TEXT_HEIGHT / 2, text, BLACK);
  }

  // Legend.
  const legend: Record<string, string> = {};
  [...colors].forEach(([label, color], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = LEFT + col * Math.floor(plotWidth / 3);
    const yy = legendTop + row * (TEXT_HEIGHT + 6);
    img.fillRect(x, yy + 2, 14, TEXT_HEIGHT - 4, color);
    img.text(x + 20, yy, label, BLACK, plotWidth / 3 - 24);
    legend[label] = `rgb(${color.join(",")})`;
  });
  return { png: img.toPng(), legend };
}

export const renderAudioTool = defineListenTool({
  name: "render_audio",
  description: `Draw a stretch of a meeting (at most ${MAX_RENDER_SECS / 60} minutes) as a PNG to look at, and return its path; open it with your file-reading tool. Rows, on one time axis: the transcript's segments (id and label, coloured by label), its words, the label the audio sounds like at each moment (same colours), how alike the voice is across each moment (red line; it dips where the speaker changes, grey dashes at 0.4), where voice activity detection hears speech, the pitch track (60-400 Hz, log scale; each voice keeps to its own band), and a mel spectrogram (0-8 kHz). A change of speaker shows as a dip in the red line, a pause in speech, a jump in pitch, and a change in the spectrogram's texture; a stretch of speech with no words under it is untranscribed. Words are written out for stretches under about 40 s.`,
  input: z.object({
    meeting: meetingRef,
    from: time,
    to: time,
    width: z
      .number()
      .int()
      .min(400)
      .max(4000)
      .default(1600)
      .describe("Width of the plot in pixels."),
  }),
  run: async (ctx, input) => {
    checkRange(input.from, input.to, MAX_RENDER_SECS);
    const meeting = await ctx.meeting(input.meeting);
    const { png, legend } = renderAudio(
      meeting,
      input.from,
      input.to,
      input.width,
    );
    mkdirSync(VIEWS_DIR, { recursive: true });
    const clock = (t: number) => formatClock(t).replace(/[:.]/g, "");
    const path = join(
      VIEWS_DIR,
      `${meeting.ref}_${clock(input.from)}-${clock(input.to)}.png`,
    );
    writeFileSync(path, png);
    return { image: path, legend };
  },
});
