import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaAnalysis, PlaybackPlan } from "./types";

/**
 * What a viewer is told when FFmpeg does not come up in time.
 *
 * Both defects covered here turned an ordinary, diagnosable startup outcome
 * into something the client could not act on: a healthy remux failed against a
 * deadline sized for a small file, and the typed error that explained it was
 * overwritten by the tidy-up that ran on the way out.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  PlaybackSessionManager,
  getHlsStartupTimeoutMs,
} from "./playbackSessionManager";

const readOnlyRoots: string[] = [];

afterEach(() => {
  for (const root of readOnlyRoots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function copyPlan(): PlaybackPlan {
  return {
    mediaId: "movie-1",
    mode: "remux",
    requiresFfmpeg: true,
    preservesOriginalVideoQuality: true,
    expectedStartup: "fast",
    selected: { videoStreamIndex: 0, audioStreamIndex: 1 },
    container: { input: "matroska", output: "hls-fmp4", action: "hls" },
    video: { inputCodec: "hevc", action: "copy" },
    audio: { inputCodec: "eac3", action: "copy" },
    subtitles: { action: "none" },
    reasons: [],
    delivery: { type: "hls" },
  } as unknown as PlaybackPlan;
}

function transcodePlan(): PlaybackPlan {
  return {
    ...copyPlan(),
    mode: "transcode",
    video: { action: "transcode", inputCodec: "hevc", outputCodec: "h264" },
  } as unknown as PlaybackPlan;
}

describe("the startup deadline", () => {
  /**
   * A stream copy still has to open the container before it can write a
   * segment, and that cost scales with the source. A 4K HDR master needed more
   * than eight seconds to reach its first segment, so the old deadline reported
   * a perfectly healthy remux as a failure.
   */
  it("gives a stream copy room to open a large source", () => {
    expect(getHlsStartupTimeoutMs(copyPlan())).toBeGreaterThanOrEqual(20_000);
  });

  it("is not shorter for a copy than for a transcode", () => {
    expect(getHlsStartupTimeoutMs(copyPlan())).toBeGreaterThanOrEqual(
      getHlsStartupTimeoutMs(transcodePlan()),
    );
  });

  /**
   * Switching to a track the package does not carry reaches Chrome as a video
   * copy with an audio transcode. It waits on the same demux as a pure remux,
   * so a deadline sized for the audio failed a healthy stream at five seconds.
   */
  it("gives an audio-only transcode the same room as a remux", () => {
    const audioTranscode = {
      ...copyPlan(),
      mode: "audio-transcode",
      audio: { inputCodec: "eac3", outputCodec: "aac", action: "transcode" },
    } as unknown as PlaybackPlan;

    expect(getHlsStartupTimeoutMs(audioTranscode)).toBe(
      getHlsStartupTimeoutMs(copyPlan()),
    );
  });

  it("still honours an explicit override", () => {
    expect(getHlsStartupTimeoutMs(copyPlan(), 30)).toBe(30);
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter & { setEncoding: () => void };
    stdout: EventEmitter & { setEncoding: () => void };
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    pid: number;
    kill: () => boolean;
    off: EventEmitter["off"];
  };
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: () => void;
  };
  stderr.setEncoding = () => {};
  child.stderr = stderr;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.pid = 4242;
  child.kill = () => true;
  return child;
}

function shortAnalysis(): MediaAnalysis {
  return {
    mediaId: "movie-1",
    filePath: "/safe/media/short.mkv",
    container: {
      formatName: "matroska,webm",
      extension: "mkv",
      isBrowserDirectPlayableContainer: false,
    },
    durationSeconds: 21.73,
    videoStreams: [{ index: 0, codecName: "h264", width: 1920, height: 1080 }],
    audioStreams: [{ index: 2, codecName: "aac", channels: 2 }],
    subtitleStreams: [],
    analysedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as MediaAnalysis;
}

describe("a short title FFmpeg finishes before the first poll", () => {
  /**
   * A remux of a 20-second clip is done in a fraction of a second, so the
   * session's readiness check meets a complete package rather than a growing
   * one. Holding that package to a resume target it can never reach — the
   * target is clamped to the *container's* duration, which on a file whose
   * subtitle track outlasts its video is longer than any media the muxer
   * produces — failed a perfectly good stream forever.
   */
  it("accepts a finished playlist that is shorter than the resume target", async () => {
    const child = fakeChild();
    const outputRoot = mkdtempSync(path.join(tmpdir(), "seyirlik-short-"));
    readOnlyRoots.push(outputRoot);

    const manager = new PlaybackSessionManager({
      hlsStartupTimeoutMs: 4_000,
      hlsStartupPollMs: 10,
      killGraceMs: 1,
      outputRoot,
      runtimeProfileProvider: () =>
        Promise.resolve({
          videoEncoder: "libx264",
          hardwareAccelerated: false,
          softwareThreads: 2,
          availableVideoEncoders: ["libx264"],
          supportsHdrToneMapping: true,
        }),
      spawnProcess: (_command: string, args: string[]) => {
        const outputDir = path.dirname(String(args[args.length - 1]));
        // Write the complete output the way a finished remux leaves it, then
        // exit cleanly — the shape that was being rejected.
        writeFileSync(path.join(outputDir, "init.mp4"), "init");
        writeFileSync(path.join(outputDir, "segment_00000.m4s"), "seg");
        writeFileSync(
          path.join(outputDir, "master.m3u8"),
          [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            '#EXT-X-MAP:URI="init.mp4"',
            "#EXTINF:4.004000,",
            "segment_00000.m4s",
            "#EXT-X-ENDLIST",
            "",
          ].join("\n"),
        );
        setTimeout(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        }, 20);
        return child as never;
      },
    } as never);

    // The viewer asked to resume at 10s of a 21.7s container whose video is
    // only 20s long: the old gate demanded 21.45s of media that cannot exist.
    const plan = {
      ...copyPlan(),
      startTimeSeconds: 10,
      sourceDurationSeconds: 21.73,
    } as unknown as PlaybackPlan;

    const session = await manager.createSession(plan, shortAnalysis());
    expect(session.sessionId).toBeTruthy();
    await manager.stopSession(session.sessionId);
  });
});

describe("cleanup after a startup failure", () => {
  it("keeps the typed startup error when the output directory will not delete", async () => {
    // FFmpeg can still be flushing into the directory when the deadline fires,
    // and losing that race threw ENOTEMPTY — which replaced the 409 the client
    // could act on with an anonymous 500. A read-only parent reproduces the
    // same shape of failure without racing a real process.
    const outputRoot = mkdtempSync(path.join(tmpdir(), "seyirlik-cleanup-"));
    readOnlyRoots.push(outputRoot);

    const child = fakeChild();
    const manager = new PlaybackSessionManager({
      hlsStartupTimeoutMs: 30,
      hlsStartupPollMs: 10,
      killGraceMs: 1,
      runtimeProfileProvider: () =>
        Promise.resolve({
          videoEncoder: "libx264",
          hardwareAccelerated: false,
          softwareThreads: 2,
          availableVideoEncoders: ["libx264"],
          supportsHdrToneMapping: true,
        }),
      outputRoot,
      spawnProcess: (_command: string, args: string[]) => {
        // The session directory exists by now; sealing its parent makes the
        // removal that runs during cleanup fail.
        void path.dirname(String(args[args.length - 1]));
        chmodSync(outputRoot, 0o500);
        return child as never;
      },
    } as never);

    const analysis = {
      mediaId: "movie-1",
      filePath: "/safe/media/movie.mkv",
      container: {
        formatName: "matroska,webm",
        extension: "mkv",
        isBrowserDirectPlayableContainer: false,
      },
      durationSeconds: 300,
      videoStreams: [
        { index: 0, codecName: "hevc", width: 3840, height: 1608 },
      ],
      audioStreams: [{ index: 1, codecName: "eac3", channels: 6 }],
      subtitleStreams: [],
      analysedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as MediaAnalysis;

    await expect(
      manager.createSession(copyPlan(), analysis),
    ).rejects.toMatchObject({
      name: "PlaybackSessionStartupError",
      statusCode: 409,
      code: "playlist-timeout-process-alive",
    });
  });
});
