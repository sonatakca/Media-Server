/**
 * Process lifetime, tested against processes that really refuse to cooperate.
 *
 * Nothing is mocked here. The fixture is a Node script that prints FFmpeg's
 * progress format, stops printing, and then sits there — because the failure
 * this file exists for is not a process that errors, it is a process that does
 * nothing at all and cannot be persuaded to stop. A real Seagate volume
 * produced exactly that: `SIGTERM` left FFmpeg in state `U`, `SIGKILL` could
 * not cancel the read either, and the process only became reapable once
 * Darwin's twenty-retry recovery unwound.
 *
 * So the fixture can ignore `SIGTERM`, spawn a child of its own, and outlive
 * the polite request — and every test here waits for the reap rather than
 * assuming one.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKGROUND_PROCESS_NICENESS,
  ProcessAbortedError,
  runBoundedProcess,
  spawnManagedProcess,
} from "./processExecution";

const run = promisify(execFile);
let workspace = "";
let fixture = "";

/**
 * A process that behaves like FFmpeg on a bad platter.
 *
 * `steps` progress blocks with an advancing timeline, then whatever `stderr`
 * says, then silence for ever. `ignoreTerm` makes it uninterruptible in the
 * only way a test can: by refusing the signal.
 */
const FIXTURE = `
const steps = Number(process.env.STEPS ?? "3");
const mode = process.env.STDERR_MODE ?? "none";
const hold = process.env.HOLD !== "false";

if (process.env.IGNORE_TERM === "true") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}

if (process.env.SPAWN_CHILD === "true") {
  const { spawn } = await import("node:child_process");
  // A grandchild in the same process group, which a leaf-only kill would miss.
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

let seconds = 0;
for (let index = 0; index < steps; index += 1) {
  seconds += 1;
  const clock = new Date(seconds * 1000).toISOString().slice(11, 23);
  process.stdout.write("out_time=" + clock + "\\n");
  process.stdout.write("speed=1.5x\\n");
  process.stdout.write("progress=continue\\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
}

if (mode === "source-eio") {
  process.stderr.write(
    "[in#0/matroska,webm @ 0x1] Read error at pos. 10074169063\\n" +
      "[in#0/matroska,webm @ 0x1] Error during demuxing: Input/output error\\n",
  );
} else if (mode === "output-eio") {
  process.stderr.write(
    "[out#0/hls @ 0x1] Error writing trailer: Input/output error\\n" +
      "av_interleaved_write_frame(): Input/output error\\n",
  );
}

if (!hold) {
  // The timeline keeps moving, which is what a slow-but-working encoder does.
  for (;;) {
    seconds += 1;
    const clock = new Date(seconds * 1000).toISOString().slice(11, 23);
    process.stdout.write("out_time=" + clock + "\\n");
    process.stdout.write("progress=continue\\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

// And then nothing, for ever. This is the whole point of the fixture.
setInterval(() => {}, 1000);
`;

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every pid in a process group, for proving a grandchild went too. */
async function groupMembers(pid: number): Promise<string[]> {
  const { stdout } = await run("ps", ["-o", "pid=", "-g", String(pid)]).catch(
    () => ({ stdout: "" }) as never,
  );
  return String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function fixtureProcess(
  environment: Record<string, string>,
  options: Parameters<typeof spawnManagedProcess>[0] extends infer T
    ? Partial<Omit<T & object, "command" | "args">>
    : never = {},
) {
  return spawnManagedProcess({
    command: process.execPath,
    args: [fixture],
    ...options,
    // The fixture reads its behaviour from the environment, and `spawn` inherits
    // this process's, so each case sets exactly what it needs.
  } as never);
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-proc-"));
  fixture = path.join(workspace, "stalling.mjs");
  await writeFile(fixture, FIXTURE, "utf8");
});

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

/** The niceness the kernel actually gave a pid, as opposed to the one asked for. */
async function nicenessOf(pid: number): Promise<number> {
  const { stdout } = await run("ps", ["-o", "nice=", "-p", String(pid)]);
  return Number(String(stdout).trim());
}

describe("scheduling priority", () => {
  /*
   * The point of the whole feature: an encode must never be able to win a core
   * away from the window server. Asserting on `ps` rather than on the argument
   * passed in, because the failure worth catching is the one where the call is
   * made against a pid that has already been reaped and nothing happens.
   */
  it("runs children behind the interface by default", async () => {
    const managed = fixtureProcess({ STEPS: "1", HOLD: "true" });
    expect(managed.pid).toBeDefined();
    await expect(nicenessOf(managed.pid as number)).resolves.toBe(
      BACKGROUND_PROCESS_NICENESS,
    );
    managed.abort("caller");
    await managed.completed;
  });

  it("leaves a process someone is waiting on at foreground priority", async () => {
    const parent = await nicenessOf(process.pid);
    const managed = fixtureProcess(
      { STEPS: "1", HOLD: "true" },
      { niceness: 0 },
    );
    expect(managed.pid).toBeDefined();
    await expect(nicenessOf(managed.pid as number)).resolves.toBe(parent);
    managed.abort("caller");
    await managed.completed;
  });

  /*
   * Reprioritising is best effort, so the one thing it must never do is turn a
   * working spawn into a failed one — including when there is no pid to
   * reprioritise because the command did not exist.
   */
  it("still settles when there is no child to reprioritise", async () => {
    const managed = spawnManagedProcess({
      command: path.join(workspace, "no-such-binary"),
      args: [],
    });
    const outcome = await managed.completed;
    expect(outcome.exitCode).toBeNull();
    expect(outcome.aborted).toBe(false);
  });
});

describe("a process that ends on its own", () => {
  it("reports its status, its output and how long it took", async () => {
    const managed = spawnManagedProcess({
      command: process.execPath,
      args: ["-e", "process.stderr.write('done'); process.exit(3)"],
    });
    const outcome = await managed.completed;
    expect(outcome.exitCode).toBe(3);
    expect(outcome.aborted).toBe(false);
    expect(outcome.abortReason).toBeUndefined();
    expect(outcome.escalated).toBe(false);
    expect(outcome.stderrTail).toContain("done");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("settles rather than hanging when the command does not exist", async () => {
    const managed = spawnManagedProcess({
      command: path.join(workspace, "no-such-binary"),
      args: [],
    });
    const outcome = await managed.completed;
    expect(outcome.exitCode).toBeNull();
    expect(outcome.aborted).toBe(false);
  });
});

describe("stopping a process that is not listening", () => {
  it("escalates to SIGKILL and waits for the reap", async () => {
    /*
     * The real behaviour, reproduced the only way user space can: a child that
     * refuses `SIGTERM`. On the failing drive the refusal was involuntary — an
     * uninterruptible read — and the consequence is identical, which is that a
     * terminator which sends one signal and walks away leaves the process
     * running.
     */
    process.env.IGNORE_TERM = "true";
    process.env.STEPS = "1";
    let pid: number | undefined;
    try {
      const managed = fixtureProcess({}, { terminationGraceMs: 300 });
      pid = managed.pid;
      await new Promise((resolve) => setTimeout(resolve, 300));
      managed.abort("caller");
      const outcome = await managed.completed;
      expect(outcome.aborted).toBe(true);
      expect(outcome.abortReason).toBe("caller");
      expect(outcome.escalated).toBe(true);
      expect(outcome.signal).toBe("SIGKILL");
    } finally {
      delete process.env.IGNORE_TERM;
      delete process.env.STEPS;
    }
    // Reaped, not merely signalled.
    expect(pid === undefined || (await alive(pid))).toBe(false);
  }, 30_000);

  it("does not escalate a process that goes quietly", async () => {
    process.env.STEPS = "1";
    try {
      const managed = fixtureProcess({}, { terminationGraceMs: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      managed.abort("caller");
      const outcome = await managed.completed;
      expect(outcome.aborted).toBe(true);
      expect(outcome.escalated).toBe(false);
      expect(outcome.signal).toBe("SIGTERM");
    } finally {
      delete process.env.STEPS;
    }
  }, 30_000);

  it("takes the whole process group, not just the leaf", async () => {
    /*
     * An FFmpeg that leaves a helper behind is an orphan holding a descriptor
     * on a volume this system is trying to give up on. The fixture spawns a
     * child that would outlive a leaf-only kill.
     */
    process.env.SPAWN_CHILD = "true";
    process.env.STEPS = "1";
    let pid: number | undefined;
    try {
      const managed = fixtureProcess({}, { terminationGraceMs: 200 });
      pid = managed.pid;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await groupMembers(pid!)).length).toBeGreaterThan(1);
      managed.abort("caller");
      await managed.completed;
    } finally {
      delete process.env.SPAWN_CHILD;
      delete process.env.STEPS;
    }
    // The group is empty, which a leaf kill could not have achieved.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await groupMembers(pid!)).toEqual([]);
  }, 30_000);

  it("keeps the first reason when asked twice", async () => {
    process.env.STEPS = "1";
    try {
      const managed = fixtureProcess({}, { terminationGraceMs: 200 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      managed.abort("media-watchdog");
      // A cancellation landing during a watchdog termination must not rewrite
      // the story, or restart the escalation.
      managed.abort("caller");
      const outcome = await managed.completed;
      expect(outcome.abortReason).toBe("media-watchdog");
    } finally {
      delete process.env.STEPS;
    }
  }, 30_000);

  it("resolves exactly once however many times it is aborted", async () => {
    process.env.STEPS = "1";
    try {
      const managed = fixtureProcess({}, { terminationGraceMs: 100 });
      let settlements = 0;
      void managed.completed.then(() => {
        settlements += 1;
      });
      managed.abort("caller");
      managed.abort("caller");
      managed.abort("wall-clock");
      await managed.completed;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settlements).toBe(1);
    } finally {
      delete process.env.STEPS;
    }
  }, 30_000);
});

describe("runBoundedProcess", () => {
  it("returns what the process printed", async () => {
    const { stdout } = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello')"],
    });
    expect(stdout).toBe("hello");
  });

  it("cannot outlive its own wall clock", async () => {
    /*
     * The property that matters for a probe of a damaged source: the question
     * is bounded even when the disk is not. Without this the diagnosis hangs in
     * exactly the situation it exists to diagnose.
     */
    process.env.STEPS = "0";
    try {
      const started = Date.now();
      await expect(
        runBoundedProcess({
          command: process.execPath,
          args: [fixture],
          timeoutMs: 400,
          terminationGraceMs: 200,
          describe: "The probe",
        }),
      ).rejects.toMatchObject({
        name: "ProcessAbortedError",
        reason: "wall-clock",
      });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      delete process.env.STEPS;
    }
  }, 30_000);

  it("reports a non-zero exit without pretending it was aborted", async () => {
    await expect(
      runBoundedProcess({
        command: process.execPath,
        args: ["-e", "process.stderr.write('nope'); process.exit(2)"],
        describe: "The probe",
      }),
    ).rejects.toThrow(/exit code 2/);
  });

  it("stops a process that will not stop talking", async () => {
    const error = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "for(;;) process.stdout.write('x'.repeat(1024))"],
      maxOutputBytes: 4_096,
      terminationGraceMs: 200,
      describe: "The probe",
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProcessAbortedError);
    expect((error as ProcessAbortedError).reason).toBe("output-limit");
  }, 30_000);
});
