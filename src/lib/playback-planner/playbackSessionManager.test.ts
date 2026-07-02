// @vitest-environment node
import { EventEmitter } from "node:events";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlaybackSessionManager,
  PlaybackSessionStartupError,
  type PlaybackSessionManagerOptions,
} from "./playbackSessionManager";
import type { MediaAnalysis, PlaybackPlan } from "./types";

interface FakeChildProcess extends EventEmitter {
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
}

const outputDirs: string[] = [];

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  const stderr = new EventEmitter() as FakeChildProcess["stderr"];

  stderr.setEncoding = vi.fn();
  child.stderr = stderr;
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });

  return child;
}

function mediaAnalysis(): MediaAnalysis {
  return {
    mediaId: "movie-1",
    filePath: "/safe/media/movie.mp4",
    container: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      extension: "mp4",
      isBrowserDirectPlayableContainer: true,
    },
    durationSeconds: 10,
    videoStreams: [
      {
        index: 0,
        codecName: "h264",
        width: 1920,
        height: 1080,
      },
    ],
    audioStreams: [
      {
        index: 1,
        codecName: "aac",
        channels: 6,
      },
    ],
    subtitleStreams: [],
    analysedAt: "2026-01-01T00:00:00.000Z",
  };
}

function hlsPlan(): PlaybackPlan {
  return {
    mode: "audio-transcode",
    requiresFfmpeg: true,
    preservesOriginalVideoQuality: true,
    expectedStartup: "fast",
    mediaId: "movie-1",
    selected: {
      videoStreamIndex: 0,
      audioStreamIndex: 1,
    },
    container: {
      input: "mp4",
      output: "hls-fmp4",
      action: "hls",
    },
    video: {
      inputCodec: "h264",
      action: "copy",
    },
    audio: {
      inputCodec: "aac",
      outputCodec: "aac",
      action: "transcode",
    },
    subtitles: {
      action: "none",
    },
    reasons: [],
    delivery: {
      type: "hls",
    },
  };
}

function videoTranscodePlan(): PlaybackPlan {
  return {
    ...hlsPlan(),
    mode: "video-transcode",
    preservesOriginalVideoQuality: false,
    expectedStartup: "slow",
    video: {
      inputCodec: "hevc",
      outputCodec: "h264",
      action: "transcode",
    },
  };
}

function createManager(options: {
  child?: FakeChildProcess;
  onSpawn?: (args: string[]) => void;
  startupTimeoutMs?: number;
  runtimeProfileProvider?: PlaybackSessionManagerOptions["runtimeProfileProvider"];
  maxConcurrentVideoTranscodes?: number;
}) {
  const child = options.child ?? createFakeChildProcess();
  const manager = new PlaybackSessionManager({
    hlsStartupTimeoutMs: options.startupTimeoutMs ?? 500,
    hlsStartupPollMs: 10,
    killGraceMs: 1,
    maxConcurrentVideoTranscodes: options.maxConcurrentVideoTranscodes,
    runtimeProfileProvider:
      options.runtimeProfileProvider ??
      (() =>
        Promise.resolve({
          videoEncoder: "libx264",
          hardwareAccelerated: false,
          softwareThreads: 2,
          availableVideoEncoders: ["libx264"],
          supportsHdrToneMapping: true,
        })),
    spawnProcess: (_command, args) => {
      options.onSpawn?.(args);
      const outputDir = path.dirname(String(args[args.length - 1]));

      outputDirs.push(outputDir);
      return child as never;
    },
  });

  return { child, manager };
}

async function expectMissing(filePath: string) {
  await expect(access(filePath)).rejects.toThrow();
}

async function writeReadyPlaylist(
  playlistPath: string,
  segmentFileName = "segment_00000.m4s",
) {
  await writeFile(
    playlistPath,
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:4.000000,",
      segmentFileName,
      "",
    ].join("\n"),
  );
  await writeFile(path.join(path.dirname(playlistPath), "init.mp4"), "init");
  await writeFile(
    path.join(path.dirname(playlistPath), segmentFileName),
    "seg",
  );
}

afterEach(async () => {
  const dirs = [...outputDirs];

  outputDirs.length = 0;
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("PlaybackSessionManager HLS readiness", () => {
  it("resolves after the playlist, init file, and first playable segment are ready", async () => {
    let playlistPath = "";
    const { manager } = createManager({
      onSpawn: (args) => {
        playlistPath = String(args[args.length - 1]);
      },
    });
    let resolved = false;
    const sessionPromise = manager
      .createSession(hlsPlan(), mediaAnalysis())
      .then((session) => {
        resolved = true;
        return session;
      });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);

    await writeFile(playlistPath, "");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);

    await writeFile(playlistPath, "#EXTM3U\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);

    await writeReadyPlaylist(playlistPath);
    const session = await sessionPromise;

    expect(resolved).toBe(true);
    expect(session.outputDir).toBe(path.dirname(playlistPath));
    expect(manager.getSession(session.sessionId)).toBe(session);
  });

  it("does not wait for every segment referenced by the live playlist", async () => {
    let playlistPath = "";

    const { manager } = createManager({
      onSpawn: (args) => {
        playlistPath = String(args[args.length - 1]);
      },
    });

    const sessionPromise = manager.createSession(hlsPlan(), mediaAnalysis());

    await vi.waitFor(() => expect(playlistPath).not.toBe(""));

    await writeFile(
      playlistPath,
      [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:2.000000,",
        "segment_00000.m4s",
        "#EXTINF:2.000000,",
        "segment_00001.m4s",
        "#EXTINF:2.000000,",
        "segment_00002.m4s",
        "",
      ].join("\n"),
    );

    await writeFile(path.join(path.dirname(playlistPath), "init.mp4"), "init");

    await writeFile(
      path.join(path.dirname(playlistPath), "segment_00000.m4s"),
      "first-segment",
    );

    const session = await sessionPromise;

    expect(manager.getSession(session.sessionId)).toBe(session);

    await expect(
      access(path.join(path.dirname(playlistPath), "segment_00001.m4s")),
    ).rejects.toThrow();

    await expect(
      access(path.join(path.dirname(playlistPath), "segment_00002.m4s")),
    ).rejects.toThrow();

    await manager.stopSession(session.sessionId);
  });

  it("waits for the fMP4 init file before marking the session ready", async () => {
    let playlistPath = "";
    let resolved = false;

    const { manager } = createManager({
      onSpawn: (args) => {
        playlistPath = String(args[args.length - 1]);
      },
    });

    const sessionPromise = manager
      .createSession(hlsPlan(), mediaAnalysis())
      .then((session) => {
        resolved = true;
        return session;
      });

    await vi.waitFor(() => expect(playlistPath).not.toBe(""));

    await writeFile(
      playlistPath,
      [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:2.000000,",
        "segment_00000.m4s",
        "",
      ].join("\n"),
    );

    await writeFile(
      path.join(path.dirname(playlistPath), "segment_00000.m4s"),
      "segment",
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);

    await writeFile(path.join(path.dirname(playlistPath), "init.mp4"), "init");

    const session = await sessionPromise;

    expect(resolved).toBe(true);

    await manager.stopSession(session.sessionId);
  });

  it("does not fall back to software for a generic hardware-process exit", async () => {
    const hardwareChild = createFakeChildProcess();
    let spawnCount = 0;

    const manager = new PlaybackSessionManager({
      hlsStartupTimeoutMs: 500,
      hlsStartupPollMs: 10,
      killGraceMs: 1,
      runtimeProfileProvider: () =>
        Promise.resolve({
          videoEncoder: "h264_qsv",
          hardwareAccelerated: true,
          softwareThreads: 2,
          availableVideoEncoders: ["h264_qsv", "libx264"],
          supportsHdrToneMapping: true,
        }),
      spawnProcess: (_command, args) => {
        const outputDir = path.dirname(String(args[args.length - 1]));

        outputDirs.push(outputDir);
        spawnCount += 1;
        return hardwareChild as never;
      },
    });

    const sessionPromise = manager.createSession(
      videoTranscodePlan(),
      mediaAnalysis(),
    );

    await vi.waitFor(() =>
      expect(hardwareChild.listenerCount("exit")).toBeGreaterThan(0),
    );

    hardwareChild.stderr.emit(
      "data",
      "Conversion failed because the input stream ended unexpectedly.\n",
    );
    hardwareChild.exitCode = 1;
    hardwareChild.emit("exit", 1, null);

    await expect(sessionPromise).rejects.toMatchObject({
      code: "early-exit",
      details: {
        exitCode: 1,
        processStillRunning: false,
      },
    });

    expect(spawnCount).toBe(1);
  });

  it("does not fall back to software when hardware FFmpeg remains alive but HLS times out", async () => {
    const hardwareChild = createFakeChildProcess();
    let spawnCount = 0;

    const manager = new PlaybackSessionManager({
      hlsStartupTimeoutMs: 30,
      hlsStartupPollMs: 10,
      killGraceMs: 1,
      runtimeProfileProvider: () =>
        Promise.resolve({
          videoEncoder: "h264_qsv",
          hardwareAccelerated: true,
          softwareThreads: 2,
          availableVideoEncoders: ["h264_qsv", "libx264"],
          supportsHdrToneMapping: true,
        }),
      spawnProcess: (_command, args) => {
        const outputDir = path.dirname(String(args[args.length - 1]));

        outputDirs.push(outputDir);
        spawnCount += 1;
        return hardwareChild as never;
      },
    });

    await expect(
      manager.createSession(videoTranscodePlan(), mediaAnalysis()),
    ).rejects.toMatchObject({
      code: "playlist-timeout-process-alive",
      details: {
        processStillRunning: true,
      },
    });

    expect(spawnCount).toBe(1);
    expect(hardwareChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects spawn errors and removes the temporary output directory", async () => {
    const child = createFakeChildProcess();
    let outputDir = "";
    const { manager } = createManager({
      child,
      onSpawn: (args) => {
        outputDir = path.dirname(String(args[args.length - 1]));
      },
    });
    const sessionPromise = manager.createSession(hlsPlan(), mediaAnalysis());

    await vi.waitFor(() =>
      expect(child.listenerCount("error")).toBeGreaterThan(0),
    );
    child.emit("error", new Error("spawn ENOENT"));

    await expect(sessionPromise).rejects.toMatchObject({
      code: "spawn-failure",
      statusCode: 409,
      details: {
        command: "ffmpeg",
        outputDir,
        args: expect.arrayContaining([
          "-hide_banner",
          "-i",
          "/safe/media/movie.mp4",
        ]),
        stderrTail: expect.stringContaining("spawn ENOENT"),
      },
    });
    expect(child.kill).toHaveBeenCalled();
    await expectMissing(outputDir);
    expect(manager.getActiveSessionIds()).toEqual([]);
  });

  it("rejects when FFmpeg exits before the playlist is ready", async () => {
    const child = createFakeChildProcess();
    let outputDir = "";
    const { manager } = createManager({
      child,
      onSpawn: (args) => {
        outputDir = path.dirname(String(args[args.length - 1]));
      },
    });
    const sessionPromise = manager.createSession(hlsPlan(), mediaAnalysis());

    await vi.waitFor(() =>
      expect(child.listenerCount("exit")).toBeGreaterThan(0),
    );
    await writeFile(
      path.join(outputDir, "partial-segment.m4s"),
      "partially-written-data",
    );

    child.exitCode = 1;
    child.emit("exit", 1, null);

    await expect(sessionPromise).rejects.toMatchObject({
      code: "early-exit",
      statusCode: 409,
      details: {
        exitCode: 1,
        processStillRunning: false,
        pid: 4321,
        command: "ffmpeg",
        outputDir,
        args: expect.arrayContaining([
          "-hide_banner",
          "-i",
          "/safe/media/movie.mp4",
        ]),
        outputFiles: expect.arrayContaining([
          {
            name: "partial-segment.m4s",
            size: Buffer.byteLength("partially-written-data"),
          },
        ]),
      },
    });
    await expectMissing(outputDir);
    expect(manager.getActiveSessionIds()).toEqual([]);
  });

  it("times out, terminates FFmpeg, removes the session, and cleans output", async () => {
    const child = createFakeChildProcess();
    let outputDir = "";
    const { manager } = createManager({
      child,
      startupTimeoutMs: 30,
      onSpawn: (args) => {
        outputDir = path.dirname(String(args[args.length - 1]));
      },
    });

    await expect(
      manager.createSession(hlsPlan(), mediaAnalysis()),
    ).rejects.toMatchObject({
      code: "playlist-timeout-process-alive",
      statusCode: 409,
      details: {
        processStillRunning: true,
      },
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expectMissing(outputDir);
    expect(manager.getActiveSessionIds()).toEqual([]);
  });

  it("keeps stderr bounded while a successful session remains registered", async () => {
    const child = createFakeChildProcess();
    let playlistPath = "";
    const { manager } = createManager({
      child,
      onSpawn: (args) => {
        playlistPath = String(args[args.length - 1]);
      },
    });
    const sessionPromise = manager.createSession(hlsPlan(), mediaAnalysis());

    await vi.waitFor(() => expect(playlistPath).not.toBe(""));
    child.stderr.emit("data", "x".repeat(9_000));
    await writeReadyPlaylist(playlistPath);
    const session = await sessionPromise;

    expect(session.stderrTail).toHaveLength(8_000);
    expect(manager.getSession(session.sessionId)).toBe(session);
  });

  it("stops a ready session and removes generated files", async () => {
    const child = createFakeChildProcess();
    let playlistPath = "";
    const { manager } = createManager({
      child,
      onSpawn: (args) => {
        playlistPath = String(args[args.length - 1]);
      },
    });
    const sessionPromise = manager.createSession(hlsPlan(), mediaAnalysis());

    await vi.waitFor(() => expect(playlistPath).not.toBe(""));
    await writeReadyPlaylist(playlistPath);
    const session = await sessionPromise;

    await expect(readFile(playlistPath, "utf8")).resolves.toContain("#EXTM3U");
    await manager.stopSession(session.sessionId);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(stat(session.outputDir)).rejects.toThrow();
    expect(manager.getSession(session.sessionId)).toBeUndefined();
  });

  it("rejects an additional video transcode above the configured limit", async () => {
    let playlistPath = "";
    const { manager } = createManager({
      maxConcurrentVideoTranscodes: 1,
      onSpawn: (args) => {
        playlistPath = String(args[args.length - 1]);
      },
    });
    const firstSessionPromise = manager.createSession(
      videoTranscodePlan(),
      mediaAnalysis(),
    );

    await vi.waitFor(() => expect(playlistPath).not.toBe(""));
    await writeReadyPlaylist(playlistPath);
    const firstSession = await firstSessionPromise;

    await expect(
      manager.createSession(videoTranscodePlan(), mediaAnalysis()),
    ).rejects.toMatchObject({
      code: "TRANSCODE_CAPACITY_REACHED",
      statusCode: 503,
    });
    expect(manager.getRuntimeStatus()).toMatchObject({
      activeVideoTranscodes: 1,
      maxConcurrentVideoTranscodes: 1,
    });

    await manager.stopSession(firstSession.sessionId);
  });

  it("falls back exactly once when a confirmed hardware encoder initialization failure occurs", async () => {
    const hardwareChild = createFakeChildProcess();
    const softwareChild = createFakeChildProcess();
    const children = [hardwareChild, softwareChild];
    let spawnCount = 0;
    let softwarePlaylistPath = "";
    const manager = new PlaybackSessionManager({
      hlsStartupTimeoutMs: 500,
      hlsStartupPollMs: 10,
      killGraceMs: 1,
      runtimeProfileProvider: () =>
        Promise.resolve({
          videoEncoder: "h264_qsv",
          hardwareAccelerated: true,
          softwareThreads: 2,
          availableVideoEncoders: ["h264_qsv", "libx264"],
          supportsHdrToneMapping: true,
        }),
      spawnProcess: (_command, args) => {
        const outputDir = path.dirname(String(args[args.length - 1]));

        outputDirs.push(outputDir);
        spawnCount += 1;

        if (spawnCount === 2) {
          softwarePlaylistPath = String(args[args.length - 1]);
        }

        return children[spawnCount - 1] as never;
      },
    });
    const sessionPromise = manager.createSession(
      videoTranscodePlan(),
      mediaAnalysis(),
    );

    void sessionPromise.catch(() => undefined);

    await vi.waitFor(() =>
      expect(hardwareChild.listenerCount("exit")).toBeGreaterThan(0),
    );

    hardwareChild.stderr.emit(
      "data",
      "Error initializing an internal MFX session\n",
    );

    hardwareChild.exitCode = 1;
    hardwareChild.emit("exit", 1, null);

    await vi.waitFor(() => expect(softwarePlaylistPath).not.toBe(""));
    await writeReadyPlaylist(softwarePlaylistPath);
    const session = await sessionPromise;

    expect(spawnCount).toBe(2);
    expect(hardwareChild.kill).not.toHaveBeenCalled();
    expect(session.plan.processing).toMatchObject({
      videoEncoder: "libx264",
      hardwareAccelerated: false,
      softwareThreadLimit: 2,
    });

    await manager.stopSession(session.sessionId);
  });
});
