import { describe, expect, it } from "vitest";
import {
  isMultivariantPlaylist,
  playlistReferences,
  withoutIFramePlaylists,
} from "./playlist";

const BASE =
  "https://playback.test/ownAPI/v1/playback/renditions/f/adaptive/abc/";

const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Türkçe",LANGUAGE="tur",DEFAULT=YES,AUTOSELECT=YES,URI="audio/track-1/playlist.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="eng",DEFAULT=NO,AUTOSELECT=YES,URI="audio/track-2/playlist.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Türkçe",LANGUAGE="tur",URI="subtitle/tr/playlist.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="aac",SUBTITLES="subs"',
  "video/720/playlist.m3u8",
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=200000,URI="video/720/iframes.m3u8"',
].join("\n");

describe("playlistReferences", () => {
  it("names every playlist a master points at, absolutely", () => {
    expect(playlistReferences(MASTER, `${BASE}master.m3u8?height=720`)).toEqual(
      [
        `${BASE}audio/track-1/playlist.m3u8`,
        `${BASE}audio/track-2/playlist.m3u8`,
        `${BASE}subtitle/tr/playlist.m3u8`,
        `${BASE}video/720/playlist.m3u8`,
        `${BASE}video/720/iframes.m3u8`,
      ],
    );
  });

  it("names a byte-ranged file once, with its init segment", () => {
    const media = [
      "#EXTM3U",
      '#EXT-X-MAP:URI="video.mp4",BYTERANGE="800@0"',
      "#EXT-X-BYTERANGE:1000@800",
      "#EXTINF:6.0,",
      "video.mp4",
      "#EXT-X-BYTERANGE:1000@1800",
      "#EXTINF:6.0,",
      "video.mp4",
      "#EXT-X-ENDLIST",
    ].join("\n");
    expect(playlistReferences(media, `${BASE}video/720/playlist.m3u8`)).toEqual(
      [`${BASE}video/720/video.mp4`],
    );
  });
});

describe("withoutIFramePlaylists", () => {
  it("keeps every dub and subtitle, and drops trick play", () => {
    const kept = withoutIFramePlaylists(MASTER);
    expect(kept).toContain('NAME="Türkçe",LANGUAGE="tur",DEFAULT=YES');
    expect(kept).toContain('NAME="English"');
    expect(kept).toContain("TYPE=SUBTITLES");
    expect(kept).not.toContain("I-FRAME");
    expect(isMultivariantPlaylist(kept)).toBe(true);
  });
});
