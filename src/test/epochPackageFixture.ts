/**
 * A real, assembled, multi-epoch package for the browser to play.
 *
 * Everything else about epoch joins is measured with ffprobe, which proves the
 * timestamps are right. It does not prove a player is happy with them — that a
 * seek across a join lands where it should, that the buffered range is
 * continuous through it, that MSE accepts the concatenated fragments under one
 * initialisation segment. Those are facts about browsers, and the only way to
 * establish them is to hand a browser the bytes.
 *
 * Built rather than committed, and cached between runs, because it takes real
 * encoding to produce.
 */

import { access, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { packageAdaptiveRendition } from "../renditions/adaptive/packager";
import { computeSourceFingerprint } from "../renditions/registry";
import {
  ensureAdaptiveEpochFixture,
  hasFfmpeg,
} from "../renditions/adaptive/testFixtures";
import type { RenditionPaths } from "../renditions/analysis";

const MEDIA_ID = "44444444-4444-4444-8444-444444444444";

/** Short enough to build quickly, long enough to cross three epoch joins. */
export const EPOCH_PACKAGE_EPOCH_SECONDS = 6;

export function epochPackageDirectory(): string {
  return path.join(tmpdir(), "seyirlik-epoch-package");
}

/** Where the published package's master playlist sits inside the title folder. */
export const EPOCH_PACKAGE_MASTER = ".seyirlik/master.m3u8";

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the package if it is not already cached, and reports the title folder.
 *
 * Returns null when FFmpeg is unavailable, so a test can skip with a reason
 * rather than failing for a missing tool.
 */
export async function ensureEpochPackageFixture(): Promise<string | null> {
  if (!(await hasFfmpeg())) return null;
  const root = epochPackageDirectory();
  const titleRoot = path.join(root, "Epoch Join Fixture");
  if (await exists(path.join(titleRoot, ...EPOCH_PACKAGE_MASTER.split("/")))) {
    return titleRoot;
  }

  const source = await ensureAdaptiveEpochFixture();
  if (!source) return null;

  await rm(root, { recursive: true, force: true });
  await mkdir(titleRoot, { recursive: true });
  const titleSource = path.join(titleRoot, "Epoch Join Fixture.mp4");
  await copyFile(source, titleSource);

  const paths: RenditionPaths = {
    mediaRoot: root,
    renditionRoot: path.join(root, "renditions"),
    workRoot: path.join(root, "work"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
  };
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });

  const result = await packageAdaptiveRendition(
    {
      mediaId: MEDIA_ID,
      relativePath: path.basename(titleSource),
      sourceFingerprint: await computeSourceFingerprint(
        titleSource,
        await stat(titleSource),
      ),
      sourcePath: titleSource,
    },
    paths,
    {
      reserveBytes: 0,
      preset: "ultrafast",
      verifySourceFingerprint: false,
      epochTargetSeconds: EPOCH_PACKAGE_EPOCH_SECONDS,
    },
  );
  if (result.status !== "ready") {
    throw new Error(
      `The epoch playback fixture could not be built: ${result.status} ${result.error ?? ""}`,
    );
  }
  return titleRoot;
}
