/**
 * Validation is only worth having if it rejects things.
 *
 * Each test below takes a package that really was produced by the packager and
 * damages exactly one property, then asserts the validator names that property.
 * Damaging a real package rather than hand-writing a broken one matters: a
 * hand-written fixture can only fail in ways its author thought of, and would
 * happily pass a validator that had stopped checking anything at all.
 */

import {
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenditionPaths } from "../analysis";
import { computeSourceFingerprint } from "../registry";
import { packageAdaptiveRendition } from "./packager";
import { inspectAdaptivePackage } from "./inspect";
import { validateAdaptivePackage } from "./validation";
import {
  ensureAdaptiveSourceFixtures,
  getAdaptiveFixtureDirectory,
} from "./testFixtures";
import { ADAPTIVE_PROFILE_VERSION } from "./profile";
import { buildWebVttMediaPlaylist } from "./subtitles";

const MEDIA_ID = "22222222-2222-4222-8222-222222222222";

let ffmpegAvailable = false;
let workspace = "";
/** One good package, copied fresh for each test that damages it. */
let pristineVersionRoot = "";
let sourceFingerprint = "";

async function damagedCopy(
  damage: (versionRoot: string) => Promise<void>,
): Promise<string> {
  const target = await mkdtemp(path.join(workspace, "damaged-"));
  await cp(pristineVersionRoot, target, { recursive: true });
  await damage(target);
  return target;
}

async function validate(versionRoot: string, deep = false) {
  return validateAdaptivePackage({
    versionRoot,
    mediaId: MEDIA_ID,
    sourceFingerprint,
    profileVersion: ADAPTIVE_PROFILE_VERSION,
    deep,
  });
}

function stages(result: Awaited<ReturnType<typeof validate>>): string[] {
  return result.issues.map((issue) => issue.stage);
}

async function readMetadata(versionRoot: string) {
  return JSON.parse(
    await readFile(path.join(versionRoot, ".seyirlik", "build.json"), "utf8"),
  ) as Record<string, unknown> & {
    videoRenditions: Array<Record<string, unknown>>;
    audioRenditions: Array<Record<string, unknown>>;
  };
}

async function writeMetadata(versionRoot: string, metadata: unknown) {
  await writeFile(
    path.join(versionRoot, ".seyirlik", "build.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

beforeAll(async () => {
  ffmpegAvailable = await ensureAdaptiveSourceFixtures();
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-adaptive-val-"));
  if (!ffmpegAvailable) return;

  /*
   * A package is published beside its source, so the fixture is copied into a
   * folder of its own first. Building into the shared fixture directory would
   * leave a package there for the next suite to find — and find it would, as
   * "already current".
   */
  const root = await mkdtemp(path.join(workspace, "pristine-"));
  const titleRoot = path.join(root, "title");
  await mkdir(titleRoot, { recursive: true });
  const sourcePath = path.join(titleRoot, "source-sdr-25.mp4");
  await copyFile(
    path.join(getAdaptiveFixtureDirectory(), "source-sdr-25.mp4"),
    sourcePath,
  );
  const paths: RenditionPaths = {
    mediaRoot: getAdaptiveFixtureDirectory(),
    renditionRoot: path.join(root, "renditions"),
    workRoot: path.join(root, "work"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
  };
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });

  sourceFingerprint = await computeSourceFingerprint(
    sourcePath,
    await stat(sourcePath),
  );
  const result = await packageAdaptiveRendition(
    {
      mediaId: MEDIA_ID,
      relativePath: "source-sdr-25.mp4",
      sourceFingerprint,
      sourcePath,
    },
    paths,
    { reserveBytes: 0, preset: "ultrafast", verifySourceFingerprint: false },
  );
  if (result.status !== "ready") {
    throw new Error(
      `Fixture package was not produced: ${result.error ?? result.status}`,
    );
  }
  // The package lives with its title now, so the title folder is the root
  // every path in its manifest is relative to.
  pristineVersionRoot = titleRoot;
}, 600_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("adaptive package validation", () => {
  it("accepts the package the packager produced", async () => {
    if (!ffmpegAvailable) return;
    const result = await validate(pristineVersionRoot, true);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  }, 300_000);

  /**
   * The regression this guards: the subtitle check compared the playlist's URI
   * against a bare filename, which assumed the playlist sits beside its media.
   * In the published layout the playlist lives in the hidden package directory
   * and the media in the folder a person browses, so every title carrying
   * subtitles failed validation while being entirely correct.
   */
  it("accepts a subtitle whose playlist and media sit in different folders", async () => {
    if (!ffmpegAvailable) return;
    const root = await damagedCopy(async (versionRoot) => {
      const metadata = await readMetadata(versionRoot);
      const duration = Number(metadata.sourceDurationSeconds);

      await mkdir(path.join(versionRoot, "subtitle"), { recursive: true });
      await mkdir(path.join(versionRoot, ".seyirlik", "subtitle"), {
        recursive: true,
      });
      await writeFile(
        path.join(versionRoot, "subtitle", "turkish.vtt"),
        "WEBVTT\n\n00:00.000 --> 00:02.000\nMerhaba.\n",
        "utf8",
      );
      await writeFile(
        path.join(versionRoot, ".seyirlik", "subtitle", "turkish.m3u8"),
        buildWebVttMediaPlaylist(duration, "../../subtitle/turkish.vtt"),
        "utf8",
      );

      await writeMetadata(versionRoot, {
        ...metadata,
        subtitleRenditions: [
          {
            id: "subtitle-1000",
            sourceStreamIndex: 1000,
            language: "tur",
            isDefault: false,
            isForced: false,
            isHearingImpaired: false,
            codec: "webvtt",
            durationSeconds: duration,
            playlistPath: ".seyirlik/subtitle/turkish.m3u8",
            subtitlePath: "subtitle/turkish.vtt",
            fileSizeBytes: 42,
          },
        ],
      });
    });

    const result = await validate(root);
    expect(
      result.issues.filter((issue) => issue.stage === "subtitle-playlist"),
    ).toEqual([]);
  }, 120_000);

  it("rejects a missing manifest", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      await rm(path.join(root, ".seyirlik", "build.json"));
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toContain("metadata");
  });

  it("rejects a corrupt media playlist", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const playlist = path.join(root, ".seyirlik", "video", "480p.m3u8");
      const text = await readFile(playlist, "utf8");
      await writeFile(playlist, text.replace("#EXT-X-ENDLIST", ""), "utf8");
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toContain("media-playlist");
    expect(result.issues[0].message).toMatch(/#EXT-X-ENDLIST/);
  });

  it("rejects a byte range that runs past the end of its media file", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const playlist = path.join(root, ".seyirlik", "video", "480p.m3u8");
      const text = await readFile(playlist, "utf8");
      await writeFile(
        playlist,
        text.replace(
          /#EXT-X-BYTERANGE:(\d+)@(\d+)/,
          "#EXT-X-BYTERANGE:$1@999999999",
        ),
        "utf8",
      );
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toContain("byte-ranges");
    expect(result.issues[0].message).toMatch(/exceeds the .* media file/);
  });

  it("rejects a missing initialization range", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const playlist = path.join(root, ".seyirlik", "video", "480p.m3u8");
      const text = await readFile(playlist, "utf8");
      await writeFile(
        playlist,
        text.replace(/#EXT-X-MAP:[^\n]*\n/, ""),
        "utf8",
      );
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toMatch(/#EXT-X-MAP/);
  });

  it("rejects a media file whose size no longer matches the manifest", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const media = path.join(root, "video", "480p.mp4");
      const stats = await stat(media);
      await truncate(media, stats.size - 1024);
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toContain("media-file");
    // The immutability claim is the point: bytes changed after validation.
    expect(result.issues[0].message).toMatch(/changed after validation/);
  });

  it("rejects an empty media file", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      await writeFile(path.join(root, "video", "480p.mp4"), "");
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toContain("media-file");
  });

  it("rejects a manifest that claims the wrong codec", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const metadata = await readMetadata(root);
      metadata.videoRenditions[0].codec = "hevc";
      await writeMetadata(root, metadata);
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toContain("video-properties");
    expect(result.issues[0].message).toMatch(
      /codec is h264, metadata records hevc/,
    );
  });

  it("rejects a manifest that claims the wrong dimensions", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const metadata = await readMetadata(root);
      metadata.videoRenditions[0].width = 640;
      await writeMetadata(root, metadata);
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message).join(" ")).toMatch(
      /dimensions are/,
    );
  });

  it("rejects an SDR rendition dressed up as HDR", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const metadata = await readMetadata(root);
      metadata.videoRenditions[0].hdr = "hdr10";
      await writeMetadata(root, metadata);
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toContain("hdr-signalling");
    const messages = result.issues.map((issue) => issue.message).join(" ");
    expect(messages).toMatch(/colour transfer/);
    expect(messages).toMatch(/not 10-bit/);
    expect(messages).toMatch(/hvc1/);
  });

  it("rejects a segment boundary that drifts out of alignment", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const playlist = path.join(root, ".seyirlik", "video", "480p.m3u8");
      const text = await readFile(playlist, "utf8");
      // Move the first boundary half a second, which shifts every later one.
      await writeFile(
        playlist,
        text.replace("#EXTINF:2.000000,", "#EXTINF:2.500000,"),
        "utf8",
      );
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toEqual(
      expect.arrayContaining(["segment-alignment"]),
    );
  });

  it("rejects a switching set whose renditions cover different durations", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const playlist = path.join(root, ".seyirlik", "video", "480p.m3u8");
      const text = await readFile(playlist, "utf8");
      const lines = text.split("\n");
      // Drop the final segment, so this rendition ends early. Every segment
      // line names the one media file this rendition is stored in.
      const lastSegment = lines.findLastIndex(
        (line) => line.trim() !== "" && !line.startsWith("#"),
      );
      lines.splice(lastSegment - 2, 3);
      await writeFile(playlist, lines.join("\n"), "utf8");
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toEqual(
      expect.arrayContaining(["segment-alignment"]),
    );
  });

  it("rejects a manifest whose audio rendition is missing from disk", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      await rm(path.join(root, "audio"), { recursive: true, force: true });
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    // The playlist survives — it lives in the package directory — so what is
    // reported is the media file the manifest names and the folder no longer
    // holds, which is exactly what went missing.
    expect(stages(result)).toEqual(
      expect.arrayContaining(["audio-media-file"]),
    );
  });

  it("rejects a manifest claiming the wrong audio sample rate", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const metadata = await readMetadata(root);
      metadata.audioRenditions[0].sampleRate = 44_100;
      await writeMetadata(root, metadata);
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toContain("audio-properties");
    expect(result.issues[0].message).toMatch(/sample rate is 48000Hz/);
  });

  it("rejects a manifest path that tries to escape the package", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      const metadata = await readMetadata(root);
      metadata.videoRenditions[0].mediaPath = "../../../../etc/passwd";
      await writeMetadata(root, metadata);
    });
    const result = await validate(versionRoot);
    expect(result.ok).toBe(false);
    expect(stages(result)).toContain("metadata");
    expect(result.issues[0].message).toMatch(
      /relative path inside the package/,
    );
  });

  it("rejects a manifest whose fingerprint does not match the source", async () => {
    if (!ffmpegAvailable) return;
    const result = await validateAdaptivePackage({
      versionRoot: pristineVersionRoot,
      mediaId: MEDIA_ID,
      sourceFingerprint: "0".repeat(64),
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toMatch(
      /sourceFingerprint does not match/,
    );
  });

  it("names the media id, rendition and stage without leaking a filesystem path", async () => {
    if (!ffmpegAvailable) return;
    const versionRoot = await damagedCopy(async (root) => {
      await writeFile(path.join(root, "video", "480p.mp4"), "");
    });
    const result = await validate(versionRoot);
    const issue = result.issues[0];

    expect(issue.mediaId).toBe(MEDIA_ID);
    expect(issue.rendition).toBe("480p");
    expect(issue.stage).toBeTruthy();
    for (const entry of result.issues) {
      expect(entry.message).not.toContain(versionRoot);
      expect(entry.message).not.toContain(tmpdir());
    }
  });
});

describe("inspectAdaptivePackage", () => {
  it("reports a folder with no package as missing", async () => {
    if (!ffmpegAvailable) return;
    const empty = await mkdtemp(path.join(workspace, "empty-"));
    expect(
      await inspectAdaptivePackage({
        titleRoot: empty,
        sourceFingerprint,
      }),
    ).toEqual({ status: "missing" });
  });

  /**
   * Stale rather than broken: the package parses and its files are there, it
   * was simply made from bytes this title no longer has. That is something to
   * regenerate, not something to report as corruption.
   */
  it("reports a package built from a different source as stale", async () => {
    if (!ffmpegAvailable) return;
    const inspection = await inspectAdaptivePackage({
      titleRoot: pristineVersionRoot,
      sourceFingerprint: "1".repeat(64),
    });
    expect(inspection.status).toBe("stale");
    expect(inspection.reason).toMatch(/source has changed/i);
  });

  it("accepts the active package and returns its manifest", async () => {
    if (!ffmpegAvailable) return;
    const inspection = await inspectAdaptivePackage({
      titleRoot: pristineVersionRoot,
      sourceFingerprint,
    });
    expect(inspection.status).toBe("ready");
    expect(inspection.metadata?.videoRenditions.length).toBeGreaterThanOrEqual(
      2,
    );
  });

  /**
   * The size check is the whole point of inspecting rather than trusting: it is
   * what catches a package whose bytes changed after it was validated.
   */
  it("refuses a package whose bytes changed after it was validated", async () => {
    if (!ffmpegAvailable) return;
    const titleRoot = await mkdtemp(path.join(workspace, "mutated-"));
    await cp(pristineVersionRoot, titleRoot, { recursive: true });
    const media = path.join(titleRoot, "video", "480p.mp4");
    const stats = await stat(media);
    await truncate(media, stats.size - 512);

    const inspection = await inspectAdaptivePackage({
      titleRoot,
      sourceFingerprint,
    });
    expect(inspection.status).toBe("validation-failed");
    expect(inspection.reason).toMatch(/changed size after it was validated/);
  });
});
