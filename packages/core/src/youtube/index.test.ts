import { describe, it, expect } from "vitest";
import { videosInChannel, downloadVideoAudio } from ".";
import { rmSync, existsSync } from "node:fs";

describe("YouTube Module", () => {
    it("should fetch videos in a channel", () => {
        const sampleChannel = "UCOUlNInprZEjhbpVPiJOlEA"; // GBOS YouTube channel ID
        const videos = videosInChannel(sampleChannel);
        expect(videos).toBeInstanceOf(Array);
        expect(videos.length).toBeGreaterThan(0);
        expect(videos[0]).toHaveProperty("id");
        expect(videos[0]).toHaveProperty("title");
    });

    it("should download video audio", () => {
        // A 5 sec video for testing
        const sampleVideo = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
        const path = new URL("./test_audio/short.wav", import.meta.url).pathname;
        // Clean up any existing file before test
        rmSync(path, { force: true });
        expect(existsSync(path)).toBe(false);
        let result = downloadVideoAudio(sampleVideo, path, "overwrite");
        expect(existsSync(path)).toBe(true);
        expect(result).toHaveProperty("downloaded", true);
        result = downloadVideoAudio(sampleVideo, path, "skip");
        expect(result).toHaveProperty("downloaded", false);
    }, 10_000);
});
