#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  MASTER_LAYOUT_VERSION,
  repairTitleMaster,
} from "../src/renditions/adaptive/repairMaster";
import path from "node:path";
import {
  analyseRenditionLibrary,
  findRootsInsideMediaRoot,
  formatAnalysisReport,
  resolveRenditionPaths,
  type RenditionAnalysisReport,
} from "../src/renditions/analysis";
import { acquireDirectoryLock, staleLock } from "../src/renditions/locks";
import { calculateReserveBytes } from "../src/renditions/planning";
import { processRenditionReport } from "../src/renditions/processor";
import {
  parseEncoderPreference,
  parseHdrPolicy,
} from "../src/renditions/encoding";
import {
  estimateRemainingSeconds,
  formatBytes,
  formatDuration,
  type RenditionProgressEvent,
} from "../src/renditions/progress";
import { RENDITION_PROFILE_VERSION } from "../src/renditions/policy";
import { probeMediaFile } from "../src/renditions/probe";
import { inspectCompletedRendition } from "../src/renditions/validation";
import { inspectAdaptivePackage } from "../src/renditions/adaptive/inspect";
import { validateAdaptivePackage } from "../src/renditions/adaptive/validation";
import { processAdaptiveReport } from "../src/renditions/adaptive/processor";
import { ADAPTIVE_PROFILE_VERSION } from "../src/renditions/adaptive/profile";
import { cleanupAdaptiveWork } from "../src/renditions/adaptive/epochs/cleanup";
import { summariseCheckpoints } from "../src/renditions/adaptive/epochs/status";

type RenditionGeneration = "legacy" | "adaptive" | "all";

interface CliArguments {
  command: string;
  library?: string;
  mediaId?: string;
  source?: string;
  workers?: number;
  dryRun: boolean;
  confirmStale: boolean;
  olderThanHours: number;
  profile: RenditionGeneration;
  allAudioTracks: boolean;
}

function parseArguments(argv: string[]): CliArguments {
  const [command = "help", ...rest] = argv;
  const result: CliArguments = {
    command,
    dryRun: false,
    confirmStale: false,
    olderThanHours: 24,
    profile: "legacy",
    // The library build applies the same retention policy the server job path
    // does — one best track per retained language, English and Turkish, and
    // never fewer than one audio track. `--all-audio-tracks` opts back out.
    allAudioTracks: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const next = rest[index + 1];
    if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--all-audio-tracks") result.allAudioTracks = true;
    else if (argument === "--default-audio-only") result.allAudioTracks = false;
    else if (argument === "--confirm-stale") result.confirmStale = true;
    else if (argument === "--library" && next) {
      result.library = next;
      index += 1;
    } else if (argument === "--media-id" && next) {
      result.mediaId = next;
      index += 1;
    } else if (argument === "--source" && next) {
      result.source = next;
      index += 1;
    } else if (argument === "--workers" && next) {
      result.workers = Number(next);
      index += 1;
      // Still accepted so an existing cron line does not start failing, and
      // deliberately ignored: age is no evidence about a checkpoint, which is
      // exactly as useful a week later as it was when it was written.
    } else if (argument === "--older-than-hours" && next) {
      result.olderThanHours = Number(next);
      index += 1;
    } else if (argument === "--profile" && next) {
      if (
        !(["legacy", "adaptive", "all"] as const).includes(
          next as RenditionGeneration,
        )
      ) {
        throw new Error("--profile must be legacy, adaptive, or all.");
      }
      result.profile = next as RenditionGeneration;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  if (
    result.workers !== undefined &&
    (!Number.isInteger(result.workers) ||
      result.workers < 1 ||
      result.workers > 4)
  ) {
    throw new Error("--workers must be an integer from 1 to 4.");
  }
  if (!Number.isFinite(result.olderThanHours) || result.olderThanHours < 1) {
    throw new Error("--older-than-hours must be at least 1.");
  }
  return result;
}

function reserveFromEnvironment(totalBytes: number): number {
  const configuredGb = process.env.SEYIRLIK_RENDITION_RESERVE_GB;
  if (!configuredGb) return calculateReserveBytes(totalBytes);
  const value = Number(configuredGb);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "SEYIRLIK_RENDITION_RESERVE_GB must be a non-negative number.",
    );
  }
  return Math.ceil(value * 1024 ** 3);
}

async function loadLatestReport(
  reportPath: string,
): Promise<RenditionAnalysisReport> {
  const parsed = JSON.parse(
    await readFile(reportPath, "utf8"),
  ) as RenditionAnalysisReport;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) {
    throw new Error(
      "Latest rendition analysis report is invalid; run analyse again.",
    );
  }
  return parsed;
}

function ensureSelectedItem(
  report: RenditionAnalysisReport,
  args: CliArguments,
): void {
  if (args.source) {
    const normalizedInput = args.source.replace(/\\/g, "/").toLowerCase();
    const match = report.items.find(
      (item) =>
        item.relativePath.toLowerCase() === normalizedInput ||
        item.relativePath.toLowerCase().endsWith(`/${normalizedInput}`),
    );
    if (!match)
      throw new Error(
        `The explicitly provided source (${args.source}) was not found under the configured media root. ` +
          "Pass the exact media-root-relative file path, including its real filename and extension " +
          '(for example, "Movies/Title (2026)/Title (2026).mkv").',
      );
    args.mediaId = match.mediaId;
  }
  if (
    args.mediaId &&
    !report.items.some((item) => item.mediaId === args.mediaId)
  ) {
    throw new Error(
      "The requested stable media ID was not found in the analysis report.",
    );
  }
}

async function validateOutputs(
  report: RenditionAnalysisReport,
  renditionRoot: string,
  ffprobePath?: string,
) {
  const results = [];
  for (const item of report.items) {
    const inspection = await inspectCompletedRendition({
      mediaRoot: path.join(renditionRoot, item.mediaId),
      mediaId: item.mediaId,
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: RENDITION_PROFILE_VERSION,
    });
    if (
      inspection.status !== "ready" ||
      !inspection.versionRoot ||
      !inspection.metadata
    ) {
      results.push({
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: inspection.status,
        error: inspection.reason,
      });
      continue;
    }
    try {
      for (const variant of inspection.metadata.files) {
        const variantProbe = await probeMediaFile(
          path.join(inspection.versionRoot, variant.file),
          ffprobePath,
        );
        if (
          variantProbe.video.width !== variant.width ||
          variantProbe.video.height !== variant.height
        ) {
          throw new Error(
            `Variant ${variant.qualityHeight}p dimensions do not match metadata.`,
          );
        }
        if (variantProbe.video.codec !== variant.videoCodec) {
          throw new Error(
            `Variant ${variant.qualityHeight}p is ${variantProbe.video.codec}, not ${variant.videoCodec}.`,
          );
        }
        const expectedPixelFormat = variant.hdr ? "yuv420p10le" : "yuv420p";
        if (variantProbe.video.pixelFormat !== expectedPixelFormat) {
          throw new Error(
            `Variant ${variant.qualityHeight}p pixel format is ${variantProbe.video.pixelFormat}, not ${expectedPixelFormat}.`,
          );
        }
        if (variant.hdr && !variantProbe.video.isHdr) {
          throw new Error(
            `Variant ${variant.qualityHeight}p lost its HDR transfer characteristics.`,
          );
        }
        if (
          !variantProbe.audioTracks[0] ||
          variantProbe.audioTracks[0].codec !== "aac"
        ) {
          throw new Error(
            `Variant ${variant.qualityHeight}p audio is not AAC.`,
          );
        }
        if (
          variant.audioLanguage &&
          (variantProbe.audioTracks[0].language ?? "und").toLowerCase() !==
            variant.audioLanguage.toLowerCase()
        ) {
          throw new Error(
            `Variant ${variant.qualityHeight}p audio language metadata changed.`,
          );
        }
        const tolerance =
          inspection.metadata.validation.durationToleranceSeconds;
        if (
          Math.abs(
            variantProbe.durationSeconds - inspection.metadata.durationSeconds,
          ) > tolerance
        ) {
          throw new Error(
            `Variant ${variant.qualityHeight}p duration is outside tolerance.`,
          );
        }
      }
      results.push({
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: "ready",
      });
    } catch (error) {
      results.push({
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: "validation-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function validateAdaptiveOutputs(
  report: RenditionAnalysisReport,
  mediaRoot: string,
  ffprobePath?: string,
) {
  const results = [];
  for (const item of report.items) {
    const inspection = await inspectAdaptivePackage({
      // A package lives beside the source it was made from.
      titleRoot: path.dirname(
        path.join(mediaRoot, ...item.relativePath.split("/")),
      ),
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
    });
    if (inspection.status !== "ready" || !inspection.versionRoot) {
      results.push({
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: inspection.status,
        error: inspection.reason,
      });
      continue;
    }
    const validation = await validateAdaptivePackage({
      versionRoot: inspection.versionRoot,
      mediaId: item.mediaId,
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      ffprobePath,
      deep: true,
    });
    results.push({
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status: validation.ok ? "ready" : "validation-failed",
      /*
       * An issue is a record, not a string, so joining the array directly
       * rendered every failure as "[object Object]" — the one moment the tool
       * exists for is the one moment it said nothing. Each issue names the
       * rendition and stage it came from, and both belong in the line.
       */
      ...(!validation.ok
        ? {
            error: validation.issues
              .map((issue) =>
                [issue.rendition, issue.stage].filter(Boolean).length > 0
                  ? `${[issue.rendition, issue.stage].filter(Boolean).join("/")}: ${issue.message}`
                  : issue.message,
              )
              .join("; "),
          }
        : {}),
    });
  }
  return results;
}

/** A lock older than this is treated as abandoned regardless of its lease. */
const LOCK_MAXIMUM_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Whether anything is still working on a media id.
 *
 * A lock's presence is not the question; whether anything is still holding it
 * is. A dead attempt leaves its lock behind — an unplugged volume is the usual
 * way — and treating that as active meant the workspace it abandoned could
 * never be reclaimed. The lease says which it is.
 */
async function hasActiveRenditionLock(
  stateRoot: string,
  mediaId: string,
): Promise<boolean> {
  for (const lockPath of [
    path.join(stateRoot, "locks", `${mediaId}.lock`),
    path.join(stateRoot, "locks", `${mediaId}.adaptive.lock`),
  ]) {
    try {
      await stat(lockPath);
      if (!(await staleLock(lockPath, LOCK_MAXIMUM_AGE_MS))) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

/**
 * Renders progress events. On a TTY the encode line rewrites itself in place;
 * otherwise it prints a throttled line so redirected logs stay readable.
 */
function describeEncoder(encoder: string): string {
  const labels: Record<string, string> = {
    h264_qsv: "h264_qsv (Intel QuickSync, H.264)",
    h264_videotoolbox: "h264_videotoolbox (Apple VideoToolbox, H.264)",
    libx264: "libx264 (software, H.264)",
    hevc_qsv: "hevc_qsv (Intel QuickSync, HEVC Main 10)",
    hevc_videotoolbox: "hevc_videotoolbox (Apple VideoToolbox, HEVC Main 10)",
    libx265: "libx265 (software, HEVC Main 10)",
  };
  return labels[encoder] ?? encoder;
}

function createProgressRenderer() {
  // `npm run` on Windows does not always present stderr as a TTY, so the
  // in-place mode is only used when rewriting is actually possible.
  const isTty = Boolean(process.stderr.isTTY);
  const throttleMs = isTty ? 500 : 30_000;
  let lastPrintedAt = 0;
  let activeLine = false;
  let currentQualities = "";
  let currentEpoch = "";

  const clearLine = () => {
    if (activeLine && isTty) {
      process.stderr.write(`\r${" ".repeat(78)}\r`);
    }
    activeLine = false;
  };

  const write = (line: string) => {
    clearLine();
    process.stderr.write(`${line}\n`);
  };

  const handle = (event: RenditionProgressEvent) => {
    switch (event.type) {
      case "encoder-selected":
        write(`Video encoder (SDR): ${describeEncoder(event.encoder)}`);
        if (event.hdrEncoder) {
          write(
            `Video encoder (HDR): ${describeEncoder(event.hdrEncoder)} — HDR10 preserved`,
          );
        }
        break;

      case "analysis-progress": {
        const now = Date.now();
        if (now - lastPrintedAt < throttleMs && event.index !== event.total) {
          break;
        }
        lastPrintedAt = now;
        const label = `[${event.index}/${event.total}] probing ${event.relativePath}`;
        if (isTty) {
          clearLine();
          process.stderr.write(label.slice(0, 78).padEnd(78));
          process.stderr.write("\r");
          activeLine = true;
        } else {
          write(label);
        }
        break;
      }

      case "item-start": {
        const { source } = event;
        const details = [
          `${source.width}x${source.height}`,
          `${source.qualityHeight}p`,
          source.videoCodec,
          source.isHdr ? "HDR" : "SDR",
          formatDuration(source.durationSeconds),
          source.audioLanguage ? `audio ${source.audioLanguage}` : "audio und",
        ].join(" · ");
        write("");
        write(`[${event.index}/${event.total}] ${event.relativePath}`);
        write(`    source: ${details}`);
        if (event.reusedQualities.length > 0) {
          write(
            `    reusing: ${event.reusedQualities.map((height) => `${height}p`).join(", ")}`,
          );
        }
        break;
      }

      case "encode-start":
        currentQualities = event.qualities
          .map((height) => `${height}p`)
          .join("+");
        write(
          `    encoding ${currentQualities} with ${event.encoder}${
            event.hdr
              ? " (HDR10 preserved)"
              : event.tonemapHdr
                ? " (HDR to SDR tone mapping)"
                : ""
          } from a single decode`,
        );
        lastPrintedAt = 0;
        break;

      case "encode-progress": {
        const now = Date.now();
        if (now - lastPrintedAt < throttleMs) break;
        lastPrintedAt = now;
        const percent =
          event.durationSeconds > 0
            ? Math.min(
                100,
                (event.processedSeconds / event.durationSeconds) * 100,
              )
            : 0;
        const remaining = estimateRemainingSeconds(
          event.processedSeconds,
          event.durationSeconds,
          event.speed,
        );
        const line =
          `    ${currentQualities}${currentEpoch ? ` e${currentEpoch}` : ""} ${percent.toFixed(1).padStart(5)}%` +
          ` ${formatDuration(event.processedSeconds)}/${formatDuration(event.durationSeconds)}` +
          `${event.speed ? ` ${event.speed.toFixed(2)}x` : ""}` +
          `${event.fps ? ` ${Math.round(event.fps)}fps` : ""}` +
          `${event.writtenBytes ? ` ${formatBytes(event.writtenBytes)}` : ""}` +
          `${remaining === undefined ? "" : ` eta ${formatDuration(remaining)}`}`;
        if (isTty) {
          clearLine();
          process.stderr.write(line.slice(0, 78).padEnd(78));
          process.stderr.write("\r");
          activeLine = true;
        } else {
          write(line);
        }
        break;
      }

      case "epoch-plan":
        write(
          `    plan: ${event.epochCount} checkpointed ${event.epochCount === 1 ? "epoch" : "epochs"}` +
            ` of about ${Math.round(event.epochTargetSeconds / 60)} min` +
            (event.reusedEpochs > 0
              ? ` — reusing ${event.reusedEpochs}, protected through ${formatDuration(event.protectedSeconds)}`
              : ""),
        );
        for (const entry of event.invalidated) {
          write(
            `    checkpoint ${entry.index + 1} rejected (${entry.reason}); it will be built again`,
          );
        }
        break;

      case "epoch-start":
        currentEpoch = `${event.index + 1}/${event.epochCount}`;
        write(
          `    ${event.attempt > 1 ? "retrying" : "encoding"} epoch ${currentEpoch}` +
            ` ${formatDuration(event.startSeconds)}–${formatDuration(event.endSeconds)}`,
        );
        lastPrintedAt = 0;
        break;

      case "epoch-complete":
        // A reused checkpoint reports no bytes; only newly durable work is
        // announced, or a resumed job would print a line per epoch it skipped.
        if (event.bytes > 0) {
          write(
            `    checkpoint saved — protected through ${formatDuration(event.protectedSeconds)}` +
              ` (${event.index + 1}/${event.epochCount}, ${formatBytes(event.bytes)})`,
          );
        }
        break;

      case "build-stage":
        if (event.stage !== "encoding") write(`    ${event.stage}...`);
        break;

      case "quality-ready":
        write(
          `    ${event.reused ? "reused" : "ready"} ${event.qualityHeight}p` +
            ` ${event.width}x${event.height} ${formatBytes(event.fileSize)}`,
        );
        break;

      case "item-complete":
        write(
          `    ${event.status} in ${formatDuration(event.elapsedMs / 1000)}` +
            `${event.error ? ` — ${event.error}` : ""}`,
        );
        break;
    }
  };

  // Anything printed after progress must start on a fresh line, or it lands on
  // top of the in-place progress line and appears to have vanished.
  return { handle, finish: clearLine };
}

function usage(): string {
  return [
    "Seyirlik rendition CLI",
    "  analyse",
    "  process [--profile legacy|adaptive|all] [--library Movies|Series] [--media-id UUID] [--source relative/path] [--workers 1] [--default-audio-only] [--dry-run]",
    "  resume  [same options as process]  continue from durable checkpoints",
    "  status",
    "  validate [--profile legacy|adaptive|all] [--media-id UUID] [--source relative/path]",
    "  cleanup [--dry-run]",
    "  repair-masters [--library Movies|Series] [--media-id UUID] [--source relative/path] [--dry-run]",
    "",
    "repair-masters rewrites published master playlists to the current layout without",
    "re-encoding. Media files are never touched.",
    "",
    "resume continues an interrupted title from its last durable five-minute checkpoint.",
    "Encoding already protected by a checkpoint is never repeated.",
    "",
    "cleanup no longer sweeps by age: a work directory can hold fifty minutes of",
    "validated encoding a job is about to resume from. It removes abandoned generated",
    "work instead — partial epochs nobody is writing, staging directories from attempts",
    "that have ended, and builds keyed to an obsolete profile. A valid completed",
    "checkpoint is never removed by this command, at any age, and neither is stale",
    "completed output.",
  ].join("\n");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help") {
    console.log(usage());
    return;
  }
  const paths = resolveRenditionPaths();
  const exposedRoots = findRootsInsideMediaRoot(paths);
  if (exposedRoots.length > 0) {
    console.error(
      `Warning: ${exposedRoots.join(" and ")} sits inside SEYIRLIK_MEDIA_ROOT.\n` +
        "  Library automation that scans the media root can re-encode or delete generated\n" +
        "  renditions in place, which makes them fail validation and disappear from the\n" +
        "  player. Set SEYIRLIK_RENDITION_ROOT and SEYIRLIK_RENDITION_WORK_ROOT to a\n" +
        "  location on the same volume but outside the media root.",
    );
  }
  const ffprobePath =
    process.env.FFPROBE_PATH ?? process.env.SEYIRLIK_FFPROBE_PATH;
  const reportPath = path.join(paths.stateRoot, "rendition-analysis.json");

  if (args.command === "analyse") {
    const analyseProgress = createProgressRenderer();
    console.error("Analysing the library; probing every eligible video...");
    const report = await analyseRenditionLibrary({
      paths,
      ffprobePath,
      reportPath,
      onEvent: analyseProgress.handle,
      reserveBytes: process.env.SEYIRLIK_RENDITION_RESERVE_GB
        ? reserveFromEnvironment(0)
        : undefined,
    });
    analyseProgress.finish();
    console.log(formatAnalysisReport(report));
    console.log(`JSON report: ${reportPath}`);
    return;
  }

  if (args.command === "status") {
    const report = await loadLatestReport(reportPath);
    console.log(formatAnalysisReport(report));
    for (const item of report.items) {
      /*
       * The durable checkpoints, read from disk rather than from any record of
       * them. "adaptive=failed" on its own tells an operator nothing about what
       * a resume would actually have to redo; "epochs=10/31 protected=00:50:00"
       * tells them exactly.
       */
      const checkpoints = await summariseCheckpoints({
        workRoot: paths.workRoot,
        mediaId: item.mediaId,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
        sourceFingerprint: item.sourceFingerprint,
      });
      const durable = checkpoints.present
        ? `\tepochs=${checkpoints.completedEpochs}/${checkpoints.epochCount}` +
          `\tprotected=${formatDuration(checkpoints.protectedSeconds)}` +
          (checkpoints.nextEpochIndex === null
            ? "\tcurrent=none"
            : `\tcurrent=${checkpoints.nextEpochIndex + 1}`) +
          `\tcheckpointed=${formatBytes(checkpoints.bytes)}` +
          (checkpoints.activePartials > 0 ? "\tactive" : "")
        : "";
      console.log(
        `legacy=${item.status}\tadaptive=${item.adaptive.status}${item.adaptive.eligible ? "" : " (incompatible)"}${durable}\t${item.mediaId}\t${item.relativePath}`,
      );
    }
    return;
  }

  if (args.command === "process" || args.command === "resume") {
    const progress = createProgressRenderer();
    const renderProgress = progress.handle;
    console.error("Analysing the library before processing...");
    const analysis = await analyseRenditionLibrary({
      paths,
      ffprobePath,
      reportPath,
      onEvent: renderProgress,
      reserveBytes: process.env.SEYIRLIK_RENDITION_RESERVE_GB
        ? reserveFromEnvironment(0)
        : undefined,
    });
    // Analysis is complete. Clear its in-place progress line before selection
    // errors or processing output are printed.
    progress.finish();
    ensureSelectedItem(analysis, args);
    const reserveBytes = reserveFromEnvironment(
      analysis.storage.driveTotalBytes,
    );
    const startedAt = Date.now();
    const abortController = new AbortController();
    let signalCount = 0;
    const cancel = () => {
      signalCount += 1;
      if (signalCount === 1) {
        console.error(
          "Cancellation requested; waiting for the active FFmpeg process to stop safely.",
        );
        abortController.abort();
      } else {
        console.error(
          "Second cancellation signal received; exiting immediately.",
        );
        process.exit(130);
      }
    };
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const results: Array<{
        status: string;
        mediaId: string;
        relativePath: string;
        error?: string;
      }> = [];
      let videoEncoder = "not-selected";
      let hdrVideoEncoder: string | undefined;
      if (args.profile === "legacy" || args.profile === "all") {
        const legacy = await processRenditionReport(analysis, paths, {
          reserveBytes,
          ffprobePath,
          encoderPreference: parseEncoderPreference(
            process.env.SEYIRLIK_RENDITION_ENCODER,
          ),
          hdrPolicy: parseHdrPolicy(process.env.SEYIRLIK_RENDITION_HDR),
          onEvent: renderProgress,
          library: args.library,
          mediaId: args.mediaId,
          workerCount: args.workers,
          dryRun: args.dryRun,
          signal: abortController.signal,
        });
        results.push(...legacy.results);
        videoEncoder = legacy.videoEncoder;
        hdrVideoEncoder = legacy.hdrVideoEncoder;
      }
      if (args.profile === "adaptive" || args.profile === "all") {
        const adaptive = await processAdaptiveReport(analysis, paths, {
          reserveBytes,
          ffprobePath,
          encoderPreference: parseEncoderPreference(
            process.env.SEYIRLIK_RENDITION_ENCODER,
          ),
          onEvent: renderProgress,
          library: args.library,
          mediaId: args.mediaId,
          workerCount: args.workers,
          allAudioTracks: args.allAudioTracks,
          dryRun: args.dryRun,
          signal: abortController.signal,
        });
        results.push(...adaptive.results);
        videoEncoder = adaptive.videoEncoder;
        hdrVideoEncoder ??= adaptive.hdrVideoEncoder;
      }

      const resultPath = path.join(
        paths.stateRoot,
        "last-process-results.json",
      );
      await writeFile(
        resultPath,
        `${JSON.stringify(results, null, 2)}\n`,
        "utf8",
      );
      progress.finish();
      console.log("");
      for (const result of results) {
        console.log(
          `${result.status}\t${result.mediaId}\t${result.relativePath}${result.error ? `\t${result.error}` : ""}`,
        );
      }
      const byStatus = results.reduce<Record<string, number>>(
        (totals, result) => {
          totals[result.status] = (totals[result.status] ?? 0) + 1;
          return totals;
        },
        {},
      );
      console.log(
        `\nEncoder: ${videoEncoder}${
          hdrVideoEncoder ? ` (HDR: ${hdrVideoEncoder})` : ""
        }; processed ${results.length} title(s) in ${formatDuration(
          (Date.now() - startedAt) / 1000,
        )}`,
      );
      console.log(
        Object.entries(byStatus)
          .map(([status, count]) => `${status}=${count}`)
          .join(", ") || "nothing to do",
      );
      if (results.some((result) => result.status === "failed"))
        process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }

  if (args.command === "repair-masters") {
    /*
     * Brings existing packages up to the current master layout without
     * re-encoding. The media in a published package is unaffected by a change
     * in how the playlist describes it, so spending hours reproducing correct
     * bytes to obtain a corrected playlist would be pure waste.
     */
    const report = await loadLatestReport(reportPath);
    const titles = new Set<string>();
    for (const item of report.items) {
      if (args.source && item.relativePath !== args.source) continue;
      if (args.mediaId && item.mediaId !== args.mediaId) continue;
      if (args.library && !item.relativePath.startsWith(`${args.library}/`)) {
        continue;
      }
      titles.add(
        path.dirname(
          path.join(paths.mediaRoot, ...item.relativePath.split("/")),
        ),
      );
    }

    let updated = 0;
    let current = 0;
    let unsupported = 0;
    for (const titleRoot of [...titles].sort()) {
      const result = args.dryRun
        ? { status: "dry-run" as const, previousVersion: 0 }
        : await repairTitleMaster(titleRoot);
      const name = path.basename(titleRoot);
      if (result.status === "updated") {
        updated += 1;
        console.log(
          `updated\t${name} (layout v${result.previousVersion} -> v${MASTER_LAYOUT_VERSION})`,
        );
      } else if (result.status === "current") {
        current += 1;
      } else if (result.status === "unsupported") {
        unsupported += 1;
        console.log(
          `skipped\t${name}: ${"reason" in result ? result.reason : "unsupported"}`,
        );
      } else {
        console.log(`dry-run\t${name}`);
      }
    }
    console.log(
      `\nMaster layout v${MASTER_LAYOUT_VERSION}: ${updated} updated, ${current} already current, ${unsupported} skipped.`,
    );
    return;
  }

  if (args.command === "validate") {
    const report = await loadLatestReport(reportPath);
    ensureSelectedItem(report, args);
    const filtered = args.mediaId
      ? {
          ...report,
          items: report.items.filter((item) => item.mediaId === args.mediaId),
        }
      : report;
    const resultSets = [];
    if (args.profile === "legacy" || args.profile === "all") {
      resultSets.push(
        await validateOutputs(filtered, paths.renditionRoot, ffprobePath),
      );
    }
    if (args.profile === "adaptive" || args.profile === "all") {
      resultSets.push(
        await validateAdaptiveOutputs(filtered, paths.mediaRoot, ffprobePath),
      );
    }
    const results = resultSets.flat();
    for (const result of results) {
      console.log(
        `${result.status}\t${result.mediaId}\t${result.relativePath}${result.error ? `\t${result.error}` : ""}`,
      );
    }
    if (results.some((result) => result.status === "validation-failed"))
      process.exitCode = 1;
    return;
  }

  if (args.command === "cleanup") {
    if (args.confirmStale) {
      throw new Error(
        "Completed stale output cleanup is intentionally not automated; inspect and remove a specific generated version deliberately.",
      );
    }
    const lock = await acquireDirectoryLock(
      path.join(paths.stateRoot, "locks", "cleanup.lock"),
      "rendition-cleanup",
    );
    try {
      /*
       * Cleanup no longer sweeps by age. A work directory can hold fifty
       * minutes of validated, immutable encoding that a job is about to resume
       * from, and "older than twenty-four hours" describes precisely the job
       * that was interrupted by a drive being unplugged over a weekend — the
       * case checkpoints exist for. It removes what is provably unusable
       * instead, and says so per entry.
       */
      const known = new Set(
        (await loadLatestReport(reportPath).catch(() => null))?.items.map(
          (item) => item.mediaId,
        ) ?? [],
      );
      const actions = await cleanupAdaptiveWork({
        workRoot: paths.workRoot,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
        ...(known.size > 0
          ? { isKnownMedia: (mediaId: string) => known.has(mediaId) }
          : {}),
        hasActiveLock: (mediaId) =>
          hasActiveRenditionLock(paths.stateRoot, mediaId),
        dryRun: args.dryRun,
      });
      for (const action of actions) {
        console.log(
          `${action.action}\t${action.path}${
            action.keptEpochs === undefined
              ? ""
              : `\tepochs=${action.keptEpochs}`
          }`,
        );
      }
    } finally {
      await lock.release();
    }
    return;
  }

  throw new Error(`Unknown command: ${args.command}\n${usage()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
