import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  adaptiveOutputDirectories,
  buildAdaptivePackageFfmpegArgs,
  type AdaptiveAudioOutput,
} from "../src/renditions/adaptive/encoding";
import { buildRenditionRequirements } from "../src/renditions/policy";
import { probeMediaFile } from "../src/renditions/probe";

const runFile = promisify(execFile);

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

const inputPath = option("--input");
const outputRoot = option("--output-root");
if (!inputPath || !outputRoot) {
  throw new Error(
    "Usage: --input <media> --output-root <external-volume-directory> [--threads 5,6,8,10] [--height 1080] [--start 600] [--duration 60] [--encoder libx264|libx265] [--filter-threads 4]",
  );
}
const sourcePath = inputPath;
const benchmarkRoot = outputRoot;

const requestedEncoder = option("--encoder", "libx264");
if (requestedEncoder !== "libx264" && requestedEncoder !== "libx265") {
  throw new Error("--encoder must be libx264 or libx265.");
}
const encoder: "libx264" | "libx265" = requestedEncoder;
const requestedHeight = positiveNumber("--height", 1080);
const startSeconds = positiveNumber("--start", 600);
const durationSeconds = positiveNumber("--duration", 60);
const filterThreads = positiveNumber("--filter-threads", 4);
const threadCounts = (option("--threads", "5,6,8,10") ?? "")
  .split(",")
  .map((value) => Number(value))
  .filter((value) => Number.isInteger(value) && value > 0);
if (threadCounts.length === 0)
  throw new Error("--threads is empty or invalid.");

const probe = await probeMediaFile(sourcePath);
const requirements = buildRenditionRequirements(probe.video);
const target = requirements.find(
  (requirement) => requirement.qualityHeight === requestedHeight,
);
if (!target) {
  throw new Error(
    `The source has no ${requestedHeight}p rendition (available: ${requirements
      .map((requirement) => requirement.qualityHeight)
      .join(", ")}).`,
  );
}
const videoOutput = target;
const sourceAudio =
  probe.audioTracks.find((track) => track.isDefault) ?? probe.audioTracks[0];
if (!sourceAudio) throw new Error("The source has no audio track.");

const audioOutput: AdaptiveAudioOutput = {
  sourceStreamIndex: sourceAudio.streamIndex,
  action: "transcode",
  bitrate: 192_000,
  channels: sourceAudio.channels,
  ...(sourceAudio.language ? { language: sourceAudio.language } : {}),
  isDefault: true,
  isForced: false,
};
const sessionRoot = path.join(
  benchmarkRoot,
  `software-threads-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(sessionRoot, { recursive: true });

interface Result {
  threads: number;
  filterThreads: number;
  averageFps: number | null;
  averageSpeed: number | null;
  averageCpuPercent: number | null;
  elapsedSeconds: number;
  outputCorrect: boolean;
  outputBytes: number;
}

async function benchmark(threads: number): Promise<Result> {
  const runRoot = path.join(sessionRoot, `threads-${threads}`);
  const directories = adaptiveOutputDirectories({
    videoOutputs: [videoOutput],
    audioOutputs: [audioOutput],
  });
  for (const directory of directories) {
    await mkdir(path.join(runRoot, ...directory.split("/")), {
      recursive: true,
    });
  }

  const args = buildAdaptivePackageFfmpegArgs({
    inputPath: sourcePath,
    outputRoot: runRoot.split(path.sep).join("/"),
    videoOutputs: [videoOutput],
    audioOutputs: [audioOutput],
    encoder,
    ...(probe.video.isHdr && encoder === "libx265"
      ? {
          hdr: {
            colorPrimaries: probe.video.colorPrimaries ?? "bt2020",
            colorTransfer: probe.video.colorTransfer ?? "smpte2084",
            colorSpace: probe.video.colorSpace ?? "bt2020nc",
          },
        }
      : {}),
    frameRate: probe.video.maxFrameRate ?? probe.video.frameRate,
    preset: "medium",
    softwareThreads: threads,
    filterComplexThreads: filterThreads,
  });
  const inputIndex = args.indexOf("-i");
  args.splice(inputIndex, 0, "-ss", String(startSeconds));
  args.splice(inputIndex + 4, 0, "-t", String(durationSeconds));
  await writeFile(
    path.join(runRoot, "command.json"),
    `${JSON.stringify(
      {
        command: process.env.SEYIRLIK_FFMPEG_PATH ?? "ffmpeg",
        args,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const fpsSamples: number[] = [];
  const speedSamples: number[] = [];
  const cpuSamples: number[] = [];
  let progressText = "";
  const started = performance.now();
  const child = spawn(process.env.SEYIRLIK_FFMPEG_PATH ?? "ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_000);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    progressText += chunk;
    const blocks = progressText.split(/progress=(?:continue|end)\r?\n/);
    progressText = blocks.pop() ?? "";
    for (const block of blocks) {
      const fields = new Map(
        block
          .trim()
          .split(/\r?\n/)
          .map((line) => line.split("=", 2) as [string, string]),
      );
      const fps = Number(fields.get("fps"));
      const speed = Number(fields.get("speed")?.replace(/x$/, ""));
      if (fps > 0) fpsSamples.push(fps);
      if (speed > 0) speedSamples.push(speed);
    }
  });
  const cpuTimer = setInterval(() => {
    if (!child.pid) return;
    void runFile("ps", ["-p", String(child.pid), "-o", "%cpu="])
      .then(({ stdout }) => {
        const cpu = Number(stdout.trim());
        if (cpu >= 0) cpuSamples.push(cpu);
      })
      .catch(() => undefined);
  }, 1_000);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearInterval(cpuTimer);
  const elapsedSeconds = (performance.now() - started) / 1_000;
  if (exitCode !== 0) {
    throw new Error(`FFmpeg exited ${exitCode ?? "without a code"}: ${stderr}`);
  }
  await writeFile(path.join(runRoot, "ffmpeg.log"), stderr, "utf8");

  const mediaFiles = directories.map((directory) =>
    path.join(runRoot, ...directory.split("/"), "media.m4s"),
  );
  const outputStats = await Promise.all(mediaFiles.map((file) => stat(file)));
  const master = await readFile(path.join(runRoot, "master.m3u8"), "utf8");
  await runFile(process.env.SEYIRLIK_FFPROBE_PATH ?? "ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    mediaFiles[0],
  ]);
  const average = (values: number[]) =>
    values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;

  return {
    threads,
    filterThreads,
    averageFps: average(fpsSamples),
    averageSpeed: average(speedSamples),
    averageCpuPercent: average(cpuSamples),
    elapsedSeconds,
    outputCorrect:
      master.includes("#EXTM3U") &&
      outputStats.every((entry) => entry.isFile() && entry.size > 0),
    outputBytes: outputStats.reduce((sum, entry) => sum + entry.size, 0),
  };
}

const results: Result[] = [];
for (const threads of threadCounts) {
  const result = await benchmark(threads);
  results.push(result);
  console.log(JSON.stringify(result));
}

await writeFile(
  path.join(sessionRoot, "results.json"),
  `${JSON.stringify(
    {
      inputPath: sourcePath,
      encoder,
      target: videoOutput,
      startSeconds,
      durationSeconds,
      results,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`Results: ${path.join(sessionRoot, "results.json")}`);
