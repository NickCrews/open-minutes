import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  akleg,
  legislatureOf,
  meetingId,
  meetingUrl,
  parseCommitteePage,
  parseMeetingPage,
  toMetadata,
} from "./index";

// Trimmed from the live pages, verbatim: the heading and the media player's
// inline script for meetings, a few rows of the "Meetings" tab for committees.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const VIDEO_PAGE = fixture("meeting-video.html");
const AUDIO_PAGE = fixture("meeting-audio.html");
const COMMITTEE_PAGE = fixture("committee.html");

describe("meetingId", () => {
  it("accepts an ID or a meeting page URL", () => {
    expect(meetingId("HRES 2018-09-10 14:00:00")).toBe(
      "HRES 2018-09-10 14:00:00",
    );
    expect(
      meetingId(
        "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
      ),
    ).toBe("HRES 2018-09-10 14:00:00");
  });

  it("rejects anything else", () => {
    expect(() => meetingId("https://www.akleg.gov/basis/Committee/")).toThrow(
      "No akleg.gov meeting ID",
    );
  });

  it("round-trips through meetingUrl", () => {
    const url = meetingUrl("HRES 2018-09-10 14:00:00");
    expect(url).toBe(
      "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
    );
    expect(meetingId(url)).toBe("HRES 2018-09-10 14:00:00");
  });
});

describe("legislatureOf", () => {
  it("numbers two-year Legislatures", () => {
    expect(legislatureOf(2017)).toBe(30);
    expect(legislatureOf(2018)).toBe(30);
    expect(legislatureOf(2026)).toBe(34);
  });
});

describe("parseCommitteePage", () => {
  it("lists recorded meetings, newest first", () => {
    expect(parseCommitteePage(COMMITTEE_PAGE)).toEqual([
      { id: "HRES 2018-09-10 15:30:00", hasVideo: false },
      { id: "HRES 2018-09-10 14:00:00", hasVideo: true },
      { id: "HRES 2018-07-11 09:00:00", hasVideo: true },
    ]);
  });
});

describe("parseMeetingPage", () => {
  it("reads a meeting with video", () => {
    expect(parseMeetingPage("HRES 2018-09-10 14:00:00", VIDEO_PAGE)).toEqual({
      id: "HRES 2018-09-10 14:00:00",
      heading: "09/10/2018 02:00 PM House RESOURCES",
      legislature: "Legislature(2017 - 2018)",
      location: "Anch LIO AUDITORIUM",
      audioUrl: "https://www.akleg.gov/ftr/2018/20180910/sres/sres_1400.mp3",
      audioDurationSecs: 10746.5,
      videoUrl: "https://www.akleg.gov/video//2018/20180910/jres/jres_1400.m4v",
      agenda: [
        { title: "Start", offsetSecs: 15 },
        { title: "Overview: Coastal Resiliency Management", offsetSecs: 111 },
        { title: "Adjourn", offsetSecs: 10528 },
      ],
    });
  });

  it("reads an audio-only meeting", () => {
    const meeting = parseMeetingPage("HRES 2018-09-10 15:30:00", AUDIO_PAGE);
    expect(meeting.audioUrl).toBe(
      "https://www.akleg.gov/ftr/2018/20180910/sres/sres_1533.mp3",
    );
    expect(meeting.videoUrl).toBeNull();
  });

  it("fails on a page with no audio", () => {
    expect(() => parseMeetingPage("HRES 2018-09-10 14:00:00", "")).toThrow(
      "No audio",
    );
  });
});

describe("toMetadata", () => {
  it("maps a meeting onto VideoMetadata", () => {
    const meeting = parseMeetingPage("HRES 2018-09-10 14:00:00", VIDEO_PAGE);
    expect(toMetadata(meeting)).toEqual({
      id: "HRES 2018-09-10 14:00:00",
      channelId: "HRES",
      title: "09/10/2018 02:00 PM House RESOURCES",
      description: [
        "Legislature(2017 - 2018)",
        "Anch LIO AUDITORIUM",
        "",
        "0:00:15 Start",
        "0:01:51 Overview: Coastal Resiliency Management",
        "2:55:28 Adjourn",
      ].join("\n"),
      durationSecs: 10746.5,
      uploadDate: "2018-09-10",
    });
  });
});

describe("akleg", () => {
  it("fetches a meeting's page by its ID", async () => {
    const urls: string[] = [];
    const source = akleg({
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(VIDEO_PAGE);
      }) as typeof fetch,
    });
    const metadata = await source.getMetadata("HRES 2018-09-10 14:00:00");
    expect(metadata.channelId).toBe("HRES");
    expect(urls).toEqual([meetingUrl("HRES 2018-09-10 14:00:00")]);
  });

  it("fetches a committee's page for a Legislature", async () => {
    const urls: string[] = [];
    const source = akleg({
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(COMMITTEE_PAGE);
      }) as typeof fetch,
    });
    expect(await source.meetingsOfCommittee("HRES", 30)).toHaveLength(3);
    expect(urls).toEqual([
      "https://www.akleg.gov/basis/Committee/Details/30?code=HRES",
    ]);
  });
});
