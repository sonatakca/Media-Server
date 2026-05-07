import Hls from "hls.js";

export interface AttachedVideoSource {
  usingHlsJs: boolean;
  destroy: () => void;
}

export function isHlsPlaybackUrl(playbackUrl: string, mimeType?: string): boolean {
  const lowerUrl = playbackUrl.toLowerCase();
  const lowerMime = mimeType?.toLowerCase() ?? "";

  return lowerUrl.includes(".m3u8") || lowerMime.includes("mpegurl") || lowerMime.includes("x-mpegurl");
}

export function attachSourceToVideo(
  videoElement: HTMLVideoElement,
  playbackUrl: string,
  mimeType?: string,
): AttachedVideoSource {
  const isHls = isHlsPlaybackUrl(playbackUrl, mimeType);

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
      capLevelToPlayerSize: true,
      lowLatencyMode: false,
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
    throw new Error("This browser cannot attach HLS playback. Safari supports HLS natively, while Chrome, Edge, and Firefox need MediaSource Extensions.");
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
