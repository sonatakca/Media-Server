/**
 * Reading the currently active adaptive package.
 *
 * Called on the playback path, so it is deliberately cheap: it follows the
 * pointer, parses the manifest strictly, and confirms every registered file is
 * present at the recorded size. It does not re-probe or re-decode — that work
 * belongs to the CLI validator, which runs once per package, not once per
 * playback session.
 *
 * Cheap does not mean trusting. The size check is what catches a package whose
 * bytes changed after it was validated, and every path the server later opens
 * comes from this manifest rather than from anything a client sent.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseAdaptiveMetadata,
  parseAdaptivePointer,
  type AdaptivePackageMetadata,
} from "./metadata";
import { ADAPTIVE_POINTER_FILE, ADAPTIVE_PROFILE_VERSION } from "./profile";

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
  /** `<renditionRoot>/<mediaId>`, the directory holding the pointer. */
  mediaRoot: string;
  mediaId: string;
  sourceFingerprint: string;
  profileVersion?: string;
}

export async function inspectAdaptivePackage({
  mediaRoot,
  mediaId,
  sourceFingerprint,
  profileVersion = ADAPTIVE_PROFILE_VERSION,
}: InspectAdaptiveOptions): Promise<AdaptiveInspection> {
  let pointerText: string;
  try {
    pointerText = await readFile(
      path.join(mediaRoot, ADAPTIVE_POINTER_FILE),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "validation-failed",
      reason: "The adaptive pointer could not be read.",
    };
  }

  let versionRoot: string;
  let metadata: AdaptivePackageMetadata;
  try {
    const pointer = parseAdaptivePointer(JSON.parse(pointerText));
    versionRoot = path.join(mediaRoot, pointer.versionDirectory);

    if (
      pointer.profileVersion !== profileVersion ||
      pointer.sourceFingerprint !== sourceFingerprint
    ) {
      return {
        status: "stale",
        versionRoot,
        reason:
          pointer.profileVersion !== profileVersion
            ? "The active adaptive package was built by a different profile version."
            : "The source has changed since the adaptive package was built.",
      };
    }

    metadata = parseAdaptiveMetadata(
      JSON.parse(
        await readFile(path.join(versionRoot, "metadata.json"), "utf8"),
      ),
      { mediaId, sourceFingerprint, profileVersion },
    );
  } catch (error) {
    return {
      status: "validation-failed",
      reason:
        error instanceof Error
          ? error.message
          : "The adaptive package manifest could not be read.",
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
