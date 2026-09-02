/**
 * What checkpointing costs when nothing goes wrong.
 *
 * The epoch architecture is bought with two things: an FFmpeg start and a seek
 * per five minutes, and a byte-copy assembly pass at the end. Both are cheap in
 * theory, and "in theory" is not evidence — a design that halved throughput
 * would be a bad trade however good its recovery story, so the overhead is
 * measured rather than asserted.
 *
 * The comparison is like for like. The baseline is the *old* architecture
 * exactly: one FFmpeg invocation, one source read, one decode, the whole ladder
 * and the audio together. The subject is the shipping path with epochs. Both
 * encode the same source with the same encoder, ladder and rate policy.
 *
 *   npm run bench:epochs -- --source /path/to/movie.mkv --epoch-seconds 300
 *
 * With no source it generates one, which is enough to measure overhead but not
 * to say anything about picture quality.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RenditionPaths } from "../src/renditions/analysis";
import {
  adaptiveOutputDirectories,
  buildAdaptivePackageFfmpegArgs,
  canStreamCopyAudio,
  deliveryChannelsFor,
  type AdaptiveAudioOutput,
  type AdaptiveVideoOutput,
} from "../src/renditions/adaptive/encoding";
import { frameRateForClass } from "../src/renditions/adaptive/layout";
import { packageAdaptiveRendition } from "../src/renditions/adaptive/packager";
import { runFfmpeg } from "../src/renditions/processor";
import { probeMediaFile } from "../src/renditions/probe";
import { buildRenditionRequirements } from "../src/renditions/policy";
import { resolveVideoEncoder } from "../src/renditions/encoding";
import { computeSourceFingerprint } from "../src/renditions/registry";
import { SEGMENT_TARGET_SECONDS } from "../src/lib/playback-planner/gopPolicy";
import {
  defaultSoftwareEncoderThreads,
  defaultSoftwareFilterThreads,
} from "../src/server/cpuTopology";
import { formatBytes, formatDuration } from "../src/renditions/progress";

const run = promisify(execFile);
const MEDIA_ID = "benchmark-0000-4000-8000-000000000000";

interface Arguments {
  source?: string;
  epochSeconds: number;
  generatedSeconds: number;
  keep: boolean;
}

function parseArguments(argv: string[]): Arguments {
  const args: Arguments = {
    epochSeconds: 300,
    generatedSeconds: 600,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--source" && value) {
      args.source = value;
      index += 1;
    } else if (flag === "--epoch-seconds" && value) {
      args.epochSeconds = Number(value);
      index += 1;
    } else if (flag === "--generated-seconds" && value) {
      args.generatedSeconds = Number(value);
      index += 1;
    } else if (flag === "--keep") {
      args.keep = true;
    }
  }
  if (!Number.isFinite(args.epochSeconds) || args.epochSeconds < 2) {
    throw new Error("--epoch-seconds must be at least 2.");
  }
  return args;
}

/**
 * CPU seconds burned across every core, from the kernel's own counters.
 *
 * Node cannot see a child's resource usage, and the encode is entirely in
 * children, so the machine-wide counter is the honest measure. It includes
 * anything else running, which is why a benchmark is run on an idle machine.
 */
function cpuSeconds(): number {
  return (
    os
      .cpus()
      .reduce(
        (total, cpu) =>
          total +
          cpu.times.user +
          cpu.times.sys +
          cpu.times.nice +
          cpu.times.irq,
        0,
      ) / 1000
  );
}

async function directoryBytes(root: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, {
      withFileTypes: true,
    }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += (await stat(full)).size;
    }
  };
  await walk(root);
  return total;
}

async function generateSource(target: string, seconds: number): Promise<void> {
  console.error(
    `Generating a ${seconds}s 1080p 23.976 fps source; this is not fast.`,
  );
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=1920x1080:rate=24000/1001:duration=${seconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-metadata:s:a:0",
      "language=eng",
      "-y",
      target,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
}

interface Measurement {
  label: string;
  wallSeconds: number;
  cpuSeconds: number;
  outputBytes: number;
  ffmpegInvocations: number;
  /** Encoded media seconds divided by wall seconds. */
  throughput: number;
}

function report(source: number, results: Measurement[]): void {
  const rows = results.map((result) => ({
    Run: result.label,
    Wall: formatDuration(result.wallSeconds),
    "Wall (s)": result.wallSeconds.toFixed(1),
    Speed: `${result.throughput.toFixed(3)}x`,
    CPU: `${result.cpuSeconds.toFixed(0)}s`,
    Output: formatBytes(result.outputBytes),
    "FFmpeg runs": String(result.ffmpegInvocations),
  }));
  console.log("");
  console.table(rows);
  const [baseline, subject] = results;
  if (baseline && subject) {
    const overhead =
      ((subject.wallSeconds - baseline.wallSeconds) / baseline.wallSeconds) *
      100;
    console.log("");
    console.log(
      `Source: ${formatDuration(source)} — checkpointed wall-clock overhead ` +
        `${overhead >= 0 ? "+" : ""}${overhead.toFixed(1)}% against one uninterrupted pass.`,
    );
    const sizeDelta =
      ((subject.outputBytes - baseline.outputBytes) / baseline.outputBytes) *
      100;
    console.log(
      `Output size difference ${sizeDelta >= 0 ? "+" : ""}${sizeDelta.toFixed(2)}%.`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "seyirlik-epoch-bench-"),
  );

  try {
    const sourcePath =
      args.source ?? path.join(workspace, "benchmark-source.mp4");
    if (!args.source) {
      await generateSource(sourcePath, args.generatedSeconds);
    }

    const probe = await probeMediaFile(sourcePath);
    const requirements = buildRenditionRequirements(probe.video);
    const encoder = await resolveVideoEncoder(
      "auto",
      "ffmpeg",
      probe.video.isHdr ? "hevc" : "h264",
      probe.video.isHdr,
    );
    const softwareThreads = defaultSoftwareEncoderThreads();

    console.error(
      `Source: ${formatDuration(probe.durationSeconds)} ${probe.video.width}x${probe.video.height} ` +
        `${probe.video.codec}${probe.video.isHdr ? " HDR" : ""}`,
    );
    console.error(
      `Ladder: ${requirements.map((entry) => `${entry.qualityHeight}p`).join(", ")} with ${encoder}`,
    );

    const sourceFrameRate =
      probe.video.frameRate && probe.video.frameRate > 0
        ? probe.video.frameRate
        : undefined;
    const videoOutputs: AdaptiveVideoOutput[] = requirements.map(
      (requirement) => {
        const rate = frameRateForClass(
          requirement.qualityHeight,
          sourceFrameRate,
        );
        return {
          qualityHeight: requirement.qualityHeight,
          width: requirement.width,
          height: requirement.height,
          ...(rate !== undefined &&
          sourceFrameRate !== undefined &&
          rate < sourceFrameRate - 0.01
            ? { frameRate: rate }
            : {}),
        };
      },
    );
    const defaultTrack =
      probe.audioTracks.find((track) => track.isDefault) ??
      probe.audioTracks[0];
    if (!defaultTrack) throw new Error("The source has no audio to package.");
    const audioOutputs: AdaptiveAudioOutput[] = [
      {
        sourceStreamIndex: defaultTrack.streamIndex,
        action: canStreamCopyAudio({
          codec: defaultTrack.codec,
          channels: defaultTrack.channels ?? 2,
        })
          ? "copy"
          : "transcode",
        channels: deliveryChannelsFor(defaultTrack.channels ?? 2),
        bitrate: 192_000,
        ...(defaultTrack.language ? { language: defaultTrack.language } : {}),
        isDefault: true,
        isForced: false,
      },
    ];

    const results: Measurement[] = [];

    /*
     * The baseline: the architecture as it was. One invocation, one read, one
     * decode, every rung and the audio together, straight into single-file
     * byte-range CMAF. Nothing is validated or published, so this is the
     * encode cost alone — which is the number the epoch design has to defend.
     */
    {
      const outputRoot = path.join(workspace, "legacy");
      await mkdir(outputRoot, { recursive: true });
      for (const directory of adaptiveOutputDirectories({
        videoOutputs,
        audioOutputs,
      })) {
        await mkdir(path.join(outputRoot, ...directory.split("/")), {
          recursive: true,
        });
      }
      const ffmpegArgs = buildAdaptivePackageFfmpegArgs({
        inputPath: sourcePath,
        outputRoot: outputRoot.split(path.sep).join("/"),
        videoOutputs,
        audioOutputs,
        encoder,
        ...(probe.video.frameRate === undefined
          ? {}
          : { frameRate: probe.video.frameRate }),
        segmentSeconds: SEGMENT_TARGET_SECONDS,
        preset: "medium",
        ...(encoder === "libx264" || encoder === "libx265"
          ? {
              softwareThreads,
              filterComplexThreads:
                defaultSoftwareFilterThreads(softwareThreads),
            }
          : {}),
      });

      console.error("\\nRunning the baseline: one uninterrupted pass...");
      const cpuBefore = cpuSeconds();
      const startedAt = Date.now();
      await runFfmpeg("ffmpeg", ffmpegArgs, {
        logPath: path.join(workspace, "legacy.log"),
      });
      const wallSeconds = (Date.now() - startedAt) / 1000;
      results.push({
        label: "One pass (previous architecture)",
        wallSeconds,
        cpuSeconds: cpuSeconds() - cpuBefore,
        outputBytes: await directoryBytes(outputRoot),
        ffmpegInvocations: 1,
        throughput: probe.durationSeconds / wallSeconds,
      });
      if (!args.keep) await rm(outputRoot, { recursive: true, force: true });
    }

    /*
     * The subject: the shipping path. Everything the baseline did, plus a plan,
     * per-epoch validation, a separate audio pass, a byte-copy assembly and a
     * full package validation — all of which is overhead the baseline never
     * paid, and all of which is included in the figure below on purpose.
     */
    {
      const root = path.join(workspace, "epoch");
      const titleRoot = path.join(root, "title");
      await mkdir(titleRoot, { recursive: true });
      const titleSource = path.join(titleRoot, path.basename(sourcePath));
      await run("cp", [sourcePath, titleSource]);
      const paths: RenditionPaths = {
        mediaRoot: path.dirname(sourcePath),
        renditionRoot: path.join(root, "renditions"),
        workRoot: path.join(root, "work"),
        stateRoot: path.join(root, "state"),
        logsRoot: path.join(root, "logs"),
      };
      await mkdir(paths.logsRoot, { recursive: true });
      await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });

      let invocations = 0;
      let epochCount = 0;
      const phaseSeconds = new Map<string, number>();
      let currentPhase = "planning";
      let phaseSince = Date.now();
      const markPhase = (next: string) => {
        phaseSeconds.set(
          currentPhase,
          (phaseSeconds.get(currentPhase) ?? 0) +
            (Date.now() - phaseSince) / 1000,
        );
        currentPhase = next;
        phaseSince = Date.now();
      };

      console.error("Running the subject: five-minute checkpointed epochs...");
      const cpuBefore = cpuSeconds();
      const startedAt = Date.now();
      const result = await packageAdaptiveRendition(
        {
          mediaId: MEDIA_ID,
          relativePath: path.basename(titleSource),
          sourceFingerprint: await computeSourceFingerprint(
            titleSource,
            await stat(titleSource),
          ),
          sourcePath: titleSource,
        },
        paths,
        {
          reserveBytes: 0,
          preset: "medium",
          verifySourceFingerprint: false,
          epochTargetSeconds: args.epochSeconds,
          runEncoder: async (command, ffmpegArgs, options) => {
            invocations += 1;
            return runFfmpeg(command, ffmpegArgs, options);
          },
          onEvent: (event) => {
            if (event.type === "epoch-plan") epochCount = event.epochCount;
            if (event.type === "build-stage") markPhase(event.stage);
          },
        },
      );
      markPhase("done");
      const wallSeconds = (Date.now() - startedAt) / 1000;
      if (result.status !== "ready") {
        throw new Error(
          `The checkpointed run did not finish: ${result.status} ${result.error ?? ""}`,
        );
      }
      results.push({
        label: `Checkpointed (${epochCount} epochs of ${args.epochSeconds}s)`,
        wallSeconds,
        cpuSeconds: cpuSeconds() - cpuBefore,
        outputBytes: result.storageBytes ?? 0,
        ffmpegInvocations: invocations,
        throughput: probe.durationSeconds / wallSeconds,
      });

      console.log("");
      console.log("Where the checkpointed run spent its time:");
      console.table(
        [...phaseSeconds.entries()]
          .filter(([phase]) => phase !== "done")
          .map(([phase, seconds]) => ({
            Phase: phase,
            Seconds: seconds.toFixed(1),
            Share: `${((seconds / wallSeconds) * 100).toFixed(1)}%`,
          })),
      );
      if (!args.keep) await rm(root, { recursive: true, force: true });
    }

    report(probe.durationSeconds, results);

    await writeFile(
      path.join(os.tmpdir(), "seyirlik-epoch-benchmark.json"),
      `${JSON.stringify({ source: probe.durationSeconds, results }, null, 2)}\\n`,
      "utf8",
    );
    console.log(
      `\\nRaw figures: ${path.join(os.tmpdir(), "seyirlik-epoch-benchmark.json")}`,
    );
  } finally {
    if (!args.keep) await rm(workspace, { recursive: true, force: true });
    else console.error(`Workspace kept at ${workspace}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
