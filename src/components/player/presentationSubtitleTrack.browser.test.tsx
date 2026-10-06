import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import type { SubtitleCue } from "./types";
import { useNativeTextTracksSuppressed } from "./useNativeTextTracksSuppressed";
import {
  isPresentationSubtitleTrack,
  usePresentationSubtitleTrack,
} from "./usePresentationSubtitleTrack";

/**
 * Picture in Picture cannot be opened headlessly, so the element reports the
 * mode WebKit would and fires the event WebKit fires; what is under test is
 * the track the system window would draw.
 */
function Harness({
  cues,
  delaySeconds = 0,
}: {
  cues: SubtitleCue[];
  delaySeconds?: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useNativeTextTracksSuppressed(videoRef, "source", "url", 0);
  usePresentationSubtitleTrack(videoRef, 0, cues, delaySeconds, "Subtitles");
  return <video ref={videoRef} playsInline muted />;
}

let presentationMode = "inline";

function mountVideo(cues: SubtitleCue[], delaySeconds?: number) {
  presentationMode = "inline";
  const result = render(<Harness cues={cues} delaySeconds={delaySeconds} />);
  const video = result.container.querySelector("video")!;
  Object.defineProperty(video, "webkitPresentationMode", {
    configurable: true,
    get: () => presentationMode,
  });
  return { ...result, video };
}

function presentationTrack(video: HTMLVideoElement): TextTrack {
  const tracks = Array.from(video.textTracks).filter(
    isPresentationSubtitleTrack,
  );
  expect(tracks).toHaveLength(1);
  return tracks[0];
}

async function setPresentationMode(video: HTMLVideoElement, mode: string) {
  presentationMode = mode;
  await act(async () => {
    video.dispatchEvent(new Event("webkitpresentationmodechanged"));
  });
}

const CUES: SubtitleCue[] = [
  { start: 1, end: 3, text: "<i>Merhaba</i> & hoş geldin" },
  { start: 4, end: 6, text: "Second line" },
];

afterEach(() => {
  cleanup();
});

describe("subtitles in Picture in Picture", () => {
  it("keeps the track hidden while the page draws its own overlay", () => {
    const { video } = mountVideo(CUES);
    const track = presentationTrack(video);

    expect(track.mode).toBe("hidden");
    expect(track.cues).toHaveLength(2);
  });

  it("shows the cues while the system holds the element, and hides them after", async () => {
    const { video } = mountVideo(CUES);
    const track = presentationTrack(video);

    await setPresentationMode(video, "picture-in-picture");
    expect(track.mode).toBe("showing");

    // The suppression hook turns every native track off on a timer. This one
    // must not even flicker: each round trip would blink the captions.
    let modeChanges = 0;
    const countChange = () => {
      modeChanges += 1;
    };
    video.textTracks.addEventListener("change", countChange);
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    video.textTracks.removeEventListener("change", countChange);
    expect(modeChanges).toBe(0);
    expect(track.mode).toBe("showing");

    await setPresentationMode(video, "inline");
    expect(track.mode).toBe("hidden");

    await setPresentationMode(video, "fullscreen");
    expect(track.mode).toBe("showing");
  });

  it("carries the overlay's delay and plain text into the cues", () => {
    const { video } = mountVideo(CUES, 1.5);
    const cue = presentationTrack(video).cues![0] as VTTCue;

    expect(cue.startTime).toBeCloseTo(2.5);
    expect(cue.endTime).toBeCloseTo(4.5);
    expect(cue.text).toBe("Merhaba &amp; hoş geldin");
    expect(cue.getCueAsHTML().textContent).toBe("Merhaba & hoş geldin");
  });

  it("empties and disables the track when subtitles are turned off", async () => {
    const { video, rerender } = mountVideo(CUES);
    const track = presentationTrack(video);

    await setPresentationMode(video, "picture-in-picture");
    rerender(<Harness cues={[]} />);

    expect(track.mode).toBe("disabled");
    track.mode = "hidden";
    expect(track.cues).toHaveLength(0);
  });

  it("adds no track to an element that never had subtitles", () => {
    const { video } = mountVideo([]);

    expect(
      Array.from(video.textTracks).filter(isPresentationSubtitleTrack),
    ).toHaveLength(0);
  });
});
