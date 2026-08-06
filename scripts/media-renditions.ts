#!/usr/bin/env node
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  analyseRenditionLibrary,
  formatAnalysisReport,
  resolveRenditionPaths,
  type RenditionAnalysisReport,
} from "../src/renditions/analysis";
import { acquireDirectoryLock } from "../src/renditions/locks";
import { calculateReserveBytes } from "../src/renditions/planning";
import { processRenditionReport } from "../src/renditions/processor";
import { RENDITION_PROFILE_VERSION } from "../src/renditions/policy";
import { probeMediaFile } from "../src/renditions/probe";
import { inspectCompletedRendition } from "../src/renditions/validation";

interface CliArguments {
  command: string;
  library?: string;
  mediaId?: string;
  source?: string;
  workers?: number;
  dryRun: boolean;
  confirmStale: boolean;
  olderThanHours: number;
}

function parseArguments(argv: string[]): CliArguments {
  const [command = "help", ...rest] = argv;
  const result: CliArguments = {
    command,
    dryRun: false,
    confirmStale: false,
    olderThanHours: 24,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const next = rest[index + 1];
    if (argument === "--dry-run") result.dryRun = true;
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
    } else if (argument === "--older-than-hours" && next) {
      result.olderThanHours = Number(next);
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
        "The explicitly provided source was not found under the configured media root.",
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
            `Variant ${variant.height}p dimensions do not match metadata.`,
          );
        }
        if (variantProbe.video.codec !== "h264") {
          throw new Error(`Variant ${variant.height}p is not H.264.`);
        }
        if (variantProbe.video.pixelFormat !== "yuv420p") {
          throw new Error(
            `Variant ${variant.height}p pixel format is not yuv420p.`,
          );
        }
        if (
          !variantProbe.audioTracks[0] ||
          variantProbe.audioTracks[0].codec !== "aac"
        ) {
          throw new Error(`Variant ${variant.height}p audio is not AAC.`);
        }
        if (
          variant.audioLanguage &&
          (variantProbe.audioTracks[0].language ?? "und").toLowerCase() !==
            variant.audioLanguage.toLowerCase()
        ) {
          throw new Error(
            `Variant ${variant.height}p audio language metadata changed.`,
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
            `Variant ${variant.height}p duration is outside tolerance.`,
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

async function cleanupWork(
  workRoot: string,
  stateRoot: string,
  olderThanHours: number,
  dryRun: boolean,
): Promise<Array<{ path: string; action: string }>> {
  const actions: Array<{ path: string; action: string }> = [];
  const cutoff = Date.now() - olderThanHours * 60 * 60 * 1_000;
  let mediaEntries;
  try {
    mediaEntries = await readdir(workRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return actions;
    throw error;
  }
  for (const mediaEntry of mediaEntries) {
    if (!mediaEntry.isDirectory() || mediaEntry.isSymbolicLink()) continue;
    const lockPath = path.join(stateRoot, "locks", `${mediaEntry.name}.lock`);
    try {
      await stat(lockPath);
      actions.push({ path: mediaEntry.name, action: "skipped-active-lock" });
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const mediaWorkRoot = path.join(workRoot, mediaEntry.name);
    const mediaStats = await stat(mediaWorkRoot);
    if (mediaStats.mtimeMs > cutoff) {
      actions.push({ path: mediaEntry.name, action: "skipped-recent" });
      continue;
    }
    actions.push({
      path: mediaEntry.name,
      action: dryRun ? "would-remove-invalid-work" : "removed-invalid-work",
    });
    if (!dryRun) await rm(mediaWorkRoot, { recursive: true, force: true });
  }
  return actions;
}

function usage(): string {
  return [
    "Seyirlik rendition CLI",
    "  analyse",
    "  process [--library Movies|Series] [--media-id UUID] [--source relative/path] [--workers 1] [--dry-run]",
    "  resume  [same options as process]",
    "  status",
    "  validate [--media-id UUID]",
    "  cleanup [--older-than-hours 24] [--dry-run]",
    "",
    "cleanup removes only abandoned generated work directories. Stale completed output is never removed by this command.",
  ].join("\n");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help") {
    console.log(usage());
    return;
  }
  const paths = resolveRenditionPaths();
  const ffprobePath =
    process.env.FFPROBE_PATH ?? process.env.SEYIRLIK_FFPROBE_PATH;
  const reportPath = path.join(paths.stateRoot, "rendition-analysis.json");

  if (args.command === "analyse") {
    const report = await analyseRenditionLibrary({
      paths,
      ffprobePath,
      reportPath,
      reserveBytes: process.env.SEYIRLIK_RENDITION_RESERVE_GB
        ? reserveFromEnvironment(0)
        : undefined,
    });
    console.log(formatAnalysisReport(report));
    console.log(`JSON report: ${reportPath}`);
    return;
  }

  if (args.command === "status") {
    const report = await loadLatestReport(reportPath);
    console.log(formatAnalysisReport(report));
    for (const item of report.items) {
      console.log(`${item.status}\t${item.mediaId}\t${item.relativePath}`);
    }
    return;
  }

  if (args.command === "process" || args.command === "resume") {
    const analysis = await analyseRenditionLibrary({
      paths,
      ffprobePath,
      reportPath,
      reserveBytes: process.env.SEYIRLIK_RENDITION_RESERVE_GB
        ? reserveFromEnvironment(0)
        : undefined,
    });
    ensureSelectedItem(analysis, args);
    const reserveBytes = reserveFromEnvironment(
      analysis.storage.driveTotalBytes,
    );
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
      const results = await processRenditionReport(analysis, paths, {
        reserveBytes,
        ffprobePath,
        library: args.library,
        mediaId: args.mediaId,
        workerCount: args.workers,
        dryRun: args.dryRun,
        signal: abortController.signal,
      });
      const resultPath = path.join(
        paths.stateRoot,
        "last-process-results.json",
      );
      await writeFile(
        resultPath,
        `${JSON.stringify(results, null, 2)}\n`,
        "utf8",
      );
      for (const result of results) {
        console.log(
          `${result.status}\t${result.mediaId}\t${result.relativePath}${result.error ? `\t${result.error}` : ""}`,
        );
      }
      if (results.some((result) => result.status === "failed"))
        process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
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
    const results = await validateOutputs(
      filtered,
      paths.renditionRoot,
      ffprobePath,
    );
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
      const actions = await cleanupWork(
        paths.workRoot,
        paths.stateRoot,
        args.olderThanHours,
        args.dryRun,
      );
      for (const action of actions)
        console.log(`${action.action}\t${action.path}`);
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
