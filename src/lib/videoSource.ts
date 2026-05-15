import Hls from "hls.js";

export interface AttachedVideoSource {
  usingHlsJs: boolean;
  destroy: () => void;
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
): AttachedVideoSource {
  const isHls = isHlsPlaybackUrl(playbackUrl, mimeType);
  const requestedMaxHeight = getRequestedMaxHeight(playbackUrl);

  if (isHls && videoElement.canPlayType("application/vnd.apple.mpegurl")) {
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
      capLevelToPlayerSize: false,
      lowLatencyMode: false,
      startLevel: -1,
      abrEwmaDefaultEstimate: 35_000_000,
      maxStarvationDelay: 4,
      maxLoadingDelay: 4,
      testBandwidth: false,
    });

    const lockInitialBestLevel = () => {
      const bestLevel = getBestAllowedHlsLevel(hls, requestedMaxHeight);

      if (bestLevel < 0) {
        return;
      }

      hls.autoLevelCapping = bestLevel;
      hls.startLevel = bestLevel;
      hls.nextLevel = bestLevel;
      hls.currentLevel = bestLevel;

      window.setTimeout(() => {
        if (hls.levels.length > 0) {
          hls.currentLevel = -1;
          hls.nextLevel = -1;
          hls.autoLevelCapping = getBestAllowedHlsLevel(
            hls,
            requestedMaxHeight,
          );
        }
      }, 18_000);
    };

    hls.on(Hls.Events.MANIFEST_PARSED, lockInitialBestLevel);
    hls.on(Hls.Events.LEVELS_UPDATED, lockInitialBestLevel);

    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      const level = hls.levels[data.level];

      console.info("[Seyirlik Playback] HLS level switched", {
        level: data.level,
        width: level?.width,
        height: level?.height,
        bitrate: level?.bitrate,
        requestedMaxHeight,
        autoLevelCapping: hls.autoLevelCapping,
      });
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        console.error("[Seyirlik Playback] hls.js fatal error", data);
        videoElement.dispatchEvent(new Event("error"));
      } else {
        console.warn("[Seyirlik Playback] hls.js warning", data);
      }
    });

    hls.loadSource(playbackUrl);
    hls.attachMedia(videoElement);

    return {
      usingHlsJs: true,
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
