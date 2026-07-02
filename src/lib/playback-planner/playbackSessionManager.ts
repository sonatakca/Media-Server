import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFfmpegCommand } from "./ffmpegCommandBuilder";
import {
  createSoftwareRuntimeProfile,
  detectFfmpegRuntime,
  type FfmpegRuntimeProfile,
} from "./ffmpegRuntime";
import type { MediaAnalysis, PlaybackPlan } from "./types";

export type PlaybackStartupFailureCode =
  | "spawn-failure"
  | "early-exit"
  | "hardware-encoder-failure"
  | "playlist-timeout-process-alive"
  | "playlist-timeout-process-exited"
  | "cancelled";

function getHlsStartupTimeoutMs(
  plan: PlaybackPlan,
  overrideMs?: number,
): number {
  if (
    typeof overrideMs === "number" &&
    Number.isFinite(overrideMs) &&
    overrideMs > 0
  ) {
    return overrideMs;
  }

  if (plan.video.action === "transcode" || plan.subtitles.action === "burn") {
    return 8_000;
  }

  if (plan.audio.action === "transcode") {
    return 3_500;
  }

  return 2_500;
}

export interface PlaybackSession {
  sessionId: string;
  mediaId: string;
  plan: PlaybackPlan;
  process: ChildProcess;
  outputDir: string;
  createdAt: Date;
  lastAccessedAt: Date;
  stderrTail: string;
}

export interface PlaybackSessionManagerOptions {
  ffmpegPath?: string;
  idleTimeoutMs?: number;
  killGraceMs?: number;
  hlsStartupTimeoutMs?: number;
  hlsStartupPollMs?: number;
  tempPrefix?: string;
  sessionRouteBase?: string;
  maxConcurrentVideoTranscodes?: number;
  preferredVideoEncoder?: string;
  softwareThreads?: number;
  runtimeProfileProvider?: () => Promise<FfmpegRuntimeProfile>;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const DEFAULT_HLS_STARTUP_POLL_MS = 100;
const DEFAULT_TEMP_PREFIX = "seyirlik-playback-";
const DEFAULT_SESSION_ROUTE_BASE = "/api/playback/sessions";
const DEFAULT_MAX_CONCURRENT_VIDEO_TRANSCODES = 1;
const STDERR_TAIL_LIMIT = 8_000;
const HLS_MAP_URI_PATTERN = /\bURI="([^"]+)"/g;

export interface PlaybackOutputFileDiagnostic {
  name: string;
  size: number;
}

export interface PlaybackStartupDiagnostics {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  processStillRunning?: boolean;
  stderrTail?: string;
  elapsedMs?: number;
  command?: string;
  args?: string[];
  pid?: number;
  outputDir?: string;
  outputFiles?: PlaybackOutputFileDiagnostic[];
}

export class PlaybackSessionStartupError extends Error {
  readonly statusCode = 409;

  constructor(
    message: string,
    readonly code: PlaybackStartupFailureCode,
    readonly details: PlaybackStartupDiagnostics = {},
  ) {
    super(message);
    this.name = "PlaybackSessionStartupError";
  }
}

export class PlaybackCapacityError extends Error {
  code = "TRANSCODE_CAPACITY_REACHED";
  statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = "PlaybackCapacityError";
  }
}

function withSessionDelivery(
  plan: PlaybackPlan,
  sessionId: string,
  sessionRouteBase: string,
): PlaybackPlan {
  const base = sessionRouteBase.replace(/\/+$/, "");

  return {
    ...plan,
    delivery: {
      type: "hls",
      sessionId,
      url: `${base}/${encodeURIComponent(sessionId)}/master.m3u8`,
    },
  };
}

function hasHardwareEncoderFailure(stderr: string): boolean {
  const normalized = stderr.toLowerCase();

  return [
    "error initializing an internal mfx session",
    "error initializing the encoder",
    "failed to initialise vaapi connection",
    "failed to initialize vaapi connection",
    "device creation failed",
    "no device available for decoder",
    "unsupported device",
    "mfx session",
    "mfx error",
    "qsv device",
    "qsv hw device",
    "error opening encoder",
  ].some((fragment) => normalized.includes(fragment));
}

function shouldFallbackToSoftware(
  error: unknown,
  hardwareAccelerated: boolean,
): boolean {
  return (
    hardwareAccelerated &&
    error instanceof PlaybackSessionStartupError &&
    error.code === "hardware-encoder-failure"
  );
}

function waitForExit(
  process: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.exitCode !== null || process.killed) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      process.off("exit", onExit);
    };

    process.once("exit", onExit);
  });
}

function getLocalHlsFileName(uri: string): string | null {
  const cleanUri = uri.trim().split(/[?#]/, 1)[0];

  if (!cleanUri || cleanUri.includes("://") || cleanUri.startsWith("//")) {
    return null;
  }

  const fileName = cleanUri.split(/[\\/]/).filter(Boolean).pop();
  return fileName || null;
}

interface HlsPlaylistReferences {
  initFile?: string;
  mediaSegments: string[];
}

function getHlsPlaylistReferences(playlist: string): HlsPlaylistReferences {
  let initFile: string | undefined;
  const mediaSegments: string[] = [];

  for (const line of playlist.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      continue;
    }

    if (trimmedLine.startsWith("#EXT-X-MAP")) {
      for (const match of trimmedLine.matchAll(HLS_MAP_URI_PATTERN)) {
        const fileName = getLocalHlsFileName(match[1]);

        if (fileName) {
          initFile = fileName;
          break;
        }
      }

      continue;
    }

    if (trimmedLine.startsWith("#")) {
      continue;
    }

    const fileName = getLocalHlsFileName(trimmedLine);

    if (fileName) {
      mediaSegments.push(fileName);
    }
  }

  return {
    initFile,
    mediaSegments,
  };
}

async function hasNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile() && fileStats.size > 0;
  } catch {
    return false;
  }
}

async function inspectOutputDirectory(
  outputDir: string,
): Promise<PlaybackOutputFileDiagnostic[]> {
  try {
    const entries = await readdir(outputDir, {
      withFileTypes: true,
    });

    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          try {
            const fileStats = await stat(join(outputDir, entry.name));

            return {
              name: entry.name,
              size: fileStats.size,
            };
          } catch {
            return {
              name: entry.name,
              size: -1,
            };
          }
        }),
    );

    return files.sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export class PlaybackSessionManager {
  private sessions = new Map<string, PlaybackSession>();
  private ffmpegPath: string;
  private idleTimeoutMs: number;
  private killGraceMs: number;
  private hlsStartupTimeoutMs?: number;
  private hlsStartupPollMs: number;
  private tempPrefix: string;
  private sessionRouteBase: string;
  private maxConcurrentVideoTranscodes: number;
  private reservedVideoTranscodes = 0;
  private runtimeProfileProvider: () => Promise<FfmpegRuntimeProfile>;
  private runtimeProfilePromise: Promise<FfmpegRuntimeProfile> | null = null;
  private resolvedRuntimeProfile: FfmpegRuntimeProfile | null = null;
  private spawnProcess: NonNullable<
    PlaybackSessionManagerOptions["spawnProcess"]
  >;

  constructor(options: PlaybackSessionManagerOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.hlsStartupTimeoutMs = options.hlsStartupTimeoutMs;
    this.hlsStartupPollMs =
      options.hlsStartupPollMs ?? DEFAULT_HLS_STARTUP_POLL_MS;
    this.tempPrefix = options.tempPrefix ?? DEFAULT_TEMP_PREFIX;
    this.sessionRouteBase =
      options.sessionRouteBase ?? DEFAULT_SESSION_ROUTE_BASE;
    this.maxConcurrentVideoTranscodes = Math.max(
      1,
      Math.floor(
        options.maxConcurrentVideoTranscodes ??
          DEFAULT_MAX_CONCURRENT_VIDEO_TRANSCODES,
      ),
    );
    this.runtimeProfileProvider =
      options.runtimeProfileProvider ??
      (() =>
        detectFfmpegRuntime({
          ffmpegPath: this.ffmpegPath,
          preferredVideoEncoder: options.preferredVideoEncoder,
          softwareThreads: options.softwareThreads,
        }));
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  private getActiveVideoTranscodeCount(): number {
    return Array.from(this.sessions.values()).filter(
      (session) => session.plan.video.action === "transcode",
    ).length;
  }

  private async getRuntimeProfile(): Promise<FfmpegRuntimeProfile> {
    if (this.resolvedRuntimeProfile) {
      return this.resolvedRuntimeProfile;
    }

    if (!this.runtimeProfilePromise) {
      this.runtimeProfilePromise = this.runtimeProfileProvider()
        .then((profile) => {
          this.resolvedRuntimeProfile = profile;
          return profile;
        })
        .finally(() => {
          this.runtimeProfilePromise = null;
        });
    }

    return this.runtimeProfilePromise;
  }

  private async startSessionAttempt(
    sessionId: string,
    plan: PlaybackPlan,
    media: MediaAnalysis,
    runtimeProfile: FfmpegRuntimeProfile,
  ): Promise<PlaybackSession> {
    const outputDir = await mkdtemp(join(tmpdir(), this.tempPrefix));
    const planWithRuntime: PlaybackPlan = {
      ...plan,
      processing: {
        node: "server",
        videoEncoder:
          plan.video.action === "transcode"
            ? runtimeProfile.videoEncoder
            : undefined,
        hardwareAccelerated:
          plan.video.action === "transcode"
            ? runtimeProfile.hardwareAccelerated
            : false,
        softwareThreadLimit: runtimeProfile.softwareThreads,
      },
    };
    const command = buildFfmpegCommand({
      plan: planWithRuntime,
      media,
      outputDir,
      ffmpegPath: this.ffmpegPath,
      runtimeProfile,
    });
    let session: PlaybackSession | undefined;

    try {
      const child = this.spawnProcess(command.command, command.args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const now = new Date();
      const nextSession: PlaybackSession = {
        sessionId,
        mediaId: media.mediaId,
        plan: planWithRuntime,
        process: child,
        outputDir,
        createdAt: now,
        lastAccessedAt: now,
        stderrTail: "",
      };
      session = nextSession;

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        nextSession.stderrTail = `${nextSession.stderrTail}${chunk}`.slice(
          -STDERR_TAIL_LIMIT,
        );
      });
      this.sessions.set(sessionId, nextSession);
      await this.waitForInitialPlaylist(nextSession, command.playlistPath);

      console.info(
        `[Seyirlik Playback Backend] FFmpeg session ready in ${
          Date.now() - now.getTime()
        }ms using ${
          plan.video.action === "transcode"
            ? runtimeProfile.videoEncoder
            : "stream copy"
        }.`,
      );
      return nextSession;
    } catch (error) {
      this.sessions.delete(sessionId);

      if (session) {
        await this.terminateSessionProcess(session);
      }

      const outputFiles = await inspectOutputDirectory(outputDir);

      const enrichedError =
        error instanceof PlaybackSessionStartupError
          ? new PlaybackSessionStartupError(error.message, error.code, {
              ...error.details,
              command: command.command,
              args: [...command.args],
              pid: session?.process.pid,
              outputDir,
              outputFiles,
            })
          : error;

      await rm(outputDir, { recursive: true, force: true });

      throw enrichedError;
    }
  }

  async createSession(
    plan: PlaybackPlan,
    media: MediaAnalysis,
  ): Promise<PlaybackSession> {
    if (!plan.requiresFfmpeg) {
      throw new Error("Direct-play plans do not need FFmpeg sessions.");
    }

    const isVideoTranscode = plan.video.action === "transcode";

    if (
      isVideoTranscode &&
      this.getActiveVideoTranscodeCount() + this.reservedVideoTranscodes >=
        this.maxConcurrentVideoTranscodes
    ) {
      throw new PlaybackCapacityError(
        `The server is already running the configured maximum of ${this.maxConcurrentVideoTranscodes} video transcode session(s).`,
      );
    }

    if (isVideoTranscode) {
      this.reservedVideoTranscodes += 1;
    }

    const sessionId = randomUUID();
    const planWithSession = withSessionDelivery(
      plan,
      sessionId,
      this.sessionRouteBase,
    );

    try {
      const runtimeProfile = await this.getRuntimeProfile();

      try {
        return await this.startSessionAttempt(
          sessionId,
          planWithSession,
          media,
          runtimeProfile,
        );
      } catch (error) {
        if (error instanceof PlaybackSessionStartupError) {
          console.error("[Seyirlik Playback Backend] FFmpeg startup failed:", {
            code: error.code,
            message: error.message,
            exitCode: error.details.exitCode,
            signal: error.details.signal,
            processStillRunning: error.details.processStillRunning,
            elapsedMs: error.details.elapsedMs,
            pid: error.details.pid,
            command: error.details.command,
            args: error.details.args,
            outputDir: error.details.outputDir,
            outputFiles: error.details.outputFiles,
            stderrTail: error.details.stderrTail,
          });
        }

        if (
          !isVideoTranscode ||
          !shouldFallbackToSoftware(error, runtimeProfile.hardwareAccelerated)
        ) {
          throw error;
        }

        console.warn(
          `[Seyirlik Playback Backend] Confirmed ${runtimeProfile.videoEncoder} hardware encoder failure; retrying once with bounded libx264 software encoding.`,
        );

        const softwareProfile = createSoftwareRuntimeProfile(
          runtimeProfile.softwareThreads,
          runtimeProfile.supportsHdrToneMapping,
        );

        return this.startSessionAttempt(
          sessionId,
          planWithSession,
          media,
          softwareProfile,
        );
      }
    } finally {
      if (isVideoTranscode) {
        this.reservedVideoTranscodes = Math.max(
          0,
          this.reservedVideoTranscodes - 1,
        );
      }
    }
  }

  getRuntimeStatus(): {
    activeVideoTranscodes: number;
    maxConcurrentVideoTranscodes: number;
    videoEncoder?: string;
    hardwareAccelerated?: boolean;
    softwareThreadLimit?: number;
    supportsHdrToneMapping?: boolean;
  } {
    return {
      activeVideoTranscodes: this.getActiveVideoTranscodeCount(),
      maxConcurrentVideoTranscodes: this.maxConcurrentVideoTranscodes,
      videoEncoder: this.resolvedRuntimeProfile?.videoEncoder,
      hardwareAccelerated: this.resolvedRuntimeProfile?.hardwareAccelerated,
      softwareThreadLimit: this.resolvedRuntimeProfile?.softwareThreads,
      supportsHdrToneMapping:
        this.resolvedRuntimeProfile?.supportsHdrToneMapping,
    };
  }

  private async terminateSessionProcess(
    session: PlaybackSession,
  ): Promise<void> {
    if (session.process.exitCode !== null || session.process.killed) {
      return;
    }

    try {
      session.process.kill("SIGTERM");
    } catch {
      return;
    }

    const exited = await waitForExit(session.process, this.killGraceMs);

    if (!exited && session.process.exitCode === null) {
      try {
        session.process.kill("SIGKILL");
      } catch {
        return;
      }

      await waitForExit(session.process, this.killGraceMs);
    }
  }

  private async waitForInitialPlaylist(
    session: PlaybackSession,
    playlistPath: string | undefined,
  ): Promise<void> {
    if (!playlistPath) {
      throw new PlaybackSessionStartupError(
        "FFmpeg did not provide an HLS playlist path.",
        "early-exit",
        {
          processStillRunning: false,
          stderrTail: session.stderrTail,
        },
      );
    }

    const startedAt = Date.now();
    const startupTimeoutMs = getHlsStartupTimeoutMs(
      session.plan,
      this.hlsStartupTimeoutMs,
    );

    return new Promise((resolve, reject) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }

        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }

        session.process.off("error", handleError);
        session.process.off("exit", handleExit);
      };

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      const poll = async () => {
        if (session.process.exitCode !== null) {
          handleExit();
          return;
        }

        try {
          const playlistStat = await stat(playlistPath);

          if (playlistStat.isFile() && playlistStat.size > 0) {
            const playlist = await readFile(playlistPath, "utf8");
            const references = getHlsPlaylistReferences(playlist);

            const initFileReady =
              !references.initFile ||
              (await hasNonEmptyFile(
                join(session.outputDir, references.initFile),
              ));

            let playableSegmentReady = false;

            for (const segmentFileName of references.mediaSegments) {
              if (
                await hasNonEmptyFile(join(session.outputDir, segmentFileName))
              ) {
                playableSegmentReady = true;
                break;
              }
            }

            if (!initFileReady || !playableSegmentReady) {
              pollTimer = setTimeout(poll, this.hlsStartupPollMs);
              return;
            }

            finish();
            return;
          }
        } catch {
          // Keep polling until the playlist exists, FFmpeg exits, or timeout fires.
        }

        if (!settled) {
          pollTimer = setTimeout(poll, this.hlsStartupPollMs);
        }
      };

      const handleError = (error: Error) => {
        finish(
          new PlaybackSessionStartupError(
            "FFmpeg could not be started.",
            "spawn-failure",
            {
              exitCode: session.process.exitCode,
              signal: session.process.signalCode,
              processStillRunning: false,
              stderrTail: [session.stderrTail, error.message]
                .filter(Boolean)
                .join("\n"),
              elapsedMs: Date.now() - startedAt,
            },
          ),
        );
      };

      const handleExit = () => {
        const hardwareFailure =
          session.plan.processing?.hardwareAccelerated === true &&
          hasHardwareEncoderFailure(session.stderrTail);

        console.warn(
          "[Seyirlik Playback Backend] FFmpeg exited before playable HLS output was ready.",
        );

        finish(
          new PlaybackSessionStartupError(
            "FFmpeg exited before playable HLS output was ready.",
            hardwareFailure ? "hardware-encoder-failure" : "early-exit",
            {
              exitCode: session.process.exitCode,
              signal: session.process.signalCode,
              processStillRunning: false,
              stderrTail: session.stderrTail,
              elapsedMs: Date.now() - startedAt,
            },
          ),
        );
      };

      timeoutTimer = setTimeout(() => {
        const elapsedMs = Date.now() - startedAt;
        const processStillRunning =
          session.process.exitCode === null &&
          session.process.signalCode === null &&
          !session.process.killed;

        console.warn(
          `[Seyirlik Playback Backend] FFmpeg HLS output was not ready after ${elapsedMs}ms ` +
            `(deadline=${startupTimeoutMs}ms, mode=${session.plan.mode}, ` +
            `video=${session.plan.video.action}, audio=${session.plan.audio.action}). ` +
            `Process still running: ${processStillRunning}.`,
        );

        finish(
          new PlaybackSessionStartupError(
            processStillRunning
              ? "FFmpeg remained alive but did not produce playable HLS output before the startup timeout."
              : "FFmpeg exited before playable HLS output became ready.",
            processStillRunning
              ? "playlist-timeout-process-alive"
              : "playlist-timeout-process-exited",
            {
              exitCode: session.process.exitCode,
              signal: session.process.signalCode,
              processStillRunning,
              stderrTail: session.stderrTail,
              elapsedMs,
            },
          ),
        );
      }, startupTimeoutMs);

      session.process.once("error", handleError);
      session.process.once("exit", handleExit);
      void poll();
    });
  }

  getSession(sessionId: string): PlaybackSession | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);

    if (session) {
      session.lastAccessedAt = new Date();
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    this.sessions.delete(sessionId);

    await this.terminateSessionProcess(session);

    await rm(session.outputDir, { recursive: true, force: true });
  }

  async stopAllSessions(): Promise<void> {
    const sessionIds = this.getActiveSessionIds();

    await Promise.all(
      sessionIds.map((sessionId) => this.stopSession(sessionId)),
    );
  }

  async cleanupIdleSessions(now = Date.now()): Promise<void> {
    const staleSessionIds = Array.from(this.sessions.values())
      .filter(
        (session) =>
          now - session.lastAccessedAt.getTime() > this.idleTimeoutMs,
      )
      .map((session) => session.sessionId);

    await Promise.all(staleSessionIds.map((id) => this.stopSession(id)));
  }
}
