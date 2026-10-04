import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  akleg,
  aklegSource,
  legislatureOf,
  mainAudio,
  mediaUrl,
  meetingId,
  parseMeetingId,
  meetingUrl,
} from "./index";

// Real BASIS API responses, trimmed to a few meetings.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
/** committees;code=RES;chamber=H,meetings,media for Legislature 30. */
const COMMITTEE = fixture("committee-hres-30.json");
/** meetings;date=09/10/2018;chamber=H,media. */
const MEETINGS_ON_DATE = fixture("meetings-h-2018-09-10.json");
/** What a malformed query gets, with HTTP 200. */
const ERROR = fixture("error.xml");

/** An akleg() whose fetch answers with `body` and records each request. */
function fake(body: string) {
  const requests: Array<{ url: string; query?: string }> = [];
  const source = akleg({
    fetch: (async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        url,
        query: headers?.["X-Alaska-Legislature-Basis-Query"],
      });
      return new Response(body);
    }) as typeof fetch,
  });
  return { source, requests };
}

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

  it("accepts codes with an ampersand", () => {
    const url = meetingUrl("SL&C 2017-03-07 13:30:00");
    expect(url).toBe(
      "https://www.akleg.gov/basis/Meeting/Detail?Meeting=SL%26C%202017-03-07%2013:30:00",
    );
    expect(meetingId(url)).toBe("SL&C 2017-03-07 13:30:00");
  });

  it("rejects anything else", () => {
    expect(() => meetingId("https://www.akleg.gov/basis/Committee/")).toThrow(
      "No akleg.gov meeting ID",
    );
  });
});

describe("parseMeetingId", () => {
  it("is undefined for what isn't an akleg.gov meeting", () => {
    expect(parseMeetingId("SL&C 2017-03-07 13:30:00")).toBe(
      "SL&C 2017-03-07 13:30:00",
    );
    expect(parseMeetingId("hTKVG_L61ec")).toBeUndefined();
    expect(
      parseMeetingId("https://www.youtube.com/watch?v=hTKVG_L61ec"),
    ).toBeUndefined();
  });
});

describe("legislatureOf", () => {
  it("numbers two-year Legislatures", () => {
    expect(legislatureOf(2017)).toBe(30);
    expect(legislatureOf(2018)).toBe(30);
    expect(legislatureOf(2026)).toBe(34);
  });
});

describe("mediaUrl", () => {
  it("fixes the API's slashes and scheme", () => {
    expect(
      mediaUrl(
        "http://www.akleg.gov/video/\\2018\\20180910\\jres\\jres_1400.m4v",
      ),
    ).toBe("https://www.akleg.gov/video/2018/20180910/jres/jres_1400.m4v");
    expect(
      mediaUrl(
        "http://www.akleg.gov/video/\\2017\\20170307\\sl&c\\sl&c_1330.m4v",
      ),
    ).toBe("https://www.akleg.gov/video/2017/20170307/sl&c/sl&c_1330.m4v");
  });
});

describe("meetingsOfCommittee", () => {
  it("lists meetings with audio, newest first", async () => {
    const { source, requests } = fake(COMMITTEE);
    const meetings = await source.meetingsOfCommittee("HRES", 30);
    // The cancelled meeting has no recordings, so it's left out.
    expect(meetings.map((m) => m.id)).toEqual([
      "HRES 2018-09-10 15:30:00",
      "HRES 2018-09-10 14:00:00",
    ]);
    expect(requests).toEqual([
      {
        url: "https://www.akleg.gov/publicservice/basis/committees?minifyresult=true&json=true&session=30",
        query: "committees;code=RES;chamber=H,meetings,media",
      },
    ]);
  });

  it("fails on an unknown committee", async () => {
    const { source } = fake('{"Basis":{"Committees":[]}}');
    await expect(source.meetingsOfCommittee("HXYZ", 30)).rejects.toThrow(
      "No committee HXYZ",
    );
  });
});

describe("getMeeting", () => {
  it("finds the meeting among its chamber's meetings that day", async () => {
    const { source, requests } = fake(MEETINGS_ON_DATE);
    expect(await source.getMeeting("HRES 2018-09-10 14:00:00")).toEqual({
      id: "HRES 2018-09-10 14:00:00",
      committee: "House RESOURCES",
      location: "Anch LIO AUDITORIUM",
      date: "2018-09-10",
      time: "14:00:00",
      cancelled: false,
      // The API lists this file twice.
      audio: [
        {
          url: "https://www.akleg.gov/ftr/2018/20180910/sres/sres_1400.mp3",
          durationSecs: 10746.5,
        },
      ],
      video: [
        {
          url: "https://www.akleg.gov/video/2018/20180910/jres/jres_1400.m4v",
          durationSecs: 11229.833,
        },
      ],
    });
    expect(requests.map((r) => r.query)).toEqual([
      "meetings;date=09/10/2018;chamber=H,media",
    ]);
  });

  it("fails on a meeting that isn't there", async () => {
    const { source } = fake(MEETINGS_ON_DATE);
    await expect(source.getMeeting("HRES 2018-09-10 09:00:00")).rejects.toThrow(
      "No akleg.gov meeting HRES 2018-09-10 09:00:00",
    );
  });

  it("reports the API's XML errors", async () => {
    const { source } = fake(ERROR);
    await expect(source.getMeeting("HRES 2018-09-10 14:00:00")).rejects.toThrow(
      "BASIS API error: FormatException",
    );
  });

  it("fails loudly when the response's shape changes", async () => {
    const { source } = fake('{"Basis":{"Meetings":[{"Chamber":"H"}]}}');
    await expect(
      source.getMeeting("HRES 2018-09-10 14:00:00"),
    ).rejects.toThrow();
  });
});

describe("getMetadata", () => {
  it("maps a meeting onto VideoMetadata", async () => {
    const { source } = fake(MEETINGS_ON_DATE);
    expect(await source.getMetadata("HRES 2018-09-10 14:00:00")).toEqual({
      id: "HRES 2018-09-10 14:00:00",
      channelId: "HRES",
      title: "House RESOURCES - 2018-09-10 14:00:00",
      description: "Anch LIO AUDITORIUM",
      durationSecs: 10746.5,
      uploadDate: "2018-09-10",
    });
  });
});

describe("mainAudio", () => {
  it("picks the longest recording", async () => {
    const { source } = fake(MEETINGS_ON_DATE);
    const meeting = await source.getMeeting("HRES 2018-09-10 14:00:00");
    const short = { url: "https://example.com/short.mp3", durationSecs: 10 };
    expect(mainAudio({ ...meeting, audio: [short, ...meeting.audio] })).toBe(
      meeting.audio[0],
    );
    expect(mainAudio({ ...meeting, audio: [] })).toBeUndefined();
  });
});

describe("aklegSource", () => {
  it("lists a committee's meetings as videos", async () => {
    const requests: string[] = [];
    const source = aklegSource(
      { committee: "HRES", legislature: 30 },
      {
        fetch: (async (url: string) => {
          requests.push(url);
          return new Response(COMMITTEE);
        }) as typeof fetch,
      },
    );
    expect(await source.listVideos()).toEqual([
      {
        id: "HRES 2018-09-10 15:30:00",
        title: "House RESOURCES - 2018-09-10 15:30:00",
      },
      {
        id: "HRES 2018-09-10 14:00:00",
        title: "House RESOURCES - 2018-09-10 14:00:00",
      },
    ]);
    expect(requests).toEqual([
      "https://www.akleg.gov/publicservice/basis/committees?minifyresult=true&json=true&session=30",
    ]);
  });
});
