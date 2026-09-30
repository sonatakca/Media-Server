import { describe, expect, it } from "vitest";
import type { PlaybackSourceCandidate } from "../../lib/types";
import type {
  AdaptiveQualityManifest,
  AvailableQualityFile,
} from "../../renditions/contracts";
import {
  buildAdvancedQualityOptions,
  buildQualityFileSourceFor,
} from "./qualityOptions";

const t = (key: string) =>
  key === "player.qualityOriginalWithHeight" ? "Original {height}p" : key;

const original: AvailableQualityFile = {
  id: "original",
  label: "Original",
  kind: "original",
  width: 3840,
  height: 1600,
  container: "mkv",
  playbackUrl: "/sessions/s1/file",
};
const generated: AvailableQualityFile = {
  id: "g720",
  label: "720p",
  kind: "generated",
  width: 1280,
  height: 720,
  container: "mp4",
  playbackUrl: "/renditions/g720.mp4",
};

const source = {
  id: "plan",
  itemId: "item",
  mediaSourceId: "media",
  url: "/renditions/adaptive/master.m3u8",
  mode: "DirectStream",
  isHls: true,
  hlsKind: "adaptive-rendition",
  playSessionId: "s1",
  mediaSource: { Id: "media", Container: "mkv", SupportsDirectPlay: false },
} as unknown as PlaybackSourceCandidate;

describe("buildQualityFileSourceFor", () => {
  it("plays the original directly when the title opened on its adaptive package", () => {
    const candidate = buildQualityFileSourceFor(source, undefined, original);
    expect(candidate.id).toBe("quality-file-original");
    expect(candidate.isHls).toBe(false);
    expect(candidate.url).toBe("/sessions/s1/file");
  });

  it("returns the planned source untouched for the original of a non-adaptive plan", () => {
    const plain = { ...source, hlsKind: undefined, isHls: false };
    expect(buildQualityFileSourceFor(plain, undefined, original)).toBe(plain);
  });

  it("keeps the playback session on a generated file, for its subtitles", () => {
    const candidate = buildQualityFileSourceFor(source, undefined, generated);
    expect(candidate.id).toBe("quality-file-g720");
    expect(candidate.playSessionId).toBe("s1");
    expect(candidate.mimeType).toBe("video/mp4");
    expect(candidate.mediaSource.Container).toBe("mp4");
  });
});

describe("buildAdvancedQualityOptions", () => {
  it("lists adaptive rungs lowest first with the original on top", () => {
    const adaptive = {
      qualities: [
        {
          id: "a1080",
          label: "1080p",
          width: 1920,
          height: 1080,
          bitrate: 8e6,
        },
        { id: "a480", label: "480p", width: 854, height: 480, bitrate: 1e6 },
      ],
    } as unknown as AdaptiveQualityManifest;
    const options = buildAdvancedQualityOptions({
      adaptiveManifest: adaptive,
      availableQualityFiles: [original, generated],
      selectedAudioStreamIndex: undefined,
      t,
    });
    expect(options.map((option) => option.id)).toEqual([
      "a480",
      "a1080",
      "original",
    ]);
    expect(options[2]?.label).toBe("Original 1600p");
  });

  it("lists complete files when there is no adaptive package", () => {
    const options = buildAdvancedQualityOptions({
      adaptiveManifest: undefined,
      availableQualityFiles: [original, generated],
      selectedAudioStreamIndex: undefined,
      t,
    });
    expect(options.map((option) => option.label)).toEqual([
      "720p",
      "Original 1600p",
    ]);
  });
});
