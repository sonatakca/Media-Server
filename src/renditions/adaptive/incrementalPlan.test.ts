import { describe, expect, it } from "vitest";
import {
  planPackageWork,
  type ExistingPackageShape,
  type PlanPackageWorkInput,
  type RenditionPresence,
} from "./incrementalPlan";

/**
 * Building only what is missing.
 *
 * The bug these guard: a title holding seven valid renditions was put through
 * a full eight-rung encode to gain one missing rung, because the encoder was
 * handed the desired ladder rather than the outstanding work.
 */

const LADDER = [2160, 1440, 1080, 720, 480, 360, 240, 144].map(
  (qualityHeight) => ({ qualityHeight }),
);

const FINGERPRINT = "f".repeat(64);
const PROFILE = "cmaf-hls-aligned-v3";

function presenceOf(
  video: readonly string[],
  audio: readonly string[] = ["track-1"],
  subtitle: readonly string[] = ["subtitle-2"],
): RenditionPresence {
  return {
    video: new Set(video),
    audio: new Set(audio),
    subtitle: new Set(subtitle),
  };
}

function packageWith(
  videoHeights: readonly number[],
  audioIds: readonly string[] = ["track-1"],
  subtitleIds: readonly string[] = ["subtitle-2"],
): ExistingPackageShape {
  return {
    sourceFingerprint: FINGERPRINT,
    profileVersion: PROFILE,
    video: videoHeights.map((qualityHeight) => ({
      id: `${qualityHeight}p`,
      qualityHeight,
    })),
    audio: audioIds.map((id) => ({ id })),
    subtitle: subtitleIds.map((id) => ({ id })),
  };
}

function plan(overrides: Partial<PlanPackageWorkInput> = {}) {
  return planPackageWork({
    requirements: LADDER,
    existing: packageWith([2160, 1080, 720, 480, 360, 240, 144]),
    presence: presenceOf([
      "2160p",
      "1080p",
      "720p",
      "480p",
      "360p",
      "240p",
      "144p",
    ]),
    sourceFingerprint: FINGERPRINT,
    profileVersion: PROFILE,
    requiredAudioStreamIndexes: [1],
    requiredSubtitleStreamIndexes: [2],
    ...overrides,
  });
}

describe("planning how much of a package to build", () => {
  /** TEST 1 — the Ford v Ferrari case: one rung short of today's ladder. */
  it("encodes only the one rung the ladder gained", () => {
    const result = plan();

    expect(result.mode).toBe("incremental");
    expect(result.videoQualityHeights).toEqual([1440]);
    // Adding a video rung is not a reason to re-encode sound or text.
    expect(result.audioStreamIndexes).toEqual([]);
    expect(result.subtitleStreamIndexes).toEqual([]);
    expect(result.reason).toContain("1440p");
  });

  /** TEST 2 — an arbitrary, non-contiguous subset of the ladder is missing. */
  it("encodes exactly the missing subset and nothing around it", () => {
    const result = plan({
      existing: packageWith([2160, 1080, 720, 360, 144]),
      presence: presenceOf(["2160p", "1080p", "720p", "360p", "144p"]),
    });

    expect(result.mode).toBe("incremental");
    expect(result.videoQualityHeights).toEqual([240, 480, 1440]);
    expect(result.audioStreamIndexes).toEqual([]);
  });

  /** TEST 3 — a complete package is not work. */
  it("asks for no encode when everything required is present", () => {
    const result = plan({
      existing: packageWith([2160, 1440, 1080, 720, 480, 360, 240, 144]),
      presence: presenceOf([
        "2160p",
        "1440p",
        "1080p",
        "720p",
        "480p",
        "360p",
        "240p",
        "144p",
      ]),
    });

    expect(result.mode).toBe("none");
    expect(result.videoQualityHeights).toEqual([]);
    expect(result.audioStreamIndexes).toEqual([]);
    expect(result.subtitleStreamIndexes).toEqual([]);
  });

  /** TEST 4 — a brand new title still builds the whole ladder. */
  it("builds the complete ladder for a title with no package", () => {
    const result = plan({ existing: null });

    expect(result.mode).toBe("full");
    expect(result.videoQualityHeights).toEqual([
      144, 240, 360, 480, 720, 1080, 1440, 2160,
    ]);
    expect(result.audioStreamIndexes).toEqual([1]);
    expect(result.subtitleStreamIndexes).toEqual([2]);
  });

  /** TEST 5 — audio missing while every video rendition is good. */
  it("processes only audio when the video ladder is complete", () => {
    const result = plan({
      existing: packageWith(
        [2160, 1440, 1080, 720, 480, 360, 240, 144],
        [],
        ["subtitle-2"],
      ),
      presence: presenceOf(
        ["2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p"],
        [],
      ),
    });

    expect(result.mode).toBe("incremental");
    expect(result.videoQualityHeights).toEqual([]);
    expect(result.audioStreamIndexes).toEqual([1]);
  });

  /**
   * TEST 6 — a listed rendition whose media file is gone.
   *
   * The manifest still advertises it, so only the on-disk check can tell that
   * it is not finished work.
   */
  it("rebuilds a rendition whose files are missing despite being listed", () => {
    const result = plan({
      existing: packageWith([2160, 1440, 1080, 720, 480, 360, 240, 144]),
      presence: presenceOf([
        "2160p",
        "1440p",
        "1080p",
        // 720p is listed by the manifest but absent or truncated on disk.
        "480p",
        "360p",
        "240p",
        "144p",
      ]),
    });

    expect(result.mode).toBe("incremental");
    expect(result.videoQualityHeights).toEqual([720]);
  });

  /**
   * A changed source or a newer profile invalidates everything at once, which
   * is the existing safety mechanism and must keep working.
   */
  it("rebuilds everything when the source or the profile changed", () => {
    expect(plan({ sourceFingerprint: "a".repeat(64) }).mode).toBe("full");
    expect(plan({ profileVersion: "cmaf-hls-aligned-v9" }).mode).toBe("full");
  });

  /** A missing subtitle track must not drag video or audio in with it. */
  it("extracts only the missing subtitle track", () => {
    const result = plan({
      existing: packageWith(
        [2160, 1440, 1080, 720, 480, 360, 240, 144],
        ["track-1"],
        [],
      ),
      presence: presenceOf(
        ["2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p"],
        ["track-1"],
        [],
      ),
    });

    expect(result.mode).toBe("incremental");
    expect(result.videoQualityHeights).toEqual([]);
    expect(result.audioStreamIndexes).toEqual([]);
    expect(result.subtitleStreamIndexes).toEqual([2]);
  });
});
