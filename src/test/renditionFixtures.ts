/**
 * Two short renditions of the same clip, for the browser-level handoff test.
 *
 * Generated with FFmpeg on demand rather than committed: they are ~2 MB of
 * binary that nothing but one test reads, and generating them keeps the two
 * files provably compatible — same duration, same frame rate, same GOP length,
 * differing only in resolution, which is exactly the shape of a real rendition
 * ladder rung.
 */

import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const FIXTURE_DURATION_SECONDS = 10;
const FRAME_RATE = 30;
/** Half a second. Short enough that a seek lands close to where it was aimed. */
const GOP_FRAMES = 15;

export interface RenditionFixture {
  name: string;
  height: number;
  width: number;
  fileName: string;
}

export const RENDITION_FIXTURES: readonly RenditionFixture[] = [
  { name: "720p", height: 720, width: 1280, fileName: "720p.mp4" },
  { name: "1080p", height: 1080, width: 1920, fileName: "1080p.mp4" },
];

export function getFixtureDirectory(): string {
  return path.join(tmpdir(), "seyirlik-rendition-fixtures");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds any fixture that is not already cached.
 *
 * Returns false when FFmpeg is not on the machine, so the browser test can skip
 * with a clear reason instead of failing for a missing tool.
 */
export async function ensureRenditionFixtures(): Promise<boolean> {
  if (!(await hasFfmpeg())) return false;

  const directory = getFixtureDirectory();
  await mkdir(directory, { recursive: true });

  for (const fixture of RENDITION_FIXTURES) {
    const target = path.join(directory, fixture.fileName);
    if (await exists(target)) continue;

    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${fixture.width}x${fixture.height}:rate=${FRAME_RATE}:duration=${FIXTURE_DURATION_SECONDS}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${FIXTURE_DURATION_SECONDS}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      // A fixed GOP with scene detection off is what makes the two files land
      // on the same keyframes, so a seek to t resolves to the same instant in
      // both. Without it the handoff would be measuring the encoder's whims.
      "-g",
      String(GOP_FRAMES),
      "-keyint_min",
      String(GOP_FRAMES),
      "-sc_threshold",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "main",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      // Moves the index to the front so the browser can start without reading
      // the whole file, the same as the real rendition output.
      "-movflags",
      "+faststart",
      "-y",
      target,
    ]);
  }

  return true;
}
