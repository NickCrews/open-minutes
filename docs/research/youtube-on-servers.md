# Reaching YouTube from servers

Notes on how YouTube treats automated access (yt-dlp) from servers: GitHub
Actions runners, cloud containers, and Claude Code on the web. Findings are
dated: YouTube changes this behavior often, so re-test before relying on any
of it.

## The problem

From a residential connection (a developer's laptop), yt-dlp lists, inspects
and downloads videos with no configuration. From servers, listing still
works, and the rest fails in one of two ways.

**The bot check.** Single-video requests fail with:

```
ERROR: [youtube] <id>: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.
```

often alongside `HTTP Error 429: Too Many Requests` on the watch page, which
redirects to `google.com/sorry`. The cause is IP reputation, not the client:
YouTube flags address ranges belonging to cloud providers. From GitHub's
runners (Microsoft's AS8075) every player client hits it. From a cloud
container and from Claude Code on the web (which reaches YouTube over Google's
internal network), the `mweb` and `web_embedded` clients pass it.

**Stream URLs bound to an address.** Each stream URL carries the address
YouTube saw when it handed out the URL (its `ip=` parameter), and
`*.googlevideo.com` answers HTTP 403 when the download comes from another
one. In cloud containers and Claude Code on the web, the address YouTube sees
changes on every connection and the session can't fix it, so every audio
download gets 403, with every client, even when metadata works.

## What was tested from a cloud container (2026-10-01)

yt-dlp 2026.08.19 installed as `yt-dlp[default]`, with deno 2.9.7 available as
its JS runtime, from a cloud container (not a GitHub runner). No cookies.

| Operation                                                                       | Result from a datacenter IP                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| List a channel's videos (`--flat-playlist -J <channel url>`)                    | **Works**: ids, titles, durations, timestamps                            |
| List a playlist (`--flat-playlist -J <playlist url>`)                           | **Works**                                                                |
| List a channel's playlists (`<channel url>/playlists`)                          | **Works**                                                                |
| One video's metadata, default player clients                                    | Fails: "sign in to confirm you're not a bot"                             |
| One video's metadata, `player_client=mweb`                                      | **Works**: channel id, title, description, duration                      |
| One video's metadata, `player_client=web_embedded`                              | **Works**, but only for embeddable videos                                |
| One video's metadata, `web_safari`                                              | Passes the check, but returns only storyboards                           |
| `web`, `android`, `android_vr`, `ios`, `visionos`, `tv_downgraded`, `tv_simply` | Fail: bot check                                                          |
| `tv`, `web_music`, `web_creator`                                                | Fail: "page needs to be reloaded", "Video unavailable", "Please sign in" |
| Audio download, any client                                                      | Fails: HTTP 403 from `*.googlevideo.com`                                 |
| Channel/playlist RSS (`/feeds/videos.xml`)                                      | 404                                                                      |
| oEmbed                                                                          | Title and author only                                                    |

Clients are chosen with `--extractor-args "youtube:player_client=<name>"`.

Installing a JS runtime (deno) is needed for full format lists, but it does
**not** get past the bot check.

**Downloads.** The container reached Google through a rotating set of
addresses, and stream URLs are bound to the address that requested them
(their `ip=` parameter). The 2026-10-26 tests from Claude Code on the web
(below) show the same 403s and trace them to that binding. yt-dlp also warns
that `mweb` downloads need a GVS PO token.

## What was tested on GitHub runners (2026-10-02)

yt-dlp 2026.08.19 with deno 2.x, bgutil-ytdlp-pot-provider 2.0.1, no cookies.
The probe workflows (one short video in many configurations; a 92-minute
meeting in five parallel trials) were throwaway; what came out of them is
`.github/workflows/fetch-youtube-audio.yml`.

**Direct from the runner, nothing works.** `ubuntu-latest`,
`ubuntu-24.04-arm`, `macos-latest` and `windows-latest` all egress from
Microsoft's AS8075, and every player client (`default`, `mweb`, `web`,
`web_safari`, `tv`, `web_embedded`) gets `LOGIN_REQUIRED` ("Sign in to confirm
you're not a bot") on the player request. This includes `mweb`, which passed
from the cloud container on 2026-10-01.

**bgutil PO tokens don't help on their own.** With `fetch_pot=always`, bgutil
generates a player PO token and yt-dlp sends it, and YouTube still answers
`LOGIN_REQUIRED`. bgutil's README says as much: a PO token "does not bypass
IP-based login restrictions".

**Changing the egress IP works.** Through Cloudflare WARP in proxy mode
(`warp-cli mode proxy`, SOCKS5 on `127.0.0.1:40000`) the default client
downloads audio with no cookies and no PO token. Through Tor, the default
client also works, and `mweb` works with bgutil. In two runs of five parallel
trials on the 92-minute meeting (71.5 MiB of opus audio):

| Run | WARP, first attempt | WARP after retries | Tor fallback | Failed |
| --- | ------------------- | ------------------ | ------------ | ------ |
| 1   | 4                   | 1                  | 0            | 0      |
| 2   | 4                   | 0                  | 1            | 0      |

WARP downloads ran at about 10 MiB/s (6–12 s for the whole file); the Tor
download took 52 s. Some WARP exit IPs are flagged by YouTube (or
rate-limited by other sites), since they are shared with every WARP user.
Deleting and re-creating the WARP registration often keeps the same exit IP,
so the Tor fallback is what recovers from a flagged WARP exit. Later the same
day, after dozens of requests for one short video from these shared exits,
bot checks on both WARP and Tor became much more common (one trial in four
failed all its attempts), so expect the success rate to move.
`ffprobe` is not on the `ubuntu-latest` image; install `ffmpeg` with apt.

**Running WARP and Tor on a runner.** The scripts are in
`packages/ytdlp/egress/` (`install.sh`, `up.sh`, `rotate.sh`, `down.sh`),
and `runWithEgress` in `packages/ytdlp/src/egress.ts` drives them. Lessons from making
the setup fast:

- `apt-get install cloudflare-warp` takes ~30 s, mostly the desktop app's
  dependencies (GTK, WebKit, GStreamer). `warp-svc` and `warp-cli` need only
  `libtss2-esys` and `libtss2-tctildr`, and Tor only `libevent`, so unpacking
  those five `.deb` files with `dpkg-deb -x` and running the binaries directly
  takes ~2 s with the `.deb` files cached (13 s without).
- About 3 s after `warp-svc` starts it finishes scanning the network
  (`NetworkInfoChanged` in its log) and restarts its tunnel, dropping every
  connection through it. A download started before then fails partway with
  "Connection refused"; wait for that log line first.
- With `socks5h://` (hostnames resolved at the exit), WARP exits over IPv6;
  with `socks5://` (resolved on the runner, which has no IPv6), over IPv4. The
  IPv4 exits got through more often in these (small) samples.
- yt-dlp retries a broken connection 10 times by default, about a minute;
  `--retries 2` moves on to a fresh exit sooner.

With all that, a run of the workflow on the 92-minute meeting took 20 s once
the runner started: 1 s to install, 11 s to download.

## What was tested from Claude Code on the web (2026-10-26)

yt-dlp 2026.10.21 installed with `pip install "yt-dlp[default]"`
(yt-dlp-ejs 0.8.0), deno 2.9.8 on `PATH` as its JS runtime. No cookies, no PO
token, no WARP or Tor. Videos: `QUF1uLgzL-s` (5 s) and `9HoIM5INxpI` (a
2 h 46 min Girdwood Board of Supervisors meeting).

| Operation                                                                     | Result                                                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| List a channel's videos (`--flat-playlist -J <channel url>/videos`)           | **Works**: 200 entries with ids, titles, durations                                                        |
| Watch page                                                                    | HTTP 429 on most requests; yt-dlp carries on with the player API                                          |
| One video's metadata, default player clients                                  | Inconsistent: worked for the short video, bot check for the long one                                      |
| One video's metadata, `mweb`                                                  | **Works** on both, but the only stream offered is format 18 (360p mp4); the rest need a GVS PO token      |
| One video's metadata, `web_embedded`                                          | **Works** on both, with audio-only formats 140 and 251; one later request got SABR-only formats (no URLs) |
| One video's metadata, `web_safari`                                            | Storyboards only ("Requested format is not available")                                                    |
| One video's metadata, `tv`                                                    | Bot check (short video), "The page needs to be reloaded" (long one)                                       |
| One video's metadata, `android_vr`                                            | Bot check                                                                                                 |
| Audio download, default and `web_embedded` (`-f bestaudio`), `mweb` (`-f 18`) | Fails on both videos: HTTP 403 from `*.googlevideo.com`                                                   |
| The same with `--force-ipv4`, `--source-address`, or bypassing the proxy      | Fails: HTTP 403                                                                                           |

`@MunicipalityofAnchorage/streams` returned "Requested entity was not found"
(HTTP 404); the listing above is of channel `UCOUlNInprZEjhbpVPiJOlEA`.

**The network.**

- Outbound HTTPS goes through an agent proxy (`HTTPS_PROXY` and `https_proxy`
  set to `http://127.0.0.1:<port>`, no `HTTP_PROXY`). It re-terminates TLS
  with Anthropic's "Egress Gateway" CA, which the system store trusts; yt-dlp
  trusts it once installed with pip. `NO_PROXY` lists localhost, private
  ranges, package registries and Anthropic's APIs.
- Through the proxy, the public address is in `160.79.104.0/21`, registered
  to Anthropic, PBC and announced by AS396982 (Google LLC), geolocated to
  Columbus, Ohio. It changes between requests: 17 requests saw 9 addresses in
  `160.79.106.0/24`.
- Connections that skip the proxy are intercepted by the same gateway on
  ports 80 and 443 (the certificate is still the gateway's), and leave from
  Google Cloud addresses (`34.x`/`35.x`, `*.bc.googleusercontent.com`,
  Council Bluffs, Iowa, AS396982), a different one almost every time. yt-dlp
  needs `--compat-options no-certifi` to trust the gateway on that path.
- TCP to other ports (22, 853, 5222, 8080, 9001) does not connect, and a
  request to port 8443 through the proxy is reset. DNS over UDP port 53 gets
  answers; a STUN request to `stun.l.google.com:19302` gets none. So neither
  WARP (UDP) nor Tor (TCP to relays, unbroken TLS) can run here.
- YouTube doesn't see either public address. The `ip=` of every stream URL
  was a private IPv6 address in `fda3:e722:ac3:10::/64` (Google's internal
  network), different on each player request, through the proxy and around
  it.

**Why downloads fail.** The stream URL is bound to the private address of the
connection that fetched it, and the download goes out on a new connection
with a different one. Every googlevideo.com server (after a 302 to another
`rr*` host) answers 403. `--force-ipv4` and `--source-address` act on the
container's side (its only interface is `192.0.2.2`, and the proxy resolves
hostnames), so they change nothing; the player request and the download go
to different hosts, so they can't share one connection either. `mweb`'s 403s
could also come from the missing PO token, but `web_embedded` and the default
client need none and get the same 403.

## Takeaways

- **Discovering videos needs nothing special.** Flat-playlist listing of
  channels and playlists works from every environment tested.
- **Metadata depends on the network.** From a home IP, any client works.
  From cloud containers and Claude Code on the web, `mweb` and
  `web_embedded` work (2026-10-01 and 2026-10-26). From GitHub's runners,
  nothing works without changing the egress (2026-10-02). Expect the working
  clients to change; keep them configurable.
- **Audio download needs one address YouTube trusts for the whole fetch.** It
  works from a home IP, and from GitHub's runners through WARP or Tor. It
  fails from cloud containers and Claude Code on the web, where the address
  YouTube sees changes on every connection and nothing in the session can pin
  it. Claude Code on the web can't replace the `fetch-youtube-audio`
  workflow.
- **The 2026-10-01 caveat is settled: the 403s come from the rotating
  egress.** On 2026-10-26 the player request passed the bot check, the stream
  URL was bound to a private address that changed on the next request, and
  the download got 403 with clients that need no PO token. A download from
  the bound address can't be tried from these sandboxes; on GitHub's runners,
  WARP and Tor, which keep one exit for the whole fetch, do download.

## Options for downloads

| Option                                         | Works?                                                                                                   | Cost / burden                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Cookies from a signed-in account               | Reliable, per yt-dlp's docs                                                                              | Throwaway account (YouTube may ban it); cookies expire and rotate      |
| Another player client                          | Metadata yes from Google-network sandboxes, no from runners; downloads 403 everywhere                    | None; breaks when YouTube changes                                      |
| PO tokens (bgutil-ytdlp-pot-provider + `mweb`) | Not on GitHub runners: the IP block comes first (2026-10-02)                                             | A sidecar server; breaks when YouTube changes                          |
| Residential proxy (`--proxy`)                  | Reported reliable. The player request must go through it too, since stream URLs are bound to its address | Roughly $1–7/GB; a 90-minute meeting's audio is ~50–90 MB              |
| Self-hosted runner or cron on a home machine   | Works (it's a residential IP)                                                                            | The machine must be on; self-hosted runners on a public repo need care |
| Cloudflare WARP as egress                      | Yes on GitHub runners: 9 of 10 trials; Tor got the 10th (2026-10-02)                                     | WireGuard sidecar; terms-of-service grey area; needs UDP               |
| Claude Code on the web, direct                 | No: metadata yes, downloads 403 (2026-10-26)                                                             | The session can't choose its egress; no UDP or arbitrary TCP           |
| Cloudflare Workers / Containers                | Unknown: no reports either way, egress IPs undocumented. A Worker can't run yt-dlp itself                | Containers need the Workers Paid plan                                  |
| GitHub `macos-latest` runners                  | No: also AS8075, same bot check (2026-10-02)                                                             | 10× minute multiplier                                                  |
| Invidious / Piped                              | Public instances are mostly blocked themselves                                                           | Unreliable                                                             |
| IPv6 address rotation                          | Mixed reports                                                                                            | Needs a host with a routed /64                                         |

## The YouTube Data API

The official [YouTube Data API v3](https://developers.google.com/youtube/v3)
covers listing (channel → uploads playlist → `playlistItems.list`) and
metadata (`videos.list`) with an API key from any Google Cloud project with
the API enabled. It has no bot check and a free quota of 10,000 units a day;
list calls cost 1 unit per page of 50, so listing a channel of a few hundred
videos costs a handful of units. It can never download media.

## Testing on a runner

A container is not a stand-in for a GitHub runner. To answer "does X work in
CI", run a manually triggered (`workflow_dispatch`) workflow on the runner
images in question that, without cookies, tries listing, metadata and a short
audio download for each player client, and writes a pass/fail table to the
job summary. Use a short (a few seconds) public video so downloads are cheap,
and keep the request count low.

## Sources

- [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [yt-dlp: exporting YouTube cookies](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies)
- [yt-dlp EJS (JS runtime) docs](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [Leveraging Cloudflare WARP to bypass YouTube's API restrictions](https://blog.arfevrier.fr/leveraging-cloudflare-warp-to-bypass-youtubes-api-restrictions/)
- [Cloudflare WARP client on Linux](https://developers.cloudflare.com/warp-client/get-started/linux/)
- [Cloudflare Containers: outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic)
- [bgutil-ytdlp-pot-provider issue: still asked to sign in](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/issues/37)
- [YouTube Data API: playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list)
