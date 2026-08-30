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
  /**
   * What the engine has actually measured the link to carry, in bits/second.
   *
   * This is throughput observed while pulling real fragments, which is a far
   * better number than `navigator.connection.downlink` — that is a coarse,
   * rounded hint the browser volunteers, and Safari and Firefox do not
   * volunteer it at all. Undefined when no estimate exists yet.
   */
  getBandwidthEstimateBps(): number | undefined;
}

export interface HlsPlaybackEvent {
  name: string;
  data?: unknown;
}

export interface AttachSourceOptions {
  onHlsEvent?: (event: HlsPlaybackEvent) => void;
  onHlsFatalError?: (data: unknown) => void;
  /**
   * The level now on screen. `width` is reported alongside `height` because a
   * ladder rung is named by its class (1080p) while the frame it produces is
   * whatever the source's shape gives — a 2.39:1 master's "2160p" rung is
   * 3840x1608. Matching a rung by frame height alone therefore fails on every
   * letterboxed title, so the caller is given the width to match on instead.
   */
  onAdaptiveLevelChanged?: (level: { height: number; width: number }) => void;
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
      /*
       * Deliberately off. hls.js's own cap controller writes `autoLevelCapping`
       * on a timer, and this file writes it too whenever the viewer's choice
       * changes — two owners of one property, where whoever ran last wins. The
       * visible symptom is Auto ignoring the ladder: the cap the viewer's mode
       * implies gets overwritten a second later by a size-derived one, and an
       * element measured while it is hidden or mid-reattach measures zero,
       * which that controller reads as "the smallest rung will do". Capping is
       * done in `applyAdaptivePreference` instead, where both inputs are
       * considered together and a zero measurement is not mistaken for a
       * request for 144p.
       */
      capLevelToPlayerSize: false,
      lowLatencyMode: false,
      startLevel: -1,
      abrEwmaDefaultEstimate: 5_000_000,
      maxStarvationDelay: 4,
      maxLoadingDelay: 4,
      testBandwidth: true,
      /*
       * Recover from a dip roughly as fast as we fell into it.
       *
       * The defaults are tuned for the open internet, where a link that just
       * failed is assumed likely to fail again, so the estimate is slow to
       * forgive and up-switches demand a wide margin. Measured against this
       * ladder that produced a badly asymmetric Auto: a drop to the bottom rung
       * happened within seconds, while climbing back took minutes at a
       * bandwidth that had comfortably served a much higher rung on the way
       * down. To a viewer that reads as Auto going to 144p and staying there.
       *
       * A media server on a home network is the opposite case — the link is
       * usually excellent and a dip is usually transient — so the estimate is
       * given a shorter memory and up-switches a smaller margin. Down-switching
       * is deliberately left at its default: being quick to protect playback is
       * the behaviour that was already right.
       */
      /*
       * Only the slow half of the estimate is shortened. Speeding up the fast
       * half as well was measurably worse: at a bandwidth with little headroom
       * it re-tried the rung above on every sample and oscillated between two
       * rungs, which is more distracting to watch than simply sitting on the
       * lower one. The slow half is what carries the memory of a bad patch, so
       * it is the half worth shortening.
       */
      abrEwmaSlowVoD: 6.0,
      abrBandWidthUpFactor: 0.8,
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

    /**
     * The tallest rung this player is physically able to show, or null when
     * that cannot be known yet.
     *
     * Returning null rather than zero is the point: an element that is hidden,
     * detached, or between sources measures nothing, and treating that as a
     * ceiling would pin Auto to the bottom rung exactly when it is least able
     * to argue back. A cap is only applied once the element has a real size.
     */
    const displayCapHeight = (): number | null => {
      const rect = videoElement.getBoundingClientRect();
      const ratio =
        typeof window === "undefined"
          ? 1
          : Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      const usable = Math.round(rect.height * ratio);
      return usable > 0 ? usable : null;
    };

    const applyAdaptivePreference = () => {
      if (hls.levels.length === 0) return;
      // The lower of what the viewer asked for and what the screen can show,
      // with either side allowed to be absent.
      const display = displayCapHeight();
      const ceiling =
        maximumHeight !== null && display !== null
          ? Math.min(maximumHeight, display)
          : (maximumHeight ?? display);
      hls.autoLevelCapping = levelAtOrBelow(ceiling);

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
      if (level?.height) {
        options.onAdaptiveLevelChanged?.({
          height: level.height,
          width: level.width ?? 0,
        });
      }

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

    /*
     * The display ceiling changes with the window, with fullscreen, and simply
     * with the element gaining a size after layout. Re-evaluating on resize is
     * what lets a player that was measured at zero recover the moment it has
     * real dimensions, instead of staying capped for the rest of the session.
     */
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => applyAdaptivePreference());
    observer?.observe(videoElement);

    return {
      usingHlsJs: true,
      adaptiveController: {
        setQualityHeight: (height, maxHeight = null) => {
          lockedHeight = height;
          maximumHeight = maxHeight;
          applyAdaptivePreference();
        },
        getBandwidthEstimateBps: () => {
          const estimate = hls.bandwidthEstimate;
          return typeof estimate === "number" &&
            Number.isFinite(estimate) &&
            estimate > 0
            ? estimate
            : undefined;
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
        observer?.disconnect();
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
