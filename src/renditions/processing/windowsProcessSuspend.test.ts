/**
 * The Windows suspend adapter, asserted from a Mac.
 *
 * Nothing here starts PowerShell. The helper's protocol is one line and the
 * classification of it is a pure function, which is deliberate: the Windows
 * paths in this project are written on a laptop and run on a server, and the
 * only ones that have ever stayed correct are the ones a laptop can test.
 *
 * What this file cannot prove is that `NtSuspendProcess` stops FFmpeg. That was
 * established against the production encoder — pid 11396, 9.469 s of CPU over
 * four seconds running, 0.000000 s over eight seconds suspended, 18.234 s over
 * four seconds after the resume, same pid throughout — and it is recorded here
 * because a measurement nobody wrote down is a measurement nobody has.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildWindowsSuspendCommand,
  createWindowsProcessSuspender,
  parseWindowsSuspendOutput,
  windowsSuspendHelperPath,
} from "./windowsProcessSuspend";
import { existsSync } from "node:fs";

const HELPER = "C:\\ProgramData\\Seyirlik\\app\\current\\src\\x.ps1";

function suspender(
  run: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
) {
  return createWindowsProcessSuspender({
    run,
    helperPath: HELPER,
    helperExists: () => true,
    // The exit-time net is a process-wide `process.once("exit")`; a unit test
    // has no business installing one.
    track: false,
  });
}

const ok = (stdout: string) => async () => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

describe("the command line", () => {
  it("passes the pid as an argument, never as script text", () => {
    const { command, args } = buildWindowsSuspendCommand(
      "suspend",
      11396,
      "ffmpeg.exe",
      HELPER,
    );

    expect(command).toBe("powershell.exe");
    expect(args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      HELPER,
      "-Action",
      "suspend",
      "-TargetProcessId",
      "11396",
      "-ImageName",
      "ffmpeg.exe",
    ]);
    // Nothing is concatenated, so nothing can be quoted out of.
    expect(args.join(" ")).not.toMatch(/[;&|]/);
  });

  it("omits the image guard when the caller has nothing to assert", () => {
    const { args } = buildWindowsSuspendCommand("resume", 7, undefined, HELPER);
    expect(args).not.toContain("-ImageName");
    expect(args).toContain("resume");
  });

  it("refuses a pid that is not one", () => {
    expect(() =>
      buildWindowsSuspendCommand("suspend", -11396, undefined, HELPER),
    ).toThrow(/positive integer/);
  });

  it("finds the helper beside this module rather than beside the process", () => {
    /*
     * The worker runs from a junction, is started by a service manager with a
     * working directory nobody here chose, and is executed straight from
     * TypeScript. `import.meta.url` is the only thing that reliably names the
     * directory this file was deployed into.
     */
    const helper = windowsSuspendHelperPath();
    expect(helper).toMatch(/windowsProcessSuspend\.ps1$/);
    expect(existsSync(helper)).toBe(true);
  });
});

describe("reading the helper's one line", () => {
  it("accepts a confirmed suspension", () => {
    expect(
      parseWindowsSuspendOutput(
        "suspend",
        "SEYIRLIK-SUSPEND status=suspended pid=11396 detail=\r\n",
      ),
    ).toEqual({ ok: true, gone: false });
  });

  it("accepts a confirmed resume", () => {
    expect(
      parseWindowsSuspendOutput(
        "resume",
        "SEYIRLIK-SUSPEND status=resumed pid=11396 detail=",
      ),
    ).toEqual({ ok: true, gone: false });
  });

  it("treats a process that has gone as a success on either action", () => {
    for (const action of ["suspend", "resume"] as const) {
      expect(
        parseWindowsSuspendOutput(
          action,
          "SEYIRLIK-SUSPEND status=gone pid=11396 detail=",
        ),
      ).toEqual({ ok: true, gone: true });
    }
  });

  it("refuses a pid that now belongs to something else", () => {
    /*
     * Windows recycles pids quickly. A suspend aimed at a recycled one freezes
     * whichever process the operating system handed the number to next, which
     * on this host could be anything at all.
     */
    const result = parseWindowsSuspendOutput(
      "suspend",
      "SEYIRLIK-SUSPEND status=wrong-process pid=11396 detail=expected ffmpeg, found explorer",
    );
    expect(result).toEqual({
      ok: false,
      failure: "wrong-process",
      detail: "expected ffmpeg, found explorer",
    });
  });

  it("reports a refused handle as a refused handle", () => {
    expect(
      parseWindowsSuspendOutput(
        "suspend",
        "SEYIRLIK-SUSPEND status=open-failed pid=11396 detail=OpenProcess failed with Win32 error 5",
      ),
    ).toMatchObject({ ok: false, failure: "access-denied" });
  });

  it("reports an NT status that was not success", () => {
    expect(
      parseWindowsSuspendOutput(
        "suspend",
        "SEYIRLIK-SUSPEND status=nt-failed pid=1 detail=NtSuspendProcess returned NTSTATUS 0xC0000022",
      ),
    ).toMatchObject({ ok: false, failure: "nt-failed" });
  });

  /**
   * The case that separates this from the bug it replaces.
   *
   * A zero NTSTATUS says the call was accepted. The helper reads the thread
   * states back afterwards and refuses to say "suspended" until they agree,
   * because everything downstream — the watchdog standing down, the durable
   * `paused`, the label an operator unplugs a drive on the strength of — is
   * built on that word meaning the process has genuinely stopped.
   */
  it("refuses to call an unconfirmed suspension a suspension", () => {
    expect(
      parseWindowsSuspendOutput(
        "suspend",
        "SEYIRLIK-SUSPEND status=not-confirmed pid=1 detail=the process still has running threads",
      ),
    ).toMatchObject({ ok: false, failure: "not-confirmed" });
  });

  it("does not read a resume as a suspension", () => {
    // The wrong answer to the wrong question is still the wrong answer.
    expect(
      parseWindowsSuspendOutput(
        "suspend",
        "SEYIRLIK-SUSPEND status=resumed pid=1 detail=",
      ),
    ).toMatchObject({ ok: false, failure: "malformed-output" });
  });

  it("rejects output that is not the protocol", () => {
    for (const noise of ["", "OK", "Get-Process : Access is denied."]) {
      expect(parseWindowsSuspendOutput("suspend", noise)).toMatchObject({
        ok: false,
        failure: "malformed-output",
      });
    }
  });
});

describe("running the helper", () => {
  it("confirms a suspension", async () => {
    const suspend = suspender(
      ok("SEYIRLIK-SUSPEND status=suspended pid=11396 detail="),
    );
    await expect(suspend("suspend", 11396, "ffmpeg.exe")).resolves.toEqual({
      ok: true,
      gone: false,
    });
  });

  it("calls a non-zero exit a failure rather than a pause", async () => {
    const suspend = suspender(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "C:\\ProgramData\\Seyirlik\\app\\current\\src\\x.ps1 : boom",
    }));
    const result = await suspend("suspend", 11396);
    expect(result).toMatchObject({ ok: false, failure: "helper-failed" });
    // The helper's stderr carries the installation's own paths, and this string
    // reaches an operator's screen.
    expect(!result.ok && result.detail).not.toMatch(/ProgramData/);
  });

  it("calls a timeout a failure", async () => {
    const suspend = suspender(async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
    }));
    await expect(suspend("suspend", 11396)).resolves.toMatchObject({
      ok: false,
      failure: "helper-timeout",
    });
  });

  it("calls a spawn that never started a failure", async () => {
    const suspend = suspender(async () => {
      throw new Error("ENOENT");
    });
    await expect(suspend("resume", 11396)).resolves.toMatchObject({
      ok: false,
      failure: "helper-failed",
    });
  });

  it("refuses a pid that is not a pid without running anything", async () => {
    const run = vi.fn();
    const suspend = suspender(run as never);
    await expect(suspend("suspend", 0)).resolves.toMatchObject({
      ok: false,
      failure: "invalid-pid",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("says so when the deployment did not bring the helper with it", async () => {
    const run = vi.fn();
    const suspend = createWindowsProcessSuspender({
      run: run as never,
      helperPath: HELPER,
      helperExists: () => false,
      track: false,
    });
    const result = await suspend("suspend", 11396);
    expect(result).toMatchObject({ ok: false, failure: "helper-missing" });
    expect(run).not.toHaveBeenCalled();
  });

  it("gives the helper its whole budget", async () => {
    let seen = 0;
    const suspend = createWindowsProcessSuspender({
      run: async (_command, _args, timeoutMs) => {
        seen = timeoutMs;
        return {
          exitCode: 0,
          stdout: "SEYIRLIK-SUSPEND status=resumed pid=1 detail=",
          stderr: "",
        };
      },
      timeoutMs: 12_345,
      helperPath: HELPER,
      helperExists: () => true,
      track: false,
    });
    await suspend("resume", 1);
    expect(seen).toBe(12_345);
  });
});
