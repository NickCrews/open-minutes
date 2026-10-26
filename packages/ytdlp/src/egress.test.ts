import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { down, rotate, unavailableReason, up } from "./daemons";
import { EgressError, egress, runWithEgress } from "./egress";
import { YtDlpError, run } from "./run";

vi.mock("./run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run")>();
  return { ...actual, run: vi.fn() };
});
vi.mock("./daemons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemons")>();
  return {
    ...actual,
    unavailableReason: vi.fn(),
    up: vi.fn(),
    rotate: vi.fn(),
    down: vi.fn(),
  };
});

const BOT_CHECK =
  "ERROR: [youtube] QUF1uLgzL-s: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.";
const PRIVATE = "ERROR: [youtube] QUF1uLgzL-s: Private video";
const ARGS = ["--skip-download", "-J", "https://www.youtube.com/watch?v=x"];

function ytDlpError(stderr: string) {
  return new YtDlpError(ARGS, "", `${stderr}\n`, new Error("exit 1"));
}

const proxyOf = (args: readonly string[]) => {
  const i = args.indexOf("--proxy");
  return i === -1 ? "direct" : args[i + 1];
};

/**
 * Replaces yt-dlp with `reply`, called with the proxy (or "direct") of each
 * attempt, and returns the proxy of each call.
 */
function fakeYtDlp(reply: (proxy: string) => string | YtDlpError) {
  const calls: string[] = [];
  vi.mocked(run).mockImplementation(async (args) => {
    const proxy = proxyOf(args)!;
    calls.push(proxy);
    const out = reply(proxy);
    if (out instanceof YtDlpError) throw out;
    return { stdout: out, stderr: "" };
  });
  return calls;
}

/** WARP's exits are warp1, warp2, ...; Tor's tor1, tor2, .... */
function fakeDaemons({
  unavailable = {},
  upFails = [],
}: {
  unavailable?: Partial<Record<"warp" | "tor", string>>;
  upFails?: ("warp" | "tor")[];
} = {}) {
  const exits = { warp: 0, tor: 0 };
  vi.mocked(unavailableReason).mockImplementation(
    async (service) => unavailable[service] ?? null,
  );
  vi.mocked(up).mockImplementation(async (service) => {
    if (upFails.includes(service)) throw new Error(`up.sh ${service}: failed`);
    return `socks5://${service}${++exits[service]}`;
  });
  vi.mocked(rotate).mockImplementation(
    async (service) => `socks5://${service}${++exits[service]}`,
  );
  vi.mocked(down).mockResolvedValue();
}

const quiet = { log: () => {} };
let state: string;

beforeEach(async () => {
  vi.clearAllMocks();
  state = await mkdtemp(join(tmpdir(), "ytdlp-egress-"));
  vi.stubEnv("YOUTUBE_EGRESS_STATE", state);
  vi.stubEnv("YOUTUBE_EGRESS", "");
  fakeDaemons();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(run).mockReset();
  await rm(state, { recursive: true, force: true });
});

describe("runWithEgress", () => {
  it("goes direct when that works, starting nothing", async () => {
    const calls = fakeYtDlp(() => "{}");
    const result = await runWithEgress(ARGS, quiet);
    expect(result).toEqual({ stdout: "{}", stderr: "", route: "direct" });
    expect(calls).toEqual(["direct"]);
    expect(vi.mocked(run).mock.calls[0]![0]).toEqual(ARGS);
    expect(up).not.toHaveBeenCalled();
    expect(down).not.toHaveBeenCalled();
  });

  it("starts WARP when direct is blocked, and stops it after", async () => {
    const calls = fakeYtDlp((proxy) =>
      proxy === "direct" ? ytDlpError(BOT_CHECK) : "{}",
    );
    const result = await runWithEgress(ARGS, quiet);
    expect(result.route).toBe("warp");
    expect(calls).toEqual(["direct", "socks5://warp1"]);
    expect(vi.mocked(run).mock.calls[1]![0]).toEqual([
      "--proxy",
      "socks5://warp1",
      "--retries",
      "2",
      "--fragment-retries",
      "2",
      ...ARGS,
    ]);
    expect(up).toHaveBeenCalledTimes(1);
    expect(down).toHaveBeenCalledTimes(1);
    expect(existsSync(join(state, "manager.lock"))).toBe(false);
  });

  it("gives WARP two new exits, then moves to Tor", async () => {
    const calls = fakeYtDlp((proxy) =>
      proxy === "socks5://tor2" ? "{}" : ytDlpError(BOT_CHECK),
    );
    const result = await runWithEgress(ARGS, quiet);
    expect(result.route).toBe("tor");
    expect(calls).toEqual([
      "direct",
      "socks5://warp1",
      "socks5://warp2",
      "socks5://warp3",
      "socks5://tor1",
      "socks5://tor2",
    ]);
  });

  it("moves on when a route's proxy can't be reached", async () => {
    vi.stubEnv("YOUTUBE_EGRESS", "socks5://a,socks5://b");
    const calls = fakeYtDlp((proxy) =>
      proxy === "socks5://a"
        ? ytDlpError(
            "ERROR: [youtube] x: Unable to download API page: Unable to connect to proxy",
          )
        : "{}",
    );
    const result = await runWithEgress(ARGS, quiet);
    expect(result.route).toBe("socks5://b");
    expect(calls).toEqual(["socks5://a", "socks5://b"]);
    expect(up).not.toHaveBeenCalled();
  });

  it("throws an error that isn't a blocked exit at once", async () => {
    const calls = fakeYtDlp(() => ytDlpError(PRIVATE));
    await expect(runWithEgress(ARGS, quiet)).rejects.toMatchObject({
      name: "YtDlpError",
      message: PRIVATE,
    });
    expect(calls).toEqual(["direct"]);
  });

  it("takes the caller's isBlocked", async () => {
    const calls = fakeYtDlp((proxy) =>
      proxy === "direct" ? ytDlpError(PRIVATE) : "{}",
    );
    const result = await runWithEgress(ARGS, {
      ...quiet,
      isBlocked: (e) => e.stderr.includes("Private"),
    });
    expect(result.route).toBe("warp");
    expect(calls).toEqual(["direct", "socks5://warp1"]);
  });

  it("runs beforeAttempt before every attempt", async () => {
    const order: string[] = [];
    fakeYtDlp((proxy) => {
      order.push(proxy);
      return proxy === "socks5://warp2" ? "{}" : ytDlpError(BOT_CHECK);
    });
    await runWithEgress(ARGS, {
      ...quiet,
      beforeAttempt: () => order.push("clear"),
    });
    expect(order).toEqual([
      "clear",
      "direct",
      "clear",
      "socks5://warp1",
      "clear",
      "socks5://warp2",
    ]);
  });

  it("skips routes that can't run here", async () => {
    fakeDaemons({ unavailable: { warp: "WARP runs only on Linux" } });
    const calls = fakeYtDlp((proxy) =>
      proxy === "direct" ? ytDlpError(BOT_CHECK) : "{}",
    );
    const result = await runWithEgress(ARGS, quiet);
    expect(result.route).toBe("tor");
    expect(calls).toEqual(["direct", "socks5://tor1"]);
    expect(up).toHaveBeenCalledWith("tor", expect.anything());
    expect(up).not.toHaveBeenCalledWith("warp", expect.anything());
  });

  it("names each route's outcome when none works", async () => {
    fakeDaemons({ unavailable: { warp: "WARP runs only on Linux" } });
    fakeYtDlp(() => ytDlpError(BOT_CHECK));
    const error = await runWithEgress(ARGS, quiet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EgressError);
    expect((error as EgressError).routes).toEqual([
      { route: "direct", outcome: "blocked", error: BOT_CHECK },
      {
        route: "warp",
        outcome: "unavailable",
        reason: "WARP runs only on Linux",
      },
      { route: "tor", outcome: "blocked", error: BOT_CHECK },
    ]);
    expect((error as Error).message).toBe(
      [
        "yt-dlp got through on no route:",
        `  direct: blocked: ${BOT_CHECK}`,
        "  warp: unavailable: WARP runs only on Linux",
        `  tor: blocked: ${BOT_CHECK}`,
      ].join("\n"),
    );
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("counts a daemon that won't start as unavailable, and still stops it", async () => {
    vi.stubEnv("YOUTUBE_EGRESS", "warp");
    fakeDaemons({ upFails: ["warp"] });
    const calls = fakeYtDlp(() => "{}");
    const error = await runWithEgress(ARGS, quiet).catch((e: unknown) => e);
    expect((error as EgressError).routes).toEqual([
      { route: "warp", outcome: "unavailable", reason: "up.sh warp: failed" },
    ]);
    expect(calls).toEqual([]);
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("ends a daemon route early when rotating fails", async () => {
    vi.stubEnv("YOUTUBE_EGRESS", "warp,tor");
    vi.mocked(rotate).mockRejectedValue(new Error("rotate.sh warp: failed"));
    const calls = fakeYtDlp((proxy) =>
      proxy === "socks5://tor1" ? "{}" : ytDlpError(BOT_CHECK),
    );
    const result = await runWithEgress(ARGS, quiet);
    expect(result.route).toBe("tor");
    expect(calls).toEqual(["socks5://warp1", "socks5://tor1"]);
  });

  it("reads its routes from YOUTUBE_EGRESS", async () => {
    vi.stubEnv("YOUTUBE_EGRESS", "tor");
    const calls = fakeYtDlp(() => "{}");
    const result = await runWithEgress(ARGS, quiet);
    expect(result.route).toBe("tor");
    expect(calls).toEqual(["socks5://tor1"]);
  });
});

describe("egress", () => {
  it("keeps daemons up and blocked routes skipped until close", async () => {
    const calls = fakeYtDlp((proxy) =>
      proxy === "direct" ? ytDlpError(BOT_CHECK) : "{}",
    );
    const manager = egress(quiet);
    try {
      expect((await manager.run(ARGS)).route).toBe("warp");
      expect((await manager.run(ARGS)).route).toBe("warp");
      expect(calls).toEqual(["direct", "socks5://warp1", "socks5://warp1"]);
      expect(up).toHaveBeenCalledTimes(1);
      expect(down).not.toHaveBeenCalled();
      expect(existsSync(join(state, "manager.lock"))).toBe(true);
    } finally {
      await manager.close();
    }
    expect(down).toHaveBeenCalledTimes(1);
    expect(existsSync(join(state, "manager.lock"))).toBe(false);
    await expect(manager.run(ARGS)).rejects.toThrow(/closed/);
  });

  it("waits for another manager on this machine before starting a daemon", async () => {
    const calls = fakeYtDlp((proxy) =>
      proxy === "direct" ? ytDlpError(BOT_CHECK) : "{}",
    );
    const first = egress({ ...quiet, routes: ["warp"] });
    const second = egress({ ...quiet, routes: ["direct", "warp"] });
    await first.run(ARGS);
    let secondDone = false;
    const secondRun = second.run(ARGS).then((r) => {
      secondDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 1_200));
    // Direct needs no lock, so the second got that far.
    expect(calls).toEqual(["socks5://warp1", "direct"]);
    expect(secondDone).toBe(false);
    await first.close();
    expect((await secondRun).route).toBe("warp");
    await second.close();
  });
});
