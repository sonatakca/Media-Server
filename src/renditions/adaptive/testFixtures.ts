/**
 * Real FFmpeg sources for the adaptive packaging tests.
 *
 * Generated rather than committed, and generated as genuinely awkward material
 * rather than as a convenient 30 fps clip: 23.976 is the rate the whole library
 * is full of and the one whose GOP arithmetic does not come out even, and an
 * irregular-timestamp source is the case where frame-counted keyframes drift
 * and time-based ones do not. A fixture set that only contained easy input
 * would prove the packager works on input it will never see.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, link, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const ADAPTIVE_FIXTURE_SECONDS = 12;

export interface AdaptiveSourceFixture {
  name: string;
  fileName: string;
  frameRate: number;
  width: number;
  height: number;
  description: string;
}

export const ADAPTIVE_SOURCE_FIXTURES: readonly AdaptiveSourceFixture[] = [
  {
    name: "sdr-2398",
    fileName: "source-sdr-2398.mp4",
    frameRate: 24000 / 1001,
    width: 1920,
    height: 1080,
    description: "23.976 fps SDR H.264 with two audio tracks (AAC and AC3)",
  },
  {
    name: "sdr-25",
    fileName: "source-sdr-25.mp4",
    frameRate: 25,
    width: 1920,
    height: 800,
    description: "25 fps letterboxed SDR H.264 with one AAC track",
  },
  {
    name: "vfr",
    fileName: "source-vfr.mp4",
    // The ceiling rate, which is what the GOP is sized from and what one frame
    // duration means when judging alignment.
    frameRate: 30,
    // Large enough to produce more than one rung: a single-rendition package
    // cannot demonstrate cross-quality alignment, which is the property this
    // fixture exists to stress.
    width: 1920,
    height: 1080,
    description: "irregular-timestamp source with one AAC track",
  },
];

/**
 * A source long enough to be cut into several epochs.
 *
 * Small on purpose: the epoch tests are about where the cuts land and whether
 * the joins are exact, and those properties are identical at 640x360 and at 4K
 * while the encode is a fraction of the cost. The rate is still 23.976, because
 * a boundary that lands between two frames rather than on one is the whole
 * difficulty and a round 30 fps clip would hide it.
 */
export const ADAPTIVE_EPOCH_FIXTURE: AdaptiveSourceFixture = {
  name: "epoch-2398",
  fileName: "source-epoch-2398.mp4",
  frameRate: 24000 / 1001,
  width: 640,
  height: 360,
  description: "23.976 fps SDR H.264 long enough for several epochs",
};

/** Long enough that a six-second epoch target produces four epochs. */
export const ADAPTIVE_EPOCH_FIXTURE_SECONDS = 26;

export const ADAPTIVE_HDR_FIXTURE: AdaptiveSourceFixture = {
  name: "hdr-2398",
  fileName: "source-hdr-2398.mp4",
  frameRate: 24000 / 1001,
  width: 3840,
  height: 2160,
  description: "23.976 fps HDR10 HEVC Main 10 with one AAC track",
};

export function getAdaptiveFixtureDirectory(): string {
  return path.join(tmpdir(), "seyirlik-adaptive-fixtures");
}

/**
 * Publishes a fixture into the shared cache, or discovers that somebody else
 * already has.
 *
 * The cache is a fixed path under `tmpdir()` shared by every suite and every
 * test worker, and the previous version of this file wrote straight into it:
 *
 *   if (!(await exists(target))) await buildSdrFixture(fixture, target);
 *
 * with `ffmpeg -y target` doing the writing. Under the runner's default
 * parallelism that is a torn read waiting to happen. FFmpeg creates and
 * truncates the destination the instant it starts, so a second worker's
 * `exists(target)` returns true for a file that is empty, then a few hundred
 * kilobytes, then briefly gone again. What the second worker gets is whatever
 * was there at the moment it looked — which is how the suite produced
 * `moov atom not found` on one run and
 * `ENOENT: copyfile … source-epoch-2398.mp4` on another, from the same cause.
 *
 * The fix is to make a fixture atomically *appear*, complete or not at all:
 *
 *  - build into a private file named for this process and a fresh UUID, so two
 *    workers building simultaneously cannot write to the same bytes;
 *  - publish with `link`, which fails with `EEXIST` rather than replacing, so a
 *    fixture is written exactly once and is immutable from the instant it is
 *    visible;
 *  - a loser deletes its own temporary file and uses the winner's, which is
 *    correct rather than merely tolerable — both are complete;
 *  - the temporary is removed on every path, including failure, and removing it
 *    twice is not an error.
 *
 * `link` rather than `rename` deliberately. Rename would silently replace a
 * fixture another suite is mid-copy from, which is the same torn read one layer
 * further down; refusing to replace is what makes "immutable after atomic
 * creation" true rather than aspirational.
 */
export async function publishFixture(
  target: string,
  build: (temporaryPath: string) => Promise<void>,
): Promise<void> {
  if (await exists(target)) return;

  /*
   * The extension is preserved because FFmpeg infers the container from it, and
   * the leading dot keeps a half-built fixture out of a directory listing — the
   * cache doubles as `mediaRoot` for several suites.
   */
  const temporary = path.join(
    path.dirname(target),
    `.building-${process.pid}-${randomUUID().slice(0, 8)}-${path.basename(target)}`,
  );

  try {
    await build(temporary);
    await link(temporary, target);
  } catch (error) {
    /*
     * `EEXIST` is another worker having finished first, which is a success: the
     * file it published is as complete as the one built here.
     */
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      if (!(await exists(target))) throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export async function hasEncoder(encoder: string): Promise<boolean> {
  try {
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=128x128:d=0.1,format=yuv420p10le",
      "-c:v",
      encoder,
      "-f",
      "null",
      "-",
    ]);
    return true;
  } catch {
    return false;
  }
}

function fixtureSeconds(fixture: AdaptiveSourceFixture): number {
  return fixture.name === ADAPTIVE_EPOCH_FIXTURE.name
    ? ADAPTIVE_EPOCH_FIXTURE_SECONDS
    : ADAPTIVE_FIXTURE_SECONDS;
}

function sourceArguments(fixture: AdaptiveSourceFixture): string[] {
  const duration = String(fixtureSeconds(fixture));
  const rate =
    fixture.name === "sdr-2398" ||
    fixture.name === "hdr-2398" ||
    fixture.name === ADAPTIVE_EPOCH_FIXTURE.name
      ? "24000/1001"
      : String(fixture.frameRate);

  return [
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${fixture.width}x${fixture.height}:rate=${rate}:duration=${duration}`,
  ];
}

async function buildSdrFixture(
  fixture: AdaptiveSourceFixture,
  target: string,
): Promise<void> {
  const duration = String(fixtureSeconds(fixture));
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...sourceArguments(fixture),
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${duration}`,
  ];

  const isMultiTrack = fixture.name === "sdr-2398";
  if (isMultiTrack) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=880:sample_rate=48000:duration=${duration}`,
    );
  }

  args.push("-map", "0:v", "-map", "1:a");
  if (isMultiTrack) args.push("-map", "2:a");

  if (fixture.name === "vfr") {
    // Keeps every surviving frame's original presentation time and drops in an
    // uneven pattern, so gaps alternate between one frame and five. Renumbering
    // with `setpts` would have produced a short constant-rate clip instead —
    // which is exactly the case this fixture exists not to be.
    args.push("-vf", "select='lt(mod(n\\,13)\\,9)'", "-fps_mode", "vfr");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a:0",
    "aac",
    "-b:a:0",
    "128k",
    "-metadata:s:a:0",
    "language=eng",
  );
  if (isMultiTrack) {
    args.push(
      "-c:a:1",
      "ac3",
      "-b:a:1",
      "192k",
      "-metadata:s:a:1",
      "language=tur",
    );
  }
  args.push("-disposition:a:0", "default", "-y", target);

  await run("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
}

async function buildHdrFixture(target: string): Promise<void> {
  const duration = String(ADAPTIVE_FIXTURE_SECONDS);
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...sourceArguments(ADAPTIVE_HDR_FIXTURE),
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${duration}`,
      "-map",
      "0:v",
      "-map",
      "1:a",
      // Stamped onto the frames rather than set through `-color_*`, which on
      // FFmpeg 8 does not reach the transfer or the primaries — the fixture has
      // to actually be HDR for the HDR test to mean anything.
      "-vf",
      "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=yuv420p10le",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p10le",
      "-profile:v",
      "main10",
      "-tag:v",
      "hvc1",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-metadata:s:a:0",
      "language=eng",
      "-y",
      target,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

/**
 * Builds any fixture that is not already cached, and reports whether FFmpeg was
 * available at all so a test can skip with a clear reason rather than fail for
 * a missing tool.
 */
export async function ensureAdaptiveSourceFixtures(): Promise<boolean> {
  if (!(await hasFfmpeg())) return false;

  const directory = getAdaptiveFixtureDirectory();
  await mkdir(directory, { recursive: true });

  for (const fixture of ADAPTIVE_SOURCE_FIXTURES) {
    await publishFixture(path.join(directory, fixture.fileName), (temporary) =>
      buildSdrFixture(fixture, temporary),
    );
  }

  return true;
}

/**
 * Builds the multi-epoch fixture, returning its path.
 *
 * Kept out of `ensureAdaptiveSourceFixtures` so the packaging suite, which has
 * nothing to say about epoch boundaries, does not pay to encode it.
 */
export async function ensureAdaptiveEpochFixture(): Promise<string | null> {
  if (!(await hasFfmpeg())) return null;
  const directory = getAdaptiveFixtureDirectory();
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, ADAPTIVE_EPOCH_FIXTURE.fileName);
  await publishFixture(target, (temporary) =>
    buildSdrFixture(ADAPTIVE_EPOCH_FIXTURE, temporary),
  );
  return target;
}

export async function ensureAdaptiveHdrFixture(): Promise<string | null> {
  if (!(await hasFfmpeg())) return null;
  if (!(await hasEncoder("libx265"))) return null;

  const directory = getAdaptiveFixtureDirectory();
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, ADAPTIVE_HDR_FIXTURE.fileName);
  await publishFixture(target, (temporary) => buildHdrFixture(temporary));
  return target;
}
