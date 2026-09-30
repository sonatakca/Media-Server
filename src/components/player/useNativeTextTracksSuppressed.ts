import { useEffect, type RefObject } from "react";
import { disableNativeVideoTextTracks } from "./subtitleUtils";

/**
 * Keeps the browser's own subtitle rendering off.
 *
 * Subtitles are drawn by the player's overlay; a native track the engine turns
 * on by itself (Safari does, on attach and on every track change) would draw a
 * second copy underneath. The source and the deck epoch name what makes
 * the element or its source new, so the listeners follow it.
 */
export function useNativeTextTracksSuppressed(
  videoRef: RefObject<HTMLVideoElement | null>,
  sourceId: string,
  sourceUrl: string,
  deckEpoch: number,
): void {
  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    const disableTracks = () => {
      disableNativeVideoTextTracks(video);
    };

    disableTracks();

    video.addEventListener("loadedmetadata", disableTracks);
    video.addEventListener("loadeddata", disableTracks);
    video.addEventListener("canplay", disableTracks);
    video.addEventListener("play", disableTracks);

    video.textTracks.addEventListener?.("addtrack", disableTracks);
    video.textTracks.addEventListener?.("change", disableTracks);

    const interval = window.setInterval(disableTracks, 500);

    return () => {
      video.removeEventListener("loadedmetadata", disableTracks);
      video.removeEventListener("loadeddata", disableTracks);
      video.removeEventListener("canplay", disableTracks);
      video.removeEventListener("play", disableTracks);

      video.textTracks.removeEventListener?.("addtrack", disableTracks);
      video.textTracks.removeEventListener?.("change", disableTracks);

      window.clearInterval(interval);
    };
  }, [sourceId, sourceUrl, deckEpoch, videoRef]);
}
