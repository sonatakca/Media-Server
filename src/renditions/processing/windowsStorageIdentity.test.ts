import { describe, expect, it, vi } from "vitest";
import {
  buildVolumeQuery,
  classifyWindowsMedium,
  createWindowsIdentityProbe,
  createWindowsVolumeIdentityQuery,
  extractVolumeGuid,
  MAX_PROBE_OUTPUT_BYTES,
  parseWindowsVolumeDocument,
  resolveWindowsVolumeTarget,
} from "./windowsStorageIdentity";
import { satisfiesRecovery, type VolumeIdentity } from "./storageIdentity";
import { ProcessAbortedError } from "../processExecution";

/**
 * The Windows half of volume identity.
 *
 * The question is the same one the Darwin tests ask — *is the volume in front of
 * me the volume that was quarantined?* — and the answer has to be as
 * untrusting. Nothing here touches a disk: the probe's only outside contact is
 * an injected command runner, and every fixture is a string.
 *
 * The external drive this system runs on is **not** identified by any of these
 * fixtures. Its real identity is unknown until the separately authorised HDD
 * gate captures it; the GUIDs below are invented.
 */

/** A volume record shaped exactly as the probe's own script emits one. */
function volumeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    uniqueId: "\\\\?\\Volume{9f3a1c6e-1111-4a2b-9c3d-000000000001}\\",
    fileSystemType: "NTFS",
    driveType: "Fixed",
    driveLetter: "D",
    busType: "USB",
    diskNumber: 1,
    partitionNumber: 2,
    ...overrides,
  });
}

/** A runner that answers with one document and records how it was called. */
function runnerReturning(stdout: string) {
  const calls: Array<{
    command: string;
    args: readonly string[];
    timeoutMs: number;
  }> = [];
  const run = async (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => {
    calls.push({ command, args, timeoutMs });
    return stdout;
  };
  return { run, calls };
}

/* ------------------------------------------------------------ path handling */

describe("resolving a Windows path to the volume underneath it", () => {
  it("takes the drive letter from an ordinary path", () => {
    expect(resolveWindowsVolumeTarget("D:\\media")).toEqual({
      kind: "drive-letter",
      letter: "D",
    });
  });

  it("accepts forward slashes, which is how the .env writes them", () => {
    // The Windows deployment's own configuration uses `D:/media`.
    expect(resolveWindowsVolumeTarget("D:/media")).toEqual({
      kind: "drive-letter",
      letter: "D",
    });
  });

  it("upper-cases a lowercase drive letter", () => {
    expect(resolveWindowsVolumeTarget("d:\\media\\Movies")).toEqual({
      kind: "drive-letter",
      letter: "D",
    });
  });

  it("treats a bare drive, a root and a trailing separator as the same volume", () => {
    for (const path of ["D:", "D:\\", "D:/", "D:\\media\\", "D:/media/"]) {
      expect(resolveWindowsVolumeTarget(path)).toEqual({
        kind: "drive-letter",
        letter: "D",
      });
    }
  });

  it("resolves a deep child directory to its volume, not to itself", () => {
    expect(
      resolveWindowsVolumeTarget("D:\\media\\Series\\Example Show\\Season 1"),
    ).toEqual({ kind: "drive-letter", letter: "D" });
  });

  it("strips the extended-length prefix that long paths carry", () => {
    expect(resolveWindowsVolumeTarget("\\\\?\\D:\\media")).toEqual({
      kind: "drive-letter",
      letter: "D",
    });
  });

  it("recognises a UNC path instead of mangling it into a drive letter", () => {
    expect(resolveWindowsVolumeTarget("\\\\nas\\media\\Movies")).toEqual({
      kind: "unc",
      server: "nas",
      share: "media",
    });
  });

  it("recognises a UNC path wearing the extended-length prefix", () => {
    expect(resolveWindowsVolumeTarget("\\\\?\\UNC\\nas\\media")).toEqual({
      kind: "unc",
      server: "nas",
      share: "media",
    });
  });

  it("refuses a relative path rather than guessing a drive", () => {
    const target = resolveWindowsVolumeTarget("media\\Movies");
    expect(target.kind).toBe("unsupported");
  });

  it("refuses a POSIX path rather than guessing a drive", () => {
    const target = resolveWindowsVolumeTarget("/Volumes/Expansion/media");
    expect(target.kind).toBe("unsupported");
  });

  it("refuses a volume mounted into a folder, which has no drive letter", () => {
    // `C:\mounts\data` may be a distinct volume; without a letter this probe
    // cannot say which, and saying "C:" would be a fabricated identity.
    const target = resolveWindowsVolumeTarget("");
    expect(target).toMatchObject({
      kind: "unsupported",
      reason: "no-drive-letter",
    });
  });
});

/* --------------------------------------------------------- command building */

describe("the command the probe runs", () => {
  it("never puts the media path into the script text", () => {
    const { args } = buildVolumeQuery("D");
    const script = args.join(" ");
    expect(script).not.toContain("media");
    expect(script).toContain("Get-Volume -DriveLetter D");
  });

  it("runs PowerShell without a profile and without prompting", () => {
    const { command, args } = buildVolumeQuery("D");
    expect(command).toBe("powershell.exe");
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
  });

  it("refuses anything that is not a single letter", () => {
    for (const bad of ["D:", "DD", "", "1", "D;Remove-Item", "../"]) {
      expect(() => buildVolumeQuery(bad)).toThrow();
    }
  });

  it("passes a fixed argument array rather than a shell string", () => {
    const { args } = buildVolumeQuery("E");
    expect(Array.isArray(args)).toBe(true);
    // The letter reaches the script as one validated character, nothing else.
    expect(args.filter((a) => a.includes("Get-Volume"))).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- classifying */

describe("what kind of storage Windows is describing", () => {
  it("calls a USB disk external physical media", () => {
    expect(classifyWindowsMedium("Fixed", "USB")).toBe("physical-external");
  });

  it("calls the RAID-attached boot disk internal, not unknown", () => {
    // This machine's only internal disk reports BusType `RAID` behind Intel
    // RST. Reading that as `unknown` would make every internal path unidentified.
    expect(classifyWindowsMedium("Fixed", "RAID")).toBe("physical-internal");
  });

  it("calls SATA and NVMe internal", () => {
    expect(classifyWindowsMedium("Fixed", "SATA")).toBe("physical-internal");
    expect(classifyWindowsMedium("Fixed", "NVMe")).toBe("physical-internal");
  });

  it("names a file-backed virtual disk as a disk image", () => {
    // The case the whole identity system exists for, and Windows says it plainly.
    expect(classifyWindowsMedium("Fixed", "File Backed Virtual")).toBe(
      "disk-image",
    );
  });

  it("calls a mapped drive a network volume whatever bus it claims", () => {
    expect(classifyWindowsMedium("Network", "USB")).toBe("network");
  });

  it("does not guess internal when the bus is unrecognised", () => {
    expect(classifyWindowsMedium("Fixed", "Frobnicator")).toBe("unknown");
  });

  it("still recognises removable media when the bus is unknown", () => {
    expect(classifyWindowsMedium("Removable", "")).toBe("physical-external");
  });
});

describe("extracting a volume GUID", () => {
  it("takes the GUID out of a UniqueId path", () => {
    expect(
      extractVolumeGuid(
        "\\\\?\\Volume{9f3a1c6e-1111-4a2b-9c3d-000000000001}\\",
      ),
    ).toBe("9f3a1c6e-1111-4a2b-9c3d-000000000001");
  });

  it("normalises case so the same volume compares equal", () => {
    expect(
      extractVolumeGuid(
        "\\\\?\\Volume{9F3A1C6E-1111-4A2B-9C3D-000000000001}\\",
      ),
    ).toBe("9f3a1c6e-1111-4a2b-9c3d-000000000001");
  });

  it("returns null rather than inventing one", () => {
    for (const bad of ["", "   ", "Volume-no-guid", null, undefined]) {
      expect(extractVolumeGuid(bad as string)).toBeNull();
    }
  });
});

/* ----------------------------------------------------------------- parsing */

describe("reading a volume document", () => {
  it("builds an identity for the volume, not for the directory asked about", () => {
    const result = parseWindowsVolumeDocument(volumeJson(), "D:\\media");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.volumeUuid).toBe(
      "9f3a1c6e-1111-4a2b-9c3d-000000000001",
    );
    expect(result.identity.medium).toBe("physical-external");
    expect(result.identity.mountPath).toBe("D:\\");
  });

  it("lower-cases the filesystem so it compares with the Darwin spelling", () => {
    const result = parseWindowsVolumeDocument(
      volumeJson({ fileSystemType: "exFAT" }),
      "D:\\",
    );
    expect(result.ok && result.identity.fsType).toBe("exfat");
  });

  it("keeps disk and partition numbers for diagnostics without giving them authority", () => {
    const result = parseWindowsVolumeDocument(volumeJson(), "D:\\");
    expect(result.ok && result.identity.deviceNode).toBe(
      "\\\\.\\PhysicalDrive1#2",
    );
  });

  it("rejects output that is not JSON", () => {
    const result = parseWindowsVolumeDocument(
      "Get-Volume : Cannot find drive",
      "D:\\",
    );
    expect(result).toMatchObject({ ok: false, failure: "malformed-output" });
  });

  it("rejects empty output", () => {
    expect(parseWindowsVolumeDocument("   \n ", "D:\\")).toMatchObject({
      ok: false,
      failure: "malformed-output",
    });
  });

  it("rejects oversized output instead of parsing it", () => {
    const huge = " ".repeat(MAX_PROBE_OUTPUT_BYTES + 1);
    expect(parseWindowsVolumeDocument(huge, "D:\\")).toMatchObject({
      ok: false,
      failure: "oversized-output",
    });
  });

  it("refuses an ambiguous answer rather than taking the first record", () => {
    const two = `[${volumeJson()},${volumeJson({ driveLetter: "E" })}]`;
    expect(parseWindowsVolumeDocument(two, "D:\\")).toMatchObject({
      ok: false,
      failure: "ambiguous-output",
    });
  });

  it("accepts a single-element array, which is how one record can arrive", () => {
    expect(parseWindowsVolumeDocument(`[${volumeJson()}]`, "D:\\").ok).toBe(
      true,
    );
  });

  it("refuses a document carrying no identifier and no recognisable medium", () => {
    const empty = JSON.stringify({ uniqueId: "", driveType: "", busType: "" });
    expect(parseWindowsVolumeDocument(empty, "D:\\")).toMatchObject({
      ok: false,
      failure: "incomplete-identity",
    });
  });

  it("does not accept misleading stdout that merely looks like success", () => {
    // A profile banner printed before an error, for instance.
    const misleading =
      'Windows PowerShell\nCopyright (C) Microsoft Corporation\n{"ok":true}';
    expect(parseWindowsVolumeDocument(misleading, "D:\\").ok).toBe(false);
  });
});

/* ------------------------------------------------------------------- probe */

describe("the Windows identity probe end to end", () => {
  it("identifies the volume behind a nested media path", async () => {
    const { run, calls } = runnerReturning(volumeJson());
    const query = createWindowsVolumeIdentityQuery({ run });

    const result = await query("D:\\media\\Movies");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.volumeUuid).toBe(
      "9f3a1c6e-1111-4a2b-9c3d-000000000001",
    );
    expect(result.identity.medium).toBe("physical-external");
    // One bounded call, and the path never travelled with it.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.args.join(" ")).not.toContain("Movies");
  });

  it("answers a UNC path as a network volume without running anything", async () => {
    const { run, calls } = runnerReturning(volumeJson());
    const query = createWindowsVolumeIdentityQuery({ run });

    const result = await query("\\\\nas\\media");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.medium).toBe("network");
    expect(result.identity.volumeUuid).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("reports a missing drive as a failure, not as a volume", async () => {
    const run = async () => {
      throw new Error(
        "Get-Volume : No MSFT_Volume objects found with property 'DriveLetter'",
      );
    };
    const result = await createWindowsVolumeIdentityQuery({ run })("D:\\media");
    expect(result).toMatchObject({ ok: false, failure: "probe-failed" });
  });

  /**
   * The error is the runner's own class, built from the outcome the runner
   * actually produces when `timeoutMs` expires — not a literal shaped to match
   * the check.
   *
   * That distinction is the whole test. The first version of this suite threw
   * `{ name: "ProcessAbortedError", reason: "timeout" }`, the probe looked for
   * exactly that, and both agreed on a value `ProcessAbortReason` has never
   * had. It passed for months and was worth nothing: on a real Windows host
   * every expired probe was classified `probe-failed`, which tells an operator
   * the storage would not answer when in fact nobody waited long enough.
   */
  it("distinguishes a timeout from an ordinary failure", async () => {
    const aborted = new ProcessAbortedError("stopped", {
      exitCode: null,
      signal: "SIGKILL",
      aborted: true,
      abortReason: "wall-clock",
      escalated: true,
      stderrTail: "",
      durationMs: 10_000,
    });
    const run = async () => {
      throw aborted;
    };
    const result = await createWindowsVolumeIdentityQuery({ run })("D:\\media");
    expect(result).toMatchObject({ ok: false, failure: "probe-timeout" });
  });

  it("does not mistake an ordinary abort for a timeout", async () => {
    const cancelled = new ProcessAbortedError("stopped", {
      exitCode: null,
      signal: "SIGTERM",
      aborted: true,
      abortReason: "caller",
      escalated: false,
      stderrTail: "",
      durationMs: 4,
    });
    const run = async () => {
      throw cancelled;
    };
    const result = await createWindowsVolumeIdentityQuery({ run })("D:\\media");
    expect(result).toMatchObject({ ok: false, failure: "probe-failed" });
  });

  it("never puts the command's own output into an operator-facing message", async () => {
    const run = async () => {
      throw new Error(
        "Cannot find path 'D:\\media\\Series\\Example Show' because it does not exist.",
      );
    };
    const result = await createWindowsVolumeIdentityQuery({ run })(
      "D:\\media\\Series\\Example Show",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain("Example Show");
    expect(result.detail).not.toContain("media");
  });

  it("propagates cancellation as a failure rather than hanging", async () => {
    const controller = new AbortController();
    const run = (_c: string, _a: readonly string[], _t: number) =>
      new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("stopped"), {
              name: "ProcessAbortedError",
              reason: "caller",
            }),
          ),
        );
      });
    const pending = createWindowsVolumeIdentityQuery({ run })("D:\\media");
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      failure: "probe-failed",
    });
  });
});

/* ------------------------------------------------- the shared probe contract */

describe("the probe as the rest of the system consumes it", () => {
  it("returns an identity on success", async () => {
    const { run } = runnerReturning(volumeJson());
    const probe = createWindowsIdentityProbe({ run });
    await expect(probe("D:\\media")).resolves.toMatchObject({
      medium: "physical-external",
    });
  });

  it("returns null — fail closed — on every failure, and says why once", async () => {
    const onFailure = vi.fn();
    const run = async () => "not json";
    const probe = createWindowsIdentityProbe({ run, onFailure });

    await expect(probe("D:\\media")).resolves.toBeNull();
    expect(onFailure).toHaveBeenCalledWith(
      "malformed-output",
      expect.any(String),
    );
    // The reason is logged; the raw output is not.
    expect(onFailure.mock.calls[0]?.[1]).not.toContain("not json");
  });

  it("returns null for a path it cannot resolve to a volume", async () => {
    const { run, calls } = runnerReturning(volumeJson());
    const probe = createWindowsIdentityProbe({ run });
    await expect(probe("relative\\path")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------- what identity actually decides */

describe("what a Windows identity can and cannot release", () => {
  const recorded: VolumeIdentity = {
    volumeUuid: "9f3a1c6e-1111-4a2b-9c3d-000000000001",
    deviceNode: "\\\\.\\PhysicalDrive1#2",
    medium: "physical-external",
    fsType: "ntfs",
    mountPath: "D:\\",
  };

  async function identityFrom(json: string, path = "D:\\media") {
    const { run } = runnerReturning(json);
    return createWindowsIdentityProbe({ run })(path);
  }

  it("accepts the same volume back at the same drive letter", async () => {
    const current = await identityFrom(volumeJson());
    expect(satisfiesRecovery(recorded, current)).toEqual({ ok: true });
  });

  it("accepts the same volume after it is assigned a different drive letter", async () => {
    // The identity is the GUID. A letter is a mount location, and Windows
    // hands them out in enumeration order.
    const current = await identityFrom(
      volumeJson({ driveLetter: "F" }),
      "F:\\media",
    );
    expect(satisfiesRecovery(recorded, current)).toEqual({ ok: true });
  });

  it("refuses a different volume that has taken the expected drive letter", async () => {
    const current = await identityFrom(
      volumeJson({
        uniqueId: "\\\\?\\Volume{deadbeef-0000-0000-0000-00000000ffff}\\",
      }),
    );
    expect(satisfiesRecovery(recorded, current).ok).toBe(false);
  });

  it("never lets a mounted VHD release a quarantine on physical media", async () => {
    // The exact false negative the identity system exists to prevent, in its
    // Windows form: a file-backed disk attached at the expected letter.
    const current = await identityFrom(
      volumeJson({ busType: "File Backed Virtual", driveType: "Fixed" }),
    );
    expect(current?.medium).toBe("disk-image");
    expect(satisfiesRecovery(recorded, current).ok).toBe(false);
  });

  it("refuses when the drive is absent", async () => {
    const run = async () => {
      throw new Error("no such volume");
    };
    const current = await createWindowsIdentityProbe({ run })("D:\\media");
    expect(current).toBeNull();
    expect(satisfiesRecovery(recorded, current).ok).toBe(false);
  });

  it("refuses when the volume has been reformatted to another filesystem", async () => {
    const current = await identityFrom(volumeJson({ fileSystemType: "exFAT" }));
    expect(satisfiesRecovery(recorded, current)).toMatchObject({ ok: false });
  });

  it("refuses a network volume standing in for the physical drive", async () => {
    const current = await identityFrom(volumeJson(), "\\\\nas\\media");
    expect(current?.medium).toBe("network");
    expect(satisfiesRecovery(recorded, current).ok).toBe(false);
  });

  it("refuses every unidentifiable answer, one failure mode at a time", async () => {
    const failures = [
      "",
      "not json",
      `[${volumeJson()},${volumeJson()}]`,
      "{}",
    ];
    for (const stdout of failures) {
      const current = await identityFrom(stdout);
      expect(satisfiesRecovery(recorded, current).ok).toBe(false);
    }
  });
});
