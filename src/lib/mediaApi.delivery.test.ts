import { describe, expect, it } from "vitest";
import { buildPlaybackCandidates } from "./mediaApi";
import type { PlaybackInfoResponse } from "./types";

/**
 * Which URL the player actually attaches.
 *
 * The pre-generated package manifest travels with every plan, including the
 * plans where the server chose a live session instead — so the manifest alone
 * cannot say what to play. Only the delivery URL can.
 */

const ADAPTIVE_URL =
  "/ownAPI/v1/playback/renditions/file-1/adaptive/abc123/master.m3u8";
const LIVE_URL = "/ownAPI/v1/playback/sessions/session-1/master.m3u8";

function playbackInfo(deliveryUrl: string): PlaybackInfoResponse {
  return {
    MediaSources: [
      {
        Id: "file-1",
        SupportsDirectPlay: false,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
        TranscodingUrl: deliveryUrl,
        TranscodingSubProtocol: "hls",
      },
    ],
    PlaySessionId: "session-1",
    qualityManifest: {
      mediaId: "file-1",
      qualities: [],
      adaptive: {
        playbackUrl: ADAPTIVE_URL,
        audioTracks: [{ sourceStreamIndex: 1 }],
        qualities: [],
      },
    },
  } as unknown as PlaybackInfoResponse;
}

describe("choosing what to attach", () => {
  it("plays the package when the server delivered the package", () => {
    const [candidate] = buildPlaybackCandidates(
      "item-1",
      playbackInfo(ADAPTIVE_URL),
    );

    expect(candidate?.url).toBe(ADAPTIVE_URL);
    expect(candidate?.hlsKind).toBe("adaptive-rendition");
  });

  /**
   * Asking for an audio track the retention policy dropped is the ordinary way
   * to reach this: the package cannot serve it, so the server plans a live
   * session and still describes the package alongside. Playing the package
   * anyway left the requested track silent and restarted the title, because the
   * URL never changed and the switch was skipped as a no-op.
   */
  it("plays the live session when the server chose one over the package", () => {
    const [candidate] = buildPlaybackCandidates(
      "item-1",
      playbackInfo(LIVE_URL),
    );

    expect(candidate?.url).toBe(LIVE_URL);
    expect(candidate?.hlsKind).not.toBe("adaptive-rendition");
  });

  it("still marks a live session as an HLS source", () => {
    const [candidate] = buildPlaybackCandidates(
      "item-1",
      playbackInfo(LIVE_URL),
    );

    expect(candidate?.isHls).toBe(true);
    expect(candidate?.mimeType).toBe("application/vnd.apple.mpegurl");
  });
});
