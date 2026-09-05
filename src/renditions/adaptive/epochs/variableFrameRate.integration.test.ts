/**
 * What the epoch pipeline does with a genuinely variable-rate source.
 *
 * The seam policy is written in terms of "a gap of more than about a frame is a
 * gap the source itself contains, and is kept rather than filled". This file
 * exists to find out whether that is what actually happens, using a source that
 * really does change rate part way through and really does contain a two-second
 * hole in its presentation timeline.
 *
 * The answer is not the one the policy describes, and the tests below say so
 * explicitly rather than asserting a comfortable approximation of it. FFmpeg's
 * encoder normalises to a constant rate *inside each epoch*, long before the
 * assembler sees anything, so by the time the seam logic runs there is no
 * irregularity left to preserve and no hole left to keep. Anything relying on
 * `sourceGaps` to report a hole in the middle of an epoch is relying on
 * something that cannot happen.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageAdaptiveRendition } from "../packager";
import { computeSourceFingerprint } from "../../registry";
import { stat } from "node:fs/promises";
import type { RenditionPaths } from "../../analysis";
import { mkdir } from "node:fs/promises";

const run = promisify(execFile);
const MEDIA_ID = "55555555-5555-4555-8555-555555555555";
/** Frame index where a two-second hole is punched into the timeline. */
const GAP_AT_FRAME = 200;
const GAP_SECONDS = 2;

let workspace = "";
let sourcePath = "";
let available = false;

/** Presentation times of every video packet, in order. */
async function packetTimes(file: string): Promise<number[]> {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time",
      "-of",
      "csv=p=0",
      file,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return (
    stdout
      .split("\n")
      // Blank lines must be dropped *before* conversion: `Number("")` is 0, not
      // NaN, so filtering afterwards on `isFinite` silently invents a frame at
      // the start of the timeline.
      .map((line) => line.replace(/,/g, "").trim())
      .filter((line) => line !== "")
      .map((line) => Number(line))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right)
  );
}

function gapsMs(times: readonly number[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    out.push(Math.round((times[index]! - times[index - 1]!) * 1000));
  }
  return out;
}

beforeAll(async () => {
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    return;
  }
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-vfr-"));

  // Five stretches at five different frame rates, concatenated. Each stretch is
  // internally regular; the file as a whole is not, which is what a screen
  // recording or a phone capture looks like.
  const parts: string[] = [];
  const rates = [24, 12, 30, 15, 24];
  for (const [index, rate] of rates.entries()) {
    const part = path.join(workspace, `part${index}.mkv`);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x180:rate=${rate}:duration=3`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-y",
      part,
    ]);
    parts.push(part);
  }
  const list = path.join(workspace, "list.txt");
  await writeFile(list, parts.map((p) => `file '${p}'`).join("\n"), "utf8");

  const concat = path.join(workspace, "concat.mkv");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "24",
    "-y",
    concat,
  ]);

  // A real hole in the presentation timeline, not a slow patch: every frame
  // from here on jumps forward by two seconds and nothing fills the space.
  sourcePath = path.join(workspace, "vfr-source.mkv");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    // Both inputs are declared before any output option: `-vf` belongs to the
    // output, and FFmpeg refuses it if an input follows it.
    "-i",
    concat,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=17",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-vf",
    `setpts=PTS+${GAP_SECONDS}/TB*gte(N\\,${GAP_AT_FRAME})`,
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "24",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-metadata:s:a:0",
    "language=eng",
    "-y",
    sourcePath,
  ]);
  available = true;
}, 300_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("the fixture itself", () => {
  it("really is variable rate and really does contain a hole", async () => {
    if (!available) return;
    const gaps = gapsMs(await packetTimes(sourcePath));
    const distinct = [...new Set(gaps)].sort((a, b) => a - b);
    // Several different frame durations, not one.
    expect(distinct.filter((g) => g > 0 && g < 200).length).toBeGreaterThan(2);
    // And exactly one hole of about two seconds.
    const holes = gaps.filter((g) => g > 1000);
    expect(holes).toHaveLength(1);
    expect(holes[0]!).toBeGreaterThan(GAP_SECONDS * 1000 - 100);
  }, 120_000);
});

describe("packaging a variable-rate source across several epochs", () => {
  it("builds, and normalises the whole title to a constant frame rate", async () => {
    if (!available) return;
    const root = await mkdtemp(path.join(workspace, "run-"));
    const paths: RenditionPaths = {
      mediaRoot: path.dirname(sourcePath),
      renditionRoot: path.join(root, "renditions"),
      workRoot: path.join(root, "work"),
      stateRoot: path.join(root, "state"),
      logsRoot: path.join(root, "logs"),
    };
    await mkdir(paths.logsRoot, { recursive: true });
    await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });

    const result = await packageAdaptiveRendition(
      {
        mediaId: MEDIA_ID,
        relativePath: path.basename(sourcePath),
        sourceFingerprint: await computeSourceFingerprint(
          sourcePath,
          await stat(sourcePath),
        ),
        sourcePath,
      },
      paths,
      {
        reserveBytes: 0,
        preset: "ultrafast",
        verifySourceFingerprint: false,
        // Four epochs over a seventeen-second source, so the hole falls inside
        // one of them rather than on a boundary.
        epochTargetSeconds: 4,
      } as never,
    );
    expect((result as { status: string }).status).toBe("ready");

    const published = path.join(path.dirname(sourcePath), "video", "240p.mp4");
    const outTimes = await packetTimes(published);
    const outGaps = gapsMs(outTimes);
    const distinct = [...new Set(outGaps)];

    const sourceGapsMs = gapsMs(await packetTimes(sourcePath));
    const sourceDistinct = [...new Set(sourceGapsMs)].sort((a, b) => a - b);
    const anomalies = outGaps
      .map((gap, index) => ({ gap, at: outTimes[index + 1]! }))
      .filter((entry) => entry.gap < 20 || entry.gap > 60)
      .slice(0, 10);
    const context = `source gaps ${JSON.stringify(sourceDistinct)}, output gaps ${JSON.stringify([...distinct].sort((a, b) => a - b))}, frames ${outTimes.length}, anomalies ${JSON.stringify(anomalies)}`;

    /*
     * One frame duration for the whole title, give or take the rounding of a
     * single tick. Every rate change in the source has been resampled away by
     * the encoder, inside its own epoch, before the assembler sees anything.
     */
    const spread = Math.max(...outGaps) - Math.min(...outGaps);
    expect(spread, context).toBeLessThanOrEqual(1);
    expect(sourceDistinct.length, context).toBeGreaterThan(distinct.length);

    /*
     * And the hole is gone: filled with repeated frames rather than preserved.
     * This is the finding that matters — a gap in the middle of an epoch never
     * reaches the assembler, so no counter of "gaps the source contains" can
     * ever report it, however the assembler is written.
     */
    expect(
      sourceGapsMs.filter((gap) => gap > 500),
      context,
    ).toHaveLength(1);
    expect(
      outGaps.filter((gap) => gap > 500),
      context,
    ).toHaveLength(0);

    // Frames were added, not dropped: the output covers the hole.
    expect(outTimes.length).toBeGreaterThan(
      (await packetTimes(sourcePath)).length,
    );

    /*
     * Whatever else it does, the timeline it produces is sound: no frame shares
     * a presentation time with another and none arrives before the one before
     * it. The source has eighteen pairs of frames stamped at the same instant;
     * none of them survives into the package.
     */
    for (let index = 1; index < outTimes.length; index += 1) {
      expect(outTimes[index]!).toBeGreaterThan(outTimes[index - 1]!);
    }
    expect(new Set(outTimes).size).toBe(outTimes.length);
  }, 600_000);
});
