/**
 * Audio, as its own recoverable stage.
 *
 * Audio used to ride along in the same FFmpeg process as the video ladder,
 * which was free while a package was one transaction and is wrong now: a
 * failure encoding a soundtrack would take eight video renditions with it, and
 * a video epoch that had to be redone would re-encode audio it had already
 * produced. Sound is cheap — minutes against hours — so it is built once for
 * the whole title and checkpointed on its own.
 *
 * The consequence that matters is stated plainly because it is the whole point:
 * audio failing never invalidates a video epoch, and a video epoch failing
 * never re-encodes audio.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { PauseController } from "../../processing/pauseController";
import { parseFfmpegProgressFields } from "../../progress";
import {
  adaptiveOutputDirectories,
  buildAdaptivePackageFfmpegArgs,
  type AdaptiveAudioOutput,
} from "../encoding";
import {
  ADAPTIVE_AUDIO_DIRECTORY,
  ADAPTIVE_MEDIA_FILE,
  ADAPTIVE_PLAYLIST_FILE,
  AUDIO_DURATION_TOLERANCE_SECONDS,
  audioRenditionId,
} from "../profile";
import { probePackagedAudio } from "../probePackaged";
import { parseMediaPlaylist } from "../playlist";
import { readFile } from "node:fs/promises";
import { EPOCH_CHECKPOINT_SCHEMA_VERSION } from "./policy";
import {
  readAuxiliaryStage,
  writeAuxiliaryStage,
  type AuxiliaryStageManifest,
} from "./checkpoints";
import { classifyFailure, StorageInterruptedError } from "./failure";

export interface AudioStageResult {
  /** Directory the finished audio renditions live in. */
  directory: string;
  reused: boolean;
  bytes: number;
  manifest: AuxiliaryStageManifest;
}

export interface EnsureAudioStageInput {
  stageDirectory: string;
  mediaId: string;
  sourceFingerprint: string;
  adaptiveProfileVersion: string;
  sourcePath: string;
  audioOutputs: readonly AdaptiveAudioOutput[];
  sourceDurationSeconds: number;
  ffmpegPath: string;
  ffprobePath: string;
  logPath: string;
  runEncoder: (
    command: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      logPath: string;
      onProgress?: (
        progress: ReturnType<typeof parseFfmpegProgressFields>,
      ) => void;
      pauseController?: PauseController;
    },
  ) => Promise<void>;
  signal?: AbortSignal;
  pauseController?: PauseController;
  storageAvailable?: () => boolean | Promise<boolean>;
  onProgress?: (fraction: number) => void;
}

function sameStreams(
  manifest: AuxiliaryStageManifest,
  wanted: readonly number[],
): boolean {
  if (manifest.streamIndexes.length !== wanted.length) return false;
  const present = new Set(manifest.streamIndexes);
  return wanted.every((index) => present.has(index));
}

/**
 * Builds the title's audio, or proves what is already there still fits.
 *
 * The stage is only reused when it was produced from the same source bytes,
 * under the same profile, for exactly the tracks wanted now. A retention policy
 * that changed its mind about a language must rebuild rather than publish a
 * package whose manifest and media disagree about which tracks exist.
 */
export async function ensureAudioStage({
  stageDirectory,
  mediaId,
  sourceFingerprint,
  adaptiveProfileVersion,
  sourcePath,
  audioOutputs,
  sourceDurationSeconds,
  ffmpegPath,
  ffprobePath,
  logPath,
  runEncoder,
  signal,
  pauseController,
  storageAvailable,
  onProgress,
}: EnsureAudioStageInput): Promise<AudioStageResult> {
  const wanted = audioOutputs.map((output) => output.sourceStreamIndex);
  const existing = await readAuxiliaryStage(stageDirectory);
  if (
    existing &&
    existing.schemaVersion === EPOCH_CHECKPOINT_SCHEMA_VERSION &&
    existing.mediaId === mediaId &&
    existing.sourceFingerprint === sourceFingerprint &&
    existing.adaptiveProfileVersion === adaptiveProfileVersion &&
    sameStreams(existing, wanted) &&
    (await audioFilesPresent(stageDirectory, audioOutputs))
  ) {
    return {
      directory: stageDirectory,
      reused: true,
      bytes: existing.totalBytes,
      manifest: existing,
    };
  }

  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(stageDirectory, { recursive: true });
  for (const directory of adaptiveOutputDirectories({
    videoOutputs: [],
    audioOutputs: [...audioOutputs],
  })) {
    await mkdir(path.join(stageDirectory, ...directory.split("/")), {
      recursive: true,
    });
  }

  const args = buildAdaptivePackageFfmpegArgs({
    inputPath: sourcePath,
    outputRoot: stageDirectory.split(path.sep).join("/"),
    videoOutputs: [],
    audioOutputs: [...audioOutputs],
    statsPeriodSeconds: 1,
  });

  try {
    await runEncoder(ffmpegPath, args, {
      ...(signal ? { signal } : {}),
      ...(pauseController ? { pauseController } : {}),
      logPath,
      ...(onProgress
        ? {
            onProgress: (progress) => {
              onProgress(
                sourceDurationSeconds > 0
                  ? Math.min(
                      1,
                      progress.processedSeconds / sourceDurationSeconds,
                    )
                  : 0,
              );
            },
          }
        : {}),
    });
  } catch (error) {
    await rm(stageDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const failure = classifyFailure({
      message,
      storageAvailable: storageAvailable ? await storageAvailable() : true,
    });
    if (
      failure.kind === "storage-unavailable" ||
      failure.kind === "out-of-space"
    ) {
      throw new StorageInterruptedError(failure);
    }
    throw new Error(`Audio could not be packaged. ${failure.detail}`.trim());
  }

  let totalBytes = 0;
  for (const output of audioOutputs) {
    const id = audioRenditionId(output.sourceStreamIndex);
    const mediaPath = path.join(
      stageDirectory,
      ADAPTIVE_AUDIO_DIRECTORY,
      id,
      ADAPTIVE_MEDIA_FILE,
    );
    const playlistPath = path.join(
      stageDirectory,
      ADAPTIVE_AUDIO_DIRECTORY,
      id,
      ADAPTIVE_PLAYLIST_FILE,
    );
    const stats = await stat(mediaPath).catch(() => undefined);
    if (!stats?.isFile() || stats.size === 0) {
      throw new Error(`Audio rendition ${id} was not written.`);
    }
    totalBytes += stats.size;

    // Parsed rather than merely present: a playlist the delivery route cannot
    // read is a track that plays as silence with no error anywhere.
    parseMediaPlaylist(await readFile(playlistPath, "utf8"));

    const probe = await probePackagedAudio(mediaPath, ffprobePath, signal);
    if (
      Math.abs(probe.durationSeconds - sourceDurationSeconds) >
      Math.max(AUDIO_DURATION_TOLERANCE_SECONDS, sourceDurationSeconds * 0.01)
    ) {
      throw new Error(
        `Audio rendition ${id} covers ${probe.durationSeconds.toFixed(2)}s of a ${sourceDurationSeconds.toFixed(2)}s source.`,
      );
    }
  }

  const manifest: AuxiliaryStageManifest = {
    schemaVersion: EPOCH_CHECKPOINT_SCHEMA_VERSION,
    mediaId,
    sourceFingerprint,
    adaptiveProfileVersion,
    stage: "audio",
    streamIndexes: wanted,
    totalBytes,
    completedAt: new Date().toISOString(),
  };
  await writeAuxiliaryStage(stageDirectory, manifest);

  return {
    directory: stageDirectory,
    reused: false,
    bytes: totalBytes,
    manifest,
  };
}

async function audioFilesPresent(
  stageDirectory: string,
  audioOutputs: readonly AdaptiveAudioOutput[],
): Promise<boolean> {
  for (const output of audioOutputs) {
    const id = audioRenditionId(output.sourceStreamIndex);
    for (const file of [ADAPTIVE_MEDIA_FILE, ADAPTIVE_PLAYLIST_FILE]) {
      const stats = await stat(
        path.join(stageDirectory, ADAPTIVE_AUDIO_DIRECTORY, id, file),
      ).catch(() => undefined);
      if (!stats?.isFile() || stats.size === 0) return false;
    }
  }
  return true;
}
