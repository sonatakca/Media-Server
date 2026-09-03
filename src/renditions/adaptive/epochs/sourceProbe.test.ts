/**
 * The probe that diagnoses a stalled encoder must not stall in the same way.
 *
 * `verifySourceReadable` asks a targeted question of the very file that has
 * just wedged an encoder, so on a failing platter it can enter the same
 * twenty-retry kernel recovery — and before this it was an unbounded `await` on
 * a subprocess with no wall clock, a single `SIGTERM` and no escalation. The
 * worker would have hung inside the code meant to explain why it was hanging.
 *
 * The fixtures are programs that answer nothing and never exit, which is the
 * only honest stand-in for a read that has not come back. One of them refuses
 * `SIGTERM` as well, because the real process could not act on it either.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeSourceFrameTimeline } from "./sourceTimeline";

let workspace = "";
let hangingProbe = "";
let stubbornProbe = "";
let pidFile = "";

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid the fixture recorded for itself, once it has recorded one. */
async function recordedPid(): Promise<number | undefined> {
  const raw = await readFile(pidFile, "utf8").catch(() => "");
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-probe-"));
  hangingProbe = path.join(workspace, "hanging-probe");
  stubbornProbe = path.join(workspace, "stubborn-probe");
  pidFile = path.join(workspace, "probe.pid");

  // Arguments ignored on purpose: this stands in for a prober that has issued
  // a read and is waiting for a platter that will not answer.
  await writeFile(
    hangingProbe,
    `#!/bin/sh\necho $$ > "${pidFile}"\nwhile true; do sleep 1; done\n`,
    "utf8",
  );
  await writeFile(
    stubbornProbe,
    `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nwhile true; do sleep 1; done\n`,
    "utf8",
  );
  await chmod(hangingProbe, 0o755);
  await chmod(stubbornProbe, 0o755);
});

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("probing a source that does not answer", () => {
  it("gives up on its own wall clock rather than waiting for the disk", async () => {
    const started = Date.now();
    const timeline = await probeSourceFrameTimeline({
      sourcePath: path.join(workspace, "film.mkv"),
      boundaries: [3000],
      ffprobePath: hangingProbe,
      /*
       * Long enough for the fixture to record its own pid before the deadline
       * lands on it, and still two orders of magnitude below the ceiling this
       * test asserts.
       *
       * At 500ms the shell script had not always reached its first line under
       * a loaded machine, so there was no pid to look for and the test failed
       * claiming nothing had been reaped — when in truth nothing had yet been
       * started. The property under test is that the prober gives up on its
       * own clock, which this still demonstrates.
       */
      timeoutMs: 2_000,
    });

    /*
     * `null` is the existing contract for "the prober could not answer", and
     * the planner already knows how to fall back from it. What is new is that
     * an answer arrives at all.
     */
    expect(timeline).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);

    const pid = await recordedPid();
    expect(pid).toBeDefined();
    // Reaped, not merely signalled: an ffprobe left running holds a descriptor
    // open on a volume this system is trying to give up on.
    expect(await alive(pid!)).toBe(false);
  }, 30_000);

  it("kills a prober that refuses to stop", async () => {
    const started = Date.now();
    const timeline = await probeSourceFrameTimeline({
      sourcePath: path.join(workspace, "film.mkv"),
      boundaries: [3000],
      ffprobePath: stubbornProbe,
      // Same race as the test above: the fixture has to exist to be killed.
      timeoutMs: 2_000,
    });

    expect(timeline).toBeNull();
    expect(Date.now() - started).toBeLessThan(20_000);
    const pid = await recordedPid();
    expect(pid).toBeDefined();
    expect(await alive(pid!)).toBe(false);
  }, 40_000);

  it("still waits when nothing has been asked of the disk", async () => {
    // No boundaries is answered without spawning anything, so a timeout must
    // not change what an ordinary planning pass gets back.
    const timeline = await probeSourceFrameTimeline({
      sourcePath: path.join(workspace, "film.mkv"),
      ffprobePath: hangingProbe,
      boundaries: [],
      timeoutMs: 500,
    });
    expect(timeline).toEqual({ timebase: 1000, ticks: [] });
  }, 30_000);
});
