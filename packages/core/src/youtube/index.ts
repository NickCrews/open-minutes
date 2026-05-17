import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export function channelUrl(channelIdOrUrl: string) {
    // if youtube.com already, return as-is
    if (channelIdOrUrl.includes("youtube.com")) {
        return channelIdOrUrl;
    }
    return `https://www.youtube.com/channel/${channelIdOrUrl}`;
}

export function videoUrl(videoIdOrUrl: string) {
    // if youtube.com already, return as-is
    if (videoIdOrUrl.includes("youtube.com")) {
        return videoIdOrUrl;
    }
    return `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
}

export function videosInChannel(channelIdOrUrl: string) {
    const raw = execSync(
        `yt-dlp --flat-playlist -J "${channelUrl(channelIdOrUrl)}"`,
        {
            maxBuffer: 10 * 1024 * 1024,
        },
    ).toString();
    const playlist = JSON.parse(raw) as {
        entries: Array<{
            id: string;
            title?: string;
        }>;
    };
    return playlist.entries;
}

export function downloadVideoAudio(
    youtubeIdOrUrl: string,
    path: string,
    onExists: "skip" | "overwrite" = "skip",
) {
    const folder = dirname(path);
    mkdirSync(folder, { recursive: true });
    const shouldDownload = onExists === "overwrite" || !existsSync(path);
    if (shouldDownload) {
        const url = videoUrl(youtubeIdOrUrl);
        console.log(`Downloading audio for ${url} to ${path}...`);
        execFileSync("yt-dlp", [
            "-x",
            "--audio-format", "wav",
            // the trancription model wants 16kHz audio with one channel
            "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",
            "--audio-quality", "0",
            "-o", path,
            url,
        ]);
        return { downloaded: true };
    }
    return { downloaded: false };
}
