import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TITLE_AUDIO_DIRECTORY,
  TITLE_SUBTITLE_DIRECTORY,
  TITLE_VIDEO_DIRECTORY,
} from "../renditions/adaptive/layout";
import { TITLE_PACKAGE_DIRECTORY } from "../renditions/adaptive/titleLayout";

/**
 * A destination that refuses to be written to, on any host.
 *
 * The tests that need this are about what the packager does when publication
 * fails after the encoding has already succeeded — hours of work, and the last
 * step is the one that breaks. They forced it with `chmod(titleRoot, 0o500)`,
 * which is a POSIX way of asking. Windows honours the read-only attribute on
 * *files* and effectively ignores it on directories: the chmod succeeded, the
 * publisher wrote everything anyway, and four tests failed asserting that a
 * package which had in fact been published had not been.
 *
 * So the block is expressed in something both filesystems agree about: a plain
 * file standing exactly where the publisher must create a directory. `mkdir`
 * over a file fails on POSIX and on Windows alike, the source stays readable
 * throughout — which is the asymmetry a failing destination actually has — and
 * nothing depends on how a platform interprets a mode.
 *
 * POSIX keeps its mode change as well. It is the more faithful reproduction of
 * a volume that has gone read-only, and losing it would be losing coverage.
 */
export async function blockPublication(
  titleRoot: string,
): Promise<() => Promise<void>> {
  return blockPaths(
    titleRoot,
    [
      TITLE_PACKAGE_DIRECTORY,
      TITLE_VIDEO_DIRECTORY,
      TITLE_AUDIO_DIRECTORY,
      TITLE_SUBTITLE_DIRECTORY,
    ].map((name) => path.join(titleRoot, name)),
  );
}

/**
 * The same block, aimed at named paths rather than at a package's layout.
 *
 * `root` is only where the POSIX mode change goes, so both mechanisms describe
 * one failure rather than two.
 */
export async function blockPaths(
  root: string,
  blocked: readonly string[],
): Promise<() => Promise<void>> {
  for (const target of blocked) {
    await rm(target, { recursive: true, force: true });
    await writeFile(target, "phase-0c: a file where a directory has to go");
  }
  if (process.platform !== "win32") await chmod(root, 0o500);

  return async () => {
    if (process.platform !== "win32") await chmod(root, 0o700);
    for (const target of blocked) await rm(target, { force: true });
    await mkdir(root, { recursive: true });
  };
}
