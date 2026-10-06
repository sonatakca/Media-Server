import { useEffect, type RefObject } from "react";
import type { SubtitleCue } from "./types";
import { decodeCueText } from "./subtitleUtils";

type WebKitPresentationVideo = HTMLVideoElement & {
  webkitPresentationMode?: "inline" | "picture-in-picture" | "fullscreen";
  webkitDisplayingFullscreen?: boolean;
};

/**
 * The text track each element carries for the system to draw.
 *
 * A track made with `addTextTrack` can never be removed, so each element gets
 * exactly one and keeps it; only its cues change.
 */
const presentationTracks = new WeakMap<HTMLVideoElement, TextTrack>();
const presentationTrackSet = new WeakSet<TextTrack>();

/** The track the suppression hook must leave alone. */
export function isPresentationSubtitleTrack(track: TextTrack): boolean {
  return presentationTrackSet.has(track);
}

/**
 * Whether the system, not the page, is showing this element: Picture in
 * Picture anywhere, or the native full-screen player on iPhone. The page's
 * subtitle overlay is invisible in both.
 */
export function isPresentedOutsidePage(video: HTMLVideoElement): boolean {
  const webkitVideo = video as WebKitPresentationVideo;
  const mode = webkitVideo.webkitPresentationMode;

  if (mode === "picture-in-picture" || mode === "fullscreen") return true;
  if (document.pictureInPictureElement === video) return true;

  return webkitVideo.webkitDisplayingFullscreen === true;
}

/** Cue text is markup; the decoded line is plain text and must stay so. */
function toCueMarkup(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clearCues(track: TextTrack): void {
  // `cues` is null while a track is disabled.
  if (track.mode === "disabled") track.mode = "hidden";

  const cues = track.cues;
  if (!cues) return;

  for (let index = cues.length - 1; index >= 0; index -= 1) {
    track.removeCue(cues[index]);
  }
}

const PRESENTATION_EVENTS = [
  "webkitpresentationmodechanged",
  "enterpictureinpicture",
  "leavepictureinpicture",
  "webkitbeginfullscreen",
  "webkitendfullscreen",
] as const;

/**
 * Carries the overlay's subtitles into the windows the page cannot draw in.
 *
 * Subtitles are normally the player's own overlay, and every native track is
 * kept off so nothing draws a second copy. Picture in Picture and the iPhone's
 * native full-screen player only ever show the element itself, so the same
 * cues — shifted by the same delay — ride on one native track that is showing
 * exactly while the system holds the element, and hidden the rest of the time.
 */
export function usePresentationSubtitleTrack(
  videoRef: RefObject<HTMLVideoElement | null>,
  deckEpoch: number,
  cues: SubtitleCue[],
  delaySeconds: number,
  label: string,
): void {
  useEffect(() => {
    const video = videoRef.current;
    const existingTrack = video ? presentationTracks.get(video) : undefined;

    if (!video || (cues.length === 0 && !existingTrack)) {
      return undefined;
    }

    if (typeof window.VTTCue !== "function") {
      return undefined;
    }

    let track = existingTrack;
    if (!track) {
      track = video.addTextTrack("subtitles", label);
      presentationTracks.set(video, track);
      presentationTrackSet.add(track);
    }
    const ownTrack = track;

    clearCues(ownTrack);

    for (const cue of cues) {
      const start = cue.start + delaySeconds;
      const end = cue.end + delaySeconds;
      const text = decodeCueText(cue.text);

      if (end <= 0 || !text) continue;

      ownTrack.addCue(new VTTCue(Math.max(0, start), end, toCueMarkup(text)));
    }

    const syncMode = () => {
      const nextMode: TextTrackMode =
        cues.length === 0
          ? "disabled"
          : isPresentedOutsidePage(video)
            ? "showing"
            : "hidden";

      if (ownTrack.mode !== nextMode) ownTrack.mode = nextMode;
    };

    syncMode();

    for (const eventName of PRESENTATION_EVENTS) {
      video.addEventListener(eventName, syncMode);
    }
    // Safari picks a track to show by itself, from the viewer's caption
    // settings; this one only answers to the presentation mode.
    video.textTracks.addEventListener?.("change", syncMode);

    return () => {
      for (const eventName of PRESENTATION_EVENTS) {
        video.removeEventListener(eventName, syncMode);
      }
      video.textTracks.removeEventListener?.("change", syncMode);

      // The element may be about to become the standby deck, or hold another
      // title's cues next; it must not keep drawing these.
      clearCues(ownTrack);
      ownTrack.mode = "disabled";
    };
  }, [cues, deckEpoch, delaySeconds, label, videoRef]);
}
