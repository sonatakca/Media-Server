import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildClientCapabilities } from "./clientCapabilities";

const originalMediaCapabilitiesDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaCapabilities",
);

describe("buildClientCapabilities", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
      "probably",
    );
    vi.stubGlobal("MediaSource", {
      isTypeSupported: vi.fn(() => true),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    if (originalMediaCapabilitiesDescriptor) {
      Object.defineProperty(
        navigator,
        "mediaCapabilities",
        originalMediaCapabilitiesDescriptor,
      );
    } else {
      Reflect.deleteProperty(navigator, "mediaCapabilities");
    }
  });

  it("starts independent codec probes concurrently", async () => {
    const decodingInfo = vi.fn(async () => ({
      supported: true,
      smooth: true,
      powerEfficient: true,
    }));
    Object.defineProperty(navigator, "mediaCapabilities", {
      configurable: true,
      value: { decodingInfo },
    });

    const capabilitiesPromise = buildClientCapabilities();

    expect(decodingInfo).toHaveBeenCalledTimes(12);

    const capabilities = await capabilitiesPromise;
    expect(capabilities.video.h264?.supported).toBe(true);
    expect(capabilities.audio.aac?.supported).toBe(true);
  });
});
