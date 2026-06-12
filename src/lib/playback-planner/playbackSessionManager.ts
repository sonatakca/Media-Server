import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  tempPrefix?: string;
  sessionRouteBase?: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const DEFAULT_TEMP_PREFIX = "seyirlik-playback-";
const DEFAULT_SESSION_ROUTE_BASE = "/api/playback/sessions";

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
  private tempPrefix: string;
  private sessionRouteBase: string;

  constructor(options: PlaybackSessionManagerOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.tempPrefix = options.tempPrefix ?? DEFAULT_TEMP_PREFIX;
    this.sessionRouteBase =
      options.sessionRouteBase ?? DEFAULT_SESSION_ROUTE_BASE;
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

    try {
      const child = spawn(command.command, command.args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const now = new Date();
      const session: PlaybackSession = {
        sessionId,
        mediaId: media.mediaId,
        plan: planWithSession,
        process: child,
        outputDir,
        createdAt: now,
        lastAccessedAt: now,
        stderrTail: "",
      };

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        session.stderrTail = `${session.stderrTail}${chunk}`.slice(-8_000);
      });
      this.sessions.set(sessionId, session);

      return session;
    } catch (error) {
      await rm(outputDir, { recursive: true, force: true });
      throw error;
    }
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

    if (session.process.exitCode === null && !session.process.killed) {
      session.process.kill("SIGTERM");
      const exited = await waitForExit(session.process, this.killGraceMs);

      if (!exited && session.process.exitCode === null) {
        session.process.kill("SIGKILL");
        await waitForExit(session.process, this.killGraceMs);
      }
    }

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
