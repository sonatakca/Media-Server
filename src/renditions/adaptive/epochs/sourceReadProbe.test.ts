/**
 * The probe that decides whether a stalled epoch's source is to blame.
 *
 * This is the evidence of last resort. When the watchdog stops an encoder
 * before Darwin's twenty-retry recovery has returned `EIO`, FFmpeg has written
 * nothing about its input — by design, because letting it learn of the first
 * bad block is letting it walk to the next — so there is no input-side line to
 * read and this probe is the only thing that can tell a damaged platter from a
 * wedged encoder.
 *
 * Which makes *what it is asked* as important as whether it answers. The first
 * version asked whether the epoch's start could be read. On the real damaged
 * title that was the one part of the interval that certainly could: eighty-three
 * seconds had already been encoded from it. The probe said "readable", the
 * assessment cleared the source, and a title with a hole in it was failed as an
 * encoder fault. These cases hold the window to the stretch that was *not*
 * read, and hold the answer to the wall clock rather than to the reap.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureAdaptiveEpochFixture,
  ADAPTIVE_EPOCH_FIXTURE_SECONDS,
} from "../testFixtures";
import { probeSourceRangeReadable } from "./sourceReadProbe";

let fixture: string | null = null;
let workspace = "";
/** A program that reads nothing and says nothing, for ever. */
let hangingProbe = "";

beforeAll(async () => {
  fixture = await ensureAdaptiveEpochFixture();
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-range-probe-"));
  hangingProbe = path.join(workspace, "hangs");
  await writeFile(
    hangingProbe,
    ["#!/bin/sh", "while :; do sleep 60; done", ""].join("\n"),
    "utf8",
  );
  await chmod(hangingProbe, 0o755);
}, 600_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("reading the window an encoder could not get through", () => {
  it("confirms a window the disk returns in full", async () => {
    if (!fixture) return;
    const outcome = await probeSourceRangeReadable({
      sourcePath: fixture,
      fromSeconds: 6,
      toSeconds: 14,
      sourceDurationSeconds: ADAPTIVE_EPOCH_FIXTURE_SECONDS,
      timeoutMs: 60_000,
    });
    expect(outcome.verdict).toBe("readable");
  }, 120_000);

  /*
   * The regression the real incident turned on. A read that stops early is the
   * signature of a hole, and it is only visible because the probe measures how
   * far it got rather than trusting the exit status: `-read_intervals` past the
   * end of a file returns what there is and exits zero.
   */
  it("will not call a window read that stopped far short of it readable", async () => {
    if (!fixture) return;
    const outcome = await probeSourceRangeReadable({
      sourcePath: fixture,
      fromSeconds: ADAPTIVE_EPOCH_FIXTURE_SECONDS - 2,
      toSeconds: ADAPTIVE_EPOCH_FIXTURE_SECONDS + 300,
      timeoutMs: 60_000,
    });
    expect(outcome.verdict).toBe("unreadable");
    expect(outcome.detail).toBeDefined();
  }, 120_000);

  /*
   * The same read, with the file's own length known. Not reaching bytes that do
   * not exist is not evidence against a disk, and treating it as such would
   * replace the last epoch of every title with black.
   */
  it("does not blame the disk for the end of the file", async () => {
    if (!fixture) return;
    const outcome = await probeSourceRangeReadable({
      sourcePath: fixture,
      fromSeconds: ADAPTIVE_EPOCH_FIXTURE_SECONDS - 2,
      toSeconds: ADAPTIVE_EPOCH_FIXTURE_SECONDS + 300,
      sourceDurationSeconds: ADAPTIVE_EPOCH_FIXTURE_SECONDS,
      timeoutMs: 60_000,
    });
    expect(outcome.verdict).toBe("readable");
  }, 120_000);

  it("reads nothing when the stall left no window to read", async () => {
    if (!fixture) return;
    const outcome = await probeSourceRangeReadable({
      sourcePath: fixture,
      fromSeconds: ADAPTIVE_EPOCH_FIXTURE_SECONDS,
      toSeconds: ADAPTIVE_EPOCH_FIXTURE_SECONDS,
      sourceDurationSeconds: ADAPTIVE_EPOCH_FIXTURE_SECONDS,
      timeoutMs: 60_000,
    });
    expect(outcome.verdict).toBe("readable");
  }, 120_000);
});

describe("a probe of a disk that has stopped answering", () => {
  /*
   * The latency half of the fix. The runner cannot hurry a `SIGKILL` the kernel
   * has not finished acting on — measured at four minutes from signal to reap on
   * the failing volume — but the *diagnosis* was complete the moment the wall
   * clock expired, and waiting for the reap to say so added those four minutes
   * to every salvage.
   */
  it("answers on its wall clock rather than waiting for the reap", async () => {
    const started = Date.now();
    const outcome = await probeSourceRangeReadable({
      sourcePath: "/does/not/matter.mkv",
      fromSeconds: 100,
      toSeconds: 300,
      ffprobePath: hangingProbe,
      timeoutMs: 750,
    });
    const elapsed = Date.now() - started;
    expect(outcome.verdict).toBe("timeout");
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);

  it("still stops the process it gave up on", async () => {
    const pidFile = path.join(workspace, "pid");
    const recorder = path.join(workspace, "records-its-pid");
    await writeFile(
      recorder,
      [
        "#!/bin/sh",
        `echo $$ > ${JSON.stringify(pidFile)}`,
        "while :; do sleep 60; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(recorder, 0o755);

    const outcome = await probeSourceRangeReadable({
      sourcePath: "/does/not/matter.mkv",
      fromSeconds: 0,
      toSeconds: 300,
      ffprobePath: recorder,
      timeoutMs: 500,
    });
    expect(outcome.verdict).toBe("timeout");

    const pid = await readPid(pidFile);
    expect(Number.isFinite(pid) && pid > 0).toBe(true);
    // The escalation is queued behind the grace, so this waits for it rather
    // than asserting an instant that has not arrived yet.
    await expect
      .poll(() => alive(pid), { timeout: 30_000, interval: 250 })
      .toBe(false);
  }, 60_000);

  /*
   * A probe stopped by anything but its own clock has learned nothing. The
   * commonest is a person cancelling the job, and reporting that as an
   * unreadable window would replace film over it.
   */
  it("says nothing about the source when the caller stops it", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const outcome = await probeSourceRangeReadable({
      sourcePath: "/does/not/matter.mkv",
      fromSeconds: 0,
      toSeconds: 300,
      ffprobePath: hangingProbe,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(outcome.verdict).toBe("readable");
  }, 60_000);

  /*
   * The false positive this rule exists to prevent. Five minutes of 4K is a few
   * hundred megabytes, so a healthy disk having a slow day can take longer than
   * the allowance — and calling that damage would replace film with black
   * because the drive was unhurried. What indicts a source is a read that has
   * stopped, not a read that is taking its time.
   */
  it("does not blame a disk that is answering, only slowly", async () => {
    const slow = path.join(workspace, "answers-slowly");
    await writeFile(
      slow,
      [
        "#!/bin/sh",
        // Keeps producing, steadily, for longer than the silence allowance.
        "i=0",
        "while [ $i -lt 40 ]; do echo $i; i=$((i+1)); sleep 0.05; done",
        "while :; do sleep 60; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(slow, 0o755);

    const outcome = await probeSourceRangeReadable({
      sourcePath: "/does/not/matter.mkv",
      fromSeconds: 0,
      toSeconds: 40,
      ffprobePath: slow,
      timeoutMs: 400,
    });
    // Never "timeout": the disk was returning data the whole time.
    expect(outcome.verdict).not.toBe("timeout");
  }, 60_000);

  it("answers as soon as a producing read goes quiet", async () => {
    const stalls = path.join(workspace, "stalls-mid-read");
    await writeFile(
      stalls,
      [
        "#!/bin/sh",
        "echo 1",
        "echo 2",
        // …and then the sector stops coming back.
        "while :; do sleep 60; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(stalls, 0o755);

    const started = Date.now();
    const outcome = await probeSourceRangeReadable({
      sourcePath: "/does/not/matter.mkv",
      fromSeconds: 0,
      toSeconds: 300,
      ffprobePath: stalls,
      timeoutMs: 600,
    });
    expect(outcome.verdict).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it("treats a prober that cannot be run as nothing to go on", async () => {
    const outcome = await probeSourceRangeReadable({
      sourcePath: "/does/not/matter.mkv",
      fromSeconds: 0,
      toSeconds: 300,
      ffprobePath: path.join(workspace, "no-such-prober"),
      timeoutMs: 10_000,
    });
    expect(outcome.verdict).toBe("unreadable");
  }, 60_000);
});

async function readPid(pidFile: string): Promise<number> {
  const raw = await readFile(pidFile, "utf8").catch(() => "");
  return Number(raw.trim());
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
