import { describe, expect, it } from "vitest";
import {
  mediaUriFromPlaylist,
  planTitleLayout,
  playlistUri,
  rewriteMasterPlaylist,
  rewriteRenditionPlaylist,
} from "./titleLayout";

function video(
  overrides: Partial<{
    id: string;
    qualityHeight: number;
    frameRate: number;
    hdr: "sdr" | "hdr10";
  }> = {},
) {
  return {
    id: "1080p",
    qualityHeight: 1080,
    frameRate: 23.976,
    hdr: "sdr" as const,
    ...overrides,
  } as never;
}

/**
 * `isDefault` is deliberately fixed true: a track's name must be decided by the
 * source's `original` disposition alone, so every case here that comes out
 * unqualified is also evidence that the default flag no longer leaks into it.
 */
function audio(
  overrides: Partial<{
    id: string;
    language: string;
    title: string;
    isOriginal: boolean;
    isCommentary: boolean;
  }> = {},
) {
  return {
    id: "track-1",
    language: "eng",
    isDefault: true,
    ...overrides,
  } as never;
}

describe("where a package lands in the title folder", () => {
  it("names video rungs the way the settings panel does", () => {
    const plan = planTitleLayout({
      videoRenditions: [
        video({
          id: "2160p",
          qualityHeight: 2160,
          frameRate: 60,
          hdr: "hdr10",
        }),
        video({ id: "1080p", qualityHeight: 1080, frameRate: 60 }),
        video({ id: "480p", qualityHeight: 480, frameRate: 30 }),
      ],
      audioRenditions: [],
    });

    expect(plan.video.map((rendition) => rendition.mediaPath)).toEqual([
      "video/2160p60 HDR.mp4",
      "video/1080p60.mp4",
      "video/480p.mp4",
    ]);
  });

  it("names audio and subtitle files by language", () => {
    const plan = planTitleLayout({
      videoRenditions: [],
      audioRenditions: [
        audio({ id: "track-1", language: "eng", isOriginal: true }),
        audio({ id: "track-2", language: "tur" }),
      ],
      subtitleRenditions: [
        { id: "subtitle-4", language: "eng", isForced: false } as never,
        { id: "subtitle-6", language: "eng", isForced: true } as never,
      ],
    });

    expect(plan.audio.map((rendition) => rendition.mediaPath)).toEqual([
      "audio/english (original).m4a",
      "audio/turkish.m4a",
    ]);
    expect(plan.subtitle.map((rendition) => rendition.mediaPath)).toEqual([
      "subtitle/english.vtt",
      "subtitle/english (forced).vtt",
    ]);
  });

  /**
   * A Turkish remux routinely ships its dub flagged default while the film was
   * shot in English. Naming from the default flag called that dub the original.
   */
  it("does not call the default track original", () => {
    const plan = planTitleLayout({
      videoRenditions: [],
      audioRenditions: [
        audio({ id: "track-1", language: "tur" }),
        audio({ id: "track-2", language: "eng", isOriginal: true }),
      ],
    });

    expect(plan.audio.map((rendition) => rendition.mediaPath)).toEqual([
      "audio/turkish.m4a",
      "audio/english (original).m4a",
    ]);
  });

  it("marks a commentary track as one", () => {
    const plan = planTitleLayout({
      videoRenditions: [],
      audioRenditions: [audio({ id: "track-3", isCommentary: true })],
    });

    expect(plan.audio[0]?.mediaPath).toBe("audio/english (commentary).m4a");
  });

  /**
   * Two tracks reducing to one name would be one file, and the second would
   * quietly replace the first.
   */
  it("keeps two tracks that would share a name apart", () => {
    const plan = planTitleLayout({
      videoRenditions: [],
      audioRenditions: [
        audio({ id: "track-1", language: "eng" }),
        audio({ id: "track-2", language: "eng" }),
      ],
    });

    expect(plan.audio.map((rendition) => rendition.mediaPath)).toEqual([
      "audio/english.m4a",
      "audio/english (2).m4a",
    ]);
  });

  it("hides the playlists and the manifest away from the media folders", () => {
    const plan = planTitleLayout({
      videoRenditions: [video()],
      audioRenditions: [audio({ isOriginal: true })],
    });

    expect(plan.video[0]?.playlistPath).toBe(".seyirlik/video/1080p.m3u8");
    expect(plan.audio[0]?.playlistPath).toBe(
      ".seyirlik/audio/english (original).m3u8",
    );
    expect(plan.masterPlaylistPath).toBe(".seyirlik/master.m3u8");
    expect(plan.manifestPath).toBe(".seyirlik/package.json");
  });
});

describe("pointing the playlists at the published files", () => {
  /**
   * The names are chosen to be read by people, so they contain spaces — which
   * a player resolving the raw name against the playlist's URL would send to
   * the server unencoded, asking for something it will not recognise.
   */
  it("escapes a name a URI cannot carry literally", () => {
    expect(playlistUri("video/2160p60 HDR.mp4")).toBe(
      "video/2160p60%20HDR.mp4",
    );
    expect(mediaUriFromPlaylist("audio/english (original).m4a")).toBe(
      "../../audio/english%20(original).m4a",
    );
  });

  it("repoints every segment and the initialisation range at once", () => {
    const playlist = [
      "#EXTM3U",
      '#EXT-X-MAP:URI="media.m4s",BYTERANGE="1052@0"',
      "#EXTINF:2.002000,",
      "#EXT-X-BYTERANGE:855499@1052",
      "media.m4s",
      "#EXTINF:2.002000,",
      "#EXT-X-BYTERANGE:934967@856551",
      "media.m4s",
      "#EXT-X-ENDLIST",
    ].join("\n");

    const rewritten = rewriteRenditionPlaylist(
      playlist,
      "media.m4s",
      "video/2160p60 HDR.mp4",
    );

    expect(rewritten).not.toContain("media.m4s");
    expect(rewritten).toContain(
      '#EXT-X-MAP:URI="../../video/2160p60%20HDR.mp4",BYTERANGE="1052@0"',
    );
    expect(
      rewritten
        .split("\n")
        .filter((line) => line === "../../video/2160p60%20HDR.mp4"),
    ).toHaveLength(2);
    // The byte ranges are what make one file serve every segment; losing them
    // would turn each request into the whole rendition.
    expect(rewritten).toContain("#EXT-X-BYTERANGE:934967@856551");
  });

  it("repoints the master at the renditions beside it", () => {
    const master = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="eng",URI="audio/track-1/playlist.m3u8"',
      "#EXT-X-STREAM-INF:BANDWIDTH=1979370",
      "video/1080p/playlist.m3u8",
    ].join("\n");

    const plan = planTitleLayout({
      videoRenditions: [video({ id: "1080p", frameRate: 60 })],
      audioRenditions: [audio({ id: "track-1", isOriginal: true })],
    });

    const rewritten = rewriteMasterPlaylist(
      master,
      plan,
      new Map([
        ["1080p", "video/1080p/playlist.m3u8"],
        ["track-1", "audio/track-1/playlist.m3u8"],
      ]),
    );

    expect(rewritten).toContain("video/1080p60.m3u8");
    expect(rewritten).toContain('URI="audio/english%20(original).m3u8"');
    expect(rewritten).not.toContain("playlist.m3u8");
    // The master describes bandwidth and codecs; rewriting a URI must not
    // disturb the attributes a player selects on.
    expect(rewritten).toContain("#EXT-X-STREAM-INF:BANDWIDTH=1979370");
  });
});
