import { execSync } from "child_process";

export interface ExtractClipParams {
    inputPath: string, outputPath: string, startSec: number, durationSec: number
}
export function extractClip({ inputPath, outputPath, startSec, durationSec }: ExtractClipParams): void {
    execSync(
        `ffmpeg -y -loglevel error -i "${inputPath}" -ss ${startSec} -t ${durationSec} -ar 16000 -ac 1 "${outputPath}"`,
        { stdio: "inherit" },
    );
}