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
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SEGMENT_TARGET_SECONDS } from "../../lib/playback-planner/gopPolicy";
import { UNKNOWN_LANGUAGE } from "../processing/languages";
import type { PauseController } from "../processing/pauseController";
import type { SidecarSubtitle } from "./sidecarSubtitles";
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
  deliveryChannelsFor,
  type AdaptiveAudioOutput,
  type AdaptiveVideoOutput,
} from "./encoding";
import type {
  AdaptiveAudioRenditionMetadata,
  AdaptiveHdrState,
  AdaptivePackageMetadata,
  AdaptiveSubtitleRenditionMetadata,
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
  ADAPTIVE_PROFILE_VERSION,
  ADAPTIVE_SUBTITLE_DIRECTORY,
  ADAPTIVE_SUBTITLE_FILE,
  ADAPTIVE_VIDEO_DIRECTORY,
  ALIGNMENT_EPSILON_SECONDS,
  AUDIO_DURATION_TOLERANCE_SECONDS,
  audioRenditionId,
  subtitleRenditionId,
  videoRenditionId,
} from "./profile";
import { frameRateForClass } from "./layout";
import {
  publishAdditionalRenditions,
  publishTitlePackage,
  readTitleBuildRecord,
  readTitlePackageManifest,
  type TitlePackageManifest,
} from "./publishTitle";
import { validateAdaptivePackage } from "./validation";
import { createOutputMeter } from "../outputMeter";
import {
  planPackageWork,
  type PackageWorkPlan,
  type RenditionPresence,
} from "./incrementalPlan";
import { buildWebVttMediaPlaylist, extractWebVttFile } from "./subtitles";

/**
 * Whether a title still holds every file its manifest names.
 *
 * A manifest alone is not proof: a half-deleted folder would otherwise be
 * reported as current and then fail on the first request.
 */
/**
 * Which published renditions are individually intact.
 *
 * `titlePackageFilesPresent` answers for the package as a whole, which is the
 * right question when deciding whether to skip everything and the wrong one
 * when deciding what to build: a single truncated rendition would condemn the
 * other seven to a needless re-encode. This reports per rendition so the plan
 * can rebuild exactly the broken one.
 */
async function titleRenditionPresence(
  titleRoot: string,
  manifest: TitlePackageManifest,
): Promise<RenditionPresence> {
  const intact = async (relatives: readonly string[]): Promise<boolean> => {
    for (const relative of relatives) {
      const stats = await stat(
        path.join(titleRoot, ...relative.split("/")),
      ).catch(() => undefined);
      if (!stats?.isFile() || stats.size === 0) return false;
    }
    return true;
  };
  const collect = async (
    renditions: readonly {
      id: string;
      mediaPath: string;
      playlistPath: string;
    }[],
  ): Promise<Set<string>> => {
    const present = new Set<string>();
    for (const rendition of renditions) {
      if (await intact([rendition.mediaPath, rendition.playlistPath])) {
        present.add(rendition.id);
      }
    }
    return present;
  };
  return {
    video: await collect(manifest.video),
    audio: await collect(manifest.audio),
    subtitle: await collect(manifest.subtitle),
  };
}

/**
 * A matching source/profile is not enough to skip packaging: the ladder can
 * gain a rung without invalidating the renditions already on disk. In that
 * case the package is still playable, but it is not complete for today's
 * policy and must go through the encoder.
 */
export function titlePackageCoversVideoLadder(
  manifest: { video: readonly { qualityHeight: number }[] },
  requirements: readonly { qualityHeight: number }[],
): boolean {
  const present = new Set(
    manifest.video.map((rendition) => rendition.qualityHeight),
  );
  return requirements.every((requirement) =>
    present.has(requirement.qualityHeight),
  );
}

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
  /**
   * Bytes this run actually produced, as against `storageBytes` which is the
   * whole published package. They are the same for a full build and very
   * different for an incremental one — a job that added a single rung must not
   * report the size of the seven it reused.
   */
  jobOutputBytes?: number;
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
  /** Source audio stream indexes the retention policy chose, in order. */
  audioStreamIndexes?: readonly number[];
  /** Text subtitle stream indexes the retention policy chose for WebVTT. */
  subtitleStreamIndexes?: readonly number[];
  /**
   * Suspends the encoder while paused instead of killing it, so a pause keeps
   * the work already done rather than costing the whole ladder.
   */
  pauseController?: PauseController;
  /**
   * Subtitle files sitting beside the source that the policy chose to package.
   *
   * Most of this library is subtitled this way rather than in-container, so a
   * packager that only reads embedded streams publishes titles with no
   * subtitles at all in a language it was told to retain.
   */
  sidecarSubtitles?: readonly SidecarSubtitle[];
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
      pauseController?: PauseController;
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
  {
    allTracks = false,
    streamIndexes,
  }: {
    allTracks?: boolean;
    /**
     * Exactly which source tracks to package, decided by the retention policy.
     *
     * Takes precedence over `allTracks`. The policy knows which language is the
     * source default and which duplicates to drop; the packager only has to
     * carry out that decision. An index the source does not have is ignored
     * rather than failing the encode.
     */
    streamIndexes?: readonly number[];
  } = {},
): { outputs: AdaptiveAudioOutput[]; deferred: number[] } {
  const tracks = probe.audioTracks;
  if (tracks.length === 0) {
    return { outputs: [], deferred: [] };
  }
  const defaultTrack = tracks.find((track) => track.isDefault) ?? tracks[0];
  // Mapped in the order the policy asked for, not the order the container
  // stores them in: the first rendition becomes the package default, and that
  // has to be the track the policy chose as the source's own default.
  const requested = streamIndexes
    ? streamIndexes
        .map((index) => tracks.find((track) => track.streamIndex === index))
        .filter(
          (track): track is (typeof tracks)[number] => track !== undefined,
        )
    : undefined;
  const selected =
    requested && requested.length > 0
      ? requested
      : allTracks
        ? tracks
        : [defaultTrack];
  const deferred = tracks
    .filter((track) => !selected.includes(track))
    .map((track) => track.streamIndex);

  const outputs = selected.map<AdaptiveAudioOutput>((track) => {
    const channels = track.channels ?? 2;
    // The rate follows the layout that is actually delivered, not the source
    // one, so a downmixed 7.1 track is not paid for at 7.1 rates.
    const deliveryChannels = deliveryChannelsFor(channels);
    return {
      sourceStreamIndex: track.streamIndex,
      action: canStreamCopyAudio({ codec: track.codec, channels })
        ? "copy"
        : "transcode",
      channels: deliveryChannels,
      bitrate: deliveryChannels > 2 ? 256_000 : 192_000,
      ...(track.language ? { language: track.language } : {}),
      ...(track.title ? { title: track.title } : {}),
      isDefault:
        track.streamIndex === (selected[0] ?? defaultTrack).streamIndex,
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
    pauseController?: PauseController;
  },
): Promise<void> {
  const { runFfmpeg } = await import("../processor");
  return runFfmpeg(command, args, options);
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
    audioStreamIndexes,
    subtitleStreamIndexes = [],
    sidecarSubtitles = [],
    pauseController,
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

  const versionDirectory = `${ADAPTIVE_PROFILE_VERSION}-${request.sourceFingerprint.slice(0, 16)}`;

  try {
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
          "The source does not report usable video dimensions, so no ladder can be built from it.",
      };
    }

    /*
     * A title that already holds a package built from these exact bytes under
     * this exact profile and containing every rung required today is left
     * alone. This is what makes `resume` cheap without mistaking an older,
     * shorter ladder for a complete one.
     */
    const existingTitleRoot = path.dirname(request.sourcePath);
    const existing = await readTitlePackageManifest(existingTitleRoot);
    const presence: RenditionPresence = existing
      ? await titleRenditionPresence(existingTitleRoot, existing)
      : { video: new Set(), audio: new Set(), subtitle: new Set() };

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

    const audioPlan = planAudioRenditions(probe, {
      allTracks: allAudioTracks,
      ...(audioStreamIndexes ? { streamIndexes: audioStreamIndexes } : {}),
    });
    if (audioPlan.outputs.length === 0) {
      return {
        ...base,
        status: "incompatible",
        error:
          "The source has no audio stream, which an adaptive package requires.",
      };
    }

    /*
     * What actually has to be built, per rendition.
     *
     * Everything below encodes from `work`, never from `requirements`. That is
     * the whole fix: the desired ladder describes the finished package, while
     * this describes the outstanding job, and handing the first to the encoder
     * is what rebuilt seven good renditions to obtain an eighth.
     */
    const work: PackageWorkPlan = planPackageWork({
      requirements,
      existing,
      presence,
      sourceFingerprint: request.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      requiredAudioStreamIndexes: audioPlan.outputs.map(
        (output) => output.sourceStreamIndex,
      ),
      requiredSubtitleStreamIndexes: [
        ...subtitleStreamIndexes,
        // Sidecar files are published as subtitle renditions like any other,
        // so they are reusable on the same terms.
        ...sidecarSubtitles.map((sidecar) => sidecar.streamIndex),
      ],
    });

    if (work.mode === "none" && existing) {
      return {
        ...base,
        status: "already-valid",
        versionDirectory,
        storageBytes: existing.storage.totalBytes,
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

    /*
     * What *this run* will write, not what the finished package will hold.
     *
     * Both the free-space preflight and the job's progress reporting read this,
     * and estimating a whole ladder for a one-rung job overstated both: the
     * preflight reserved space for eight renditions that were not being made,
     * and the page showed the full package size under a heading that says what
     * the encoder has produced so far.
     */
    const estimate = estimateAdaptivePackageBytes({
      durationSeconds: probe.durationSeconds,
      qualityHeights: work.videoQualityHeights,
      codecFamily,
      audioTrackCount: work.audioStreamIndexes.length,
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

    const sourceFrameRate =
      probe.video.frameRate && probe.video.frameRate > 0
        ? probe.video.frameRate
        : undefined;
    /*
     * Only the rungs the plan asked for. `requirements` still describes the
     * finished ladder — the estimate and the published manifest need that —
     * but the filter graph, the encoders and the variant map are all derived
     * from this list, so a one-rung job produces one scaler and one encoder.
     */
    const plannedRequirements = requirements.filter((requirement) =>
      work.videoQualityHeights.includes(requirement.qualityHeight),
    );
    const videoOutputs: AdaptiveVideoOutput[] = plannedRequirements.map(
      (requirement) => {
        const rate = frameRateForClass(
          requirement.qualityHeight,
          sourceFrameRate,
        );
        return {
          qualityHeight: requirement.qualityHeight,
          width: requirement.width,
          height: requirement.height,
          // Only carried when it actually differs: a rung at the source's own
          // rate must not gain an `fps` filter that would resample a timeline
          // that is already correct.
          ...(rate !== undefined &&
          sourceFrameRate !== undefined &&
          rate < sourceFrameRate - 0.01
            ? { frameRate: rate }
            : {}),
        };
      },
    );
    const gopFrameRate =
      Math.max(probe.video.frameRate ?? 0, probe.video.maxFrameRate ?? 0) ||
      undefined;

    /*
     * Audio is asked for separately from video. Adding a video rung must not
     * re-encode sound that is already published and intact — that transcode is
     * pure waste and it rewrites a track the viewer is currently using.
     */
    const plannedAudioOutputs = audioPlan.outputs.filter((output) =>
      work.audioStreamIndexes.includes(output.sourceStreamIndex),
    );
    const plannedSubtitleStreamIndexes = subtitleStreamIndexes.filter(
      (streamIndex) => work.subtitleStreamIndexes.includes(streamIndex),
    );
    const plannedSidecarSubtitles = sidecarSubtitles.filter((sidecar) =>
      work.subtitleStreamIndexes.includes(sidecar.streamIndex),
    );

    const workVersionRoot = path.join(
      paths.workRoot,
      request.mediaId,
      `${versionDirectory}.${process.pid}-${randomUUID().slice(0, 8)}.partial`,
    );
    await rm(workVersionRoot, { recursive: true, force: true });
    for (const directory of adaptiveOutputDirectories({
      videoOutputs,
      audioOutputs: plannedAudioOutputs,
    })) {
      await mkdir(path.join(workVersionRoot, ...directory.split("/")), {
        recursive: true,
      });
    }
    for (const streamIndex of [
      ...plannedSubtitleStreamIndexes,
      // Sidecars are extracted in the same place as embedded tracks and so
      // need their directories made here too, not only the embedded ones.
      ...plannedSidecarSubtitles.map((sidecar) => sidecar.streamIndex),
    ]) {
      await mkdir(
        path.join(
          workVersionRoot,
          ADAPTIVE_SUBTITLE_DIRECTORY,
          subtitleRenditionId(streamIndex),
        ),
        { recursive: true },
      );
    }

    /*
     * Exactly the media files this run will write — one per rendition being
     * encoded. An incremental job measures only what it is producing, never
     * the renditions it is reusing.
     */
    const outputMeter = createOutputMeter(
      adaptiveOutputDirectories({
        videoOutputs,
        audioOutputs: plannedAudioOutputs,
      }).map((directory) =>
        path.join(workVersionRoot, ...directory.split("/"), ADAPTIVE_MEDIA_FILE),
      ),
    );

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
      audioOutputs: plannedAudioOutputs,
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
        ...(pauseController ? { pauseController } : {}),
        logPath: path.join(paths.logsRoot, `${request.mediaId}.adaptive.log`),
        ...(onEvent
          ? {
              onProgress: (progress) => {
                /*
                 * FFmpeg reports `total_size=N/A` for HLS, so `progress` never
                 * carries a byte count here and the measured figure replaces
                 * it. The sample is fired and forgotten — the progress stream
                 * must not wait on the filesystem — so the value emitted is
                 * whichever measurement last landed.
                 */
                outputMeter.sample();
                const writtenBytes = outputMeter.latest();
                onEvent({
                  type: "encode-progress",
                  mediaId: request.mediaId,
                  durationSeconds: probe.durationSeconds,
                  ...progress,
                  ...(writtenBytes === undefined ? {} : { writtenBytes }),
                });
              },
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
    const subtitleRenditions: AdaptiveSubtitleRenditionMetadata[] = [];
    let videoBytes = 0;
    let audioBytes = 0;
    let subtitleBytes = 0;

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

    for (const output of plannedAudioOutputs) {
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
        ...(sourceTrack?.isOriginal === undefined
          ? {}
          : { isOriginal: sourceTrack.isOriginal }),
        ...(sourceTrack?.isCommentary === undefined
          ? {}
          : { isCommentary: sourceTrack.isCommentary }),
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

    for (const streamIndex of plannedSubtitleStreamIndexes) {
      const sourceTrack = probe.subtitleTracks.find(
        (track) => track.streamIndex === streamIndex && track.isTextBased,
      );
      if (!sourceTrack) continue;
      const id = subtitleRenditionId(streamIndex);
      const playlistPath = `${ADAPTIVE_SUBTITLE_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`;
      const subtitlePath = `${ADAPTIVE_SUBTITLE_DIRECTORY}/${id}/${ADAPTIVE_SUBTITLE_FILE}`;
      const absoluteSubtitle = path.join(
        workVersionRoot,
        ...subtitlePath.split("/"),
      );
      const extracted = await extractWebVttFile({
        ffmpegPath,
        inputPath: request.sourcePath,
        streamIndex,
        outputPath: absoluteSubtitle,
        ...(signal ? { signal } : {}),
      });
      await writeFile(
        path.join(workVersionRoot, ...playlistPath.split("/")),
        buildWebVttMediaPlaylist(probe.durationSeconds, ADAPTIVE_SUBTITLE_FILE),
        "utf8",
      );
      subtitleBytes += extracted.fileSizeBytes;
      subtitleRenditions.push({
        id,
        sourceStreamIndex: streamIndex,
        ...(sourceTrack.language ? { language: sourceTrack.language } : {}),
        ...(sourceTrack.title ? { title: sourceTrack.title } : {}),
        isDefault: sourceTrack.isDefault,
        isForced: sourceTrack.isForced,
        isHearingImpaired: sourceTrack.isHearingImpaired,
        codec: "webvtt",
        durationSeconds: probe.durationSeconds,
        playlistPath,
        subtitlePath,
        fileSizeBytes: extracted.fileSizeBytes,
      });
    }

    /*
     * Subtitles that live beside the source rather than inside it. They are
     * converted the same way, differing only in that each is its own input file
     * and so is always that file's stream 0.
     */
    for (const sidecar of plannedSidecarSubtitles) {
      const id = subtitleRenditionId(sidecar.streamIndex);
      const playlistPath = `${ADAPTIVE_SUBTITLE_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`;
      const subtitlePath = `${ADAPTIVE_SUBTITLE_DIRECTORY}/${id}/${ADAPTIVE_SUBTITLE_FILE}`;
      const absoluteSubtitle = path.join(
        workVersionRoot,
        ...subtitlePath.split("/"),
      );
      let extracted: { fileSizeBytes: number };
      try {
        extracted = await extractWebVttFile({
          ffmpegPath,
          inputPath: sidecar.filePath,
          streamIndex: 0,
          outputPath: absoluteSubtitle,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        /*
         * A malformed or mis-encoded sidecar must not fail the whole package —
         * the title is still worth publishing without that one translation —
         * but it must not vanish either. Swallowing this silently is how a
         * wiring mistake reads as "this library simply has no subtitles".
         */
        console.warn(
          `[seyirlik] ${request.relativePath}: skipped sidecar subtitle ${
            sidecar.fileName
          } — ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      await writeFile(
        path.join(workVersionRoot, ...playlistPath.split("/")),
        buildWebVttMediaPlaylist(probe.durationSeconds, ADAPTIVE_SUBTITLE_FILE),
        "utf8",
      );
      subtitleBytes += extracted.fileSizeBytes;
      subtitleRenditions.push({
        id,
        sourceStreamIndex: sidecar.streamIndex,
        ...(sidecar.language !== UNKNOWN_LANGUAGE
          ? { language: sidecar.language }
          : {}),
        isDefault: false,
        isForced: sidecar.isForced,
        isHearingImpaired: sidecar.isHearingImpaired,
        codec: "webvtt",
        durationSeconds: probe.durationSeconds,
        playlistPath,
        subtitlePath,
        fileSizeBytes: extracted.fileSizeBytes,
      });
    }

    await writeFile(
      generatedMasterPath,
      buildMasterPlaylist({
        videoRenditions,
        audioRenditions,
        subtitleRenditions,
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
      subtitleRenditions,
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
        subtitleBytes,
        totalBytes: videoBytes + audioBytes + subtitleBytes,
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
      // An incremental run's work directory holds only what it built, which is
      // video alone whenever the published audio is being reused.
      allowMissingAudio: audioRenditions.length === 0,
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
        // The issues, not just the verdict: a package that fails validation is
        // discarded, so this message is the only surviving evidence of why.
        error: `The packaged ladder did not pass validation and was discarded: ${validation.issues
          .map((issue) =>
            [issue.rendition, issue.stage].filter(Boolean).length > 0
              ? `${[issue.rendition, issue.stage].filter(Boolean).join("/")}: ${issue.message}`
              : issue.message,
          )
          .slice(0, 6)
          .join("; ")}`,
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

    /*
     * The package lives with the title it belongs to, not in a parallel tree
     * keyed by an opaque id. It is published only after it has proven itself in
     * the work directory, and publication never touches the source file: the
     * original is read throughout and is still there afterwards.
     */
    const titleRoot = path.dirname(request.sourcePath);
    /*
     * An incremental run must not swap the package's directories: the swap
     * carries away every rendition this job did not produce, which for a
     * one-rung job is the entire rest of the ladder. Its new files are written
     * in beside the existing ones instead, and only the master, manifest and
     * build record are replaced.
     */
    const existingBuildRecord =
      work.mode === "incremental"
        ? await readTitleBuildRecord(titleRoot)
        : null;
    const { manifest } = existingBuildRecord
      ? await publishAdditionalRenditions({
          workVersionRoot,
          titleRoot,
          existing: existingBuildRecord,
          added: metadata,
        })
      : await publishTitlePackage({
          workVersionRoot,
          titleRoot,
          metadata,
        });
    // The manifest describes the whole title, including renditions this run
    // reused, so it is the honest source for the package's own size.
    const publishedTotalBytes = manifest.storage.totalBytes;

    // Publication moves and rewrites; a file the manifest names but the folder
    // does not hold would be a package that reads as present and plays as
    // broken, so the manifest is checked against the disk it just described.
    const missing: string[] = [];
    for (const rendition of [
      ...manifest.video,
      ...manifest.audio,
      ...manifest.subtitle,
    ]) {
      for (const relative of [rendition.mediaPath, rendition.playlistPath]) {
        const stats = await stat(
          path.join(titleRoot, ...relative.split("/")),
        ).catch(() => undefined);
        if (!stats?.isFile() || stats.size === 0) missing.push(relative);
      }
    }
    if (missing.length > 0) {
      return {
        ...base,
        status: "validation-failed",
        error:
          "The published package is missing files its own manifest names, so it was not activated.",
        issues: missing,
      };
    }

    /*
     * No pointer is written into the rendition root any more: nothing lives
     * there. The title folder's own manifest is what says which package is
     * current, which keeps the answer next to the files it describes.
     */
    await rm(path.dirname(workVersionRoot), {
      recursive: true,
      force: true,
    }).catch(() => undefined);

    return {
      ...base,
      status: "ready",
      versionDirectory,
      // The published package, whether this run built all of it or one rung.
      storageBytes: publishedTotalBytes,
      // What this run itself wrote.
      jobOutputBytes: metadata.storage.totalBytes,
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
