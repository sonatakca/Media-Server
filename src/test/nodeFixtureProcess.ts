import {
  runBoundedProcess,
  spawnManagedProcess,
} from "../renditions/processExecution";

/**
 * Runs a Node script in place of whatever binary a prober was going to spawn.
 *
 * The probe suites stood their fake `ffprobe` up as a `/bin/sh` script with a
 * shebang. That is not something Windows can execute at all: the spawn failed
 * immediately, the runner settled with an error, and every case read that as
 * "the source is unreadable" — a diagnosis about a disk, produced by a missing
 * shell. Worse, the two cases that then look for a pid the fixture was supposed
 * to have recorded found nothing, and reported that nothing had been reaped when
 * in truth nothing had been started.
 *
 * Only the binary is replaced. The command's own arguments are dropped, because
 * a Node script has no use for `ffprobe`'s, and everything the tests are about —
 * the probe's clock, the abort, the real signal or the real `taskkill`, and the
 * real reap — stays on the production path.
 */
export function runsNodeFixture(script: string): typeof spawnManagedProcess {
  return (input) =>
    spawnManagedProcess({
      ...input,
      command: process.execPath,
      args: [script],
    });
}

/** A process that says nothing and never ends, until something stops it. */
export const HANGING_FIXTURE = `
process.stdout.write("");
setInterval(() => {}, 1000);
`;

/** The same, but it records its own pid first so a test can look for it. */
export function recordingFixture(pidFile: string): string {
  return `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`;
}

/** Records its pid and then refuses to go quietly. */
export function stubbornFixture(pidFile: string): string {
  return `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`;
}

/**
 * The same substitution for the bounded runner rather than the managed spawn.
 *
 * `runBoundedProcess` is a different entry point into the same machinery, and
 * the prober that uses it needs the identical treatment: a fake binary the host
 * can actually execute, with the clock and the termination left alone.
 */
export function runsNodeFixtureBounded(
  script: string,
): typeof runBoundedProcess {
  return (input) =>
    runBoundedProcess({ ...input, command: process.execPath, args: [script] });
}
