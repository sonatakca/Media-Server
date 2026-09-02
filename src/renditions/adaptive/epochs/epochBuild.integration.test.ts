/**
 * The epoch architecture, measured against real FFmpeg output.
 *
 * Everything here is a fact about bytes rather than about a command line. Three
 * claims carry the whole design and none of them can be checked any other way:
 *
 *  - Cutting a source into epochs and joining the pieces back together loses no
 *    frame, repeats no frame and drifts by nothing.
 *  - A crash costs the running epoch and nothing else, and the next attempt
 *    reuses what survived rather than starting again.
 *  - Assembly never invokes a video encoder.
 */

import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenditionPaths } from "../../analysis";
import { computeSourceFingerprint } from "../../registry";
import { packageAdaptiveRendition } from "../packager";
import { runFfmpeg } from "../../processor";
import { validateAdaptivePackage } from "../validation";
import { readTitlePackageManifest } from "../publishTitle";
import { ADAPTIVE_PROFILE_VERSION } from "../profile";
import {
  ensureAdaptiveEpochFixture,
  getAdaptiveFixtureDirectory,
} from "../testFixtures";
import { checkpointRoot, epochsRoot } from "./checkpoints";
import { readEpochPlanFile } from "./checkpoints";

const run = promisify(execFile);
const MEDIA_ID = "22222222-2222-4222-8222-222222222222";
/** Six seconds is three segments, so boundaries land on the segment grid. */
const EPOCH_TARGET_SECONDS = 6;

let fixture: string | null = null;
let workspace = "";

async function framePresentationTimes(file: string): Promise<number[]> {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "csv=p=0",
      file,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split(",")[0]?.trim() ?? "")
    .filter((value) => value !== "" && value.toUpperCase() !== "N/A")
    .map(Number)
    .filter((value) => Number.isFinite(value));
}

async function keyframeTimes(file: string): Promise<number[]> {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-skip_frame",
      "nokey",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "csv=p=0",
      file,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split(",")[0]?.trim() ?? "")
    .filter((value) => value !== "" && value.toUpperCase() !== "N/A")
    .map(Number)
    .filter((value) => Number.isFinite(value));
}

async function decodesCleanly(file: string): Promise<boolean> {
  try {
    await run("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function createPaths(): Promise<RenditionPaths> {
  const root = await mkdtemp(path.join(workspace, "run-"));
  const paths: RenditionPaths = {
    mediaRoot: getAdaptiveFixtureDirectory(),
    renditionRoot: path.join(root, "renditions"),
    workRoot: path.join(root, "work"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
  };
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });
  return paths;
}

interface Harness {
  paths: RenditionPaths;
  sourcePath: string;
  titleRoot: string;
  fingerprint: string;
  checkpoints: string;
}

async function createHarness(): Promise<Harness> {
  const paths = await createPaths();
  const titleRoot = await mkdtemp(path.join(workspace, "title-"));
  const sourcePath = path.join(titleRoot, "epoch-source.mp4");
  await copyFile(fixture!, sourcePath);
  const fingerprint = await computeSourceFingerprint(
    sourcePath,
    await stat(sourcePath),
  );
  return {
    paths,
    sourcePath,
    titleRoot,
    fingerprint,
    checkpoints: checkpointRoot(
      paths.workRoot,
      MEDIA_ID,
      ADAPTIVE_PROFILE_VERSION,
      fingerprint,
    ),
  };
}

function packageOptions(
  harness: Harness,
  overrides: Record<string, unknown> = {},
) {
  return {
    reserveBytes: 0,
    preset: "ultrafast",
    verifySourceFingerprint: false,
    epochTargetSeconds: EPOCH_TARGET_SECONDS,
    ...overrides,
  };
}

async function packageOnce(
  harness: Harness,
  overrides: Record<string, unknown> = {},
) {
  return packageAdaptiveRendition(
    {
      mediaId: MEDIA_ID,
      relativePath: path.basename(harness.sourcePath),
      sourceFingerprint: harness.fingerprint,
      sourcePath: harness.sourcePath,
    },
    harness.paths,
    packageOptions(harness, overrides) as never,
  );
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-epoch-it-"));
  fixture = await ensureAdaptiveEpochFixture();
}, 300_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("epoch checkpointing", () => {
  it("cuts the timeline into epochs and joins them without losing or repeating a frame", async () => {
    if (!fixture) {
      console.warn("FFmpeg is not available; skipping epoch build test.");
      return;
    }
    const harness = await createHarness();
    const sourceTimes = await framePresentationTimes(harness.sourcePath);

    let planned: { epochCount: number; epochTargetSeconds: number } | undefined;
    const result = await packageOnce(harness, {
      onEvent: (event: {
        type: string;
        epochCount?: number;
        epochTargetSeconds?: number;
      }) => {
        if (event.type === "epoch-plan") {
          planned = {
            epochCount: event.epochCount!,
            epochTargetSeconds: event.epochTargetSeconds!,
          };
        }
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ready");

    // The plan cut it where the policy says it should.
    expect(planned).toBeDefined();
    expect(planned!.epochCount).toBeGreaterThan(2);
    expect(planned!.epochTargetSeconds).toBe(EPOCH_TARGET_SECONDS);

    const manifest = await readTitlePackageManifest(harness.titleRoot);
    expect(manifest).not.toBeNull();

    for (const rendition of manifest!.video) {
      const mediaFile = path.join(
        harness.titleRoot,
        ...rendition.mediaPath.split("/"),
      );
      expect(await decodesCleanly(mediaFile)).toBe(true);

      const times = await framePresentationTimes(mediaFile);
      /*
       * The full-rate rungs carry one frame per source frame. Anything else is
       * a frame the join lost or produced twice, which is the failure this
       * whole assembly strategy exists to make impossible.
       */
      if (Math.abs(rendition.frameRate - 24000 / 1001) < 0.01) {
        expect(times.length).toBe(sourceTimes.length);
        for (let index = 0; index < times.length; index += 1) {
          expect(Math.abs(times[index]! - sourceTimes[index]!)).toBeLessThan(
            0.001,
          );
        }
      }

      // Strictly increasing: no overlap anywhere, least of all at a join.
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]!).toBeGreaterThan(times[index - 1]!);
      }
    }
  }, 900_000);

  it("keeps every rung on one keyframe grid across the epoch joins", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const result = await packageOnce(harness);
    expect(result.status).toBe("ready");

    const manifest = await readTitlePackageManifest(harness.titleRoot);
    expect(manifest).not.toBeNull();

    const grids: number[][] = [];
    for (const rendition of manifest!.video) {
      grids.push(
        await keyframeTimes(
          path.join(harness.titleRoot, ...rendition.mediaPath.split("/")),
        ),
      );
    }

    const reference = grids[0]!;
    // A two-second grid, unbroken through every boundary.
    for (let index = 1; index < reference.length; index += 1) {
      const gap = reference[index]! - reference[index - 1]!;
      expect(gap).toBeGreaterThan(1.9);
      expect(gap).toBeLessThan(2.11);
    }
    // Every rung agrees with it to within a frame.
    for (const grid of grids.slice(1)) {
      expect(grid.length).toBe(reference.length);
      for (let index = 0; index < grid.length; index += 1) {
        expect(Math.abs(grid[index]! - reference[index]!)).toBeLessThan(0.05);
      }
    }
  }, 900_000);

  it("passes deep package validation after assembly", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const result = await packageOnce(harness);
    expect(result.status).toBe("ready");

    const validation = await validateAdaptivePackage({
      versionRoot: harness.titleRoot,
      mediaId: MEDIA_ID,
      sourceFingerprint: harness.fingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      deep: true,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  }, 900_000);

  it("reuses completed epochs after the encoder dies part way through", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    /*
     * Failure injection rather than a real crash: the encoder is allowed to
     * finish the first two epochs and then refuses, which is what an unplugged
     * drive or a killed FFmpeg looks like from here.
     */
    let firstRunEncodes = 0;
    const failing = async (
      command: string,
      args: string[],
      options: Parameters<typeof runFfmpeg>[2],
    ) => {
      firstRunEncodes += 1;
      if (firstRunEncodes === 3) {
        throw new Error("FFmpeg failed with exit code 1: injected failure");
      }
      return runFfmpeg(command, args, options);
    };

    const first = await packageOnce(harness, { runEncoder: failing });
    expect(first.status).toBe("failed");

    /*
     * Read before the retry: a successful publish clears the checkpoint root,
     * plan included, because at that point the durable progress has become the
     * published package.
     */
    const plan = await readEpochPlanFile(harness.checkpoints);
    expect(plan).not.toBeNull();

    const completed = await readdir(epochsRoot(harness.checkpoints));
    const durable = completed.filter((name) => /^\d{6}$/.test(name));
    expect(durable).toEqual(["000000", "000001"]);
    // Nothing half-written survives under a name anything would read.
    expect(completed.filter((name) => name.includes(".partial"))).toEqual([]);

    const digests = new Map<string, string>();
    for (const name of durable) {
      const file = path.join(
        epochsRoot(harness.checkpoints),
        name,
        "COMPLETE.json",
      );
      digests.set(name, await readFile(file, "utf8"));
    }

    let secondRunEncodes = 0;
    const counting = async (
      command: string,
      args: string[],
      options: Parameters<typeof runFfmpeg>[2],
    ) => {
      secondRunEncodes += 1;
      return runFfmpeg(command, args, options);
    };

    const second = await packageOnce(harness, { runEncoder: counting });
    expect(second.status).toBe("ready");

    // Every epoch but the two that were protected, plus the audio stage.
    expect(secondRunEncodes).toBe(plan!.epochs.length - 2 + 1);

    // The checkpoints existed at all only because the first attempt survived
    // its own failure; the publish has since consumed them.
    expect(digests.size).toBe(2);
  }, 900_000);

  it("rebuilds only the epoch whose media was corrupted", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    /*
     * A successful publish clears the checkpoints, so the corruption has to be
     * introduced into a build that was stopped — which is also the realistic
     * case: a checkpoint goes bad because the storage under it went away.
     */
    let encodes = 0;
    await packageOnce(harness, {
      runEncoder: async (
        command: string,
        args: string[],
        options: Parameters<typeof runFfmpeg>[2],
      ) => {
        encodes += 1;
        if (encodes === 3) throw new Error("injected failure");
        return runFfmpeg(command, args, options);
      },
    });

    // Epoch zero's media is truncated, which is what a half-written file left
    // behind by a vanishing volume looks like.
    const epochZero = path.join(epochsRoot(harness.checkpoints), "000000");
    const zeroManifest = JSON.parse(
      await readFile(path.join(epochZero, "COMPLETE.json"), "utf8"),
    ) as { renditions: Array<{ mediaPath: string }> };
    await truncate(
      path.join(epochZero, ...zeroManifest.renditions[0]!.mediaPath.split("/")),
      64,
    );

    const plan = await readEpochPlanFile(harness.checkpoints);

    let secondRunEncodes = 0;
    const invalidated: number[] = [];
    const reused: number[] = [];
    const second = await packageOnce(harness, {
      runEncoder: async (
        command: string,
        args: string[],
        options: Parameters<typeof runFfmpeg>[2],
      ) => {
        secondRunEncodes += 1;
        return runFfmpeg(command, args, options);
      },
      onEvent: (event: { type: string; index?: number; bytes?: number }) => {
        if (event.type === "epoch-invalid") invalidated.push(event.index!);
        if (event.type === "epoch-complete" && event.bytes === 0) {
          reused.push(event.index!);
        }
      },
    });
    expect(second.status).toBe("ready");

    // Exactly the damaged checkpoint was condemned, and exactly the intact one
    // was reused rather than encoded again.
    expect(invalidated).toEqual([0]);
    expect(reused).toEqual([1]);
    // Everything except epoch one, plus the audio stage.
    expect(secondRunEncodes).toBe(plan!.epochs.length - 1 + 1);
  }, 900_000);

  it("does not run a video encoder during final assembly", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    const commands: string[][] = [];
    const recording = async (
      command: string,
      args: string[],
      options: Parameters<typeof runFfmpeg>[2],
    ) => {
      commands.push(args);
      return runFfmpeg(command, args, options);
    };

    let epochCount = 0;
    const result = await packageOnce(harness, {
      runEncoder: recording,
      onEvent: (event: { type: string; epochCount?: number }) => {
        if (event.type === "epoch-plan") epochCount = event.epochCount!;
      },
    });
    expect(result.status).toBe("ready");
    expect(epochCount).toBeGreaterThan(2);

    /*
     * One invocation per epoch and exactly one more for audio. An assembly that
     * re-encoded would need another, and a second full pass over the title is
     * the outcome this architecture exists to avoid.
     */
    expect(commands.length).toBe(epochCount + 1);
    const videoEncodes = commands.filter((args) =>
      args.includes("-filter_complex"),
    );
    expect(videoEncodes.length).toBe(epochCount);
    // The one non-video command is audio, and it names no encoder for pictures.
    const audioCommands = commands.filter(
      (args) => !args.includes("-filter_complex"),
    );
    expect(audioCommands).toHaveLength(1);
    expect(audioCommands[0]!.some((argument) => argument === "-c:v")).toBe(
      false,
    );
  }, 900_000);
});

describe("checkpoint identity", () => {
  it("refuses to reuse checkpoints built from different source bytes", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    let encodes = 0;
    const failing = async (
      command: string,
      args: string[],
      options: Parameters<typeof runFfmpeg>[2],
    ) => {
      encodes += 1;
      if (encodes === 3) throw new Error("injected failure");
      return runFfmpeg(command, args, options);
    };
    await packageOnce(harness, { runEncoder: failing });
    expect(
      (await readdir(epochsRoot(harness.checkpoints))).filter((name) =>
        /^\d{6}$/.test(name),
      ).length,
    ).toBe(2);

    /*
     * The same media id and the same work root, but the source has been
     * replaced. The checkpoints from the first build describe frames this
     * source does not contain, so nothing may be carried over — every epoch is
     * encoded again.
     */
    const replaced: Harness = {
      ...harness,
      fingerprint: `ffff${harness.fingerprint.slice(4)}`,
    };
    replaced.checkpoints = checkpointRoot(
      harness.paths.workRoot,
      MEDIA_ID,
      ADAPTIVE_PROFILE_VERSION,
      replaced.fingerprint,
    );
    expect(replaced.checkpoints).not.toBe(harness.checkpoints);

    let reusedEpochs = -1;
    let epochCount = 0;
    let encodesAfterChange = 0;
    const result = await packageOnce(replaced, {
      runEncoder: async (
        command: string,
        args: string[],
        options: Parameters<typeof runFfmpeg>[2],
      ) => {
        encodesAfterChange += 1;
        return runFfmpeg(command, args, options);
      },
      onEvent: (event: {
        type: string;
        reusedEpochs?: number;
        epochCount?: number;
      }) => {
        if (event.type === "epoch-plan") {
          reusedEpochs = event.reusedEpochs!;
          epochCount = event.epochCount!;
        }
      },
    });
    expect(result.status).toBe("ready");
    expect(reusedEpochs).toBe(0);
    expect(encodesAfterChange).toBe(epochCount + 1);
  }, 900_000);
});
