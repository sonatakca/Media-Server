import { describe, expect, it } from "vitest";
import type { AvailableQualityFile } from "../../renditions/contracts";
import {
  loadQualityPreference,
  isQualityAudioCompatible,
  resolveManualHeight,
  saveQualityPreference,
  displayTargetHeight,
  selectAutoQuality,
  selectHigherResolutionQuality,
  selectLowDataQuality,
  selectManualQuality,
  shouldSwitchFileQuality,
} from "./qualityPreference";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const qualities: AvailableQualityFile[] = [
  {
    id: "original",
    label: "Original (2160p)",
    kind: "original",
    width: 3840,
    height: 2160,
    playbackUrl: "/original",
  },
  {
    id: "generated-1080",
    label: "1080p",
    kind: "generated",
    width: 1920,
    height: 1080,
    playbackUrl: "/1080.mp4",
  },
  {
    id: "generated-720",
    label: "720p",
    kind: "generated",
    width: 1280,
    height: 720,
    playbackUrl: "/720.mp4",
  },
  {
    id: "generated-480",
    label: "480p",
    kind: "generated",
    width: 854,
    height: 480,
    playbackUrl: "/480.mp4",
  },
];

describe("quality preference persistence", () => {
  it("defaults to Auto and isolates preferences by user", () => {
    const storage = new MemoryStorage();
    saveQualityPreference({ mode: "low-data" }, "user-a", storage);

    expect(loadQualityPreference("user-a", storage)).toEqual({
      mode: "low-data",
    });
    expect(loadQualityPreference("user-b", storage)).toEqual({ mode: "auto" });
  });

  it("persists a stable manual quality id and rejects invalid values safely", () => {
    const storage = new MemoryStorage();
    saveQualityPreference(
      {
        mode: "advanced",
        preferredHeight: 720,
        preferredQualityId: "generated-720",
      },
      "user-a",
      storage,
    );
    expect(loadQualityPreference("user-a", storage)).toEqual({
      mode: "advanced",
      preferredHeight: 720,
      preferredQualityId: "generated-720",
    });

    storage.setItem(
      "seyirlik:quality-preference:user-a",
      '{"mode":"ultra","preferredHeight":999}',
    );
    expect(loadQualityPreference("user-a", storage)).toEqual({ mode: "auto" });
  });

  it("chooses the nearest lower manual height and never silently upgrades", () => {
    expect(resolveManualHeight(1080, [2160, 720, 480])).toBe(720);
    expect(resolveManualHeight(360, [2160, 720, 480])).toBe(480);
    expect(resolveManualHeight(720, [1080, 720, 480])).toBe(720);
  });
});

describe("complete-file quality selection", () => {
  it("does not silently replace a selected audio track with a generated file encoded from another track", () => {
    const generated = qualities.find(
      (quality) => quality.id === "generated-720",
    )!;
    const original = qualities.find((quality) => quality.kind === "original")!;
    const generatedWithAudio = { ...generated, sourceAudioStreamIndex: 1 };

    expect(isQualityAudioCompatible(generatedWithAudio, 1)).toBe(true);
    expect(isQualityAudioCompatible(generatedWithAudio, 2)).toBe(false);
    expect(isQualityAudioCompatible(original, 2)).toBe(true);
  });

  it("selects only existing files for Low Data and Higher Resolution", () => {
    expect(selectLowDataQuality(qualities)?.id).toBe("generated-480");
    expect(selectHigherResolutionQuality(qualities)?.id).toBe("original");
    expect(
      selectLowDataQuality(
        qualities.filter((quality) => quality.height !== 480),
      )?.id,
    ).toBe("generated-720");
  });

  it("selects Auto from player size and conservative network information", () => {
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 360,
        devicePixelRatio: 1,
        saveData: true,
      })?.height,
    ).toBe(480);
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 600,
        devicePixelRatio: 1,
      })?.height,
    ).toBe(720);
    // Safari and Firefox report no connection info. Auto used to cap at 720p
    // there no matter how large the player was, so it could never climb.
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 1000,
        devicePixelRatio: 2,
      })?.height,
    ).toBe(1080);
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 900,
        devicePixelRatio: 1,
        downlinkMbps: 15,
      })?.height,
    ).toBe(1080);
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 2160,
        devicePixelRatio: 2,
        downlinkMbps: 30,
      })?.height,
    ).toBe(2160);
  });

  it("resolves Advanced only to a quality actually present", () => {
    expect(
      selectManualQuality(qualities, {
        mode: "advanced",
        preferredQualityId: "generated-720",
      })?.playbackUrl,
    ).toBe("/720.mp4");

    // A different title rarely carries the same generated file, so the saved
    // height falls back to the nearest lower available quality.
    expect(
      selectManualQuality(
        qualities.filter((quality) => quality.id !== "generated-720"),
        {
          mode: "advanced",
          preferredQualityId: "generated-720",
          preferredHeight: 720,
        },
      )?.playbackUrl,
    ).toBe("/480.mp4");

    // When nothing lower exists the lowest available quality is used, never a
    // silent upgrade.
    expect(
      selectManualQuality(
        qualities.filter((quality) => quality.height >= 1080),
        {
          mode: "advanced",
          preferredQualityId: "generated-720",
          preferredHeight: 720,
        },
      )?.playbackUrl,
    ).toBe("/1080.mp4");

    // Without a usable height there is nothing to resolve to.
    expect(
      selectManualQuality(qualities, {
        mode: "advanced",
        preferredQualityId: "generated-1440",
      }),
    ).toBeUndefined();
  });

  it("reports what the display can use, with the pixel ratio capped at 2", () => {
    expect(displayTargetHeight(1000, 2)).toBe(2000);
    expect(displayTargetHeight(1000, 4)).toBe(2000);
    expect(displayTargetHeight(1000, undefined)).toBe(1000);
    // A container measured before layout must not collapse the target to zero.
    expect(displayTargetHeight(0, 2)).toBe(2);
  });

  it("uses cooldown and hysteresis while allowing repeated-stall downgrades", () => {
    expect(
      shouldSwitchFileQuality({
        currentHeight: 720,
        candidateHeight: 1080,
        now: 10_000,
        lastSwitchAt: 0,
      }),
    ).toBe(false);
    expect(
      shouldSwitchFileQuality({
        currentHeight: 1080,
        candidateHeight: 720,
        now: 10_000,
        lastSwitchAt: 5_000,
        recentStallCount: 2,
      }),
    ).toBe(true);
    expect(
      shouldSwitchFileQuality({
        currentHeight: 720,
        candidateHeight: 1080,
        now: 40_000,
        lastSwitchAt: 0,
      }),
    ).toBe(true);
  });
});
