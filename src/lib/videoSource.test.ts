import { describe, expect, it, beforeEach, vi } from "vitest";
import { attachSourceToVideo, shouldUseNativeHls } from "./videoSource";

const hlsMock = vi.hoisted(() => ({
  instances: [] as Array<{
    attachMedia: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    loadSource: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    autoLevelCapping: number;
    currentLevel: number;
    loadLevel: number;
    nextLevel: number;
    audioTrack: number;
    audioTracks: Array<{ name: string; url?: string }>;
    levels: Array<{ width: number; height: number; bitrate: number }>;
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
    loadLevel = -1;
    levels: Array<{ width: number; height: number; bitrate: number }> = [];
    nextLevel = -1;
    startLevel = -1;
    audioTrack = -1;
    audioTracks: Array<{ name: string; url?: string }> = [];
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

  it("applies a manual rung ahead of the play head and returns to ABR without flushing", () => {
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const onAdaptiveLevelChanged = vi.fn();
    const attachment = attachSourceToVideo(
      createVideo(""),
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
      { onAdaptiveLevelChanged },
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [
      { width: 854, height: 480, bitrate: 1_500_000 },
      { width: 1280, height: 720, bitrate: 3_000_000 },
      { width: 1920, height: 1080, bitrate: 6_000_000 },
    ];
    hls.trigger("manifestParsed", {});

    attachment.adaptiveController?.setQualityHeight(720, 720);
    expect(hls.loadLevel).toBe(1);
    expect(hls.autoLevelCapping).toBe(1);
    // `nextLevel` replaces what is buffered ahead, so a title whose whole
    // timeline is already downloaded still changes rung within a second or two
    // instead of waiting minutes for the old one to play out.
    expect(hls.nextLevel).toBe(1);
    // The fragment on screen is left alone: flushing everything is what puts a
    // black frame in front of the viewer.
    expect(hls.currentLevel).toBe(-1);

    hls.trigger("levelSwitched", { level: 1 });
    expect(onAdaptiveLevelChanged).toHaveBeenCalledWith(720);

    attachment.adaptiveController?.setQualityHeight(null, null);
    expect(hls.loadLevel).toBe(-1);
    expect(hls.autoLevelCapping).toBe(-1);
    expect(hls.nextLevel).toBe(-1);
    expect(hls.currentLevel).toBe(-1);
  });

  describe("hls.js audio rendition switching", () => {
    function attachWithTracks(tracks: Array<{ name: string; url?: string }>) {
      setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
      const attachment = attachSourceToVideo(
        createVideo(""),
        "http://example.test/play/master.m3u8",
        "application/vnd.apple.mpegurl",
      );
      const hls = hlsMock.instances[0];
      if (!hls) throw new Error("hls.js was not attached");
      hls.audioTracks = tracks;
      return { attachment, hls };
    }

    /**
     * Audio renditions are addressed by their source stream index, which is
     * what the package's directory names carry, so a regenerated package that
     * drops a track cannot silently re-point a saved choice at another
     * language.
     */
    it("selects a rendition by its source stream index", () => {
      const { attachment, hls } = attachWithTracks([
        {
          name: "English",
          url: "https://media.test/audio/track-1/playlist.m3u8",
        },
        {
          name: "Turkish",
          url: "https://media.test/audio/track-2/playlist.m3u8",
        },
        {
          name: "French",
          url: "https://media.test/audio/track-3/playlist.m3u8",
        },
      ]);

      expect(attachment.adaptiveController?.setAudioStream(2)).toBe(true);
      expect(hls.audioTrack).toBe(1);

      expect(attachment.adaptiveController?.setAudioStream(3)).toBe(true);
      expect(hls.audioTrack).toBe(2);

      expect(attachment.adaptiveController?.setAudioStream(1)).toBe(true);
      expect(hls.audioTrack).toBe(0);
    });

    it("reports a rendition the package does not carry rather than silently keeping the old one", () => {
      const { attachment, hls } = attachWithTracks([
        {
          name: "English",
          url: "https://media.test/audio/track-1/playlist.m3u8",
        },
      ]);
      hls.audioTrack = 0;

      expect(attachment.adaptiveController?.setAudioStream(7)).toBe(false);
      expect(hls.audioTrack).toBe(0);
    });

    it("falls back to the rendition name when the track carries no url", () => {
      const { attachment, hls } = attachWithTracks([
        { name: "audio/track-1" },
        { name: "audio/track-2" },
      ]);

      expect(attachment.adaptiveController?.setAudioStream(2)).toBe(true);
      expect(hls.audioTrack).toBe(1);
    });

    it("has no controller at all on a native HLS engine", () => {
      // Safari plays the package itself, so there is nothing to call. The
      // player must recognise this and re-plan rather than treat the missing
      // controller as a completed switch.
      setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      );
      const attachment = attachSourceToVideo(
        createVideo("maybe"),
        "http://example.test/play/master.m3u8",
        "application/vnd.apple.mpegurl",
      );

      expect(attachment.usingHlsJs).toBe(false);
      expect(attachment.adaptiveController).toBeUndefined();
    });
  });

  it("caps automatic switching without pinning a rung", () => {
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const attachment = attachSourceToVideo(
      createVideo(""),
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [
      { width: 854, height: 480, bitrate: 1_500_000 },
      { width: 1280, height: 720, bitrate: 3_000_000 },
      { width: 1920, height: 1080, bitrate: 6_000_000 },
    ];
    hls.trigger("manifestParsed", {});

    // A ceiling is not a lock: ABR still chooses, it just may not go above 720p.
    attachment.adaptiveController?.setQualityHeight(null, 720);

    expect(hls.autoLevelCapping).toBe(1);
    expect(hls.loadLevel).toBe(-1);
    expect(hls.nextLevel).toBe(-1);
  });
});
