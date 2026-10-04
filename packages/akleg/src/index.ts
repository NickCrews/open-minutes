import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  AudioProvider,
  VideoMetadata,
} from "@open-minutes/core/audio-provider";
import type { VideoLister } from "@open-minutes/core/video-lister";
import { mp3ToWav } from "./mp3";

export type {
  AudioProvider,
  VideoMetadata,
} from "@open-minutes/core/audio-provider";
export type { ListedVideo, VideoLister } from "@open-minutes/core/video-lister";

const BASE = "https://www.akleg.gov";

/**
 * akleg.gov names a meeting by its chamber (H or S), committee code, and
 * scheduled start, Alaska time: "HRES 2018-09-10 14:00:00" is House Resources
 * at 2 PM on 2018-09-10. Codes can hold "&" ("SL&C", Senate Labor & Commerce).
 * A joint meeting has one ID per chamber, sharing its recordings.
 */
const MEETING_ID_RE =
  /^([HS])([A-Z0-9&]+) (\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})$/;

/**
 * The meeting ID ("HRES 2018-09-10 14:00:00"), from either an ID or a meeting
 * page URL (".../basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00").
 */
export function meetingId(meetingIdOrUrl: string): string {
  const id = MEETING_ID_RE.test(meetingIdOrUrl)
    ? meetingIdOrUrl
    : new URL(meetingIdOrUrl, BASE).searchParams.get("Meeting");
  if (!id || !MEETING_ID_RE.test(id)) {
    throw new Error(`No akleg.gov meeting ID in ${meetingIdOrUrl}`);
  }
  return id;
}

/**
 * The meeting ID in `ref` (see {@link meetingId}), or undefined when it names
 * no akleg.gov meeting, eg because it's a YouTube video's.
 */
export function parseMeetingId(ref: string): string | undefined {
  try {
    return meetingId(ref);
  } catch {
    return undefined;
  }
}

/** The meeting's page on akleg.gov. */
export function meetingUrl(meetingIdOrUrl: string): string {
  const id = meetingId(meetingIdOrUrl);
  return `${BASE}/basis/Meeting/Detail?Meeting=${encodeURIComponent(id).replaceAll("%3A", ":")}`;
}

/**
 * The number of the Legislature sitting in `year`. Each sits for two years,
 * the 30th in 2017-2018.
 */
export function legislatureOf(year: number): number {
  return Math.floor((year - 1957) / 2);
}

// The BASIS public API (https://www.akleg.gov/apptester.html), which backs the
// Legislature's own app. Only the fields used here are checked; a change to
// them fails loudly in parse() rather than yielding wrong data.

const mediaFileSchema = z.object({
  /** "A" for the FTR audio (MP3), "V" for video (MP4). */
  MediaType: z.string(),
  /** Milliseconds. */
  Duration: z.number(),
  /** With backslashes for some of its slashes; see {@link mediaUrl}. */
  Url: z.string(),
  // StartTime is deliberately unused: it is unreliable (see
  // docs/research/akleg.md).
});

const meetingSchema = z.object({
  Chamber: z.string(),
  /** The committee's code, without the chamber ("RES"). */
  MeetingSponsor: z.string(),
  /** The committee's name ("RESOURCES"). */
  MeetingTitle: z.string(),
  /** "YYYY-MM-DD". */
  MeetingDate: z.string(),
  /** "hh:mm:ss". */
  MeetingTime: z.string(),
  Location: z.string(),
  MeetingCanceled: z.boolean(),
  /** Only filled in when the query asks for ",media". */
  MediaFiles: z.array(mediaFileSchema),
});
type BasisMeeting = z.infer<typeof meetingSchema>;

const meetingsResponse = z.object({
  Basis: z.object({ Meetings: z.array(meetingSchema) }),
});
const committeesResponse = z.object({
  Basis: z.object({
    Committees: z.array(z.object({ Meetings: z.array(meetingSchema) })),
  }),
});

/**
 * A response body as `schema`. Errors come back as XML with HTTP 200
 * (`<Basis><Error><Code>FormatException</Code>...`), which this reports.
 */
export function parse<T>(schema: z.ZodType<T>, body: string): T {
  if (body.trimStart().startsWith("<")) {
    const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1] ?? "unknown";
    throw new Error(`akleg.gov BASIS API error: ${code}`);
  }
  return schema.parse(JSON.parse(body));
}

/** A recording of a meeting. */
export interface MediaFile {
  url: string;
  durationSecs: number;
}

/** A meeting, as the BASIS API describes it. */
export interface AkLegMeeting {
  /** See {@link meetingId}. */
  id: string;
  /** Eg "House RESOURCES". */
  committee: string;
  /** Eg "Anch LIO AUDITORIUM". */
  location: string;
  /** "YYYY-MM-DD", Alaska time. */
  date: string;
  /** "hh:mm:ss", Alaska time: the scheduled start. */
  time: string;
  cancelled: boolean;
  /**
   * The "FTR" (For The Record) audio recordings, MP3s, deduplicated (the API
   * repeats files). Every recorded meeting has at least one; their file names
   * don't follow from the meeting ID ("sres_1300_1.mp3"). See
   * {@link mainAudio} for which to use.
   */
  audio: MediaFile[];
  /** The video recordings, MP4s, on a different timeline from the audio's. */
  video: MediaFile[];
}

/**
 * The API's media URLs mix in backslashes and doubled slashes
 * ("http://www.akleg.gov/ftr/2018\20180910\sres\sres_1400.mp3"); akleg.gov
 * serves them all as https with forward slashes.
 */
export function mediaUrl(raw: string): string {
  const url = new URL(raw.replaceAll("\\", "/"));
  url.protocol = "https:";
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return url.href;
}

export function toMeeting(m: BasisMeeting): AkLegMeeting {
  const files = (type: string) => {
    const seen = new Set<string>();
    const out: MediaFile[] = [];
    for (const f of m.MediaFiles) {
      const url = mediaUrl(f.Url);
      if (f.MediaType !== type || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, durationSecs: f.Duration / 1000 });
    }
    return out;
  };
  return {
    id: `${m.Chamber}${m.MeetingSponsor} ${m.MeetingDate} ${m.MeetingTime}`,
    committee: `${m.Chamber === "S" ? "Senate" : "House"} ${m.MeetingTitle}`,
    location: m.Location,
    date: m.MeetingDate,
    time: m.MeetingTime,
    cancelled: m.MeetingCanceled,
    audio: files("A"),
    video: files("V"),
  };
}

/**
 * The audio recording to transcribe: the longest, so the most complete. A
 * meeting with several holds alternate recordings of the same meeting, not
 * consecutive parts: the same file under two names, a recorder restarted a
 * few minutes in, or a joint meeting's other room. Undefined when there's
 * none.
 */
export function mainAudio(meeting: AkLegMeeting): MediaFile | undefined {
  return meeting.audio.reduce<MediaFile | undefined>(
    (best, a) => (!best || a.durationSecs > best.durationSecs ? a : best),
    undefined,
  );
}

/**
 * {@link VideoMetadata} for a meeting. akleg.gov has no channels: the
 * chamber and committee code ("HRES") stand in for one, as they're what a
 * body's meetings share. The title ends with the scheduled start as
 * "YYYY-MM-DD hh:mm:ss", which the pipeline reads the meeting's date and time
 * from. akleg.gov gives no publication date, so the meeting's own date stands
 * in for it.
 */
export function toMetadata(meeting: AkLegMeeting): VideoMetadata {
  const audio = mainAudio(meeting);
  return {
    id: meeting.id,
    channelId: meeting.id.split(" ")[0]!,
    title: `${meeting.committee} - ${meeting.date} ${meeting.time}`,
    description: meeting.location,
    durationSecs: audio ? audio.durationSecs : null,
    uploadDate: meeting.date,
  };
}

/** How to reach akleg.gov. */
export interface AkLegConfig {
  /** Replaces the global fetch; tests pass a fake. */
  fetch?: typeof fetch;
}

/**
 * Everything the pipeline gets from akleg.gov, the Alaska Legislature's site,
 * through its BASIS API. Create one with {@link akleg}; tests pass a fake
 * instead.
 *
 * Its {@link AudioProvider} methods take a meeting ID or meeting page URL
 * where YouTube's take a video ID or URL.
 */
export interface AkLeg extends AudioProvider {
  /**
   * The meetings of a committee (by chamber and code, "HRES") in a Legislature
   * (34 for 2025-2026; see {@link legislatureOf}) that have audio, newest
   * first.
   */
  meetingsOfCommittee(
    committee: string,
    legislature: number,
  ): Promise<AkLegMeeting[]>;
  getMeeting(meetingIdOrUrl: string): Promise<AkLegMeeting>;
}

/** An {@link AkLeg} that uses `config`. Does no I/O until a method is called. */
export function akleg(config: AkLegConfig = {}): AkLeg {
  const fetchFn = config.fetch ?? fetch;

  async function get(url: string, headers?: Record<string, string>) {
    const res = await fetchFn(url, { headers });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return res;
  }

  /**
   * One BASIS query. The query (eg "meetings;date=09/10/2018;chamber=H,media")
   * goes in a header; ",media" adds each meeting's recordings.
   */
  async function basis<T>(
    schema: z.ZodType<T>,
    query: string,
    legislature: number,
  ): Promise<T> {
    const section = query.split(";")[0];
    const res = await get(
      `${BASE}/publicservice/basis/${section}?minifyresult=true&json=true&session=${legislature}`,
      {
        "X-Alaska-Legislature-Basis-Version": "1.4",
        "X-Alaska-Legislature-Basis-Query": query,
      },
    );
    return parse(schema, await res.text());
  }

  async function getMeeting(meetingIdOrUrl: string): Promise<AkLegMeeting> {
    const id = meetingId(meetingIdOrUrl);
    const [, chamber, , year, month, day] = MEETING_ID_RE.exec(id)!;
    // A date query without a chamber fails with a FormatException.
    const { Basis } = await basis(
      meetingsResponse,
      `meetings;date=${month}/${day}/${year};chamber=${chamber},media`,
      legislatureOf(Number(year)),
    );
    const meeting = Basis.Meetings.map(toMeeting).find((m) => m.id === id);
    if (!meeting) throw new Error(`No akleg.gov meeting ${id}`);
    return meeting;
  }

  return {
    async meetingsOfCommittee(committee, legislature) {
      const chamber = committee.slice(0, 1);
      const code = committee.slice(1);
      const { Basis } = await basis(
        committeesResponse,
        `committees;code=${code};chamber=${chamber},meetings,media`,
        legislature,
      );
      const committees = Basis.Committees;
      if (committees.length === 0) {
        throw new Error(
          `No committee ${committee} in Legislature ${legislature}`,
        );
      }
      return committees
        .flatMap((c) => c.Meetings.map(toMeeting))
        .filter((m) => m.audio.length > 0)
        .sort((a, b) => b.id.slice(-19).localeCompare(a.id.slice(-19)));
    },
    getMeeting,
    getMetadata: async (meetingIdOrUrl) =>
      toMetadata(await getMeeting(meetingIdOrUrl)),
    async ensureAudioDownloaded(meetingIdOrUrl, path, { overwrite } = {}) {
      await mkdir(dirname(path), { recursive: true });
      const exists = await access(path).then(
        () => true,
        () => false,
      );
      if (exists && !overwrite) return { downloaded: false };
      const meeting = await getMeeting(meetingIdOrUrl);
      const audio = mainAudio(meeting);
      if (!audio)
        throw new Error(`No audio for akleg.gov meeting ${meeting.id}`);
      // Progress goes to stderr so callers' stdout stays machine-readable.
      console.error(`Downloading audio from ${audio.url} to ${path}...`);
      const res = await get(audio.url);
      if (!res.body) throw new Error(`GET ${audio.url}: no body`);
      // Decoded as it downloads; see mp3ToWav.
      await mp3ToWav(chunksOf(res.body), path);
      return { downloaded: true };
    },
  };
}

/** One committee's meetings on akleg.gov, as a body's meeting source. */
export interface AkLegSource {
  /** The chamber and committee code, as in meeting IDs ("HRES"). */
  committee: string;
  /**
   * The Legislature whose meetings to list; the one sitting now if omitted
   * (see {@link legislatureOf}).
   */
  legislature?: number;
}

/**
 * Lists the meetings with audio in `source`, newest first, using `config`.
 * Does no I/O until {@link VideoLister.listVideos} is called.
 */
export function aklegSource(
  source: AkLegSource,
  config: AkLegConfig = {},
): VideoLister {
  return {
    async listVideos() {
      const legislature =
        source.legislature ?? legislatureOf(new Date().getFullYear());
      const meetings = await akleg(config).meetingsOfCommittee(
        source.committee,
        legislature,
      );
      return meetings.map((m) => ({ id: m.id, title: toMetadata(m).title }));
    },
  };
}

/** A stream's chunks, as they arrive. */
async function* chunksOf(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
