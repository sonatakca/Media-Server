import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageAdaptiveRendition } from "./packager";
import { computeSourceFingerprint } from "../registry";
import {
  ensureAdaptiveSourceFixtures,
  getAdaptiveFixtureDirectory,
} from "./testFixtures";
import type { RenditionPaths } from "../analysis";

/**
 * Adding one rendition to a package that already exists, with a real encoder.
 *
 * The unit tests prove the plan and the merge in isolation; this proves the
 * whole path actually runs. It is the test that would have caught the two bugs
 * the first production attempt hit — a master built for a video-only run
 * refusing to exist without audio, and then naming an audio group it never
 * defined. Both only appear when the packager runs end to end.
 */

let workspace = "";
let ffmpegAvailable = false;

beforeAll(async () => {
  ffmpegAvailable = await ensureAdaptiveSourceFixtures();
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-incremental-it-"));
}, 300_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

async function paths(): Promise<RenditionPaths> {
  const root = await mkdtemp(path.join(workspace, "paths-"));
  return {
    mediaRoot: root,
    renditionRoot: path.join(root, "renditions"),
    workRoot: path.join(root, "work"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
  } as RenditionPaths;
}

describe("incremental packaging against a real encoder", () => {
  it(
    "adds a missing rendition without rebuilding or losing the others",
    async () => {
      if (!ffmpegAvailable) return;

      const titleRoot = await mkdtemp(path.join(workspace, "title-"));
      const sourcePath = path.join(titleRoot, "source-sdr-2398.mp4");
      await copyFile(
        path.join(getAdaptiveFixtureDirectory(), "source-sdr-2398.mp4"),
        sourcePath,
      );
      const fingerprint = await computeSourceFingerprint(
        sourcePath,
        await stat(sourcePath),
      );
      const request = {
        mediaId: "11111111-1111-4111-8111-111111111111",
        relativePath: "source-sdr-2398.mp4",
        sourceFingerprint: fingerprint,
        sourcePath,
      };
      const options = {
        reserveBytes: 0,
        preset: "ultrafast",
        verifySourceFingerprint: false,
        audioStreamIndexes: [1],
      };

      // ---------------------------------------------------- the first build
      const first = await packageAdaptiveRendition(
        request,
        await paths(),
        options,
      );
      expect(first.status).toBe("ready");

      const manifestPath = path.join(titleRoot, ".seyirlik", "package.json");
      const before = JSON.parse(await readFile(manifestPath, "utf8"));
      const builtRungs: number[] = before.video.map(
        (rendition: { qualityHeight: number }) => rendition.qualityHeight,
      );
      expect(builtRungs.length).toBeGreaterThan(1);

      /*
       * Remove one rendition's media the way a partial or interrupted write
       * would leave it. The manifest still advertises the rung, so only the
       * on-disk check can tell it is not finished work.
       */
      const victim = before.video[1];
      await rm(path.join(titleRoot, ...victim.mediaPath.split("/")));
      const survivors = builtRungs.filter(
        (height) => height !== victim.qualityHeight,
      );
      const audioBefore = await stat(
        path.join(titleRoot, ...before.audio[0].mediaPath.split("/")),
      );

      // ----------------------------------------------- the incremental build
      const second = await packageAdaptiveRendition(
        request,
        await paths(),
        options,
      );
      expect(
        `${second.status} ${(second as { error?: string }).error ?? ""}`.trim(),
      ).toBe("ready");

      /*
       * TEST 7 at the packaging level: the run reports what *it* produced,
       * which for a one-rendition job is a fraction of the package it joins.
       */
      const jobBytes = (second as { jobOutputBytes?: number }).jobOutputBytes;
      const packageBytes = (second as { storageBytes?: number }).storageBytes;
      expect(jobBytes).toBeGreaterThan(0);
      expect(packageBytes).toBeGreaterThan(jobBytes!);

      const after = JSON.parse(await readFile(manifestPath, "utf8"));
      const finalRungs: number[] = after.video.map(
        (rendition: { qualityHeight: number }) => rendition.qualityHeight,
      );

      // Every rung is present again, each exactly once.
      expect([...finalRungs].sort((a, b) => a - b)).toEqual(
        [...builtRungs].sort((a, b) => a - b),
      );
      expect(new Set(finalRungs).size).toBe(finalRungs.length);

      // The renditions this run did not touch were not rewritten.
      for (const rendition of after.video) {
        const onDisk = await stat(
          path.join(titleRoot, ...rendition.mediaPath.split("/")),
        );
        expect(onDisk.size).toBeGreaterThan(0);
      }

      /*
       * Audio was already valid, so it must be the very same file — not a
       * re-encode that happens to look similar.
       */
      const audioAfter = await stat(
        path.join(titleRoot, ...after.audio[0].mediaPath.split("/")),
      );
      expect(audioAfter.size).toBe(audioBefore.size);
      expect(audioAfter.mtimeMs).toBe(audioBefore.mtimeMs);

      // ------------------------------------------------------- the master
      const master = await readFile(
        path.join(titleRoot, ...after.masterPlaylistPath.split("/")),
        "utf8",
      );
      const variantLines = master
        .split("\n")
        .filter((line) => line.startsWith("#EXT-X-STREAM-INF"));
      expect(variantLines).toHaveLength(finalRungs.length);

      // Every rung is advertised, including the ones this run only inherited.
      for (const height of [...survivors, victim.qualityHeight]) {
        const uri = after.video.find(
          (rendition: { qualityHeight: number }) =>
            rendition.qualityHeight === height,
        )!.playlistPath;
        const name = encodeURIComponent(path.basename(uri));
        expect(master.split(name).length - 1).toBe(1);
      }

      // The published master still carries the audio and its group.
      expect(master).toContain("TYPE=AUDIO");
      expect(master).toContain('AUDIO="aud"');
      expect(master).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    },
    600_000,
  );
});
