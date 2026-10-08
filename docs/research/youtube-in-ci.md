# Reaching YouTube from CI and servers

Notes on how YouTube treats automated access (yt-dlp) from datacenter
networks, and the options for getting past it. Findings are dated: YouTube
changes this behavior often, so re-test before relying on any of it.

## The problem

From a residential connection (a developer's laptop), yt-dlp lists, inspects
and downloads videos with no configuration. From a datacenter network (GitHub
Actions runners, cloud VMs and containers), single-video requests fail with:

```
ERROR: [youtube] <id>: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.
```

often alongside `HTTP Error 429: Too Many Requests` on the watch page, which
redirects to `google.com/sorry`.

The cause is IP reputation, not the client: YouTube flags address ranges
belonging to cloud providers (GitHub's Linux runners are on Azure). The same
yt-dlp version, with the same flags, works from a home IP.

## What was tested (2026-10-01)

yt-dlp 2026.08.19 installed as `yt-dlp[default]`, with deno 2.9.7 available as
its JS runtime, from a cloud container (not a GitHub runner; see the caveat
below). No cookies.

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

**Caveat on downloads.** The test container reached Google through a rotating
set of addresses, and stream URLs are bound to the IP that requested them
(their `ip=` parameter), so the 403s there may come from the rotation rather
than the bot check. A GitHub runner keeps one IP for a job, so downloads there
must be tested on a runner itself. yt-dlp also warns that `mweb` downloads need
a GVS PO token.

### Takeaways

- **Discovering videos needs nothing special.** Flat-playlist listing of
  channels and playlists works from datacenter IPs.
- **Metadata works with the right player client** (`mweb` at the time of
  testing). Expect the working client to change; keep it configurable.
- **Audio download is the hard part.** It needs either an IP YouTube trusts,
  a PO token, or a signed-in session.

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
`packages/youtube/egress/` (`install.sh`, `up.sh`, `rotate.sh`, `down.sh`),
and `.github/scripts/fetch-youtube-audio.sh` drives them. Lessons from making
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

## Options for downloads

| Option                                              | Works?                                                                                    | Cost / burden                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Cookies from a signed-in account                    | Reliable, per yt-dlp's docs                                                               | Throwaway account (YouTube may ban it); cookies expire and rotate      |
| Another player client                               | Metadata yes; downloads untested on runners                                               | None; breaks when YouTube changes                                      |
| PO tokens (bgutil-ytdlp-pot-provider + `mweb`)      | Not on GitHub runners: the IP block comes first (2026-10-02)                              | A sidecar server; breaks when YouTube changes                          |
| Residential proxy (`--proxy`) for the download only | Reported reliable                                                                         | Roughly $1–7/GB; a 90-minute meeting's audio is ~50–90 MB              |
| Self-hosted runner or cron on a home machine        | Works (it's a residential IP)                                                             | The machine must be on; self-hosted runners on a public repo need care |
| Cloudflare WARP as egress                           | Yes on GitHub runners: 9 of 10 trials; Tor got the 10th (2026-10-02)                      | WireGuard sidecar; terms-of-service grey area                          |
| Cloudflare Workers / Containers                     | Unknown: no reports either way, egress IPs undocumented. A Worker can't run yt-dlp itself | Containers need the Workers Paid plan                                  |
| GitHub `macos-latest` runners                       | Untested; different IP space from the Azure Linux runners                                 | 10× minute multiplier                                                  |
| Invidious / Piped                                   | Public instances are mostly blocked themselves                                            | Unreliable                                                             |
| IPv6 address rotation                               | Mixed reports                                                                             | Needs a host with a routed /64                                         |

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
