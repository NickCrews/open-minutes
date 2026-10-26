import { existsSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { youtubeIdOf } from "@open-minutes/core/site";
import { type CachedAudio, getCachedAudio } from "@open-minutes/meeting-audio";
import type { GoldenMeeting } from "./test-data";

/**
 * A golden meeting's audio, from the per-machine cache (downloaded on first
 * use) and checked against its `_audio_sha256`, so the audio is the audio its
 * golden transcript was timed against. Also symlinked into the meeting's
 * fixture directory as audio.gen.wav, for inspection.
 */
export async function getMeetingAudio(
  meeting: GoldenMeeting,
): Promise<CachedAudio> {
  const youtubeId = youtubeIdOf(meeting.recording);
  if (!youtubeId) {
    throw new Error(
      `Golden meeting ${meeting.slug}: only YouTube recordings have cached audio`,
    );
  }
  const audio = await getCachedAudio({
    youtubeId,
    sha256: meeting._audio_sha256,
  });

  const symlinkPath = join(meeting.meetingDir, "audio.gen.wav");
  if (!existsSync(symlinkPath)) {
    await symlink(audio.path, symlinkPath);
  }

  return audio;
}
