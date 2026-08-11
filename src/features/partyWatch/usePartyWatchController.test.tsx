import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { usePartyWatchController } from "./usePartyWatchController";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock("../../lib/authStorage", () => ({
  getCachedSession: () => null,
}));

// `vi.mock` is hoisted above ordinary declarations, so the spies the factory
// closes over have to be hoisted with it.
const { sendPartyWatchPlay, sendPartyWatchPause, sendPartyWatchSeek } =
  vi.hoisted(() => ({
    sendPartyWatchPlay: vi.fn(async () => null),
    sendPartyWatchPause: vi.fn(async () => null),
    sendPartyWatchSeek: vi.fn(async () => null),
  }));

vi.mock("./partyWatchApi", () => ({
  closePartyWatchGroup: vi.fn(),
  connectPartyWatchStream: () => ({ close: () => {} }),
  createPartyWatchGroup: vi.fn(),
  getPartyWatchGroup: vi.fn(),
  joinPartyWatchGroup: vi.fn(),
  leavePartyWatchGroup: vi.fn(),
  reportPartyWatchStatus: vi.fn(),
  sendPartyWatchPause,
  sendPartyWatchPlay,
  sendPartyWatchSeek,
}));

/** A video element with just the surface the controller drives. */
function fakeVideo(overrides: Partial<HTMLVideoElement> = {}) {
  const play = vi.fn(async () => undefined);
  const pause = vi.fn();
  const video = {
    paused: true,
    ended: false,
    duration: 600,
    currentTime: 30,
    play,
    pause,
    ...overrides,
  } as unknown as HTMLVideoElement;
  return { video, play, pause };
}

function render(video: HTMLVideoElement | null) {
  const refreshProgress = vi.fn();
  const videoRef = createRef<HTMLVideoElement>() as {
    current: HTMLVideoElement | null;
  };
  videoRef.current = video;

  const hook = renderHook(() =>
    usePartyWatchController({
      videoRef: videoRef as never,
      itemId: "item-1",
      title: "Dune",
      currentTime: 30,
      isPlaying: false,
      refreshProgress,
      showControls: vi.fn(),
    }),
  );

  return { hook, refreshProgress };
}

describe("party watch controller outside a group", () => {
  it("plays and pauses the local element", () => {
    // Every player control routes through this controller. Doing nothing here
    // is doing nothing at all: the pause and seek buttons were dead for anyone
    // watching alone, which is nearly everyone.
    const { video, play, pause } = fakeVideo({ paused: true });
    const { hook } = render(video);

    act(() => hook.result.current.togglePlay());
    expect(play).toHaveBeenCalled();

    (video as { paused: boolean }).paused = false;
    act(() => hook.result.current.togglePlay());
    expect(pause).toHaveBeenCalled();

    // Nothing is sent to the server; there is no group to command.
    expect(sendPartyWatchPlay).not.toHaveBeenCalled();
    expect(sendPartyWatchPause).not.toHaveBeenCalled();
  });

  it("seeks the local element and refreshes the displayed position", () => {
    const { video } = fakeVideo();
    const { hook, refreshProgress } = render(video);

    act(() => hook.result.current.seekTo(120));

    expect(video.currentTime).toBe(120);
    expect(refreshProgress).toHaveBeenCalled();
    expect(sendPartyWatchSeek).not.toHaveBeenCalled();
  });

  it("seeks relative to where the element actually is", () => {
    const { video } = fakeVideo({ currentTime: 30 });
    const { hook } = render(video);

    act(() => hook.result.current.seekBy(-10));
    expect(video.currentTime).toBe(20);
  });

  it("clamps a seek inside the media rather than past its end", () => {
    const { video } = fakeVideo({ duration: 600, currentTime: 595 });
    const { hook } = render(video);

    act(() => hook.result.current.seekBy(30));
    expect(video.currentTime).toBeLessThan(600);

    act(() => hook.result.current.seekTo(-50));
    expect(video.currentTime).toBe(0);
  });

  it("does not write NaN before the duration is known", () => {
    // `duration` is NaN until metadata arrives. Clamping against it then would
    // put the position at NaN and lose the viewer's place entirely.
    const { video } = fakeVideo({ duration: Number.NaN, currentTime: 0 });
    const { hook } = render(video);

    act(() => hook.result.current.seekTo(45));
    expect(video.currentTime).toBe(45);
  });

  it("does nothing when there is no element yet", () => {
    const { hook } = render(null);
    expect(() => act(() => hook.result.current.togglePlay())).not.toThrow();
    expect(() => act(() => hook.result.current.seekTo(10))).not.toThrow();
  });
});
