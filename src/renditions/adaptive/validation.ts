/**
 * Strict validation of a packaged adaptive rendition set.
 *
 * A package is either provably correct or it is not activated. There is no
 * middle state, because the failure mode of a nearly-correct adaptive package
 * is not an error message — it is a viewer whose picture freezes for a few
 * seconds every time the ladder moves, with nothing in any log to say why.
 *
 * Two rules shape the checks below:
 *
 *  - Nothing is trusted because the encoder was asked for it. Every claim in
 *    the manifest is re-derived from the packaged bytes and compared.
 *  - Error messages name the media id, the rendition, the stage and the
 *    measured discrepancy, and contain no absolute filesystem path, because
 *    they are surfaced to operators through interfaces that also reach clients.
 */

import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { sourceFrameDurationSeconds } from "../../lib/playback-planner/gopPolicy";
import {
  parseAdaptiveMetadata,
  type AdaptivePackageMetadata,
  type AdaptiveVideoRenditionMetadata,
} from "./metadata";
import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  type ParsedMediaPlaylist,
} from "./playlist";
import {
  probePackagedAudio,
  probePackagedVideo,
  type PackagedVideoProbe,
} from "./probePackaged";
import {
  ADAPTIVE_MEDIA_FILE,
  ADAPTIVE_METADATA_FILE,
  ALIGNMENT_EPSILON_SECONDS,
  AUDIO_DURATION_TOLERANCE_SECONDS,
  VIDEO_DURATION_TOLERANCE_SECONDS,
} from "./profile";

export interface AdaptiveValidationIssue {
  mediaId: string;
  /** Rendition id, or `package` for whole-package checks. */
  rendition: string;
  stage: string;
  message: string;
}

export interface AdaptiveValidationResult {
  ok: boolean;
  /** Names of the checks that passed, recorded into the manifest. */
  checks: string[];
  issues: AdaptiveValidationIssue[];
  metadata?: AdaptivePackageMetadata;
}

export interface AdaptiveValidationOptions {
  versionRoot: string;
  mediaId: string;
  sourceFingerprint?: string;
  profileVersion?: string;
  ffprobePath?: string;
  ffmpegPath?: string;
  /**
   * Decode-level checks: seek points and cross-rendition splice accuracy.
   * Skipped by the read-only inspection the playback path performs on every
   * session, which must stay cheap, and always run by the CLI validator.
   */
  deep?: boolean;
  signal?: AbortSignal;
}

class ValidationCollector {
  readonly issues: AdaptiveValidationIssue[] = [];
  readonly checks: string[] = [];

  constructor(private readonly mediaId: string) {}

  add(rendition: string, stage: string, message: string): void {
    this.issues.push({ mediaId: this.mediaId, rendition, stage, message });
  }

  pass(check: string): void {
    if (!this.checks.includes(check)) this.checks.push(check);
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

/**
 * Resolves a package-relative path and proves it stays inside the version
 * directory even after symlinks are followed.
 *
 * The manifest parser already rejects traversal syntax, so this is the second
 * of two independent barriers: it catches the case the parser structurally
 * cannot, which is a well-formed relative path whose real target has been
 * redirected outside the package since it was written.
 */
async function resolveInsidePackage(
  versionRoot: string,
  relativePath: string,
): Promise<string | null> {
  const candidate = path.resolve(versionRoot, ...relativePath.split("/"));
  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(versionRoot),
      realpath(candidate),
    ]);
    const normalise = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    const root = normalise(realRoot);
    const target = normalise(realCandidate);
    return target === root || target.startsWith(`${root}${path.sep}`)
      ? realCandidate
      : null;
  } catch {
    return null;
  }
}

async function readPackageFile(
  versionRoot: string,
  relativePath: string,
): Promise<string | null> {
  const resolved = await resolveInsidePackage(versionRoot, relativePath);
  if (!resolved) return null;
  try {
    return await readFile(resolved, "utf8");
  } catch {
    return null;
  }
}

/** Byte offsets of the first sample of every segment, derived from the playlist. */
function segmentStartTimes(playlist: ParsedMediaPlaylist): number[] {
  const starts: number[] = [];
  let elapsed = 0;
  for (const segment of playlist.segments) {
    starts.push(elapsed);
    elapsed += segment.durationSeconds;
  }
  return starts;
}

function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (
      error?: Error,
      value?: { code: number; stderr: string; stdout: string },
    ) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as { code: number; stderr: string; stdout: string });
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("Validation process was cancelled."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, 1024 * 1024);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      finish(undefined, { code: code ?? -1, stderr, stdout }),
    );
  });
}

/**
 * Writes `init + segments` from one rendition into a standalone fMP4.
 *
 * This is the shape a Media Source buffer holds after a quality change: the
 * initialization for the rendition being switched to, followed by that
 * rendition's segments from the switch point onwards. Reconstructing it on disk
 * is what lets a decoder be pointed at the exact splice the browser will make.
 */
async function extractSegmentSlice(
  mediaPath: string,
  playlist: ParsedMediaPlaylist,
  fromSegment: number,
  segmentCount: number,
  destination: string,
): Promise<void> {
  const handle = await open(mediaPath, "r");
  try {
    const parts: Buffer[] = [];
    const readRange = async (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error("Byte range read short of its declared length.");
      }
      return buffer;
    };

    parts.push(
      await readRange(
        playlist.map.byteRange.offset,
        playlist.map.byteRange.length,
      ),
    );
    for (
      let index = fromSegment;
      index < Math.min(fromSegment + segmentCount, playlist.segments.length);
      index += 1
    ) {
      const segment = playlist.segments[index];
      parts.push(
        await readRange(segment.byteRange.offset, segment.byteRange.length),
      );
    }
    await writeFile(destination, Buffer.concat(parts));
  } finally {
    await handle.close();
  }
}

async function firstPresentationTime(
  ffprobePath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const { code, stdout } = await runProcess(
    ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time,flags",
      "-of",
      "csv=p=0",
      "-read_intervals",
      "%+#1",
      filePath,
    ],
    signal,
  );
  if (code !== 0) return null;
  const first = stdout.split(/\r?\n/).find((line) => line.trim() !== "");
  if (!first) return null;
  const [time, flags] = first.split(",");
  const parsed = Number(time);
  if (!Number.isFinite(parsed)) return null;
  // A slice that does not begin on a keyframe is not independently decodable,
  // which is the whole property being tested.
  return flags?.includes("K") ? parsed : null;
}

async function decodes(
  ffmpegPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const { code } = await runProcess(
    ffmpegPath,
    ["-hide_banner", "-v", "error", "-i", filePath, "-f", "null", "-"],
    signal,
  );
  return code === 0;
}

function compareVideoAgainstMetadata(
  collector: ValidationCollector,
  rendition: AdaptiveVideoRenditionMetadata,
  probe: PackagedVideoProbe,
): void {
  const stage = "video-properties";
  if (probe.codec !== rendition.codec) {
    collector.add(
      rendition.id,
      stage,
      `codec is ${probe.codec}, metadata records ${rendition.codec}.`,
    );
  }
  if (probe.width !== rendition.width || probe.height !== rendition.height) {
    collector.add(
      rendition.id,
      stage,
      `dimensions are ${probe.width}x${probe.height}, metadata records ${rendition.width}x${rendition.height}.`,
    );
  }
  if (probe.pixelFormat !== rendition.pixelFormat) {
    collector.add(
      rendition.id,
      stage,
      `pixel format is ${probe.pixelFormat}, metadata records ${rendition.pixelFormat}.`,
    );
  }
  if (Math.abs(probe.frameRate - rendition.frameRate) > 0.01) {
    collector.add(
      rendition.id,
      stage,
      `frame rate is ${round(probe.frameRate)}, metadata records ${round(rendition.frameRate)}.`,
    );
  }

  if (rendition.hdr === "sdr") return;

  const hdrStage = "hdr-signalling";
  const expectedTransfer =
    rendition.hdr === "hdr10" ? "smpte2084" : "arib-std-b67";
  if ((probe.colorTransfer ?? "").toLowerCase() !== expectedTransfer) {
    collector.add(
      rendition.id,
      hdrStage,
      `colour transfer is ${probe.colorTransfer ?? "unset"}, expected ${expectedTransfer}.`,
    );
  }
  if (
    rendition.colorPrimaries &&
    (probe.colorPrimaries ?? "").toLowerCase() !==
      rendition.colorPrimaries.toLowerCase()
  ) {
    collector.add(
      rendition.id,
      hdrStage,
      `colour primaries are ${probe.colorPrimaries ?? "unset"}, metadata records ${rendition.colorPrimaries}.`,
    );
  }
  if (
    rendition.colorSpace &&
    (probe.colorSpace ?? "").toLowerCase() !==
      rendition.colorSpace.toLowerCase()
  ) {
    collector.add(
      rendition.id,
      hdrStage,
      `colour matrix is ${probe.colorSpace ?? "unset"}, metadata records ${rendition.colorSpace}.`,
    );
  }
  if (!probe.pixelFormat.includes("10")) {
    collector.add(
      rendition.id,
      hdrStage,
      `pixel format ${probe.pixelFormat} is not 10-bit, which an HDR rendition must be.`,
    );
  }
  if (probe.codecTag !== "hvc1") {
    collector.add(
      rendition.id,
      hdrStage,
      `codec tag is ${probe.codecTag || "unset"}, not hvc1; Safari refuses hev1-tagged media.`,
    );
  }
}

export async function validateAdaptivePackage({
  versionRoot,
  mediaId,
  sourceFingerprint,
  profileVersion,
  ffprobePath = process.env.FFPROBE_PATH ??
    process.env.SEYIRLIK_FFPROBE_PATH ??
    "ffprobe",
  ffmpegPath = process.env.FFMPEG_PATH ??
    process.env.SEYIRLIK_FFMPEG_PATH ??
    "ffmpeg",
  deep = false,
  signal,
}: AdaptiveValidationOptions): Promise<AdaptiveValidationResult> {
  const collector = new ValidationCollector(mediaId);

  const metadataText = await readPackageFile(
    versionRoot,
    ADAPTIVE_METADATA_FILE,
  );
  if (metadataText === null) {
    collector.add(
      "package",
      "metadata",
      "metadata.json is missing or unreadable.",
    );
    return { ok: false, checks: collector.checks, issues: collector.issues };
  }

  let metadata: AdaptivePackageMetadata;
  try {
    metadata = parseAdaptiveMetadata(JSON.parse(metadataText), {
      mediaId,
      ...(sourceFingerprint ? { sourceFingerprint } : {}),
      ...(profileVersion ? { profileVersion } : {}),
    });
  } catch (error) {
    collector.add(
      "package",
      "metadata",
      error instanceof Error ? error.message : String(error),
    );
    return { ok: false, checks: collector.checks, issues: collector.issues };
  }
  collector.pass("metadata-schema");

  // 1 & 20. The master must exist, parse, and resolve inside the package.
  const masterText = await readPackageFile(
    versionRoot,
    metadata.masterPlaylistPath,
  );
  if (masterText === null) {
    collector.add(
      "package",
      "master-playlist",
      `${metadata.masterPlaylistPath} is missing, unreadable, or resolves outside the package.`,
    );
    return {
      ok: false,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }

  try {
    const master = parseMasterPlaylist(masterText);
    if (!master.independentSegments) {
      collector.add(
        "package",
        "master-playlist",
        "master playlist does not declare #EXT-X-INDEPENDENT-SEGMENTS.",
      );
    }
    const declaredVariants = new Set(
      master.variants.map((variant) => variant.uri),
    );
    for (const rendition of metadata.videoRenditions) {
      if (!declaredVariants.has(rendition.playlistPath)) {
        collector.add(
          rendition.id,
          "master-playlist",
          `master playlist does not reference ${rendition.playlistPath}.`,
        );
      }
    }
    const declaredAudio = new Set(
      master.audioRenditions.map((entry) => entry.uri),
    );
    for (const rendition of metadata.audioRenditions) {
      if (!declaredAudio.has(rendition.playlistPath)) {
        collector.add(
          rendition.id,
          "master-playlist",
          `master playlist does not reference ${rendition.playlistPath}.`,
        );
      }
    }
    for (const variant of master.variants) {
      if (!variant.audioGroup) {
        collector.add(
          "package",
          "master-playlist",
          `variant ${variant.uri} has no AUDIO group, so it carries no sound.`,
        );
      }
    }
    collector.pass("master-playlist");
  } catch (error) {
    collector.add(
      "package",
      "master-playlist",
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: false,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }

  const frameTolerance =
    sourceFrameDurationSeconds(metadata.source.frameRate) +
    ALIGNMENT_EPSILON_SECONDS;

  interface LoadedRendition {
    id: string;
    playlist: ParsedMediaPlaylist;
    mediaPath: string;
    rendition: AdaptiveVideoRenditionMetadata;
    probe?: PackagedVideoProbe;
  }
  const loadedVideo: LoadedRendition[] = [];

  // 2-7. Playlists parse, media files exist, sizes match, ranges stay inside.
  for (const rendition of metadata.videoRenditions) {
    const playlistText = await readPackageFile(
      versionRoot,
      rendition.playlistPath,
    );
    if (playlistText === null) {
      collector.add(
        rendition.id,
        "media-playlist",
        `${rendition.playlistPath} is missing, unreadable, or resolves outside the package.`,
      );
      continue;
    }
    let playlist: ParsedMediaPlaylist;
    try {
      playlist = parseMediaPlaylist(playlistText);
    } catch (error) {
      collector.add(
        rendition.id,
        "media-playlist",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    if (!playlist.independentSegments) {
      collector.add(
        rendition.id,
        "media-playlist",
        "media playlist does not declare #EXT-X-INDEPENDENT-SEGMENTS.",
      );
    }
    if (playlist.map.uri !== ADAPTIVE_MEDIA_FILE) {
      collector.add(
        rendition.id,
        "media-playlist",
        `#EXT-X-MAP points at ${playlist.map.uri}, not ${ADAPTIVE_MEDIA_FILE}.`,
      );
    }
    if (
      playlist.segments.some((segment) => segment.uri !== ADAPTIVE_MEDIA_FILE)
    ) {
      collector.add(
        rendition.id,
        "media-playlist",
        `a segment references a file other than ${ADAPTIVE_MEDIA_FILE}.`,
      );
    }
    if (playlist.segments.length !== rendition.segmentCount) {
      collector.add(
        rendition.id,
        "media-playlist",
        `playlist has ${playlist.segments.length} segments, metadata records ${rendition.segmentCount}.`,
      );
    }

    const mediaPath = await resolveInsidePackage(
      versionRoot,
      rendition.mediaPath,
    );
    if (!mediaPath) {
      collector.add(
        rendition.id,
        "media-file",
        `${rendition.mediaPath} is missing or resolves outside the package.`,
      );
      continue;
    }
    const stats = await stat(mediaPath).catch(() => null);
    if (!stats?.isFile() || stats.size === 0) {
      collector.add(
        rendition.id,
        "media-file",
        "media file is missing or empty.",
      );
      continue;
    }
    if (stats.size !== rendition.fileSizeBytes) {
      collector.add(
        rendition.id,
        "media-file",
        `media file is ${stats.size} bytes, metadata records ${rendition.fileSizeBytes}; the file changed after validation.`,
      );
      continue;
    }

    // 4 & 5. Every declared range, including the init range, must lie wholly
    // inside the file the playlist names.
    if (
      playlist.map.byteRange.offset + playlist.map.byteRange.length >
      stats.size
    ) {
      collector.add(
        rendition.id,
        "byte-ranges",
        `#EXT-X-MAP range ${playlist.map.byteRange.offset}+${playlist.map.byteRange.length} exceeds the ${stats.size}-byte media file.`,
      );
    }
    for (const [index, segment] of playlist.segments.entries()) {
      const end = segment.byteRange.offset + segment.byteRange.length;
      if (end > stats.size) {
        collector.add(
          rendition.id,
          "byte-ranges",
          `segment ${index} range ${segment.byteRange.offset}+${segment.byteRange.length} exceeds the ${stats.size}-byte media file.`,
        );
        break;
      }
    }

    loadedVideo.push({ id: rendition.id, playlist, mediaPath, rendition });
  }

  if (loadedVideo.length === 0) {
    collector.add(
      "package",
      "media-playlist",
      "no video rendition survived structural validation.",
    );
    return {
      ok: false,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }
  collector.pass("byte-ranges");
  collector.pass("media-playlists");

  // 8, 13, 14, 16, 19. Probe each rendition and compare against its claims.
  for (const entry of loadedVideo) {
    let probe: PackagedVideoProbe;
    try {
      probe = await probePackagedVideo(entry.mediaPath, ffprobePath, signal);
    } catch (error) {
      collector.add(
        entry.id,
        "probe",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    entry.probe = probe;
    compareVideoAgainstMetadata(collector, entry.rendition, probe);

    if (probe.keyframeTimes.length !== entry.rendition.keyframeCount) {
      collector.add(
        entry.id,
        "keyframes",
        `probe found ${probe.keyframeTimes.length} keyframes, metadata records ${entry.rendition.keyframeCount}.`,
      );
    }

    // 16. The playlist's declared timeline must match the samples it describes.
    const playlistDuration = entry.playlist.totalDurationSeconds;
    if (
      Math.abs(playlistDuration - probe.durationSeconds) >
      VIDEO_DURATION_TOLERANCE_SECONDS
    ) {
      collector.add(
        entry.id,
        "extinf-accuracy",
        `EXTINF durations sum to ${round(playlistDuration)}s but the media decodes to ${round(probe.durationSeconds)}s.`,
      );
    }

    // 13. Every segment must begin on a random-access frame.
    const baseTime = probe.keyframeTimes[0] ?? 0;
    const starts = segmentStartTimes(entry.playlist);
    for (const [index, start] of starts.entries()) {
      const wanted = baseTime + start;
      const nearest = probe.keyframeTimes.reduce(
        (best, time) =>
          Math.abs(time - wanted) < Math.abs(best - wanted) ? time : best,
        Number.POSITIVE_INFINITY,
      );
      if (Math.abs(nearest - wanted) > frameTolerance) {
        collector.add(
          entry.id,
          "segment-keyframe-start",
          `segment ${index} starts at ${round(wanted)}s but the nearest keyframe is at ${round(nearest)}s, ${round(Math.abs(nearest - wanted))}s away (tolerance ${round(frameTolerance)}s).`,
        );
        break;
      }
    }

    // 15. Keyframes must advance monotonically at roughly the target interval.
    for (let index = 1; index < probe.keyframeTimes.length; index += 1) {
      const gap = probe.keyframeTimes[index] - probe.keyframeTimes[index - 1];
      if (gap <= 0) {
        collector.add(
          entry.id,
          "timestamp-continuity",
          `keyframe ${index} at ${round(probe.keyframeTimes[index])}s does not advance past the previous one.`,
        );
        break;
      }
    }
  }

  const probed = loadedVideo.filter(
    (entry): entry is LoadedRendition & { probe: PackagedVideoProbe } =>
      entry.probe !== undefined,
  );
  if (probed.length !== loadedVideo.length) {
    return {
      ok: false,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }
  collector.pass("video-properties");
  collector.pass("segment-keyframe-start");
  collector.pass("extinf-accuracy");
  collector.pass("timestamp-continuity");

  // 10 & 12. Every video rendition must describe the same timeline, segment for
  // segment. This is the property that makes a mid-playback switch invisible.
  const reference = probed[0];
  for (const entry of probed.slice(1)) {
    if (entry.playlist.segments.length !== reference.playlist.segments.length) {
      collector.add(
        entry.id,
        "segment-alignment",
        `has ${entry.playlist.segments.length} segments but ${reference.id} has ${reference.playlist.segments.length}.`,
      );
      continue;
    }
    const referenceStarts = segmentStartTimes(reference.playlist);
    const entryStarts = segmentStartTimes(entry.playlist);
    for (let index = 0; index < entryStarts.length; index += 1) {
      const drift = Math.abs(entryStarts[index] - referenceStarts[index]);
      if (drift > frameTolerance) {
        collector.add(
          entry.id,
          "segment-alignment",
          `segment ${index} starts at ${round(entryStarts[index])}s but ${reference.id} starts it at ${round(referenceStarts[index])}s, a drift of ${round(drift)}s (tolerance ${round(frameTolerance)}s).`,
        );
        break;
      }
    }
    const durationDrift = Math.abs(
      entry.playlist.totalDurationSeconds -
        reference.playlist.totalDurationSeconds,
    );
    if (durationDrift > VIDEO_DURATION_TOLERANCE_SECONDS) {
      collector.add(
        entry.id,
        "switching-set-duration",
        `covers ${round(entry.playlist.totalDurationSeconds)}s but ${reference.id} covers ${round(reference.playlist.totalDurationSeconds)}s.`,
      );
    }

    // 14. Keyframe instants themselves, not merely the boundaries derived from
    // EXTINF, must line up.
    const referenceBase = reference.probe.keyframeTimes[0] ?? 0;
    const entryBase = entry.probe.keyframeTimes[0] ?? 0;
    const shared = Math.min(
      entry.probe.keyframeTimes.length,
      reference.probe.keyframeTimes.length,
    );
    for (let index = 0; index < shared; index += 1) {
      const drift = Math.abs(
        entry.probe.keyframeTimes[index] -
          entryBase -
          (reference.probe.keyframeTimes[index] - referenceBase),
      );
      if (drift > frameTolerance) {
        collector.add(
          entry.id,
          "keyframe-alignment",
          `keyframe ${index} is ${round(drift)}s away from the matching keyframe in ${reference.id} (tolerance ${round(frameTolerance)}s).`,
        );
        break;
      }
    }
  }
  collector.pass("segment-alignment");
  collector.pass("keyframe-alignment");
  collector.pass("switching-set-duration");

  // 9 & 11. Audio must match its metadata and cover the same content.
  for (const rendition of metadata.audioRenditions) {
    const playlistText = await readPackageFile(
      versionRoot,
      rendition.playlistPath,
    );
    if (playlistText === null) {
      collector.add(
        rendition.id,
        "audio-playlist",
        `${rendition.playlistPath} is missing, unreadable, or resolves outside the package.`,
      );
      continue;
    }
    let playlist: ParsedMediaPlaylist;
    try {
      playlist = parseMediaPlaylist(playlistText);
    } catch (error) {
      collector.add(
        rendition.id,
        "audio-playlist",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }

    const mediaPath = await resolveInsidePackage(
      versionRoot,
      rendition.mediaPath,
    );
    if (!mediaPath) {
      collector.add(
        rendition.id,
        "audio-media-file",
        `${rendition.mediaPath} is missing or resolves outside the package.`,
      );
      continue;
    }
    const stats = await stat(mediaPath).catch(() => null);
    if (!stats?.isFile() || stats.size === 0) {
      collector.add(
        rendition.id,
        "audio-media-file",
        "audio media file is missing or empty.",
      );
      continue;
    }
    if (stats.size !== rendition.fileSizeBytes) {
      collector.add(
        rendition.id,
        "audio-media-file",
        `audio media file is ${stats.size} bytes, metadata records ${rendition.fileSizeBytes}.`,
      );
      continue;
    }
    if (
      playlist.map.byteRange.offset + playlist.map.byteRange.length >
        stats.size ||
      playlist.segments.some(
        (segment) =>
          segment.byteRange.offset + segment.byteRange.length > stats.size,
      )
    ) {
      collector.add(
        rendition.id,
        "audio-byte-ranges",
        `a declared byte range exceeds the ${stats.size}-byte audio media file.`,
      );
      continue;
    }

    try {
      const probe = await probePackagedAudio(mediaPath, ffprobePath, signal);
      if (probe.codec !== rendition.codec) {
        collector.add(
          rendition.id,
          "audio-properties",
          `codec is ${probe.codec}, metadata records ${rendition.codec}.`,
        );
      }
      if (probe.channels !== rendition.channels) {
        collector.add(
          rendition.id,
          "audio-properties",
          `has ${probe.channels} channels, metadata records ${rendition.channels}.`,
        );
      }
      if (probe.sampleRate !== rendition.sampleRate) {
        collector.add(
          rendition.id,
          "audio-properties",
          `sample rate is ${probe.sampleRate}Hz, metadata records ${rendition.sampleRate}Hz.`,
        );
      }
      const coverageDrift = Math.abs(
        probe.durationSeconds - reference.playlist.totalDurationSeconds,
      );
      if (coverageDrift > AUDIO_DURATION_TOLERANCE_SECONDS) {
        collector.add(
          rendition.id,
          "audio-video-coverage",
          `covers ${round(probe.durationSeconds)}s but the video switching set covers ${round(reference.playlist.totalDurationSeconds)}s, a difference of ${round(coverageDrift)}s.`,
        );
      }
    } catch (error) {
      collector.add(
        rendition.id,
        "audio-probe",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  collector.pass("audio-properties");
  collector.pass("audio-video-coverage");

  if (!deep) {
    return {
      ok: collector.ok,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }

  // 17 & 18. Decode-level proof. Slices are reconstructed the way a Media
  // Source buffer holds them after a switch — the target rendition's own
  // initialization followed by its segments from the splice point — and each
  // must decode and begin exactly at the boundary the ladder shares.
  const workDirectory = await mkdtemp(
    path.join(tmpdir(), "seyirlik-adaptive-check-"),
  );
  try {
    const segmentTotal = reference.playlist.segments.length;
    const probePoints = [
      0,
      Math.floor(segmentTotal / 2),
      Math.max(0, segmentTotal - 2),
    ].filter((value, index, all) => all.indexOf(value) === index);

    for (const entry of probed) {
      const starts = segmentStartTimes(entry.playlist);
      const base = entry.probe.keyframeTimes[0] ?? 0;
      for (const point of probePoints) {
        const slicePath = path.join(
          workDirectory,
          `${entry.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${point}.mp4`,
        );
        try {
          await extractSegmentSlice(
            entry.mediaPath,
            entry.playlist,
            point,
            2,
            slicePath,
          );
        } catch (error) {
          collector.add(
            entry.id,
            "seek-decode",
            `could not read the byte ranges for segment ${point}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        if (!(await decodes(ffmpegPath, slicePath, signal))) {
          collector.add(
            entry.id,
            "seek-decode",
            `the slice starting at segment ${point} (${round(starts[point])}s) does not decode independently.`,
          );
          continue;
        }
        const firstTime = await firstPresentationTime(
          ffprobePath,
          slicePath,
          signal,
        );
        if (firstTime === null) {
          collector.add(
            entry.id,
            "seek-decode",
            `the slice starting at segment ${point} does not begin on a random-access frame.`,
          );
          continue;
        }
        const expected = base + starts[point];
        if (Math.abs(firstTime - expected) > frameTolerance) {
          collector.add(
            entry.id,
            "seek-decode",
            `the slice starting at segment ${point} begins at ${round(firstTime)}s, ${round(Math.abs(firstTime - expected))}s from the ${round(expected)}s the playlist promises.`,
          );
        }
        await rm(slicePath, { force: true });
      }
    }
    collector.pass("seek-decode");

    // A cross-quality switch is two independently decodable slices meeting at
    // one instant. Proving both sides start at the same presentation time — and
    // that each decodes on its own — is what makes the splice sample-accurate.
    if (probed.length > 1) {
      const splicePoint = Math.max(1, Math.floor(segmentTotal / 2));
      const spliceTimes: Array<{ id: string; time: number }> = [];
      for (const entry of probed) {
        const slicePath = path.join(
          workDirectory,
          `splice-${entry.id.replace(/[^A-Za-z0-9_-]/g, "_")}.mp4`,
        );
        await extractSegmentSlice(
          entry.mediaPath,
          entry.playlist,
          splicePoint,
          2,
          slicePath,
        );
        if (!(await decodes(ffmpegPath, slicePath, signal))) {
          collector.add(
            entry.id,
            "cross-quality-splice",
            `the segment-${splicePoint} slice does not decode on its own, so a switch into this rendition would stall.`,
          );
          continue;
        }
        const firstTime = await firstPresentationTime(
          ffprobePath,
          slicePath,
          signal,
        );
        if (firstTime === null) {
          collector.add(
            entry.id,
            "cross-quality-splice",
            `the segment-${splicePoint} slice does not begin on a random-access frame.`,
          );
          continue;
        }
        const base = entry.probe.keyframeTimes[0] ?? 0;
        spliceTimes.push({ id: entry.id, time: firstTime - base });
        await rm(slicePath, { force: true });
      }
      for (const candidate of spliceTimes.slice(1)) {
        const drift = Math.abs(candidate.time - spliceTimes[0].time);
        if (drift > frameTolerance) {
          collector.add(
            candidate.id,
            "cross-quality-splice",
            `enters segment ${splicePoint} at ${round(candidate.time)}s but ${spliceTimes[0].id} enters it at ${round(spliceTimes[0].time)}s, a drift of ${round(drift)}s.`,
          );
        }
      }
      collector.pass("cross-quality-splice");
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  return {
    ok: collector.ok,
    checks: collector.checks,
    issues: collector.issues,
    metadata,
  };
}

export function formatValidationIssue(issue: AdaptiveValidationIssue): string {
  return `${issue.mediaId}\t${issue.rendition}\t${issue.stage}\t${issue.message}`;
}
