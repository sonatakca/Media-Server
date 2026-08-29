import Hls from "hls.js";

export interface AttachedVideoSource {
  usingHlsJs: boolean;
  adaptiveController?: AdaptiveHlsController;
  destroy: () => void;
}

export interface AdaptiveHlsController {
  /** `height` locks one level; null returns future fragments to ABR. */
  setQualityHeight(height: number | null, maxHeight?: number | null): void;
  setAudioStream(sourceStreamIndex: number): boolean;
}

export interface HlsPlaybackEvent {
  name: string;
  data?: unknown;
}

export interface AttachSourceOptions {
  onHlsEvent?: (event: HlsPlaybackEvent) => void;
  onHlsFatalError?: (data: unknown) => void;
  onAdaptiveLevelChanged?: (height: number) => void;
}

export function isHlsPlaybackUrl(
  playbackUrl: string,
  mimeType?: string,
): boolean {
  const lowerUrl = playbackUrl.toLowerCase();
  const lowerMime = mimeType?.toLowerCase() ?? "";

  return (
    lowerUrl.includes(".m3u8") ||
    lowerMime.includes("mpegurl") ||
    lowerMime.includes("x-mpegurl")
  );
}

function getNativeHlsSupport(
  videoElement: HTMLVideoElement,
): CanPlayTypeResult {
  const appleHlsSupport = videoElement.canPlayType(
    "application/vnd.apple.mpegurl",
  );

  return appleHlsSupport || videoElement.canPlayType("application/x-mpegURL");
}

function isAppleNativeHlsRuntime(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent;

  if (/iPad|iPhone|iPod/i.test(userAgent)) {
    return true;
  }

  return (
    /Safari/i.test(userAgent) &&
    !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|SamsungBrowser/i.test(userAgent)
  );
}

export function shouldUseNativeHls(videoElement: HTMLVideoElement): boolean {
  const nativeSupport = getNativeHlsSupport(videoElement);

  if (nativeSupport === "probably") {
    return true;
  }

  return nativeSupport === "maybe" && isAppleNativeHlsRuntime();
}

function getRequestedMaxHeight(playbackUrl: string): number | null {
  try {
    const url = new URL(playbackUrl);
    const rawMaxHeight =
      url.searchParams.get("maxHeight") ?? url.searchParams.get("MaxHeight");
    const maxHeight = rawMaxHeight ? Number(rawMaxHeight) : NaN;

    return Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : null;
  } catch {
    return null;
  }
}

function getBestAllowedHlsLevel(
  hls: Hls,
  requestedMaxHeight: number | null,
): number {
  let bestLevel = -1;
  let bestScore = -1;

  hls.levels.forEach((level, index) => {
    const height = level.height || 0;
    const bitrate = level.bitrate || 0;

    if (requestedMaxHeight !== null && height > requestedMaxHeight) {
      return;
    }

    const score = height * 10_000_000 + bitrate;

    if (score > bestScore) {
      bestScore = score;
      bestLevel = index;
    }
  });

  if (bestLevel >= 0) {
    return bestLevel;
  }

  return hls.levels.reduce((bestIndex, level, index) => {
    const bestLevelSoFar = hls.levels[bestIndex];

    if (!bestLevelSoFar) {
      return index;
    }

    const levelScore = (level.height || 0) * 10_000_000 + (level.bitrate || 0);
    const bestScoreSoFar =
      (bestLevelSoFar.height || 0) * 10_000_000 + (bestLevelSoFar.bitrate || 0);

    return levelScore > bestScoreSoFar ? index : bestIndex;
  }, 0);
}

export function attachSourceToVideo(
  videoElement: HTMLVideoElement,
  playbackUrl: string,
  mimeType?: string,
  options: AttachSourceOptions = {},
): AttachedVideoSource {
  const isHls = isHlsPlaybackUrl(playbackUrl, mimeType);
  const requestedMaxHeight = getRequestedMaxHeight(playbackUrl);

  if (isHls && shouldUseNativeHls(videoElement)) {
    videoElement.src = playbackUrl;
    return {
      usingHlsJs: false,
      destroy: () => {
        videoElement.removeAttribute("src");
        videoElement.load();
      },
    };
  }

  if (isHls && Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      capLevelToPlayerSize: true,
      lowLatencyMode: false,
      startLevel: -1,
      abrEwmaDefaultEstimate: 5_000_000,
      maxStarvationDelay: 4,
      maxLoadingDelay: 4,
      testBandwidth: true,
    });
    let lockedHeight: number | null = null;
    let maximumHeight: number | null = requestedMaxHeight;

    const levelAtOrBelow = (height: number | null): number => {
      if (height === null) return -1;
      const allowed = hls.levels
        .map((level, index) => ({ index, height: level.height || 0 }))
        .filter((level) => level.height <= height)
        .sort((left, right) => right.height - left.height);
      return allowed[0]?.index ?? getBestAllowedHlsLevel(hls, height);
    };

    const applyAdaptivePreference = () => {
      if (hls.levels.length === 0) return;
      hls.autoLevelCapping = levelAtOrBelow(maximumHeight);

      if (lockedHeight === null) {
        // Back to automatic: future fragments follow ABR again, and nothing
        // already buffered needs to be thrown away to get there.
        hls.nextLevel = -1;
        hls.loadLevel = -1;
        return;
      }

      // An explicit rung is a promise to the viewer, so it has to become the
      // picture within a second or two. `loadLevel` alone only changes what is
      // fetched next, and a title whose whole timeline is already buffered has
      // nothing left to fetch — the click then does nothing visible for
      // minutes, until the old rung has finished playing out. `nextLevel`
      // replaces the buffer ahead of the play head while leaving the fragment
      // currently on screen alone, so the change lands quickly without the
      // black frame that flushing everything (`currentLevel`) would cause.
      const level = levelAtOrBelow(lockedHeight);
      hls.loadLevel = level;
      if (hls.nextLevel !== level) hls.nextLevel = level;
    };

    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.MANIFEST_PARSED, data });
      applyAdaptivePreference();
    });
    hls.on(Hls.Events.LEVELS_UPDATED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.LEVELS_UPDATED, data });
      applyAdaptivePreference();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.LEVEL_SWITCHED, data });
      const level = hls.levels[data.level];
      if (level?.height) options.onAdaptiveLevelChanged?.(level.height);

      console.info("[Seyirlik Playback] HLS level switched", {
        level: data.level,
        width: level?.width,
        height: level?.height,
        bitrate: level?.bitrate,
        requestedMaxHeight,
        autoLevelCapping: hls.autoLevelCapping,
      });
    });

    hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.FRAG_BUFFERED, data });
    });

    hls.on(Hls.Events.BUFFER_APPENDED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.BUFFER_APPENDED, data });
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.ERROR, data });

      if (data.fatal) {
        console.error("[Seyirlik Playback] hls.js fatal error", data);
        if (options.onHlsFatalError) {
          options.onHlsFatalError(data);
        } else {
          videoElement.dispatchEvent(new Event("error"));
        }
      } else {
        console.warn("[Seyirlik Playback] hls.js warning", data);
      }
    });

    hls.loadSource(playbackUrl);
    hls.attachMedia(videoElement);

    return {
      usingHlsJs: true,
      adaptiveController: {
        setQualityHeight: (height, maxHeight = null) => {
          lockedHeight = height;
          maximumHeight = maxHeight;
          applyAdaptivePreference();
        },
        setAudioStream: (sourceStreamIndex) => {
          const marker = `track-${sourceStreamIndex}`;
          const index = hls.audioTracks.findIndex((track) => {
            const candidate = track as typeof track & { url?: string };
            return (
              candidate.url?.includes(marker) || candidate.name.includes(marker)
            );
          });
          if (index < 0) return false;
          hls.audioTrack = index;
          return true;
        },
      },
      destroy: () => {
        hls.destroy();
        videoElement.removeAttribute("src");
        videoElement.load();
      },
    };
  }

  if (isHls) {
    throw new Error(
      "This browser cannot attach HLS playback. Safari supports HLS natively, while Chrome, Edge, and Firefox need MediaSource Extensions.",
    );
  }

  videoElement.src = playbackUrl;

  return {
    usingHlsJs: false,
    destroy: () => {
      videoElement.removeAttribute("src");
      videoElement.load();
    },
  };
}
