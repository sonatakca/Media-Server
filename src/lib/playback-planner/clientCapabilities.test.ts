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

    expect(decodingInfo).toHaveBeenCalledTimes(13);

    const capabilities = await capabilitiesPromise;
    expect(capabilities.video.h264?.supported).toBe(true);
    expect(capabilities.audio.aac?.supported).toBe(true);
  });

  it("reports 10-bit and HDR H.264 when the client decodes High 10", async () => {
    Reflect.deleteProperty(navigator, "mediaCapabilities");

    const capabilities = await buildClientCapabilities();

    // High 10 carries 10-bit HDR H.264 masters; without it such originals are
    // classed as needing FFmpeg and never offered as a playable quality.
    expect(capabilities.video.h264?.supports10Bit).toBe(true);
    expect(capabilities.video.h264?.supportsHdr).toBe(true);
  });

  it("believes decodingInfo over canPlayType about High 10", async () => {
    // Safari answers "probably" for avc1.6E0034 because it matches `avc1`
    // without reading the profile. Trusting that reported a 10-bit master as
    // playable, and the element then failed to decode it — a fatal player error
    // on a title with a perfectly good rendition to fall back to.
    const decodingInfo = vi.fn(
      async (configuration: { video?: { contentType?: string } }) => ({
        supported: !configuration.video?.contentType?.includes("avc1.6E"),
        smooth: true,
        powerEfficient: true,
      }),
    );
    Object.defineProperty(navigator, "mediaCapabilities", {
      configurable: true,
      value: { decodingInfo },
    });

    const capabilities = await buildClientCapabilities();

    // canPlayType said "probably" for every probe, including High 10.
    expect(capabilities.video.h264?.supported).toBe(true);
    expect(capabilities.video.h264?.supports10Bit).toBe(false);
  });

  it("leaves H.264 as 8-bit only when High 10 is not decodable", async () => {
    Reflect.deleteProperty(navigator, "mediaCapabilities");
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation(
      (mimeType: string) => (mimeType.includes("avc1.6E") ? "" : "probably"),
    );
    vi.stubGlobal("MediaSource", {
      isTypeSupported: vi.fn(
        (mimeType: string) => !mimeType.includes("avc1.6E"),
      ),
    });

    const capabilities = await buildClientCapabilities();

    expect(capabilities.video.h264?.supported).toBe(true);
    expect(capabilities.video.h264?.supports10Bit).toBe(false);
  });
});
