import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);

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

export async function videosInChannel(channelIdOrUrl: string) {
    const { stdout } = await execFileAsync(
        "yt-dlp",
        ["--flat-playlist", "-J", channelUrl(channelIdOrUrl)],
        {
            maxBuffer: 10 * 1024 * 1024,
        },
    );
    const playlist = JSON.parse(stdout) as {
        entries: Array<{
            id: string;
            title?: string;
        }>;
    };
    return playlist.entries;
}

export async function downloadVideoAudio(
    youtubeIdOrUrl: string,
    path: string,
    onExists: "skip" | "overwrite" = "skip",
) {
    const folder = dirname(path);
    await mkdir(folder, { recursive: true });
    const exists = await access(path).then(() => true, () => false);
    const shouldDownload = onExists === "overwrite" || !exists;
    if (shouldDownload) {
        const url = videoUrl(youtubeIdOrUrl);
        console.log(`Downloading audio for ${url} to ${path}...`);
        await execFileAsync("yt-dlp", [
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
