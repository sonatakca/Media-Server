import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildClientCapabilities,
  videoOnlyContentType,
} from "./clientCapabilities";

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

    // Seven video probes, each asked both the combined and the video-only way,
    // plus six audio probes — all dispatched before the first await resolves.
    expect(decodingInfo).toHaveBeenCalledTimes(20);

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

describe("videoOnlyContentType", () => {
  it("drops the audio codec from a combined content type", () => {
    expect(
      videoOnlyContentType('video/mp4; codecs="avc1.640028, mp4a.40.2"'),
    ).toBe('video/mp4; codecs="avc1.640028"');
    expect(
      videoOnlyContentType('video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"'),
    ).toBe('video/mp4; codecs="hvc1.2.4.L153.B0"');
  });

  it("leaves a type that already names only a video codec alone", () => {
    expect(videoOnlyContentType('video/mp4; codecs="av01.0.08M.08"')).toBe(
      'video/mp4; codecs="av01.0.08M.08"',
    );
    expect(videoOnlyContentType("video/mp4")).toBe("video/mp4");
  });

  it("leaves a type naming no recognisable video codec alone", () => {
    expect(videoOnlyContentType('audio/mp4; codecs="mp4a.40.2"')).toBe(
      'audio/mp4; codecs="mp4a.40.2"',
    );
  });
});

describe("decodingInfo queries", () => {
  it("keeps a browser's combined-form answers when it answers them", async () => {
    // Safari answers the combined form correctly, including refusing 10-bit
    // H.264 that `canPlayType` wrongly calls playable. Its results must survive
    // untouched — the Chrome workaround must not become a second source of
    // truth that overrides a browser that was already right.
    const decodingInfo = vi.fn(async (config: MediaDecodingConfiguration) => ({
      supported: !/avc1\.6E/.test(config.video?.contentType ?? ""),
      smooth: true,
      powerEfficient: true,
    }));

    Object.defineProperty(navigator, "mediaCapabilities", {
      configurable: true,
      value: { decodingInfo },
    });

    const capabilities = await buildClientCapabilities();

    expect(capabilities.video.h264?.supported).toBe(true);
    expect(capabilities.video.hevc?.supported).toBe(true);
    // 10-bit H.264 was refused by one probe and allowed by the others, so the
    // merged answer stays true — what matters is that the refusal was heard at
    // all rather than replaced by the video-only query.
    const calls = decodingInfo.mock.calls
      .map(([config]) => config.video?.contentType)
      .filter((type): type is string => Boolean(type));
    expect(calls.some((type) => /mp4a/.test(type))).toBe(true);
  });

  it("falls back to the video-only answer when a browser rejects every combined query", async () => {
    // Chrome answers `supported: false` for a video content type that also
    // names an audio codec — for every codec, H.264 included. Because
    // `decodingInfo` is authoritative here, that reported the client as unable
    // to decode anything, and the server then withheld every pre-generated
    // rendition: the quality picker offered only the original in Chrome while
    // Safari, which is lenient about the combined type, showed the full ladder.
    const decodingInfo = vi.fn(async (config: MediaDecodingConfiguration) => ({
      supported: !/mp4a|opus|ac-3|ec-3|flac/.test(
        config.video?.contentType ?? "",
      ),
      smooth: true,
      powerEfficient: true,
    }));

    Object.defineProperty(navigator, "mediaCapabilities", {
      configurable: true,
      value: { decodingInfo },
    });

    const capabilities = await buildClientCapabilities();

    // Audio probes call the same API without a video member; only the video
    // queries are under test here.
    const videoQueries = decodingInfo.mock.calls
      .map(([config]) => config.video?.contentType)
      .filter((contentType): contentType is string => Boolean(contentType));

    // Both forms are asked; the video-only one is what rescues this browser.
    expect(
      videoQueries.some((contentType) => !/mp4a|opus/.test(contentType)),
    ).toBe(true);
    expect(capabilities.video.h264?.supported).toBe(true);
    expect(capabilities.video.hevc?.supported).toBe(true);
  });
});
