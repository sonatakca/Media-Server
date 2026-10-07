/**
 * The server's handle on the book search's process (bookSearchWorker.ts).
 *
 * The process starts on the first request, runs below normal priority so the
 * encoder and everyone's playback come first, and exits after a quiet spell so
 * its model's memory is not held by a server nobody is searching.
 */

import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

import type { BookPassage } from "./bookText";
import type { BookSearchReply, BookSearchRequest } from "./bookSearchProtocol";

/** The book itself cannot be read; asking again will not change that. */
export class BookUnreadableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BookUnreadableError";
  }
}

export interface BookSearchProcess {
  index(
    filePath: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<{ passages: BookPassage[]; vectors: Float32Array }>;
  embedQuery(text: string): Promise<Float32Array>;
  close(): void;
}

/** One of the requests, before it is numbered. */
type Unnumbered<T> = T extends unknown ? Omit<T, "id"> : never;

const WORKER = fileURLToPath(new URL("./bookSearchWorker.ts", import.meta.url));
const IDLE_MS = 10 * 60_000;

interface Pending {
  resolve(reply: BookSearchReply): void;
  reject(error: Error): void;
  onProgress?: (done: number, total: number) => void;
}

export function createBookSearchProcess({
  modelDir,
}: {
  /** Where the model is downloaded to once and kept. */
  modelDir: string;
}): BookSearchProcess {
  let child: ChildProcess | null = null;
  let nextId = 1;
  let idleTimer: NodeJS.Timeout | null = null;
  const pending = new Map<number, Pending>();

  const failAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  const start = (): ChildProcess => {
    const started = fork(WORKER, [], {
      // Its environment arrives through `env`; only the TypeScript loader is needed.
      execArgv: ["--import", "tsx"],
      env: { ...process.env, SEYIRLIK_BOOK_SEARCH_MODEL_DIR: modelDir },
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    if (started.pid !== undefined) {
      try {
        os.setPriority(
          started.pid,
          os.constants.priority.PRIORITY_BELOW_NORMAL,
        );
      } catch {
        // Not permitted here; it still runs on two threads.
      }
    }

    started.on("message", (reply: BookSearchReply) => {
      const request = pending.get(reply.id);
      if (!request) return;
      if (reply.kind === "progress") {
        request.onProgress?.(reply.done, reply.total);
        return;
      }
      pending.delete(reply.id);
      request.resolve(reply);
      if (pending.size === 0) scheduleIdle();
    });
    const ended = () => {
      if (child === started) child = null;
      failAll(new Error("The book search process stopped."));
    };
    started.on("exit", ended);
    started.on("error", ended);
    return started;
  };

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pending.size === 0) child?.kill();
    }, IDLE_MS);
    idleTimer.unref();
  };

  const request = (
    message: Unnumbered<BookSearchRequest>,
    onProgress?: Pending["onProgress"],
  ): Promise<BookSearchReply> => {
    if (idleTimer) clearTimeout(idleTimer);
    child ??= start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      child!.send({ ...message, id } as BookSearchRequest);
    });
  };

  const unwrap = (reply: BookSearchReply): BookSearchReply => {
    if (reply.kind !== "error") return reply;
    throw reply.rejected
      ? new BookUnreadableError(reply.message)
      : new Error(reply.message);
  };

  return {
    index: async (filePath, onProgress) => {
      const reply = unwrap(
        await request({ kind: "index", filePath }, onProgress),
      );
      if (reply.kind !== "indexed") throw new Error("Unexpected reply.");
      return { passages: reply.passages, vectors: reply.vectors };
    },
    embedQuery: async (text) => {
      const reply = unwrap(await request({ kind: "query", text }));
      if (reply.kind !== "embedded") throw new Error("Unexpected reply.");
      return reply.vector;
    },
    close: () => {
      if (idleTimer) clearTimeout(idleTimer);
      child?.kill();
      child = null;
      failAll(new Error("The book search was closed."));
    },
  };
}
