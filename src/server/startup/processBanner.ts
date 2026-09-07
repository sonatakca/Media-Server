/**
 * The first thing this process says, before it can say anything useful.
 *
 * Static imports are evaluated depth-first in source order, and the server's
 * graph is several hundred modules that `tsx` transpiles on the way in. All of
 * that runs before the first statement of `mediaServer.ts`, so a log line
 * written inside `main()` cannot describe the period it takes — which on a cold
 * cache is seconds of a completely silent terminal, and was part of why the
 * nine-minute storage stall looked like "nothing is happening" rather than
 * "something specific is happening slowly".
 *
 * Importing this module *first* is what closes that gap. Its top-level code
 * runs before the modules listed after it are even loaded, so the process
 * announces itself immediately and the time spent loading the rest becomes a
 * measured number rather than a blank.
 *
 * Keep this file dependency-free. Anything it imports would be loaded before
 * the announcement, which is the problem it exists to solve.
 */

/** Set at module evaluation, which is as close to process start as we get. */
export const PROCESS_STARTED_AT_MS = Date.now();

/** How long the rest of the import graph took, measured at the call site. */
export function moduleLoadElapsedMs(): number {
  return Math.max(0, Date.now() - PROCESS_STARTED_AT_MS);
}

const ENTRY_BASENAMES = new Set([
  "mediaServer.ts",
  "mediaServer.js",
  "mediaWorker.ts",
  "mediaWorker.js",
]);

/**
 * Whether this process was launched *as* a Seyirlik server or worker.
 *
 * The guard matters: these modules are also imported by the test runner and by
 * scripts, and a banner printed into a test's output is noise rather than
 * observability.
 */
export function isSeyirlikProcessEntryPoint(
  argv: readonly string[] = process.argv,
): boolean {
  const entry = argv[1];
  if (!entry) return false;
  const basename = entry.slice(
    Math.max(entry.lastIndexOf("/"), entry.lastIndexOf("\\")) + 1,
  );
  return ENTRY_BASENAMES.has(basename);
}

export function announceProcessStart(
  stream: { write(chunk: string): unknown; isTTY?: boolean } = process.stdout,
  startedAtMs = PROCESS_STARTED_AT_MS,
): void {
  stream.write(
    stream.isTTY === true
      ? `\nSeyirlik — loading (pid ${process.pid})\n`
      : `${new Date(startedAtMs).toISOString()} [Seyirlik startup] process loading pid=${process.pid}\n`,
  );
}

if (isSeyirlikProcessEntryPoint()) {
  announceProcessStart();
}
