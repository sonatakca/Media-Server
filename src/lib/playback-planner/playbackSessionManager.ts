import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFfmpegCommand } from "./ffmpegCommandBuilder";
import type { MediaAnalysis, PlaybackPlan } from "./types";

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
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const DEFAULT_HLS_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_HLS_STARTUP_POLL_MS = 100;
const DEFAULT_TEMP_PREFIX = "seyirlik-playback-";
const DEFAULT_SESSION_ROUTE_BASE = "/api/playback/sessions";
const STDERR_TAIL_LIMIT = 8_000;

export class PlaybackSessionStartupError extends Error {
  code = "FFMPEG_STARTUP_FAILED";
  statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "PlaybackSessionStartupError";
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

export class PlaybackSessionManager {
  private sessions = new Map<string, PlaybackSession>();
  private ffmpegPath: string;
  private idleTimeoutMs: number;
  private killGraceMs: number;
  private hlsStartupTimeoutMs: number;
  private hlsStartupPollMs: number;
  private tempPrefix: string;
  private sessionRouteBase: string;
  private spawnProcess: NonNullable<
    PlaybackSessionManagerOptions["spawnProcess"]
  >;

  constructor(options: PlaybackSessionManagerOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.hlsStartupTimeoutMs =
      options.hlsStartupTimeoutMs ?? DEFAULT_HLS_STARTUP_TIMEOUT_MS;
    this.hlsStartupPollMs =
      options.hlsStartupPollMs ?? DEFAULT_HLS_STARTUP_POLL_MS;
    this.tempPrefix = options.tempPrefix ?? DEFAULT_TEMP_PREFIX;
    this.sessionRouteBase =
      options.sessionRouteBase ?? DEFAULT_SESSION_ROUTE_BASE;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async createSession(
    plan: PlaybackPlan,
    media: MediaAnalysis,
  ): Promise<PlaybackSession> {
    if (!plan.requiresFfmpeg) {
      throw new Error("Direct-play plans do not need FFmpeg sessions.");
    }

    const sessionId = randomUUID();
    const outputDir = await mkdtemp(join(tmpdir(), this.tempPrefix));
    const planWithSession = withSessionDelivery(
      plan,
      sessionId,
      this.sessionRouteBase,
    );
    const command = buildFfmpegCommand({
      plan: planWithSession,
      media,
      outputDir,
      ffmpegPath: this.ffmpegPath,
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
        plan: planWithSession,
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
        }ms.`,
      );
      return nextSession;
    } catch (error) {
      this.sessions.delete(sessionId);
      if (session) {
        await this.terminateSessionProcess(session);
      }
      await rm(outputDir, { recursive: true, force: true });
      throw error;
    }
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
      );
    }

    const startedAt = Date.now();

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

      const handleError = () => {
        finish(new PlaybackSessionStartupError("FFmpeg could not be started."));
      };

      const handleExit = () => {
        console.warn(
          "[Seyirlik Playback Backend] FFmpeg exited before HLS playlist was ready.",
        );
        finish(
          new PlaybackSessionStartupError(
            "FFmpeg exited before the HLS playlist was ready.",
          ),
        );
      };

      timeoutTimer = setTimeout(() => {
        console.warn(
          `[Seyirlik Playback Backend] FFmpeg HLS playlist was not ready after ${
            Date.now() - startedAt
          }ms.`,
        );
        finish(
          new PlaybackSessionStartupError(
            "FFmpeg did not produce an HLS playlist before startup timeout.",
          ),
        );
      }, this.hlsStartupTimeoutMs);

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
