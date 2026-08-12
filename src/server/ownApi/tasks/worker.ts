import { randomUUID } from "node:crypto";
import type { JobQueue, JobRecord } from "./jobQueue";

export interface JobContext {
  job: JobRecord;
  reportProgress(progress: number, message?: string): Promise<void>;
  isCancelled(): Promise<boolean>;
}

export type JobHandler = (
  context: JobContext,
) => Promise<Record<string, unknown> | void>;

export interface WorkerOptions {
  queue: JobQueue;
  handlers: Record<string, JobHandler>;
  /** How long a claimed job stays leased without a heartbeat. */
  leaseMs?: number;
  pollIntervalMs?: number;
  logger?: {
    info(event: string, context: Record<string, unknown>): void;
    error?(event: string, context: Record<string, unknown>): void;
  };
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Error text that reaches an operator dashboard must never carry a filesystem
 * path, a command line, or a connection string.
 */
export function sanitizeJobError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .split("\n", 1)[0]
      ?.replace(/(^|\s)(?:[A-Za-z]:)?[\\/][^\s]*/g, " ")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 480) || "The task failed."
  );
}

/**
 * A job whose failure is deterministic — a malformed payload, a deleted
 * library — should not burn its remaining attempts.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export function createWorker({
  queue,
  handlers,
  leaseMs = DEFAULT_LEASE_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  logger,
}: WorkerOptions) {
  const leaseOwner = `${process.pid}-${randomUUID().slice(0, 8)}`;
  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  async function runOne(job: JobRecord): Promise<void> {
    const handler = handlers[job.jobType];
    if (!handler) {
      await queue.fail(
        job.id,
        "No handler is registered for this task.",
        false,
      );
      return;
    }

    // Keep the lease alive for the length of the job so a long scan is not
    // reclaimed underneath itself.
    const heartbeat = setInterval(
      () => {
        void queue
          .heartbeat(job.id, leaseOwner, leaseMs)
          .catch(() => undefined);
      },
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref();

    try {
      const result = await handler({
        job,
        reportProgress: (progress, message) =>
          queue.reportProgress(job.id, progress, message),
        isCancelled: () => queue.isCancellationRequested(job.id),
      });
      await queue.complete(job.id, result ?? undefined);
      logger?.info("job.completed", { jobId: job.id, jobType: job.jobType });
    } catch (error) {
      const retry = !(error instanceof PermanentJobError);
      await queue.fail(job.id, sanitizeJobError(error), retry);
      logger?.error?.("job.failed", {
        jobId: job.id,
        jobType: job.jobType,
        retry,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function tick(): Promise<void> {
    if (stopping) return;

    try {
      await queue.reclaimExpiredLeases();

      // Drain rather than taking one job per interval, so a queued backlog is
      // not paced by the poll interval.
      for (;;) {
        if (stopping) return;
        const job = await queue.claim(leaseOwner, leaseMs);
        if (!job) return;
        await runOne(job);
      }
    } catch (error) {
      logger?.error?.("job.poll.failed", { message: sanitizeJobError(error) });
    }
  }

  return {
    leaseOwner,

    start(): void {
      if (running) return;
      running = true;
      stopping = false;

      const loop = async () => {
        await tick();
        if (!stopping) timer = setTimeout(loop, pollIntervalMs);
        timer?.unref();
      };
      void loop();
    },

    async stop(): Promise<void> {
      stopping = true;
      running = false;
      if (timer) clearTimeout(timer);
    },

    /** Runs a single drain pass; used by tests and the one-shot CLI. */
    runPending: tick,
  };
}
