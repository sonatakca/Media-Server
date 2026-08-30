import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMasterPlaylist } from "./playlist";
import {
  TITLE_PACKAGE_DIRECTORY,
  TITLE_MASTER_PLAYLIST,
  playlistUri,
} from "./titleLayout";
import type { AdaptivePackageMetadata } from "./metadata";

/**
 * Bringing an existing package's master playlist up to date, without re-encoding.
 *
 * The media in a package and the playlist that describes it go stale for very
 * different reasons and at very different costs. A source that changed, or a
 * ladder that gained a rung, genuinely needs the encoder. A change in how the
 * master *describes* the same files does not — and treating the two the same
 * way means a one-line playlist improvement is unavailable to every title
 * already on disk unless hours of encoding are spent reproducing bytes that are
 * already correct.
 *
 * That is not hypothetical: ordering the variants so a native player opens on a
 * usable rung is a master-only change, and without this it would have reached
 * new titles only.
 */

/**
 * Bumped when `buildMasterPlaylist` starts producing a materially different
 * master for the same inputs.
 *
 * 2 — variants lead with an opening rung rather than being listed
 *     cheapest-first, so a native player does not begin every title at 144p.
 */
export const MASTER_LAYOUT_VERSION = 2;

export interface MasterRepairResult {
  status: "updated" | "current" | "unsupported";
  /** The layout version the package carried before this ran. */
  previousVersion: number;
  reason?: string;
}

/** The layout version a package records, defaulting to the pre-versioned one. */
export function recordedMasterLayoutVersion(
  metadata: Pick<AdaptivePackageMetadata, "masterPlaylistPath"> & {
    masterLayoutVersion?: number;
  },
): number {
  const recorded = metadata.masterLayoutVersion;
  return typeof recorded === "number" &&
    Number.isInteger(recorded) &&
    recorded > 0
    ? recorded
    : 1;
}

/**
 * Rewrites `titleRoot`'s master from the package's own build record.
 *
 * Everything the master needs — the renditions, their measured bitrates and the
 * codec strings taken from the real bitstream — is already in `build.json`, so
 * the playlist is regenerated from what was actually produced rather than from
 * a fresh guess at what would be produced now.
 */
export async function repairTitleMaster(
  titleRoot: string,
  options: { readJson?: (path: string) => Promise<string> } = {},
): Promise<MasterRepairResult> {
  const buildPath = path.join(titleRoot, TITLE_PACKAGE_DIRECTORY, "build.json");
  const read = options.readJson ?? ((p: string) => readFile(p, "utf8"));

  let metadata: AdaptivePackageMetadata & { masterLayoutVersion?: number };
  try {
    metadata = JSON.parse(await read(buildPath));
  } catch {
    return {
      status: "unsupported",
      previousVersion: 0,
      reason: "The package has no readable build record.",
    };
  }

  const previousVersion = recordedMasterLayoutVersion(metadata);
  if (previousVersion >= MASTER_LAYOUT_VERSION) {
    return { status: "current", previousVersion };
  }

  // A master built before codec strings were recorded cannot be regenerated
  // faithfully, and guessing them would produce a playlist that lies about the
  // bitstream. Such a package is left for a real rebuild.
  const missingCodec =
    metadata.videoRenditions.some((rendition) => !rendition.codecString) ||
    metadata.audioRenditions.some((rendition) => !rendition.codecString);
  if (missingCodec) {
    return {
      status: "unsupported",
      previousVersion,
      reason: "The build record has no measured codec strings.",
    };
  }

  /** A published path, as the master beside it must name it. */
  const relativeToPackage = (published: string): string =>
    playlistUri(published.slice(TITLE_PACKAGE_DIRECTORY.length + 1));

  const master = buildMasterPlaylist({
    videoRenditions: metadata.videoRenditions.map((rendition) => ({
      ...rendition,
      playlistPath: relativeToPackage(rendition.playlistPath),
    })),
    audioRenditions: metadata.audioRenditions.map((rendition) => ({
      ...rendition,
      playlistPath: relativeToPackage(rendition.playlistPath),
    })),
    subtitleRenditions: (metadata.subtitleRenditions ?? []).map(
      (rendition) => ({
        ...rendition,
        playlistPath: relativeToPackage(rendition.playlistPath),
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

  // Written beside the target and renamed, so a reader never observes a
  // half-written master — the same discipline the publisher uses.
  const masterPath = path.join(
    titleRoot,
    TITLE_PACKAGE_DIRECTORY,
    TITLE_MASTER_PLAYLIST,
  );
  const pending = `${masterPath}.pending`;
  await writeFile(pending, master, "utf8");
  await rename(pending, masterPath);

  const stamped = { ...metadata, masterLayoutVersion: MASTER_LAYOUT_VERSION };
  const pendingBuild = `${buildPath}.pending`;
  await writeFile(pendingBuild, JSON.stringify(stamped, null, 2), "utf8");
  await rename(pendingBuild, buildPath);

  return { status: "updated", previousVersion };
}
