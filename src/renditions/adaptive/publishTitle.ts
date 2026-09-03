import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { AdaptivePackageMetadata } from "./metadata";
import { buildMasterPlaylist } from "./playlist";
import { MASTER_LAYOUT_VERSION } from "./repairMaster";
import {
  safeFraction,
  type PublishPhaseProgress,
  type PublishStepId,
  type PublishStepProgress,
} from "./phaseProgress";
import {
  TITLE_AUDIO_DIRECTORY,
  TITLE_SUBTITLE_DIRECTORY,
  TITLE_VIDEO_DIRECTORY,
} from "./layout";
import {
  TITLE_MASTER_PLAYLIST,
  TITLE_PACKAGE_DIRECTORY,
  TITLE_PACKAGE_MANIFEST,
  TITLE_STAGING_PREFIX,
  type TitleLayoutPlan,
  planTitleLayout,
  playlistUri,
  rewriteMasterPlaylist,
  rewriteRenditionPlaylist,
} from "./titleLayout";

/**
 * Moving a validated package into the title's own folder.
 *
 * The package is built and proven somewhere else, then laid out here under the
 * names a person would expect. Publication is the only step that writes into
 * the library, and it never touches the source file — the original is read
 * throughout and is still there afterwards.
 */

export const TITLE_MANIFEST_SCHEMA_VERSION = 1;

/** The packager's own record of what it made and how it proved it. */
export const TITLE_BUILD_RECORD = "build.json";

export interface TitleManifestRendition {
  id: string;
  /** Path of the media file, relative to the title folder. */
  mediaPath: string;
  /** Path of the playlist, relative to the title folder. */
  playlistPath: string;
  fileSizeBytes: number;
}

export interface TitleVideoRendition extends TitleManifestRendition {
  qualityHeight: number;
  width: number;
  height: number;
  codec: "h264" | "hevc";
  codecString: string;
  frameRate: number;
  hdr: string;
  averageBitrate: number;
  peakBitrate: number;
}

export interface TitleAudioRendition extends TitleManifestRendition {
  sourceStreamIndex: number;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  codecString: string;
  channels: number;
}

export interface TitleSubtitleRendition extends TitleManifestRendition {
  sourceStreamIndex: number;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
}

/**
 * What a title folder says about its own package.
 *
 * Deliberately separate from the packager's build manifest: that one describes
 * a work directory whose layout is fixed and machine shaped, and its validator
 * is right to insist on it. This one describes where things ended up in a
 * library folder, which is a different question with different answers.
 */
export interface TitlePackageManifest {
  schemaVersion: number;
  profileVersion: string;
  sourceFingerprint: string;
  createdAt: string;
  sourceDurationSeconds: number;
  /** Relative to the title folder. */
  masterPlaylistPath: string;
  video: TitleVideoRendition[];
  audio: TitleAudioRendition[];
  subtitle: TitleSubtitleRendition[];
  storage: { totalBytes: number };
}

/**
 * Moves one file, falling back to a copy across filesystems.
 *
 * The work directory is often on a different volume from the library — that is
 * the point of having a separate work root — and `rename` cannot cross one.
 */
async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await unlink(from).catch(() => undefined);
  }
}

function absolute(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

export interface PublishTitlePackageInput {
  /** The validated package, in the packager's own work layout. */
  workVersionRoot: string;
  /** The folder the source file lives in. */
  titleRoot: string;
  metadata: AdaptivePackageMetadata;
  /**
   * Called as each publication step finishes.
   *
   * Publication is usually renames within one filesystem and over in seconds —
   * but when the work directory is on a different volume from the library every
   * byte of the package is copied, and a job that sat silent for ten minutes at
   * "publishing" looked hung. The steps are weighted by the bytes they move so
   * the reported position means the same thing in both cases.
   */
  onProgress?: (progress: PublishPhaseProgress) => void;
}

/**
 * A reporter over the fixed list of steps publication performs.
 *
 * The list is derived from the package being published, so it names only work
 * that will actually happen: a title with no subtitles has no subtitle step.
 */
export function createPublishReporter(
  steps: readonly { id: PublishStepId; bytes?: number }[],
  onProgress: ((progress: PublishPhaseProgress) => void) | undefined,
) {
  const state = new Map<PublishStepId, PublishStepProgress["state"]>(
    steps.map((step) => [step.id, "waiting" as const]),
  );
  const totalBytes = steps.reduce((sum, step) => sum + (step.bytes ?? 0), 0);

  const emit = (currentId?: PublishStepId): void => {
    if (!onProgress) return;
    const list: PublishStepProgress[] = steps.map((step) => ({
      id: step.id,
      state: state.get(step.id) ?? "waiting",
      ...(step.bytes === undefined ? {} : { bytes: step.bytes }),
    }));
    const completedBytes = steps.reduce(
      (sum, step) =>
        sum + (state.get(step.id) === "complete" ? (step.bytes ?? 0) : 0),
      0,
    );
    onProgress({
      steps: list,
      totalBytes,
      completedBytes,
      fraction: safeFraction(completedBytes, totalBytes),
      ...(currentId === undefined ? {} : { currentId }),
    });
  };

  return {
    begin(id: PublishStepId): void {
      if (!state.has(id)) return;
      state.set(id, "running");
      emit(id);
    },
    complete(id: PublishStepId): void {
      if (!state.has(id)) return;
      state.set(id, "complete");
      emit();
    },
    /** Marks a step complete that another component performed. */
    finish(): void {
      emit();
    },
  };
}

export type PublishReporter = ReturnType<typeof createPublishReporter>;

export interface PublishTitlePackageResult {
  manifest: TitlePackageManifest;
  plan: TitleLayoutPlan;
}

/**
 * Publishes a package into its title folder, replacing any previous one.
 *
 * Everything is assembled in a staging directory beside the destination first,
 * so the swap at the end is a sequence of renames within one filesystem rather
 * than a folder that is half old and half new for the length of a copy.
 */
export async function publishTitlePackage({
  workVersionRoot,
  titleRoot,
  metadata,
  onProgress,
}: PublishTitlePackageInput): Promise<PublishTitlePackageResult> {
  const plan = planTitleLayout(metadata);
  /*
   * The steps, named before any of them runs. The media steps carry the bytes
   * they move; the small ones carry none, so a package that publishes by rename
   * still reports each stage passing rather than one long silence.
   */
  const progress = createPublishReporter(
    [
      ...(metadata.videoRenditions.length > 0
        ? [
            {
              id: "video" as const,
              bytes: metadata.videoRenditions.reduce(
                (sum, rendition) => sum + rendition.fileSizeBytes,
                0,
              ),
            },
          ]
        : []),
      ...(metadata.audioRenditions.length > 0
        ? [
            {
              id: "audio" as const,
              bytes: metadata.audioRenditions.reduce(
                (sum, rendition) => sum + rendition.fileSizeBytes,
                0,
              ),
            },
          ]
        : []),
      ...((metadata.subtitleRenditions?.length ?? 0) > 0
        ? [
            {
              id: "subtitles" as const,
              bytes: (metadata.subtitleRenditions ?? []).reduce(
                (sum, rendition) => sum + rendition.fileSizeBytes,
                0,
              ),
            },
          ]
        : []),
      { id: "master-playlist" as const },
      { id: "manifest" as const },
      { id: "build-record" as const },
      { id: "swap" as const },
    ],
    onProgress,
  );
  const staging = path.join(
    titleRoot,
    `${TITLE_STAGING_PREFIX}-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  await rm(staging, { recursive: true, force: true });

  const workPlaylistPathById = new Map<string, string>();
  for (const rendition of metadata.videoRenditions) {
    workPlaylistPathById.set(rendition.id, rendition.playlistPath);
  }
  for (const rendition of metadata.audioRenditions) {
    workPlaylistPathById.set(rendition.id, rendition.playlistPath);
  }
  for (const rendition of metadata.subtitleRenditions ?? []) {
    workPlaylistPathById.set(rendition.id, rendition.playlistPath);
  }

  try {
    const publishOne = async (
      published: { id: string; mediaPath: string; playlistPath: string },
      workMediaPath: string,
      workPlaylistPath: string,
    ) => {
      await moveFile(
        absolute(workVersionRoot, workMediaPath),
        absolute(staging, published.mediaPath),
      );
      const playlist = await readFile(
        absolute(workVersionRoot, workPlaylistPath),
        "utf8",
      );
      const target = absolute(staging, published.playlistPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        rewriteRenditionPlaylist(
          playlist,
          // Every URI in a byte-range playlist names the one media file, by its
          // bare filename rather than by any path.
          path.posix.basename(workMediaPath),
          published.mediaPath,
        ),
        "utf8",
      );
    };

    const video: TitleVideoRendition[] = [];
    progress.begin("video");
    for (const [index, rendition] of metadata.videoRenditions.entries()) {
      const published = plan.video[index]!;
      await publishOne(published, rendition.mediaPath, rendition.playlistPath);
      video.push({
        id: rendition.id,
        mediaPath: published.mediaPath,
        playlistPath: published.playlistPath,
        fileSizeBytes: rendition.fileSizeBytes,
        qualityHeight: rendition.qualityHeight,
        width: rendition.width,
        height: rendition.height,
        codec: rendition.codec,
        codecString: rendition.codecString,
        frameRate: rendition.frameRate,
        hdr: rendition.hdr,
        averageBitrate: rendition.averageBitrate,
        peakBitrate: rendition.peakBitrate,
      });
    }

    progress.complete("video");
    const audio: TitleAudioRendition[] = [];
    progress.begin("audio");
    for (const [index, rendition] of metadata.audioRenditions.entries()) {
      const published = plan.audio[index]!;
      await publishOne(published, rendition.mediaPath, rendition.playlistPath);
      audio.push({
        id: rendition.id,
        mediaPath: published.mediaPath,
        playlistPath: published.playlistPath,
        fileSizeBytes: rendition.fileSizeBytes,
        sourceStreamIndex: rendition.sourceStreamIndex,
        ...(rendition.language ? { language: rendition.language } : {}),
        ...(rendition.title ? { title: rendition.title } : {}),
        isDefault: rendition.isDefault,
        isForced: rendition.isForced,
        codecString: rendition.codecString,
        channels: rendition.channels,
      });
    }

    progress.complete("audio");
    const subtitle: TitleSubtitleRendition[] = [];
    progress.begin("subtitles");
    for (const [index, rendition] of (
      metadata.subtitleRenditions ?? []
    ).entries()) {
      const published = plan.subtitle[index]!;
      await publishOne(
        published,
        rendition.subtitlePath,
        rendition.playlistPath,
      );
      subtitle.push({
        id: rendition.id,
        mediaPath: published.mediaPath,
        playlistPath: published.playlistPath,
        fileSizeBytes: rendition.fileSizeBytes,
        sourceStreamIndex: rendition.sourceStreamIndex,
        ...(rendition.language ? { language: rendition.language } : {}),
        ...(rendition.title ? { title: rendition.title } : {}),
        isDefault: rendition.isDefault,
        isForced: rendition.isForced,
        isHearingImpaired: rendition.isHearingImpaired,
      });
    }

    progress.complete("subtitles");

    progress.begin("master-playlist");
    const master = await readFile(
      absolute(workVersionRoot, metadata.masterPlaylistPath),
      "utf8",
    );
    await writeFile(
      absolute(staging, plan.masterPlaylistPath),
      rewriteMasterPlaylist(master, plan, workPlaylistPathById),
      "utf8",
    );
    progress.complete("master-playlist");
    progress.begin("manifest");

    const manifest: TitlePackageManifest = {
      schemaVersion: TITLE_MANIFEST_SCHEMA_VERSION,
      profileVersion: metadata.profileVersion,
      sourceFingerprint: metadata.sourceFingerprint,
      createdAt: metadata.createdAt,
      sourceDurationSeconds: metadata.sourceDurationSeconds,
      masterPlaylistPath: plan.masterPlaylistPath,
      video,
      audio,
      subtitle,
      storage: { totalBytes: metadata.storage.totalBytes },
    };
    await writeFile(
      absolute(staging, plan.manifestPath),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    progress.complete("manifest");
    progress.begin("build-record");

    /*
     * The build record travels with the package it describes: which checks the
     * validator ran, the measured keyframe cadence, the bitrates actually
     * achieved. `package.json` is what the server reads to serve; this is what
     * a person reads to understand what was made and how it was proven.
     */
    const publishedById = new Map<string, string>();
    for (const group of [plan.video, plan.audio, plan.subtitle]) {
      for (const rendition of group) {
        publishedById.set(rendition.id, rendition.mediaPath);
      }
    }
    const playlistById = new Map<string, string>();
    for (const group of [plan.video, plan.audio, plan.subtitle]) {
      for (const rendition of group) {
        playlistById.set(rendition.id, rendition.playlistPath);
      }
    }
    const buildRecord = {
      ...metadata,
      // Which master generator produced this playlist, so a later improvement
      // to it can be applied to the package without re-encoding media that is
      // already correct.
      masterLayoutVersion: MASTER_LAYOUT_VERSION,
      masterPlaylistPath: plan.masterPlaylistPath,
      videoRenditions: metadata.videoRenditions.map((rendition) => ({
        ...rendition,
        mediaPath: publishedById.get(rendition.id) ?? rendition.mediaPath,
        playlistPath: playlistById.get(rendition.id) ?? rendition.playlistPath,
      })),
      audioRenditions: metadata.audioRenditions.map((rendition) => ({
        ...rendition,
        mediaPath: publishedById.get(rendition.id) ?? rendition.mediaPath,
        playlistPath: playlistById.get(rendition.id) ?? rendition.playlistPath,
      })),
      subtitleRenditions: (metadata.subtitleRenditions ?? []).map(
        (rendition) => ({
          ...rendition,
          subtitlePath:
            publishedById.get(rendition.id) ?? rendition.subtitlePath,
          playlistPath:
            playlistById.get(rendition.id) ?? rendition.playlistPath,
        }),
      ),
    };
    await writeFile(
      absolute(staging, `${TITLE_PACKAGE_DIRECTORY}/${TITLE_BUILD_RECORD}`),
      `${JSON.stringify(buildRecord, null, 2)}\n`,
      "utf8",
    );

    progress.complete("build-record");
    progress.begin("swap");
    await swapPublishedDirectories(titleRoot, staging);
    progress.complete("swap");
    return { manifest, plan };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Replaces the previous package's folders with the staged ones.
 *
 * Each folder is swapped by rename, which is atomic within a filesystem, so a
 * reader never sees a folder that is half of one package and half of another.
 * A request already reading a file keeps reading it: the bytes outlive the name
 * that led to them.
 */
async function swapPublishedDirectories(
  titleRoot: string,
  staging: string,
): Promise<void> {
  const retired = `${staging}.retired`;
  await rm(retired, { recursive: true, force: true });
  await mkdir(retired, { recursive: true });

  for (const directory of [
    TITLE_VIDEO_DIRECTORY,
    TITLE_AUDIO_DIRECTORY,
    TITLE_SUBTITLE_DIRECTORY,
    TITLE_PACKAGE_DIRECTORY,
  ]) {
    const staged = path.join(staging, directory);
    const live = path.join(titleRoot, directory);
    const stagedExists = await pathExists(staged);
    if (!stagedExists) {
      // A package with no subtitles must still clear the previous package's
      // subtitle folder, or a dropped track keeps playing from a stale file.
      await rename(live, path.join(retired, directory)).catch(() => undefined);
      continue;
    }
    await rename(live, path.join(retired, directory)).catch(() => undefined);
    await rename(staged, live);
  }

  await rm(retired, { recursive: true, force: true }).catch(() => undefined);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Reads a title's package manifest, or null when the title has none. */
export async function readTitlePackageManifest(
  titleRoot: string,
): Promise<TitlePackageManifest | null> {
  try {
    const raw = await readFile(
      path.join(titleRoot, TITLE_PACKAGE_DIRECTORY, TITLE_PACKAGE_MANIFEST),
      "utf8",
    );
    const parsed = JSON.parse(raw) as TitlePackageManifest;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.schemaVersion !== TITLE_MANIFEST_SCHEMA_VERSION ||
      typeof parsed.masterPlaylistPath !== "string" ||
      !Array.isArray(parsed.video)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export { TITLE_MASTER_PLAYLIST };

/**
 * Adding renditions to a package that is already published, without replacing it.
 *
 * `publishTitlePackage` swaps whole directories, which is exactly right when a
 * package is being rebuilt and exactly wrong when one rendition is being added
 * to seven good ones: the swap would carry away every rendition this run did
 * not produce. So the new files are written in beside the existing ones and
 * only the three description files — master playlist, package manifest and
 * build record — are replaced, each by write-then-rename.
 *
 * The ordering matters for safety. Media lands first and is inert until
 * something references it; the master is rewritten last and atomically. A run
 * that dies part-way leaves an unreferenced file and a package that still
 * plays exactly as it did before.
 */
export async function publishAdditionalRenditions({
  workVersionRoot,
  titleRoot,
  existing,
  added,
  onProgress,
}: {
  workVersionRoot: string;
  titleRoot: string;
  /** The published package's own build record, read from disk. */
  existing: AdaptivePackageMetadata;
  /** Newly encoded renditions, in the packager's work layout. */
  added: Pick<
    AdaptivePackageMetadata,
    "videoRenditions" | "audioRenditions" | "subtitleRenditions"
  >;
  onProgress?: (progress: PublishPhaseProgress) => void;
}): Promise<{ manifest: TitlePackageManifest; plan: TitleLayoutPlan }> {
  /*
   * Existing renditions are listed first so the layout planner hands them the
   * stems they already carry: their published paths must come out unchanged,
   * because those files are staying exactly where they are. Anything the new
   * run rebuilt replaces the old entry of the same id.
   */
  const replaced = new Set([
    ...added.videoRenditions.map((rendition) => rendition.id),
    ...added.audioRenditions.map((rendition) => rendition.id),
    ...(added.subtitleRenditions ?? []).map((rendition) => rendition.id),
  ]);
  const merged: AdaptivePackageMetadata = {
    ...existing,
    videoRenditions: [
      ...existing.videoRenditions.filter(
        (rendition) => !replaced.has(rendition.id),
      ),
      ...added.videoRenditions,
    ].sort((left, right) => right.qualityHeight - left.qualityHeight),
    audioRenditions: [
      ...existing.audioRenditions.filter(
        (rendition) => !replaced.has(rendition.id),
      ),
      ...added.audioRenditions,
    ],
    subtitleRenditions: [
      ...(existing.subtitleRenditions ?? []).filter(
        (rendition) => !replaced.has(rendition.id),
      ),
      ...(added.subtitleRenditions ?? []),
    ],
  };

  const plan = planTitleLayout(merged);
  const publishedById = new Map<string, { media: string; playlist: string }>();
  for (const group of [plan.video, plan.audio, plan.subtitle]) {
    for (const entry of group) {
      publishedById.set(entry.id, {
        media: entry.mediaPath,
        playlist: entry.playlistPath,
      });
    }
  }

  // Media and its playlist, moved into the live package beside what is there.
  const moveIn = async (rendition: {
    id: string;
    mediaPath: string;
    playlistPath: string;
  }) => {
    const target = publishedById.get(rendition.id);
    if (!target) return;
    const destinationMedia = path.join(titleRoot, ...target.media.split("/"));
    const destinationPlaylist = path.join(
      titleRoot,
      ...target.playlist.split("/"),
    );
    await mkdir(path.dirname(destinationMedia), { recursive: true });
    await mkdir(path.dirname(destinationPlaylist), { recursive: true });
    await moveFile(
      path.join(workVersionRoot, ...rendition.mediaPath.split("/")),
      destinationMedia,
    );
    const playlist = await readFile(
      path.join(workVersionRoot, ...rendition.playlistPath.split("/")),
      "utf8",
    );
    const pending = `${destinationPlaylist}.pending`;
    await writeFile(
      pending,
      rewriteRenditionPlaylist(
        playlist,
        path.posix.basename(rendition.mediaPath),
        target.media,
      ),
      "utf8",
    );
    await rename(pending, destinationPlaylist);
  };

  const bytesOf = (renditions: readonly { fileSizeBytes: number }[]) =>
    renditions.reduce((sum, rendition) => sum + rendition.fileSizeBytes, 0);
  const progress = createPublishReporter(
    [
      ...(added.videoRenditions.length > 0
        ? [{ id: "video" as const, bytes: bytesOf(added.videoRenditions) }]
        : []),
      ...(added.audioRenditions.length > 0
        ? [{ id: "audio" as const, bytes: bytesOf(added.audioRenditions) }]
        : []),
      ...((added.subtitleRenditions?.length ?? 0) > 0
        ? [
            {
              id: "subtitles" as const,
              bytes: bytesOf(added.subtitleRenditions ?? []),
            },
          ]
        : []),
      { id: "master-playlist" as const },
      { id: "manifest" as const },
      { id: "build-record" as const },
    ],
    onProgress,
  );

  progress.begin("video");
  for (const rendition of added.videoRenditions) await moveIn(rendition);
  progress.complete("video");
  progress.begin("audio");
  for (const rendition of added.audioRenditions) await moveIn(rendition);
  progress.complete("audio");
  progress.begin("subtitles");
  for (const rendition of added.subtitleRenditions ?? []) {
    await moveIn({
      id: rendition.id,
      mediaPath: rendition.subtitlePath,
      playlistPath: rendition.playlistPath,
    });
  }
  progress.complete("subtitles");
  progress.begin("master-playlist");

  /*
   * Rebuilt from the merged set rather than from whatever this run's FFmpeg
   * happened to emit, so the master describes every rendition the title holds
   * — including the seven this job never touched.
   */
  const republished = <T extends { id: string }>(
    renditions: readonly T[],
    pathKey: "mediaPath" | "subtitlePath",
  ) =>
    renditions.map((rendition) => {
      const target = publishedById.get(rendition.id);
      return {
        ...rendition,
        ...(target
          ? { [pathKey]: target.media, playlistPath: target.playlist }
          : {}),
      } as T;
    });

  const publishedMetadata: AdaptivePackageMetadata & {
    masterLayoutVersion: number;
  } = {
    ...merged,
    masterLayoutVersion: MASTER_LAYOUT_VERSION,
    masterPlaylistPath: plan.masterPlaylistPath,
    videoRenditions: republished(merged.videoRenditions, "mediaPath"),
    audioRenditions: republished(merged.audioRenditions, "mediaPath"),
    subtitleRenditions: republished(
      merged.subtitleRenditions ?? [],
      "subtitlePath",
    ),
  };

  const atomicWrite = async (relative: string, contents: string) => {
    const target = path.join(titleRoot, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const pending = `${target}.pending`;
    await writeFile(pending, contents, "utf8");
    await rename(pending, target);
  };

  const subtitles = publishedMetadata.subtitleRenditions ?? [];
  const totalBytes = [
    ...publishedMetadata.videoRenditions,
    ...publishedMetadata.audioRenditions,
    ...subtitles,
  ].reduce((total, rendition) => total + rendition.fileSizeBytes, 0);

  const manifest: TitlePackageManifest = {
    schemaVersion: TITLE_MANIFEST_SCHEMA_VERSION,
    profileVersion: publishedMetadata.profileVersion,
    sourceFingerprint: publishedMetadata.sourceFingerprint,
    createdAt: publishedMetadata.createdAt,
    sourceDurationSeconds: publishedMetadata.sourceDurationSeconds,
    masterPlaylistPath: plan.masterPlaylistPath,
    video: publishedMetadata.videoRenditions.map((rendition) => ({
      id: rendition.id,
      mediaPath: rendition.mediaPath,
      playlistPath: rendition.playlistPath,
      fileSizeBytes: rendition.fileSizeBytes,
      qualityHeight: rendition.qualityHeight,
      width: rendition.width,
      height: rendition.height,
      codec: rendition.codec,
      codecString: rendition.codecString,
      frameRate: rendition.frameRate,
      hdr: rendition.hdr,
      averageBitrate: rendition.averageBitrate,
      peakBitrate: rendition.peakBitrate,
    })),
    audio: publishedMetadata.audioRenditions.map((rendition) => ({
      id: rendition.id,
      mediaPath: rendition.mediaPath,
      playlistPath: rendition.playlistPath,
      fileSizeBytes: rendition.fileSizeBytes,
      sourceStreamIndex: rendition.sourceStreamIndex,
      ...(rendition.language ? { language: rendition.language } : {}),
      ...(rendition.title ? { title: rendition.title } : {}),
      isDefault: rendition.isDefault,
      isForced: rendition.isForced,
      codecString: rendition.codecString,
      channels: rendition.channels,
    })),
    subtitle: subtitles.map((rendition) => ({
      id: rendition.id,
      mediaPath: rendition.subtitlePath,
      playlistPath: rendition.playlistPath,
      fileSizeBytes: rendition.fileSizeBytes,
      sourceStreamIndex: rendition.sourceStreamIndex,
      ...(rendition.language ? { language: rendition.language } : {}),
      ...(rendition.title ? { title: rendition.title } : {}),
      isDefault: rendition.isDefault,
      isForced: rendition.isForced,
      isHearingImpaired: rendition.isHearingImpaired,
    })),
    storage: { totalBytes },
  };

  // The record describes the whole package, so its byte totals must count the
  // renditions this run reused as well as the ones it produced.
  const sumBytes = (renditions: readonly { fileSizeBytes: number }[]) =>
    renditions.reduce((total, rendition) => total + rendition.fileSizeBytes, 0);
  publishedMetadata.storage = {
    videoBytes: sumBytes(publishedMetadata.videoRenditions),
    audioBytes: sumBytes(publishedMetadata.audioRenditions),
    subtitleBytes: sumBytes(subtitles),
    totalBytes,
  };

  progress.begin("build-record");
  await atomicWrite(
    `${TITLE_PACKAGE_DIRECTORY}/${TITLE_BUILD_RECORD}`,
    `${JSON.stringify(publishedMetadata, null, 2)}\n`,
  );
  progress.complete("build-record");
  progress.begin("manifest");
  await atomicWrite(
    plan.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  progress.complete("manifest");
  // Last, so nothing advertises a rendition before its bytes are in place.
  await atomicWrite(
    plan.masterPlaylistPath,
    buildTitleMasterPlaylist(publishedMetadata),
  );
  progress.complete("master-playlist");

  return { manifest, plan };
}

/** The master a published package should carry, built from its own record. */
function buildTitleMasterPlaylist(metadata: AdaptivePackageMetadata): string {
  const relative = (published: string): string =>
    playlistUri(published.slice(TITLE_PACKAGE_DIRECTORY.length + 1));
  return buildMasterPlaylist({
    videoRenditions: metadata.videoRenditions.map((rendition) => ({
      ...rendition,
      playlistPath: relative(rendition.playlistPath),
    })),
    audioRenditions: metadata.audioRenditions.map((rendition) => ({
      ...rendition,
      playlistPath: relative(rendition.playlistPath),
    })),
    subtitleRenditions: (metadata.subtitleRenditions ?? []).map(
      (rendition) => ({
        ...rendition,
        playlistPath: relative(rendition.playlistPath),
      }),
    ),
    videoCodecStrings: new Map(
      metadata.videoRenditions.map((rendition) => [
        rendition.id,
        rendition.codecString,
      ]),
    ),
    audioCodecStrings: new Map(
      metadata.audioRenditions.map((rendition) => [
        rendition.id,
        rendition.codecString,
      ]),
    ),
  });
}

/**
 * A published package's own build record, which carries far more than the
 * manifest does — codec strings measured off the bitstream, achieved bitrates,
 * keyframe cadence. An incremental publish needs all of it to rebuild a master
 * that describes renditions it never encoded.
 */
export async function readTitleBuildRecord(
  titleRoot: string,
): Promise<AdaptivePackageMetadata | null> {
  try {
    const raw = await readFile(
      path.join(titleRoot, TITLE_PACKAGE_DIRECTORY, TITLE_BUILD_RECORD),
      "utf8",
    );
    const record = JSON.parse(raw) as AdaptivePackageMetadata;
    // Without measured codec strings a faithful master cannot be regenerated,
    // and inventing them would advertise a bitstream nobody verified.
    const complete =
      Array.isArray(record.videoRenditions) &&
      record.videoRenditions.length > 0 &&
      record.videoRenditions.every((rendition) => rendition.codecString) &&
      (record.audioRenditions ?? []).every(
        (rendition) => rendition.codecString,
      );
    return complete ? record : null;
  } catch {
    return null;
  }
}
