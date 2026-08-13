/**
 * End-to-end packaging against real FFmpeg output.
 *
 * These tests exist because the properties that make adaptive switching
 * invisible cannot be checked by inspecting a command line. Whether two
 * renditions really land on the same keyframes, whether a segment really begins
 * on a random-access frame, and whether an irregular-timestamp source really
 * cuts on two-second boundaries are all facts about bytes, and the only honest
 * way to establish them is to encode something and measure it.
 */

import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenditionPaths } from "../analysis";
import { computeSourceFingerprint } from "../registry";
import { packageAdaptiveRendition } from "./packager";
import { parseMasterPlaylist, parseMediaPlaylist } from "./playlist";
import { probeKeyframeTimes } from "./probePackaged";
import { validateAdaptivePackage } from "./validation";
import { parseAdaptiveMetadata } from "./metadata";
import {
  ADAPTIVE_SOURCE_FIXTURES,
  ensureAdaptiveHdrFixture,
  ensureAdaptiveSourceFixtures,
  getAdaptiveFixtureDirectory,
} from "./testFixtures";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

let ffmpegAvailable = false;
let workspace = "";

async function createPaths(): Promise<RenditionPaths> {
  const root = await mkdtemp(path.join(workspace, "run-"));
  const paths: RenditionPaths = {
    mediaRoot: getAdaptiveFixtureDirectory(),
    renditionRoot: path.join(root, "renditions"),
    workRoot: path.join(root, "work"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
  };
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });
  return paths;
}

async function packageSource(
  sourcePath: string,
  options: Record<string, unknown> = {},
) {
  const paths = await createPaths();
  const fingerprint = await computeSourceFingerprint(
    sourcePath,
    await stat(sourcePath),
  );
  const result = await packageAdaptiveRendition(
    {
      mediaId: MEDIA_ID,
      relativePath: path.basename(sourcePath),
      sourceFingerprint: fingerprint,
      sourcePath,
    },
    paths,
    {
      reserveBytes: 0,
      preset: "ultrafast",
      verifySourceFingerprint: false,
      ...options,
    },
  );
  const versionRoot = result.versionDirectory
    ? path.join(paths.renditionRoot, MEDIA_ID, result.versionDirectory)
    : undefined;
  return { result, paths, fingerprint, versionRoot };
}

beforeAll(async () => {
  ffmpegAvailable = await ensureAdaptiveSourceFixtures();
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-adaptive-it-"));
}, 300_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe.each(ADAPTIVE_SOURCE_FIXTURES)(
  "adaptive packaging of $description",
  (fixture) => {
    it("produces an aligned, validated, single-file byte-range CMAF package", async () => {
      if (!ffmpegAvailable) {
        console.warn(
          "FFmpeg is not available; skipping adaptive packaging test.",
        );
        return;
      }

      const sourcePath = path.join(
        getAdaptiveFixtureDirectory(),
        fixture.fileName,
      );
      const { result, versionRoot } = await packageSource(sourcePath);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe("ready");
      expect(versionRoot).toBeDefined();
      expect(result.versionDirectory).toMatch(
        /^cmaf-hls-aligned-v1-[0-9a-f]{16}$/,
      );

      const metadata = parseAdaptiveMetadata(
        JSON.parse(
          await readFile(path.join(versionRoot!, "metadata.json"), "utf8"),
        ),
      );

      // Every check the validator can make must have run and passed, including
      // the decode-level ones. A package that skipped them would still parse.
      expect(metadata.validation.checks).toEqual(
        expect.arrayContaining([
          "segment-alignment",
          "keyframe-alignment",
          "segment-keyframe-start",
          "seek-decode",
          "cross-quality-splice",
        ]),
      );

      expect(metadata.videoRenditions.length).toBeGreaterThanOrEqual(2);
      expect(metadata.audioRenditions.length).toBeGreaterThanOrEqual(1);
      expect(metadata.segmentTargetSeconds).toBe(2);

      // One media file per rendition, addressed by byte range: this is what
      // keeps a 345-hour library from becoming a million small files.
      for (const rendition of [
        ...metadata.videoRenditions,
        ...metadata.audioRenditions,
      ]) {
        const playlist = parseMediaPlaylist(
          await readFile(
            path.join(versionRoot!, ...rendition.playlistPath.split("/")),
            "utf8",
          ),
        );
        // Audio playlists do not repeat the tag: the master declares it, and
        // per RFC 8216 that applies to every media playlist it references.
        // Video playlists carry it as well, which is where it is load-bearing.
        if (metadata.videoRenditions.includes(rendition as never)) {
          expect(playlist.independentSegments).toBe(true);
        }
        expect(playlist.map.uri).toBe("media.m4s");
        expect(
          new Set(playlist.segments.map((segment) => segment.uri)),
        ).toEqual(new Set(["media.m4s"]));
        const mediaStats = await stat(
          path.join(versionRoot!, ...rendition.mediaPath.split("/")),
        );
        expect(mediaStats.size).toBe(rendition.fileSizeBytes);
      }
    }, 300_000);

    it("cuts every rendition on the same two-second keyframes", async () => {
      if (!ffmpegAvailable) return;

      const sourcePath = path.join(
        getAdaptiveFixtureDirectory(),
        fixture.fileName,
      );
      const { versionRoot } = await packageSource(sourcePath);
      const metadata = parseAdaptiveMetadata(
        JSON.parse(
          await readFile(path.join(versionRoot!, "metadata.json"), "utf8"),
        ),
      );

      const keyframesByRendition = new Map<string, number[]>();
      for (const rendition of metadata.videoRenditions) {
        keyframesByRendition.set(
          rendition.id,
          await probeKeyframeTimes(
            path.join(versionRoot!, ...rendition.mediaPath.split("/")),
            "ffprobe",
          ),
        );
      }

      const [referenceId, referenceTimes] = [...keyframesByRendition][0];
      const referenceBase = referenceTimes[0];

      // Two seconds, measured. An irregular-timestamp source reaches this
      // because keyframes are forced on presentation time rather than on frame
      // counts, which is the whole reason the policy is expressed that way.
      for (let index = 1; index < referenceTimes.length; index += 1) {
        expect(referenceTimes[index] - referenceTimes[index - 1]).toBeCloseTo(
          2,
          1,
        );
      }

      const frameTolerance = 1 / fixture.frameRate + 0.002;
      for (const [id, times] of keyframesByRendition) {
        if (id === referenceId) continue;
        expect(times.length).toBe(referenceTimes.length);
        for (let index = 0; index < times.length; index += 1) {
          expect(
            Math.abs(
              times[index] - times[0] - (referenceTimes[index] - referenceBase),
            ),
          ).toBeLessThanOrEqual(frameTolerance);
        }
      }

      // Segment boundaries, not merely keyframes, must match: they are what a
      // player actually requests when it changes rung mid-playback.
      const boundaries = new Map<string, number[]>();
      for (const rendition of metadata.videoRenditions) {
        const playlist = parseMediaPlaylist(
          await readFile(
            path.join(versionRoot!, ...rendition.playlistPath.split("/")),
            "utf8",
          ),
        );
        let elapsed = 0;
        boundaries.set(
          rendition.id,
          playlist.segments.map((segment) => {
            const start = elapsed;
            elapsed += segment.durationSeconds;
            return start;
          }),
        );
      }
      const referenceBoundaries = [...boundaries.values()][0];
      for (const starts of boundaries.values()) {
        expect(starts).toEqual(referenceBoundaries);
      }
    }, 300_000);

    it("does not duplicate audio into any video rendition", async () => {
      if (!ffmpegAvailable) return;

      const sourcePath = path.join(
        getAdaptiveFixtureDirectory(),
        fixture.fileName,
      );
      const { versionRoot } = await packageSource(sourcePath);
      const metadata = parseAdaptiveMetadata(
        JSON.parse(
          await readFile(path.join(versionRoot!, "metadata.json"), "utf8"),
        ),
      );

      const { probePackagedAudio } = await import("./probePackaged");
      for (const rendition of metadata.videoRenditions) {
        await expect(
          probePackagedAudio(
            path.join(versionRoot!, ...rendition.mediaPath.split("/")),
            "ffprobe",
          ),
        ).rejects.toThrow(/no audio stream/i);
      }
    }, 300_000);
  },
);

describe("adaptive packaging with several audio tracks", () => {
  it("packages one shared audio rendition per source track", async () => {
    if (!ffmpegAvailable) return;

    const sourcePath = path.join(
      getAdaptiveFixtureDirectory(),
      "source-sdr-2398.mp4",
    );
    const { result, versionRoot } = await packageSource(sourcePath, {
      allAudioTracks: true,
    });

    expect(result.status).toBe("ready");
    const metadata = parseAdaptiveMetadata(
      JSON.parse(
        await readFile(path.join(versionRoot!, "metadata.json"), "utf8"),
      ),
    );

    expect(metadata.audioRenditions).toHaveLength(2);
    expect(metadata.audioRenditions.map((rendition) => rendition.id)).toEqual([
      "track-1",
      "track-2",
    ]);
    expect(
      metadata.audioRenditions.map((rendition) => rendition.language),
    ).toEqual(["eng", "tur"]);
    expect(
      metadata.audioRenditions.filter((rendition) => rendition.isDefault),
    ).toHaveLength(1);

    // AC3 is not a browser-decodable fMP4 audio codec, so it must have been
    // re-encoded rather than carried through.
    const turkish = metadata.audioRenditions[1];
    expect(turkish.streamCopied).toBe(false);
    expect(turkish.codec).toBe("aac");
    expect(turkish.sampleRate).toBe(48_000);

    const master = parseMasterPlaylist(
      await readFile(path.join(versionRoot!, "master.m3u8"), "utf8"),
    );
    expect(master.audioRenditions).toHaveLength(2);
    for (const variant of master.variants) {
      expect(variant.audioGroup).toBe("aud");
      // A video variant advertises the audio codec it is paired with even
      // though it carries none of it.
      expect(variant.codecs).toContain("mp4a.40.2");
    }
  }, 300_000);

  it("records tracks a run deliberately left out", async () => {
    if (!ffmpegAvailable) return;

    const sourcePath = path.join(
      getAdaptiveFixtureDirectory(),
      "source-sdr-2398.mp4",
    );
    const { versionRoot } = await packageSource(sourcePath, {
      allAudioTracks: false,
    });
    const metadata = parseAdaptiveMetadata(
      JSON.parse(
        await readFile(path.join(versionRoot!, "metadata.json"), "utf8"),
      ),
    );

    expect(metadata.audioRenditions).toHaveLength(1);
    // Present so an operator can tell "this title has one language" from "this
    // run only packaged the default track".
    expect(metadata.deferredAudioStreamIndexes).toEqual([2]);
  }, 300_000);
});

describe("adaptive packaging of HDR sources", () => {
  it("keeps HDR10 as hvc1-tagged 10-bit HEVC without tone mapping", async () => {
    if (!ffmpegAvailable) return;
    const sourcePath = await ensureAdaptiveHdrFixture();
    if (!sourcePath) {
      console.warn(
        "libx265 is not available; skipping the HDR packaging test.",
      );
      return;
    }

    const { result, versionRoot } = await packageSource(sourcePath, {
      encoderPreference: "software",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ready");

    const metadata = parseAdaptiveMetadata(
      JSON.parse(
        await readFile(path.join(versionRoot!, "metadata.json"), "utf8"),
      ),
    );

    expect(metadata.source.isHdr).toBe(true);
    for (const rendition of metadata.videoRenditions) {
      expect(rendition.codec).toBe("hevc");
      expect(rendition.hdr).toBe("hdr10");
      expect(rendition.pixelFormat).toContain("10");
      expect(rendition.colorTransfer).toBe("smpte2084");
      expect(rendition.codecString.startsWith("hvc1")).toBe(true);
    }

    const master = parseMasterPlaylist(
      await readFile(path.join(versionRoot!, "master.m3u8"), "utf8"),
    );
    for (const variant of master.variants) {
      expect(variant.videoRange).toBe("PQ");
    }

    const validation = await validateAdaptivePackage({
      versionRoot: versionRoot!,
      mediaId: MEDIA_ID,
      deep: true,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  }, 900_000);
});

describe("adaptive packaging refusals", () => {
  it("refuses a source that is not meaningfully larger than the smallest rung", async () => {
    if (!ffmpegAvailable) return;

    const smallSource = path.join(workspace, "small.mp4");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=25:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      smallSource,
    ]);

    const { result } = await packageSource(smallSource);
    expect(result.status).toBe("incompatible");
    expect(result.error).toMatch(/not meaningfully larger/i);
  }, 120_000);

  it("refuses a source with no audio", async () => {
    if (!ffmpegAvailable) return;

    const mute = path.join(workspace, "mute.mp4");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1920x1080:rate=25:duration=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-y",
      mute,
    ]);

    const { result } = await packageSource(mute);
    expect(result.status).toBe("incompatible");
    expect(result.error).toMatch(/no audio stream/i);
  }, 120_000);

  it("does not activate a package when free space would breach the reserve", async () => {
    if (!ffmpegAvailable) return;

    const sourcePath = path.join(
      getAdaptiveFixtureDirectory(),
      "source-sdr-25.mp4",
    );
    const { result } = await packageSource(sourcePath, {
      reserveBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(result.status).toBe("deferred-for-storage");
    expect(result.versionDirectory).toBeUndefined();
  }, 120_000);
});

describe("resume behaviour", () => {
  it("re-points at an already-valid deterministic version instead of re-encoding", async () => {
    if (!ffmpegAvailable) return;

    const sourcePath = path.join(
      getAdaptiveFixtureDirectory(),
      "source-sdr-25.mp4",
    );
    const paths = await createPaths();
    const fingerprint = await computeSourceFingerprint(
      sourcePath,
      await stat(sourcePath),
    );
    const request = {
      mediaId: MEDIA_ID,
      relativePath: "source-sdr-25.mp4",
      sourceFingerprint: fingerprint,
      sourcePath,
    };
    const options = {
      reserveBytes: 0,
      preset: "ultrafast",
      verifySourceFingerprint: false,
    };

    const first = await packageAdaptiveRendition(request, paths, options);
    expect(first.status).toBe("ready");

    const second = await packageAdaptiveRendition(request, paths, options);
    expect(second.status).toBe("already-valid");
    expect(second.versionDirectory).toBe(first.versionDirectory);
  }, 300_000);
});
