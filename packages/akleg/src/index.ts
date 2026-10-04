import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AudioProvider,
  VideoMetadata,
} from "@open-minutes/core/audio-provider";
import { mp3ToWav } from "./mp3";

export type {
  AudioProvider,
  VideoMetadata,
} from "@open-minutes/core/audio-provider";

const BASE = "https://www.akleg.gov";

/**
 * akleg.gov names a meeting by its committee code and scheduled start, Alaska
 * time: "HRES 2018-09-10 14:00:00" is House Resources at 2 PM on 2018-09-10.
 * The code is the chamber (H, S, or J for joint) and the committee.
 */
const MEETING_ID_RE =
  /^([A-Z][A-Z0-9]*) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

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

/** The meeting's page on akleg.gov, which has its audio and video. */
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

/** A meeting as listed on its committee's page. */
export interface CommitteeMeeting {
  /** The meeting ID ("HRES 2018-09-10 14:00:00"); see {@link meetingId}. */
  id: string;
  /** Whether akleg.gov has video of it, or only audio. */
  hasVideo: boolean;
}

/**
 * The meetings with a recording on a committee page
 * (/basis/Committee/Details/<legislature>?code=<code>), newest first, as
 * listed. Meetings with no recording (cancelled, or not yet held) have no
 * "Audio" link and are left out.
 */
export function parseCommitteePage(html: string): CommitteeMeeting[] {
  const seen = new Set<string>();
  const meetings: CommitteeMeeting[] = [];
  const re =
    /class="link-video" href="[^"]*Meeting\/Detail\?Meeting=([^"#]+)">([^<]*)</g;
  for (const m of html.matchAll(re)) {
    const id = decodeURIComponent(m[1]!);
    if (seen.has(id) || !MEETING_ID_RE.test(id)) continue;
    seen.add(id);
    meetings.push({ id, hasVideo: /video/i.test(m[2]!) });
  }
  return meetings;
}

/** An item of a meeting's agenda, with when it came up in the recording. */
export interface AgendaMarker {
  title: string;
  /** Seconds into the audio recording ({@link AkLegMeeting.audioUrl}). */
  offsetSecs: number;
}

/** What a meeting page says about the meeting. */
export interface AkLegMeeting {
  id: string;
  /** The page's heading, eg "09/10/2018 02:00 PM House RESOURCES". */
  heading: string;
  /** Eg "Legislature(2017 - 2018)". */
  legislature: string;
  /** Eg "Anch LIO AUDITORIUM". */
  location: string;
  /**
   * The "FTR" (For The Record) audio recording, an MP3. Every recorded meeting
   * has one; its file name isn't derivable from the meeting ID, so it comes
   * from the page.
   */
  audioUrl: string;
  /** Its length, as the page states it; null if not stated. */
  audioDurationSecs: number | null;
  /**
   * The video (an MP4 named .m4v), if any. Its timeline differs from the
   * audio's: it starts at a different wall-clock time and runs longer.
   */
  videoUrl: string | null;
  /** The log notes' markers ("Start", each bill or overview, "Adjourn"). */
  agenda: AgendaMarker[];
}

/**
 * Reads a meeting page (/basis/Meeting/Detail?Meeting=<id>). The page's media
 * player is jPlayer, set up by inline script: the media URLs and the agenda
 * markers' positions are read from that script.
 */
export function parseMeetingPage(id: string, html: string): AkLegMeeting {
  const audioUrl = /setMedia",\s*\{\s*mp3:\s*"([^"]+)"/.exec(html)?.[1];
  if (!audioUrl) throw new Error(`No audio on the akleg.gov page for ${id}`);
  const videoUrl = /setMedia",\s*\{\s*m4v:\s*"([^"]*)"/.exec(html)?.[1];
  // loadBar() sets the video's length, then the audio's in the else branch.
  const audioMs = /else\s*\{\s*totalMediaTime=(\d+);\s*\}/.exec(html)?.[1];
  const agenda: AgendaMarker[] = [];
  // Each marker's audio position is "100000*<seconds>/totalMediaTime" percent.
  const markerRe =
    /newA\.title="([^"]*)";[\s\S]*?else\s*\{\s*newDiv\.style\.left=\(100000\*(\d+)\/totalMediaTime\)/g;
  for (const m of html.matchAll(markerRe)) {
    agenda.push({ title: decodeEntities(m[1]!), offsetSecs: Number(m[2]) });
  }
  const heading = /<div class="heading-container">([\s\S]*?)<\/div>/.exec(
    html,
  )?.[1];
  return {
    id,
    heading: text(/<h1>([\s\S]*?)<\/h1>/.exec(heading ?? "")?.[1]),
    legislature: text(
      /<em class="date">([\s\S]*?)<\/em>/.exec(heading ?? "")?.[1],
    ),
    location: text(/<span[^>]*>([\s\S]*?)<\/span>/.exec(heading ?? "")?.[1]),
    audioUrl: https(audioUrl),
    audioDurationSecs: audioMs ? Number(audioMs) / 1000 : null,
    videoUrl: videoUrl ? https(videoUrl) : null,
    agenda,
  };
}

/** HTML's text, entities decoded and whitespace collapsed. */
function text(html: string | undefined): string {
  return decodeEntities((html ?? "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The page links some media as http://; akleg.gov serves it all on https. */
function https(url: string): string {
  return url.replace(/^(https?:)?\/\//, "https://");
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

/** "0:02:26" for 146 s. */
function clock(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * {@link VideoMetadata} for a meeting. akleg.gov has no channels: the
 * committee code ("HRES") stands in for one, as it's what a body's meetings
 * share. The title is the page's heading, whose "MM/DD/YYYY hh:mm AM" the
 * pipeline reads the meeting's date and time from. akleg.gov gives no
 * publication date, so the meeting's own date stands in for it.
 */
export function toMetadata(meeting: AkLegMeeting): VideoMetadata {
  const [, committee, date] = MEETING_ID_RE.exec(meeting.id)!;
  const description = [
    meeting.legislature,
    meeting.location,
    "",
    ...meeting.agenda.map((a) => `${clock(a.offsetSecs)} ${a.title}`),
  ].join("\n");
  return {
    id: meeting.id,
    channelId: committee!,
    title: meeting.heading,
    description: description.trim(),
    durationSecs: meeting.audioDurationSecs,
    uploadDate: date!,
  };
}

/** How to reach akleg.gov. */
export interface AkLegConfig {
  /** Replaces the global fetch; tests pass a fake. */
  fetch?: typeof fetch;
}

/**
 * Everything the pipeline gets from akleg.gov, the Alaska Legislature's site.
 * Create one with {@link akleg}; tests pass a fake instead.
 *
 * Its {@link AudioProvider} methods take a meeting ID or meeting page URL
 * where YouTube's take a video ID or URL.
 */
export interface AkLeg extends AudioProvider {
  /**
   * The recorded meetings of the committee with `code` ("HRES") in a
   * Legislature (34 for 2025-2026; see {@link legislatureOf}), newest first.
   */
  meetingsOfCommittee(
    code: string,
    legislature: number,
  ): Promise<CommitteeMeeting[]>;
  /** Everything the meeting's page says about it. */
  getMeeting(meetingIdOrUrl: string): Promise<AkLegMeeting>;
}

/** An {@link AkLeg} that uses `config`. Does no I/O until a method is called. */
export function akleg(config: AkLegConfig = {}): AkLeg {
  const fetchFn = config.fetch ?? fetch;

  async function get(url: string): Promise<Response> {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return res;
  }

  async function getMeeting(meetingIdOrUrl: string): Promise<AkLegMeeting> {
    const id = meetingId(meetingIdOrUrl);
    const html = await (await get(meetingUrl(id))).text();
    return parseMeetingPage(id, html);
  }

  return {
    async meetingsOfCommittee(code, legislature) {
      const url = `${BASE}/basis/Committee/Details/${legislature}?code=${encodeURIComponent(code)}`;
      return parseCommitteePage(await (await get(url)).text());
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
      const { audioUrl } = await getMeeting(meetingIdOrUrl);
      // Progress goes to stderr so callers' stdout stays machine-readable.
      console.error(`Downloading audio from ${audioUrl} to ${path}...`);
      const res = await get(audioUrl);
      if (!res.body) throw new Error(`GET ${audioUrl}: no body`);
      // Decoded as it downloads; see mp3ToWav.
      await mp3ToWav(chunksOf(res.body), path);
      return { downloaded: true };
    },
  };
}
