import { eq } from "drizzle-orm";
import { z } from "zod";
import { meetingsTable } from "@open-minutes/db";
import {
  openingText,
  parseDateTimeFromTranscript,
} from "@open-minutes/core/meeting-date";
import {
  addMeeting,
  align,
  clean,
  diarize,
  discoverMeetings,
  downloadAudio,
  embedSpeakers,
  meetingWorkDir,
  parseMeetingRef,
  PipelineError,
  recognizeSpeakers,
  saveTranscript,
  transcribe,
} from "@open-minutes/pipeline";
import { loadSegments } from "../load";
import { findMeeting, meetingRef, type MeetingRef } from "../meeting-ref";
import { defineTool, ToolError, type ToolContext } from "../tool";

// One tool per pipeline step. A meeting goes from its site to a saved
// transcript in this order, each step reading what the ones before it left in
// the meeting's work directory:
//
//   add_meeting → download_audio → transcribe → clean_transcription
//               → diarize → align_speakers → embed_speakers
//               → recognize_speakers → save_transcript
//
// Nothing runs the next step for you. The model steps (transcribe, diarize,
// embed_speakers) are slow, up to an hour for a long meeting; the rest take
// seconds.

/** Run a step, passing its refusals on to the agent. */
async function step<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PipelineError) throw new ToolError(err.message);
    throw err;
  }
}

/** The meeting a step works on, and its work directory. */
async function workDirOf(ctx: ToolContext, ref: MeetingRef) {
  const meeting = await findMeeting(await ctx.db(), ref);
  const dir = await meetingWorkDir(ctx.workRoot, {
    siteKind: meeting.site_kind,
    siteId: meeting.site_id,
  });
  return { meeting, dir };
}

const meetingInput = z.object({ meeting: meetingRef });

export const discoverMeetingsTool = defineTool({
  name: "discover_meetings",
  label: "Discover meetings",
  description:
    "Scan bodies' meeting sources (YouTube channels and playlists, akleg.gov committees) for meetings that aren't in the database yet, each body's newest first. Each result's id goes to add_meeting, with the body it was found under (and any others that held it).",
  input: z.object({
    body: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Scan only this body, by slug (eg "gbos").'),
  }),
  run: async (ctx, input) =>
    step(async () =>
      (await discoverMeetings(await ctx.db(), { body: input.body })).map(
        (m) => ({ site: m.siteKind, id: m.siteId, body: m.body }),
      ),
    ),
});

export const addMeetingTool = defineTool({
  name: "add_meeting",
  label: "Add meeting",
  description:
    "Add a meeting to the database from its site, without a transcript: its title, description and duration, and its date and time if the title states them. bodies are the slugs of the bodies that held it, several for a joint meeting; its timezone is the first body's. The meeting is then listed but not shown to readers until save_transcript. Next: download_audio.",
  input: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'The meeting on its site: a YouTube video ID or URL, or an akleg.gov meeting ID or URL (eg "HRES 2018-09-10 14:00:00").',
      ),
    bodies: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe('Body slugs, eg ["gbos"] or ["gbos", "luc"].'),
  }),
  run: async (ctx, input) =>
    step(async () => {
      const site = parseMeetingRef(input.id);
      const added = await addMeeting(
        await ctx.db(),
        ctx.site(site.siteKind),
        site,
        input.bodies,
      );
      return {
        meeting: added.meetingId,
        site: added.siteKind,
        id: added.siteId,
        title: added.title,
        bodies: added.bodies,
        timezone: added.timezone,
        date: added.date,
        time: added.time,
      };
    }),
});

export const downloadAudioTool = defineTool({
  name: "download_audio",
  label: "Download audio",
  description:
    "Download a meeting's audio from its site into its work directory, as 16 kHz mono WAV. Audio already there is kept unless overwrite is true. Next: transcribe and diarize, in either order.",
  input: meetingInput.extend({ overwrite: z.boolean().default(false) }),
  run: async (ctx, input) =>
    step(async () => {
      const { meeting, dir } = await workDirOf(ctx, input.meeting);
      return downloadAudio(ctx.site(meeting.site_kind), meeting.site_id, dir, {
        overwrite: input.overwrite,
      });
    }),
});

export const transcribeTool = defineTool({
  name: "transcribe",
  label: "Transcribe",
  description:
    "Recognize the words in a meeting's downloaded audio, verbatim, fillers and all. Slow: tens of minutes for a long meeting. Next: clean_transcription.",
  input: meetingInput,
  run: async (ctx, input) =>
    step(async () => transcribe((await workDirOf(ctx, input.meeting)).dir)),
});

export const cleanTranscriptionTool = defineTool({
  name: "clean_transcription",
  label: "Clean transcription",
  description:
    "Strip fillers and stutters from what transcribe recognized. The verbatim transcription is kept, so this can be run again after a change to the cleaning rules. Next: align_speakers, once diarize has run.",
  input: meetingInput,
  run: async (ctx, input) =>
    step(async () => clean((await workDirOf(ctx, input.meeting)).dir)),
});

export const diarizeTool = defineTool({
  name: "diarize",
  label: "Diarize",
  description:
    "Split a meeting's downloaded audio into turns and group them by voice into speaker numbers, knowing nothing about words or who anyone is. Slow. Next: align_speakers, once clean_transcription has run.",
  input: meetingInput,
  run: async (ctx, input) =>
    step(async () => diarize((await workDirOf(ctx, input.meeting)).dir)),
});

export const alignSpeakersTool = defineTool({
  name: "align_speakers",
  label: "Align speakers",
  description:
    "Give each cleaned word the speaker number of the diarization turn it overlaps most, and group consecutive words by one speaker into segments. Next: embed_speakers.",
  input: meetingInput,
  run: async (ctx, input) =>
    step(async () => align((await workDirOf(ctx, input.meeting)).dir)),
});

export const embedSpeakersTool = defineTool({
  name: "embed_speakers",
  label: "Embed speakers",
  description:
    "Compute a voiceprint for each speaker number from the audio of their aligned segments. A speaker with too little speech gets none. Next: recognize_speakers.",
  input: meetingInput,
  run: async (ctx, input) =>
    step(async () => embedSpeakers((await workDirOf(ctx, input.meeting)).dir)),
});

export const recognizeSpeakersTool = defineTool({
  name: "recognize_speakers",
  label: "Recognize speakers",
  description:
    "Match each speaker's voiceprint against the people in the database: the closest person for each, with the cosine similarity, or null when nobody is close enough. Changes nothing in the database. Next: save_transcript.",
  input: meetingInput,
  run: async (ctx, input) =>
    step(async () =>
      recognizeSpeakers(
        await ctx.db(),
        (await workDirOf(ctx, input.meeting)).dir,
      ),
    ),
});

export const saveTranscriptTool = defineTool({
  name: "save_transcript",
  label: "Save transcript",
  description:
    "Write a meeting's aligned segments to the database, each speaker's attributed to the person recognize_speakers matched, or to a new anonymous person; and mark the meeting transcribed, which shows it to readers. All or nothing. Refuses a meeting that already has a transcript. Then find_date_in_transcript can check its date and time.",
  input: meetingInput,
  run: async (ctx, input) =>
    step(async () => {
      const { meeting, dir } = await workDirOf(ctx, input.meeting);
      return saveTranscript(await ctx.db(), meeting.id, dir);
    }),
});

export const findDateInTranscript = defineTool({
  name: "find_date_in_transcript",
  label: "Find date in transcript",
  description:
    "Read the date and time a saved transcript's opening minutes state for the meeting, eg the chair's \"call to order the June 15th meeting at 7:02\", next to the date and time the meeting has now. Null when the opening states no date. Chairs rarely say the year: it's taken from the meeting's date, or from year. To change the meeting's, use update_meeting.",
  input: meetingInput.extend({
    year: z
      .int()
      .min(1900)
      .max(2200)
      .optional()
      .describe("The year to assume for a date said without one."),
  }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    const { id } = await findMeeting(db, input.meeting);
    const [meeting] = await db
      .select({ date: meetingsTable.date, time: meetingsTable.time })
      .from(meetingsTable)
      .where(eq(meetingsTable.id, id));
    const segments = await loadSegments(db, id);
    if (segments.length === 0)
      throw new ToolError(`Meeting ${input.meeting} has no transcript yet`);
    const year =
      input.year ?? (meeting!.date ? Number(meeting!.date.slice(0, 4)) : null);
    const found = parseDateTimeFromTranscript(openingText(segments), {
      fallbackYear: year ?? undefined,
    });
    return {
      meeting: { date: meeting!.date, time: meeting!.time },
      transcript: found && {
        date: found.date,
        time: found.time,
        evidence: found.evidence,
      },
    };
  },
});

/** The pipeline step tools, in the order a meeting goes through them. */
export const pipelineTools = [
  discoverMeetingsTool,
  addMeetingTool,
  downloadAudioTool,
  transcribeTool,
  cleanTranscriptionTool,
  diarizeTool,
  alignSpeakersTool,
  embedSpeakersTool,
  recognizeSpeakersTool,
  saveTranscriptTool,
  findDateInTranscript,
];
