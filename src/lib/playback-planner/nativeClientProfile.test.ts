import { describe, expect, it } from "vitest";
import { createNativeClientCapabilities } from "./nativeClientProfile";

describe("createNativeClientCapabilities", () => {
  it("creates a broad but explicit libmpv desktop profile", () => {
    const profile = createNativeClientCapabilities({
      platform: "win32",
      deviceId: "desktop-1",
    });

    expect(profile.playbackEngine).toBe("native");
    expect(profile.nativePlayer).toMatchObject({
      engine: "libmpv",
      hardwareDecoding: true,
      supports10BitVideo: true,
      subtitles: {
        text: true,
        ass: true,
        imageBased: true,
      },
    });
    expect(profile.nativePlayer?.supportedContainers).toContain("mkv");
    expect(profile.nativePlayer?.supportedVideoCodecs).toContain("hevc");
    expect(profile.nativePlayer?.supportedAudioCodecs).toContain("dts");
  });
});
