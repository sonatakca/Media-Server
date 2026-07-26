import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackSourceCandidate } from "../lib/types";
import { usePlaybackSource } from "./usePlaybackSource";

const preloadMocks = vi.hoisted(() => ({
  preloadPlaybackSource: vi.fn(),
  readCachedPlaybackSource: vi.fn(),
  releasePlaybackSourceLease: vi.fn(),
}));
const tMock = vi.hoisted(() => vi.fn((key: string) => key));

vi.mock("../lib/playbackPreload", () => preloadMocks);
vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: tMock }),
}));

function source(): PlaybackSourceCandidate {
  return {
    id: "source-1",
    itemId: "movie-1",
    mode: "DirectPlay",
    url: "http://backend.test/direct/media-token",
    isHls: false,
    hlsKind: "direct",
    label: "Direct play",
    mediaSource: {},
    reason: "Direct play supported",
    priority: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  preloadMocks.readCachedPlaybackSource.mockReturnValue(null);
  preloadMocks.preloadPlaybackSource.mockResolvedValue({
    itemId: "movie-1",
    candidates: [source()],
    createdAtMs: Date.now(),
  });
});

describe("usePlaybackSource", () => {
  it("clears a reported startup failure after the active video recovers", async () => {
    const { result } = renderHook(() => usePlaybackSource("movie-1"));

    await waitFor(() => expect(result.current.activeSource).not.toBeNull());

    act(() => result.current.handleVideoFailure("startup timeout"));
    expect(result.current.error).not.toBeNull();

    act(() => result.current.handleVideoRecovery());
    expect(result.current.error).toBeNull();
  });
});
