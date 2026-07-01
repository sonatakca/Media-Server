import { describe, expect, it, beforeEach, vi } from "vitest";
import { attachSourceToVideo, shouldUseNativeHls } from "./videoSource";

const hlsMock = vi.hoisted(() => ({
  instances: [] as Array<{
    attachMedia: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    loadSource: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    trigger: (event: string, data?: unknown) => void;
  }>,
  isSupported: vi.fn(() => true),
}));

vi.mock("hls.js", () => {
  class HlsMock {
    static Events = {
      ERROR: "error",
      BUFFER_APPENDED: "hlsBufferAppended",
      FRAG_BUFFERED: "hlsFragBuffered",
      LEVEL_SWITCHED: "levelSwitched",
      LEVELS_UPDATED: "levelsUpdated",
      MANIFEST_PARSED: "manifestParsed",
    };

    static isSupported = hlsMock.isSupported;

    autoLevelCapping = -1;
    currentLevel = -1;
    levels = [];
    nextLevel = -1;
    startLevel = -1;
    handlers = new Map<
      string,
      Array<(event: string, data?: unknown) => void>
    >();

    attachMedia = vi.fn();
    destroy = vi.fn();
    loadSource = vi.fn();
    on = vi.fn(
      (event: string, handler: (event: string, data?: unknown) => void) => {
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
      },
    );

    trigger(event: string, data?: unknown) {
      this.handlers.get(event)?.forEach((handler) => handler(event, data));
    }

    constructor() {
      hlsMock.instances.push(this);
    }
  }

  return { default: HlsMock };
});

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

function createVideo(nativeHlsSupport: CanPlayTypeResult): HTMLVideoElement {
  const video = document.createElement("video");

  vi.spyOn(video, "canPlayType").mockImplementation((mimeType) =>
    mimeType.toLowerCase().includes("mpegurl") ? nativeHlsSupport : "",
  );

  return video;
}

describe("videoSource", () => {
  beforeEach(() => {
    hlsMock.instances.length = 0;
    hlsMock.isSupported.mockReturnValue(true);
  });

  it("uses hls.js when Chromium only reports maybe native HLS support", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );
    const video = createVideo("maybe");
    const url = "http://example.test/play/master.m3u8";

    const attachment = attachSourceToVideo(
      video,
      url,
      "application/vnd.apple.mpegurl",
    );

    expect(attachment.usingHlsJs).toBe(true);
    expect(video.getAttribute("src")).toBeNull();
    expect(hlsMock.instances).toHaveLength(1);
    expect(hlsMock.instances[0]?.loadSource).toHaveBeenCalledWith(url);
    expect(hlsMock.instances[0]?.attachMedia).toHaveBeenCalledWith(video);
  });

  it("forwards HLS buffered and fatal events to attempt-aware callbacks", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );
    const video = createVideo("");
    const onHlsEvent = vi.fn();
    const onHlsFatalError = vi.fn();

    attachSourceToVideo(
      video,
      "http://example.test/play/master.m3u8",
      undefined,
      {
        onHlsEvent,
        onHlsFatalError,
      },
    );

    const hls = hlsMock.instances[0];

    hls?.trigger("hlsFragBuffered", { frag: "one" });
    hls?.trigger("error", {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });

    expect(onHlsEvent).toHaveBeenCalledWith({
      name: "hlsFragBuffered",
      data: { frag: "one" },
    });
    expect(onHlsFatalError).toHaveBeenCalledWith({
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });
  });

  it("keeps native HLS for Safari maybe support", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    );
    const video = createVideo("maybe");

    expect(shouldUseNativeHls(video)).toBe(true);
  });

  it("keeps native HLS for a strong probably signal", () => {
    setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Custom/1.0",
    );
    const video = createVideo("probably");

    expect(shouldUseNativeHls(video)).toBe(true);
  });
});
