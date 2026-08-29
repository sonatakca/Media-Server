/**
 * Reading the currently active adaptive package.
 *
 * Called on the playback path, so it is deliberately cheap: it reads the
 * title's own manifest, parses it strictly, and confirms every registered file
 * is present at the recorded size. It does not re-probe or re-decode — that
 * work belongs to the CLI validator, which runs once per package, not once per
 * playback session.
 *
 * A package lives in the folder of the title it belongs to, so the answer to
 * "which package is current" is read from beside the files it describes rather
 * than from a pointer in a parallel tree.
 *
 * Cheap does not mean trusting. The size check is what catches a package whose
 * bytes changed after it was validated, and every path the server later opens
 * comes from this manifest rather than from anything a client sent.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseAdaptiveMetadata,
  type AdaptivePackageMetadata,
} from "./metadata";
import { ADAPTIVE_PROFILE_VERSION } from "./profile";
import { TITLE_PACKAGE_DIRECTORY } from "./titleLayout";
import { TITLE_BUILD_RECORD } from "./publishTitle";

export type AdaptiveInspectionStatus =
  | "missing"
  | "ready"
  | "stale"
  | "validation-failed";

export interface AdaptiveInspection {
  status: AdaptiveInspectionStatus;
  versionRoot?: string;
  metadata?: AdaptivePackageMetadata;
  /** Safe to log and to show an operator; never contains a filesystem path. */
  reason?: string;
}

export interface InspectAdaptiveOptions {
  /** The folder the source file lives in, which is also the package root. */
  titleRoot: string;
  sourceFingerprint: string;
  profileVersion?: string;
}

export async function inspectAdaptivePackage({
  titleRoot,
  sourceFingerprint,
  profileVersion = ADAPTIVE_PROFILE_VERSION,
}: InspectAdaptiveOptions): Promise<AdaptiveInspection> {
  const versionRoot = titleRoot;
  let recordText: string;
  try {
    recordText = await readFile(
      path.join(titleRoot, TITLE_PACKAGE_DIRECTORY, TITLE_BUILD_RECORD),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "validation-failed",
      reason: "The package manifest could not be read.",
    };
  }

  let metadata: AdaptivePackageMetadata;
  try {
    /*
     * Parsed without the expectations first, so a package built from other
     * bytes or by an older profile is reported as stale — something to
     * regenerate — rather than as a manifest that failed to parse.
     */
    metadata = parseAdaptiveMetadata(JSON.parse(recordText), {
      enforceCanonicalPaths: false,
    });
  } catch (error) {
    return {
      status: "validation-failed",
      reason:
        error instanceof Error
          ? error.message
          : "The adaptive package manifest could not be read.",
    };
  }

  if (
    metadata.profileVersion !== profileVersion ||
    metadata.sourceFingerprint !== sourceFingerprint
  ) {
    return {
      status: "stale",
      versionRoot,
      reason:
        metadata.profileVersion !== profileVersion
          ? "The active adaptive package was built by a different profile version."
          : "The source has changed since the adaptive package was built.",
    };
  }

  for (const rendition of [
    ...metadata.videoRenditions,
    ...metadata.audioRenditions,
  ]) {
    for (const [relativePath, expectedSize] of [
      [rendition.mediaPath, rendition.fileSizeBytes] as const,
      [rendition.playlistPath, undefined] as const,
    ]) {
      const stats = await stat(
        path.join(versionRoot, ...relativePath.split("/")),
      ).catch(() => null);
      if (!stats?.isFile() || stats.size === 0) {
        return {
          status: "validation-failed",
          versionRoot,
          reason: `Rendition ${rendition.id} is missing a registered file.`,
        };
      }
      if (expectedSize !== undefined && stats.size !== expectedSize) {
        return {
          status: "validation-failed",
          versionRoot,
          reason: `Rendition ${rendition.id} changed size after it was validated.`,
        };
      }
    }
  }

  const masterStats = await stat(
    path.join(versionRoot, ...metadata.masterPlaylistPath.split("/")),
  ).catch(() => null);
  if (!masterStats?.isFile() || masterStats.size === 0) {
    return {
      status: "validation-failed",
      versionRoot,
      reason: "The master playlist is missing or empty.",
    };
  }

  return { status: "ready", versionRoot, metadata };
}
