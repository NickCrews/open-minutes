import { spawnSync, execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
/** Where yt-dlp goes when it isn't on PATH. Gitignored. */
const BIN = join(PACKAGE, "..", "..", ".cache", "bin");

function onPath(name: string): boolean {
  return !spawnSync(name, ["--version"], { stdio: "ignore" }).error;
}

/**
 * With YTDLP=1 (the tests tagged `ytdlp`), puts yt-dlp on PATH, installing
 * it into the repo's .cache/bin if it's missing. Test workers start after
 * this and inherit its PATH.
 */
export default function setup() {
  if (process.env.YTDLP !== "1") return;
  process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ""}`;
  if (onPath("yt-dlp")) return;
  console.error(`yt-dlp is not on PATH; installing it into ${BIN}`);
  execFileSync(join(PACKAGE, "install-ytdlp.sh"), [BIN], { stdio: "inherit" });
}
