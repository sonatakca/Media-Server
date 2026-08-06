import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectCompletedRendition,
  type RenditionMetadata,
} from "./validation";
import { RENDITION_PROFILE_VERSION } from "./policy";

async function createCompletedFixture(root: string) {
  const mediaRoot = path.join(root, "media-id");
  const versionDirectory = `${RENDITION_PROFILE_VERSION}-abcdef123456`;
  const versionRoot = path.join(mediaRoot, versionDirectory);
  await mkdir(versionRoot, { recursive: true });
  await writeFile(
    path.join(mediaRoot, "current.json"),
    JSON.stringify({
      schemaVersion: 2,
      versionDirectory,
      sourceFingerprint: "a".repeat(64),
      profileVersion: RENDITION_PROFILE_VERSION,
    }),
  );
  const fileContents = Buffer.from("complete-mp4-file");
  await writeFile(path.join(versionRoot, "480p.mp4"), fileContents);
  const metadata: RenditionMetadata = {
    schemaVersion: 3,
    mediaId: "media-id",
    sourceFingerprint: "a".repeat(64),
    profileVersion: RENDITION_PROFILE_VERSION,
    createdAt: new Date(0).toISOString(),
    durationSeconds: 60,
    original: { width: 1920, height: 1080, qualityHeight: 1080, codec: "hevc" },
    files: [
      {
        qualityHeight: 480,
        width: 854,
        height: 360,
        bitrate: 1_900_000,
        fileSize: fileContents.length,
        videoCodec: "h264",
        audioCodec: "aac",
        container: "mp4",
        frameRate: 24,
        file: "480p.mp4",
        sourceAudioStreamIndex: 1,
        audioLanguage: "tur",
      },
    ],
    audioStrategy: "default-track-only",
    subtitleStrategy: "original-playback-only",
    validation: {
      validatedAt: new Date(0).toISOString(),
      durationToleranceSeconds: 2,
    },
  };
  await writeFile(
    path.join(versionRoot, "metadata.json"),
    JSON.stringify(metadata),
  );
  return { mediaRoot, versionRoot };
}

describe("completed standalone rendition validation", () => {
  it("accepts only a complete registered MP4 in the current immutable version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-validation-"));
    const { mediaRoot } = await createCompletedFixture(root);

    const result = await inspectCompletedRendition({
      mediaRoot,
      mediaId: "media-id",
      sourceFingerprint: "a".repeat(64),
      profileVersion: RENDITION_PROFILE_VERSION,
    });

    expect(result.status).toBe("ready");
    expect(result.metadata?.files.map((file) => file.qualityHeight)).toEqual([
      480,
    ]);
  });

  it("marks a source fingerprint mismatch stale", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "seyirlik-validation-stale-"),
    );
    const { mediaRoot } = await createCompletedFixture(root);

    const result = await inspectCompletedRendition({
      mediaRoot,
      mediaId: "media-id",
      sourceFingerprint: "b".repeat(64),
      profileVersion: RENDITION_PROFILE_VERSION,
    });

    expect(result.status).toBe("stale");
  });

  it("rejects a missing registered complete file", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "seyirlik-validation-missing-"),
    );
    const { mediaRoot, versionRoot } = await createCompletedFixture(root);
    await rm(path.join(versionRoot, "480p.mp4"));

    const result = await inspectCompletedRendition({
      mediaRoot,
      mediaId: "media-id",
      sourceFingerprint: "a".repeat(64),
      profileVersion: RENDITION_PROFILE_VERSION,
    });

    expect(result.status).toBe("validation-failed");
    expect(result.reason).toContain("480p.mp4");
  });

  it("rejects a truncated file whose size no longer matches validated metadata", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "seyirlik-validation-truncated-"),
    );
    const { mediaRoot, versionRoot } = await createCompletedFixture(root);
    await writeFile(path.join(versionRoot, "480p.mp4"), "short");

    const result = await inspectCompletedRendition({
      mediaRoot,
      mediaId: "media-id",
      sourceFingerprint: "a".repeat(64),
      profileVersion: RENDITION_PROFILE_VERSION,
    });

    expect(result.status).toBe("validation-failed");
    expect(result.reason).toContain("size does not match");
  });

  it("never accepts a temporary partial file as registered ready output", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "seyirlik-validation-partial-"),
    );
    const { mediaRoot, versionRoot } = await createCompletedFixture(root);
    const metadataPath = path.join(versionRoot, "metadata.json");
    const metadata = JSON.parse(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(metadataPath, "utf8"),
      ),
    );
    metadata.files[0].file = "480p.partial.mp4";
    await writeFile(
      path.join(versionRoot, "480p.partial.mp4"),
      "complete-mp4-file",
    );
    await writeFile(metadataPath, JSON.stringify(metadata));

    const result = await inspectCompletedRendition({
      mediaRoot,
      mediaId: "media-id",
      sourceFingerprint: "a".repeat(64),
      profileVersion: RENDITION_PROFILE_VERSION,
    });

    expect(result.status).toBe("validation-failed");
    expect(result.reason).toContain("metadata is invalid");
  });
});
