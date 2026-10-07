/**
 * Prepares every book for search before anyone asks.
 *
 * Preparing a book is minutes of work, done once per book for every reader, so
 * the server does it in the background: a sweep shortly after start, every
 * hour after that (a book copied onto the volume is found by the next scan),
 * and straight after an upload. A sweep only lines books up; the search reads
 * them one at a time in its own low-priority process, behind any book a
 * reader is waiting for.
 *
 * Only the process that answers searches sweeps, so the model is never loaded
 * twice (see `preindexBooks` in nativeRuntime.ts).
 */

import path from "node:path";

import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import { bookFilePath } from "./bookRoutes";
import type { BookSearch } from "./bookSearch";
import { bookToSearch } from "./bookSearchRoutes";

/** After start, once the server is answering and the first scans have settled. */
const FIRST_SWEEP_MS = 3 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;

export interface BookPreindexing {
  /** Lines up every book not yet prepared. Sweeps never overlap. */
  sweep(): Promise<void>;
  stop(): void;
}

export function startBookPreindexing({
  catalogue,
  mediaRoot,
  search,
  warn = console.warn,
  firstSweepMs = FIRST_SWEEP_MS,
  sweepEveryMs = SWEEP_EVERY_MS,
}: {
  catalogue: Pick<CatalogueRepository, "listBookFiles">;
  mediaRoot: string;
  search: Pick<BookSearch, "preindex">;
  warn?: (message: string) => void;
  firstSweepMs?: number;
  sweepEveryMs?: number;
}): BookPreindexing {
  const resolvedMediaRoot = path.resolve(mediaRoot);
  let sweeping: Promise<void> | null = null;
  let sweepAgain = false;

  const run = async () => {
    const files = await catalogue.listBookFiles();
    await search.preindex(
      files.flatMap((file) => {
        const filePath = bookFilePath(resolvedMediaRoot, file);
        return filePath ? [bookToSearch(file.itemId, file, filePath)] : [];
      }),
    );
  };

  const sweep = (): Promise<void> => {
    // Asked during a sweep (an upload): once more when it ends, not alongside.
    if (sweeping) {
      sweepAgain = true;
      return sweeping;
    }
    sweeping = run()
      .catch((error: unknown) => {
        warn(`[Seyirlik] book search sweep failed: ${String(error)}`);
      })
      .finally(() => {
        sweeping = null;
        if (sweepAgain) {
          sweepAgain = false;
          void sweep();
        }
      });
    return sweeping;
  };

  const first = setTimeout(() => void sweep(), firstSweepMs);
  first.unref();
  const every = setInterval(() => void sweep(), sweepEveryMs);
  every.unref();

  return {
    sweep,
    stop: () => {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
