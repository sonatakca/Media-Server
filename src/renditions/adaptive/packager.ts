/**
 * Produces one adaptive package, from probe to activated pointer.
 *
 * The lifecycle is the same shape as the legacy processor's and for the same
 * reason: a package is built in an isolated work directory, measured, validated
 * as a whole, and only then promoted and pointed at. Nothing ever writes into a
 * directory a playback session might currently be reading, and a failed run
 * leaves the previously active package — legacy or adaptive — exactly as it was.
 *
 * The one structural difference from the legacy processor is that the unit of
 * work is the whole package rather than a file. A ladder is only meaningful if
 * every rung shares a timeline, so a partially encoded package has no useful
 * subset to keep and resume restarts the encode instead of reusing rungs.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SEGMENT_TARGET_SECONDS } from "../../lib/playback-planner/gopPolicy";
import type { DriveSpace, RenditionPaths } from "../analysis";
import { getDriveSpace } from "../analysis";
import {
  codecFamilyForEncoder,
  getEncodingPolicy,
  resolveVideoEncoder,
  type RenditionEncoderPreference,
  type RenditionHdrSignal,
  type RenditionVideoEncoder,
} from "../encoding";
import { acquireDirectoryLock } from "../locks";
import { DEFAULT_STORAGE_SAFETY_MARGIN } from "../planning";
import {
  buildRenditionRequirements,
  classifyQualityHeight,
  getDisplayDimensions,
} from "../policy";
import type { RenditionMediaProbe } from "../probe";
import { probeMediaFile } from "../probe";
import type { RenditionProgressReporter } from "../progress";
import { parseFfmpegProgressFields } from "../progress";
import {
  adaptiveOutputDirectories,
  buildAdaptivePackageFfmpegArgs,
  canStreamCopyAudio,
  type AdaptiveAudioOutput,
  type AdaptiveVideoOutput,
} from "./encoding";
import type {
  AdaptiveAudioRenditionMetadata,
  AdaptiveHdrState,
  AdaptivePackageMetadata,
  AdaptiveVideoRenditionMetadata,
} from "./metadata";
import {
  buildMasterPlaylist,
  parseCodecsFromGeneratedMaster,
  parseMediaPlaylist,
} from "./playlist";
import {
  audioCodecString,
  probePackagedAudio,
  probePackagedVideo,
} from "./probePackaged";
import {
  ADAPTIVE_AUDIO_DIRECTORY,
  ADAPTIVE_MASTER_PLAYLIST,
  ADAPTIVE_MEDIA_FILE,
  ADAPTIVE_METADATA_FILE,
  ADAPTIVE_METADATA_SCHEMA_VERSION,
  ADAPTIVE_PLAYLIST_FILE,
  ADAPTIVE_POINTER_FILE,
  ADAPTIVE_POINTER_SCHEMA_VERSION,
  ADAPTIVE_PROFILE_VERSION,
  ADAPTIVE_VIDEO_DIRECTORY,
  ALIGNMENT_EPSILON_SECONDS,
  AUDIO_DURATION_TOLERANCE_SECONDS,
  audioRenditionId,
  videoRenditionId,
} from "./profile";
import { validateAdaptivePackage } from "./validation";

export type AdaptivePackageStatus =
  | "ready"
  | "already-valid"
  | "failed"
  | "validation-failed"
  | "deferred-for-storage"
  | "interrupted"
  | "incompatible"
  | "dry-run";

export interface AdaptivePackageResult {
  mediaId: string;
  relativePath: string;
  status: AdaptivePackageStatus;
  versionDirectory?: string;
  error?: string;
  /** Populated when validation ran and produced findings. */
  issues?: string[];
  storageBytes?: number;
}

export interface AdaptivePackageRequest {
  mediaId: string;
  relativePath: string;
  sourceFingerprint: string;
  sourcePath: string;
  probe?: RenditionMediaProbe;
}

export interface AdaptivePackagerOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  encoderPreference?: RenditionEncoderPreference;
  videoEncoder?: RenditionVideoEncoder;
  hdrVideoEncoder?: RenditionVideoEncoder;
  reserveBytes: number;
  segmentSeconds?: number;
  preset?: string;
  /**
   * Package every source audio track rather than only the default one. The
   * schema and master generator always support several; this decides how many a
   * given run actually encodes.
   */
  allAudioTracks?: boolean;
  driveSpaceProvider?: () => Promise<DriveSpace>;
  runEncoder?: (
    command: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      logPath: string;
      onProgress?: (
        progress: ReturnType<typeof parseFfmpegProgressFields>,
      ) => void;
    },
  ) => Promise<void>;
  onEvent?: RenditionProgressReporter;
  verifySourceFingerprint?: boolean;
  signal?: AbortSignal;
  dryRun?: boolean;
}

/**
 * Whether a variable-frame-rate source can be packaged deterministically.
 *
 * `avg_frame_rate` and `r_frame_rate` diverging is the usual signature of VFR
 * or of a container whose timestamps are irregular. Forced keyframes are placed
 * on presentation time rather than frame counts, so such a source can still be
 * cut on exact two-second boundaries — but the claim is proved by validation
 * afterwards, not assumed here.
 */
export function isVariableFrameRate(probe: RenditionMediaProbe): boolean {
  const average = probe.video.frameRate;
  if (!average || !Number.isFinite(average)) return true;
  const maximum = probe.video.maxFrameRate;
  if (!maximum || !Number.isFinite(maximum)) return false;
  return Math.abs(maximum - average) / average > 0.01;
}

function hdrStateFor(probe: RenditionMediaProbe): AdaptiveHdrState {
  if (!probe.video.isHdr) return "sdr";
  return probe.video.colorTransfer?.toLowerCase() === "arib-std-b67"
    ? "hlg"
    : "hdr10";
}

/**
 * Audio tracks that become renditions, and the ones deliberately left out.
 *
 * The default track always leads. Unsupported codecs are transcoded rather than
 * dropped, because a package whose only audio is a format the browser cannot
 * decode is a package that silently plays silent.
 */
export function planAudioRenditions(
  probe: RenditionMediaProbe,
  { allTracks = false }: { allTracks?: boolean } = {},
): { outputs: AdaptiveAudioOutput[]; deferred: number[] } {
  const tracks = probe.audioTracks;
  if (tracks.length === 0) {
    return { outputs: [], deferred: [] };
  }
  const defaultTrack = tracks.find((track) => track.isDefault) ?? tracks[0];
  const selected = allTracks ? tracks : [defaultTrack];
  const deferred = tracks
    .filter((track) => !selected.includes(track))
    .map((track) => track.streamIndex);

  const outputs = selected.map<AdaptiveAudioOutput>((track) => {
    const channels = track.channels ?? 2;
    return {
      sourceStreamIndex: track.streamIndex,
      action: canStreamCopyAudio({ codec: track.codec, channels })
        ? "copy"
        : "transcode",
      bitrate: channels > 2 ? 256_000 : 192_000,
      ...(track.language ? { language: track.language } : {}),
      ...(track.title ? { title: track.title } : {}),
      isDefault: track.streamIndex === defaultTrack.streamIndex,
      isForced: false,
    };
  });

  return { outputs, deferred };
}

async function runFfmpegProcess(
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    logPath: string;
    onProgress?: (
      progress: ReturnType<typeof parseFfmpegProgressFields>,
    ) => void;
  },
): Promise<void> {
  const { runFfmpeg } = await import("../processor");
  return runFfmpeg(command, args, options);
}

async function writeAdaptivePointer(
  mediaRoot: string,
  versionDirectory: string,
  sourceFingerprint: string,
): Promise<void> {
  const pointerPath = path.join(mediaRoot, ADAPTIVE_POINTER_FILE);
  const temporaryPath = `${pointerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        schemaVersion: ADAPTIVE_POINTER_SCHEMA_VERSION,
        versionDirectory,
        sourceFingerprint,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  try {
    await rename(temporaryPath, pointerPath);
  } catch (error) {
    if (process.platform !== "win32") {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    // Windows `rename` refuses to replace an existing file, so the previous
    // pointer is moved aside and restored if the swap does not complete. There
    // is no instant at which no pointer exists.
    const previousPath = `${pointerPath}.${randomUUID()}.previous`;
    try {
      await rename(pointerPath, previousPath);
      await rename(temporaryPath, pointerPath);
      await rm(previousPath, { force: true });
    } catch (replacementError) {
      await rename(previousPath, pointerPath).catch(() => undefined);
      await rm(temporaryPath, { force: true });
      throw replacementError;
    }
  }
}

/**
 * Bitrate figures measured from the packaged bytes.
 *
 * `average` is the whole rendition; `peak` is the busiest single segment, which
 * is what a player must be able to sustain to avoid stalling on the hardest two
 * seconds of the title. Using the configured rate cap instead would advertise
 * the same number for every title regardless of content.
 */
export function measureBitrates(playlistText: string): {
  averageBitrate: number;
  peakBitrate: number;
  segmentCount: number;
  durationSeconds: number;
  mediaBytes: number;
} {
  const playlist = parseMediaPlaylist(playlistText);
  let peak = 0;
  let payloadBytes = 0;
  for (const segment of playlist.segments) {
    payloadBytes += segment.byteRange.length;
    const rate = (segment.byteRange.length * 8) / segment.durationSeconds;
    if (rate > peak) peak = rate;
  }
  const durationSeconds = playlist.totalDurationSeconds;
  return {
    averageBitrate: Math.max(
      1,
      Math.round((payloadBytes * 8) / durationSeconds),
    ),
    peakBitrate: Math.max(1, Math.round(peak)),
    segmentCount: playlist.segments.length,
    durationSeconds,
    mediaBytes: payloadBytes + playlist.map.byteRange.length,
  };
}

function keyframeSummary(
  keyframeTimes: number[],
  target: number,
): AdaptiveVideoRenditionMetadata["keyframeIntervalSeconds"] {
  if (keyframeTimes.length < 2) {
    return { target, minimum: target, maximum: target, mean: target };
  }
  const gaps: number[] = [];
  for (let index = 1; index < keyframeTimes.length; index += 1) {
    gaps.push(keyframeTimes[index] - keyframeTimes[index - 1]);
  }
  const total = gaps.reduce((sum, gap) => sum + gap, 0);
  return {
    target,
    minimum: Math.max(0.0001, Math.min(...gaps)),
    maximum: Math.max(...gaps),
    mean: Math.max(0.0001, total / gaps.length),
  };
}

/**
 * Estimated package size, used only for the free-space preflight.
 *
 * Video is estimated per rung as before, but audio is counted once for the
 * whole package rather than once per rung — which is the storage difference the
 * shared-audio layout buys and the reason the adaptive estimate is materially
 * lower than the legacy one for the same ladder.
 */
export function estimateAdaptivePackageBytes({
  durationSeconds,
  qualityHeights,
  codecFamily,
  audioTrackCount = 1,
}: {
  durationSeconds: number;
  qualityHeights: number[];
  codecFamily: "h264" | "hevc";
  audioTrackCount?: number;
}): { videoBytes: number; audioBytes: number; totalBytes: number } {
  const videoBytes = qualityHeights.reduce((total, height) => {
    const policy = getEncodingPolicy(height, codecFamily);
    return (
      total + Math.ceil((durationSeconds * policy.expectedVideoBitrate) / 8)
    );
  }, 0);
  const audioBytes = Math.ceil(
    (durationSeconds * 192_000 * Math.max(1, audioTrackCount)) / 8,
  );
  // CMAF fragmentation carries more box overhead than a progressive MP4: an
  // moof per two-second fragment rather than one moov for the file.
  const totalBytes = Math.ceil((videoBytes + audioBytes) * 1.02);
  return { videoBytes, audioBytes, totalBytes };
}

export async function packageAdaptiveRendition(
  request: AdaptivePackageRequest,
  paths: RenditionPaths,
  {
    ffmpegPath = process.env.FFMPEG_PATH ??
      process.env.SEYIRLIK_FFMPEG_PATH ??
      "ffmpeg",
    ffprobePath = process.env.FFPROBE_PATH ??
      process.env.SEYIRLIK_FFPROBE_PATH ??
      "ffprobe",
    encoderPreference = "auto",
    videoEncoder,
    hdrVideoEncoder,
    reserveBytes,
    segmentSeconds = SEGMENT_TARGET_SECONDS,
    preset = "medium",
    allAudioTracks = false,
    driveSpaceProvider = () => getDriveSpace(paths.mediaRoot),
    runEncoder = runFfmpegProcess,
    onEvent,
    verifySourceFingerprint = true,
    signal,
    dryRun = false,
  }: AdaptivePackagerOptions,
): Promise<AdaptivePackageResult> {
  const base = { mediaId: request.mediaId, relativePath: request.relativePath };

  if (signal?.aborted) return { ...base, status: "interrupted" };
  if (dryRun) return { ...base, status: "dry-run" };

  const lock = await acquireDirectoryLock(
    path.join(paths.stateRoot, "locks", `${request.mediaId}.adaptive.lock`),
    `adaptive:${request.mediaId}`,
  );

  const mediaRoot = path.join(paths.renditionRoot, request.mediaId);
  const versionDirectory = `${ADAPTIVE_PROFILE_VERSION}-${request.sourceFingerprint.slice(0, 16)}`;
  const finalVersionRoot = path.join(mediaRoot, versionDirectory);

  try {
    // A deterministic version directory that already validates is simply
    // re-pointed at rather than rebuilt, which is what makes `resume` cheap.
    const existing = await validateAdaptivePackage({
      versionRoot: finalVersionRoot,
      mediaId: request.mediaId,
      sourceFingerprint: request.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      ffprobePath,
      ffmpegPath,
      ...(signal ? { signal } : {}),
    }).catch(() => null);
    if (existing?.ok) {
      await mkdir(mediaRoot, { recursive: true });
      await writeAdaptivePointer(
        mediaRoot,
        versionDirectory,
        request.sourceFingerprint,
      );
      return {
        ...base,
        status: "already-valid",
        versionDirectory,
        ...(existing.metadata
          ? { storageBytes: existing.metadata.storage.totalBytes }
          : {}),
      };
    }

    if (verifySourceFingerprint) {
      const { computeSourceFingerprint } = await import("../registry");
      const sourceStats = await stat(request.sourcePath);
      const current = await computeSourceFingerprint(
        request.sourcePath,
        sourceStats,
      );
      if (current !== request.sourceFingerprint) {
        throw new Error(
          "Source changed after analysis; run analysis again before packaging.",
        );
      }
    }

    const probe =
      request.probe ??
      (await probeMediaFile(request.sourcePath, ffprobePath, signal));
    if (!(probe.durationSeconds > 0)) {
      return {
        ...base,
        status: "incompatible",
        error: "The source does not report a positive duration.",
      };
    }

    const requirements = buildRenditionRequirements(probe.video);
    if (requirements.length === 0) {
      return {
        ...base,
        status: "incompatible",
        error:
          "The source is not meaningfully larger than the smallest ladder rung, so no adaptive variants would be produced.",
      };
    }

    const audioPlan = planAudioRenditions(probe, { allTracks: allAudioTracks });
    if (audioPlan.outputs.length === 0) {
      return {
        ...base,
        status: "incompatible",
        error:
          "The source has no audio stream, which an adaptive package requires.",
      };
    }

    const preserveHdr = probe.video.isHdr;
    const encoder = preserveHdr
      ? (hdrVideoEncoder ??
        (await resolveVideoEncoder(
          encoderPreference,
          ffmpegPath,
          "hevc",
          true,
          signal,
        )))
      : (videoEncoder ??
        (await resolveVideoEncoder(
          encoderPreference,
          ffmpegPath,
          "h264",
          false,
          signal,
        )));
    const codecFamily = codecFamilyForEncoder(encoder);
    const hdr: RenditionHdrSignal | undefined = preserveHdr
      ? {
          colorPrimaries: probe.video.colorPrimaries ?? "bt2020",
          colorTransfer: probe.video.colorTransfer ?? "smpte2084",
          colorSpace: probe.video.colorSpace ?? "bt2020nc",
        }
      : undefined;

    const estimate = estimateAdaptivePackageBytes({
      durationSeconds: probe.durationSeconds,
      qualityHeights: requirements.map(
        (requirement) => requirement.qualityHeight,
      ),
      codecFamily,
      audioTrackCount: audioPlan.outputs.length,
    });

    // Preflight accounts for the package being built while the previous one is
    // still on disk: both exist between promotion and an explicit cleanup.
    const drive = await driveSpaceProvider();
    const conservativeBytes = Math.ceil(
      estimate.totalBytes * (1 + DEFAULT_STORAGE_SAFETY_MARGIN) * 2,
    );
    if (drive.freeBytes - conservativeBytes < reserveBytes) {
      return {
        ...base,
        status: "deferred-for-storage",
        error:
          "Packaging this title alongside its existing output would breach the configured free-space reserve.",
      };
    }

    const videoOutputs: AdaptiveVideoOutput[] = requirements.map(
      (requirement) => ({
        qualityHeight: requirement.qualityHeight,
        width: requirement.width,
        height: requirement.height,
      }),
    );
    const gopFrameRate =
      Math.max(probe.video.frameRate ?? 0, probe.video.maxFrameRate ?? 0) ||
      undefined;

    const workVersionRoot = path.join(
      paths.workRoot,
      request.mediaId,
      `${versionDirectory}.${process.pid}-${randomUUID().slice(0, 8)}.partial`,
    );
    await rm(workVersionRoot, { recursive: true, force: true });
    for (const directory of adaptiveOutputDirectories({
      videoOutputs,
      audioOutputs: audioPlan.outputs,
    })) {
      await mkdir(path.join(workVersionRoot, ...directory.split("/")), {
        recursive: true,
      });
    }

    onEvent?.({
      type: "encode-start",
      mediaId: request.mediaId,
      qualities: videoOutputs.map((output) => output.qualityHeight),
      encoder,
      hdr: preserveHdr,
      tonemapHdr: false,
      durationSeconds: probe.durationSeconds,
    });

    const args = buildAdaptivePackageFfmpegArgs({
      inputPath: request.sourcePath,
      // FFmpeg's `%v` templates are joined with forward slashes regardless of
      // platform, so the output root is normalised to POSIX separators here.
      outputRoot: workVersionRoot.split(path.sep).join("/"),
      videoOutputs,
      audioOutputs: audioPlan.outputs,
      encoder,
      ...(hdr ? { hdr } : {}),
      // The GOP is sized from the ceiling rate, not the average. `-g` counts
      // frames; on a variable-rate source an average-derived count elapses
      // sooner than two seconds of presentation time and inserts keyframes at
      // positions the forced-keyframe expression never chose — which is how a
      // ladder ends up with random-access points its own segment boundaries
      // disagree with.
      ...(gopFrameRate === undefined ? {} : { frameRate: gopFrameRate }),
      segmentSeconds,
      preset,
    });

    try {
      await runEncoder(ffmpegPath, args, {
        ...(signal ? { signal } : {}),
        logPath: path.join(paths.logsRoot, `${request.mediaId}.adaptive.log`),
        ...(onEvent
          ? {
              onProgress: (progress) =>
                onEvent({
                  type: "encode-progress",
                  mediaId: request.mediaId,
                  durationSeconds: probe.durationSeconds,
                  ...progress,
                }),
            }
          : {}),
      });
    } catch (error) {
      await rm(workVersionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (signal?.aborted) return { ...base, status: "interrupted" };
      throw error;
    }

    if (signal?.aborted) {
      await rm(workVersionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      return { ...base, status: "interrupted" };
    }

    // FFmpeg's master is read only for its codec strings, which it derives from
    // the real bitstream, and is then replaced by one carrying measured
    // bandwidth and the signalling the muxer does not emit.
    const generatedMasterPath = path.join(
      workVersionRoot,
      ADAPTIVE_MASTER_PLAYLIST,
    );
    const generatedCodecs = parseCodecsFromGeneratedMaster(
      await readFile(generatedMasterPath, "utf8"),
    );

    const videoCodecStrings = new Map<string, string>();
    const audioCodecStrings = new Map<string, string>();
    const videoRenditions: AdaptiveVideoRenditionMetadata[] = [];
    const audioRenditions: AdaptiveAudioRenditionMetadata[] = [];
    let videoBytes = 0;
    let audioBytes = 0;

    for (const output of videoOutputs) {
      const id = videoRenditionId(output.qualityHeight);
      const playlistPath = `${ADAPTIVE_VIDEO_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`;
      const mediaRelativePath = `${ADAPTIVE_VIDEO_DIRECTORY}/${id}/${ADAPTIVE_MEDIA_FILE}`;
      const absolutePlaylist = path.join(
        workVersionRoot,
        ...playlistPath.split("/"),
      );
      const absoluteMedia = path.join(
        workVersionRoot,
        ...mediaRelativePath.split("/"),
      );

      const measured = measureBitrates(
        await readFile(absolutePlaylist, "utf8"),
      );
      const packaged = await probePackagedVideo(
        absoluteMedia,
        ffprobePath,
        signal,
      );
      const mediaStats = await stat(absoluteMedia);
      videoBytes += mediaStats.size;

      const codecs = generatedCodecs.get(playlistPath);
      const videoCodec = codecs?.split(",")[0]?.trim();
      if (!videoCodec) {
        throw new Error(
          `FFmpeg did not report a codec string for ${id}; the package cannot advertise it.`,
        );
      }
      videoCodecStrings.set(id, videoCodec);

      videoRenditions.push({
        id,
        qualityHeight: output.qualityHeight,
        width: packaged.width,
        height: packaged.height,
        codec: codecFamily,
        codecString: videoCodec,
        ...(packaged.profile ? { profile: packaged.profile } : {}),
        ...(packaged.level ? { level: packaged.level } : {}),
        pixelFormat: packaged.pixelFormat,
        hdr: hdrStateFor(probe),
        ...(packaged.colorPrimaries
          ? { colorPrimaries: packaged.colorPrimaries }
          : {}),
        ...(packaged.colorTransfer
          ? { colorTransfer: packaged.colorTransfer }
          : {}),
        ...(packaged.colorSpace ? { colorSpace: packaged.colorSpace } : {}),
        frameRate: packaged.frameRate,
        averageBitrate: measured.averageBitrate,
        peakBitrate: measured.peakBitrate,
        durationSeconds: measured.durationSeconds,
        playlistPath,
        mediaPath: mediaRelativePath,
        fileSizeBytes: mediaStats.size,
        keyframeCount: packaged.keyframeTimes.length,
        keyframeIntervalSeconds: keyframeSummary(
          packaged.keyframeTimes,
          segmentSeconds,
        ),
        segmentCount: measured.segmentCount,
      });

      onEvent?.({
        type: "quality-ready",
        mediaId: request.mediaId,
        qualityHeight: output.qualityHeight,
        width: packaged.width,
        height: packaged.height,
        fileSize: mediaStats.size,
        reused: false,
      });
    }

    for (const output of audioPlan.outputs) {
      const id = audioRenditionId(output.sourceStreamIndex);
      const playlistPath = `${ADAPTIVE_AUDIO_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`;
      const mediaRelativePath = `${ADAPTIVE_AUDIO_DIRECTORY}/${id}/${ADAPTIVE_MEDIA_FILE}`;
      const absolutePlaylist = path.join(
        workVersionRoot,
        ...playlistPath.split("/"),
      );
      const absoluteMedia = path.join(
        workVersionRoot,
        ...mediaRelativePath.split("/"),
      );

      const measured = measureBitrates(
        await readFile(absolutePlaylist, "utf8"),
      );
      const packaged = await probePackagedAudio(
        absoluteMedia,
        ffprobePath,
        signal,
      );
      const mediaStats = await stat(absoluteMedia);
      audioBytes += mediaStats.size;
      const codecString = audioCodecString(packaged);
      audioCodecStrings.set(id, codecString);

      const sourceTrack = probe.audioTracks.find(
        (track) => track.streamIndex === output.sourceStreamIndex,
      );

      audioRenditions.push({
        id,
        sourceStreamIndex: output.sourceStreamIndex,
        ...(sourceTrack?.language ? { language: sourceTrack.language } : {}),
        ...(sourceTrack?.title ? { title: sourceTrack.title } : {}),
        isDefault: output.isDefault,
        isForced: output.isForced,
        codec: "aac",
        codecString,
        channels: packaged.channels,
        sampleRate: packaged.sampleRate,
        averageBitrate: measured.averageBitrate,
        durationSeconds: measured.durationSeconds,
        playlistPath,
        mediaPath: mediaRelativePath,
        fileSizeBytes: mediaStats.size,
        streamCopied: output.action === "copy",
      });
    }

    await writeFile(
      generatedMasterPath,
      buildMasterPlaylist({
        videoRenditions,
        audioRenditions,
        videoCodecStrings,
        audioCodecStrings,
      }),
      "utf8",
    );

    const display = getDisplayDimensions(probe.video);
    const metadata: AdaptivePackageMetadata = {
      schemaVersion: ADAPTIVE_METADATA_SCHEMA_VERSION,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      mediaId: request.mediaId,
      sourceFingerprint: request.sourceFingerprint,
      createdAt: new Date().toISOString(),
      sourceDurationSeconds: probe.durationSeconds,
      source: {
        width: display.width,
        height: display.height,
        qualityHeight: classifyQualityHeight(probe.video),
        codec: probe.video.codec,
        ...(probe.video.frameRate === undefined
          ? {}
          : { frameRate: probe.video.frameRate }),
        isHdr: probe.video.isHdr,
        isVariableFrameRate: isVariableFrameRate(probe),
        rotation: probe.video.rotation,
      },
      segmentTargetSeconds: segmentSeconds,
      switchingSetDurationSeconds: Math.max(
        ...videoRenditions.map((rendition) => rendition.durationSeconds),
      ),
      masterPlaylistPath: ADAPTIVE_MASTER_PLAYLIST,
      videoRenditions,
      audioRenditions,
      validation: {
        validatedAt: new Date().toISOString(),
        alignmentToleranceSeconds:
          (probe.video.frameRate ? 1 / probe.video.frameRate : 1 / 30) +
          ALIGNMENT_EPSILON_SECONDS,
        audioDurationToleranceSeconds: AUDIO_DURATION_TOLERANCE_SECONDS,
        checks: [],
      },
      storage: {
        videoBytes,
        audioBytes,
        totalBytes: videoBytes + audioBytes,
      },
      ...(audioPlan.deferred.length > 0
        ? { deferredAudioStreamIndexes: audioPlan.deferred }
        : {}),
    };

    await writeFile(
      path.join(workVersionRoot, ADAPTIVE_METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );

    const validation = await validateAdaptivePackage({
      versionRoot: workVersionRoot,
      mediaId: request.mediaId,
      sourceFingerprint: request.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      ffprobePath,
      ffmpegPath,
      deep: true,
      ...(signal ? { signal } : {}),
    });

    if (!validation.ok) {
      // A package that cannot prove alignment is never promoted. The legacy
      // package, if any, keeps playing untouched.
      await rm(workVersionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      return {
        ...base,
        status: "validation-failed",
        error: "The packaged ladder did not pass validation and was discarded.",
        issues: validation.issues.map(
          (issue) => `${issue.rendition}/${issue.stage}: ${issue.message}`,
        ),
      };
    }

    // The record of what was checked is written into the immutable manifest, so
    // a package carries the evidence of its own validation.
    metadata.validation.checks = validation.checks;
    metadata.validation.validatedAt = new Date().toISOString();
    await writeFile(
      path.join(workVersionRoot, ADAPTIVE_METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );

    await mkdir(mediaRoot, { recursive: true });
    await rm(finalVersionRoot, { recursive: true, force: true });
    await rename(workVersionRoot, finalVersionRoot);

    // Re-validated after promotion: if anything altered the package between the
    // work-directory check and publication, the pointer must not be written.
    const promoted = await validateAdaptivePackage({
      versionRoot: finalVersionRoot,
      mediaId: request.mediaId,
      sourceFingerprint: request.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      ffprobePath,
      ffmpegPath,
      ...(signal ? { signal } : {}),
    });
    if (!promoted.ok) {
      return {
        ...base,
        status: "validation-failed",
        error:
          "The package failed re-validation after promotion, so it was not activated.",
        issues: promoted.issues.map(
          (issue) => `${issue.rendition}/${issue.stage}: ${issue.message}`,
        ),
      };
    }

    await writeAdaptivePointer(
      mediaRoot,
      versionDirectory,
      request.sourceFingerprint,
    );
    await rm(path.dirname(workVersionRoot), {
      recursive: true,
      force: true,
    }).catch(() => undefined);

    return {
      ...base,
      status: "ready",
      versionDirectory,
      storageBytes: metadata.storage.totalBytes,
    };
  } catch (error) {
    return {
      ...base,
      status: signal?.aborted ? "interrupted" : "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await lock.release();
  }
}
