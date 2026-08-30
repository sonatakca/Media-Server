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
import { MASTER_LAYOUT_VERSION } from "./repairMaster";
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
}

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
}: PublishTitlePackageInput): Promise<PublishTitlePackageResult> {
  const plan = planTitleLayout(metadata);
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

    const audio: TitleAudioRendition[] = [];
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

    const subtitle: TitleSubtitleRendition[] = [];
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

    const master = await readFile(
      absolute(workVersionRoot, metadata.masterPlaylistPath),
      "utf8",
    );
    await writeFile(
      absolute(staging, plan.masterPlaylistPath),
      rewriteMasterPlaylist(master, plan, workPlaylistPathById),
      "utf8",
    );

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

    await swapPublishedDirectories(titleRoot, staging);
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
