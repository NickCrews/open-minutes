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

## Options for downloads

| Option                                              | Works?                                                                                    | Cost / burden                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Cookies from a signed-in account                    | Reliable, per yt-dlp's docs                                                               | Throwaway account (YouTube may ban it); cookies expire and rotate      |
| Another player client                               | Metadata yes; downloads untested on runners                                               | None; breaks when YouTube changes                                      |
| PO tokens (bgutil-ytdlp-pot-provider + `mweb`)      | yt-dlp's recommended route for flagged IPs; mixed reports from datacenter IPs             | A sidecar server; breaks when YouTube changes                          |
| Residential proxy (`--proxy`) for the download only | Reported reliable                                                                         | Roughly $1–7/GB; a 90-minute meeting's audio is ~50–90 MB              |
| Self-hosted runner or cron on a home machine        | Works (it's a residential IP)                                                             | The machine must be on; self-hosted runners on a public repo need care |
| Cloudflare WARP as egress                           | One 2025 report of yt-dlp working through it                                              | WireGuard sidecar; terms-of-service grey area                          |
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
- [Cloudflare Containers: outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic)
- [bgutil-ytdlp-pot-provider issue: still asked to sign in](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/issues/37)
- [YouTube Data API: playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list)
