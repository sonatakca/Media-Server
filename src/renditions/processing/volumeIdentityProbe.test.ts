import { describe, expect, it } from "vitest";
import { createVolumeIdentityProbe } from "./volumeIdentityProbe";

/**
 * Which platform gets identity, asserted directly.
 *
 * Before this existed the decision was one branch of one ternary inside the
 * runtime's 900-line construction function, so the fact that Windows received
 * no probe at all could not be asserted on without standing up a server. It is
 * a factory now for exactly that reason.
 */

const DISKUTIL_PLIST = `<plist><dict>
   <key>BusProtocol</key><string>USB</string>
   <key>DeviceNode</key><string>/dev/disk6s1</string>
   <key>FilesystemType</key><string>exfat</string>
   <key>Internal</key><false/>
   <key>MountPoint</key><string>/Volumes/Expansion</string>
   <key>VolumeUUID</key><string>11111111-2222-3333-4444-555555555555</string>
 </dict></plist>`;

const WINDOWS_JSON = JSON.stringify({
  uniqueId: "\\\\?\\Volume{9f3a1c6e-1111-4a2b-9c3d-000000000001}\\",
  fileSystemType: "NTFS",
  driveType: "Fixed",
  driveLetter: "D",
  busType: "USB",
  diskNumber: 1,
  partitionNumber: 2,
});

/** Answers whichever tool it is handed, so one runner serves both platforms. */
function bothPlatforms() {
  const commands: string[] = [];
  const run = async (command: string, args: readonly string[]) => {
    commands.push(command);
    if (command === "/bin/df") {
      return `Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk6s1 1 1 1 1% /Volumes/Expansion\n`;
    }
    if (command === "/usr/sbin/diskutil") return DISKUTIL_PLIST;
    if (command === "powershell.exe") return WINDOWS_JSON;
    throw new Error(`unexpected command: ${args.length}`);
  };
  return { run, commands };
}

describe("choosing an identity probe for the host", () => {
  it("gives macOS the diskutil probe", async () => {
    const { run, commands } = bothPlatforms();
    const probe = createVolumeIdentityProbe({ platform: "darwin", run });

    expect(probe).toBeDefined();
    const identity = await probe?.("/Volumes/Expansion/media");

    expect(identity?.volumeUuid).toBe("11111111-2222-3333-4444-555555555555");
    expect(commands).toContain("/usr/sbin/diskutil");
    expect(commands).not.toContain("powershell.exe");
  });

  /**
   * The regression. Before the Windows implementation this returned
   * `undefined`, so a Windows deployment had no identity at all and every
   * identity-dependent decision fell through to a POSIX-only path heuristic.
   */
  it("gives Windows the volume probe instead of nothing", async () => {
    const { run, commands } = bothPlatforms();
    const probe = createVolumeIdentityProbe({ platform: "win32", run });

    expect(probe).toBeDefined();
    const identity = await probe?.("D:\\media");

    expect(identity?.volumeUuid).toBe("9f3a1c6e-1111-4a2b-9c3d-000000000001");
    expect(identity?.medium).toBe("physical-external");
    expect(commands).toContain("powershell.exe");
    expect(commands).not.toContain("/usr/sbin/diskutil");
  });

  it("still gives other platforms no probe, which fails closed", async () => {
    const { run } = bothPlatforms();
    for (const platform of ["linux", "freebsd", "aix"] as NodeJS.Platform[]) {
      expect(createVolumeIdentityProbe({ platform, run })).toBeUndefined();
    }
  });

  it("passes a caller's timeout through to the platform probe", async () => {
    const seen: number[] = [];
    const run = async (
      command: string,
      _args: readonly string[],
      timeoutMs: number,
    ) => {
      seen.push(timeoutMs);
      return command === "powershell.exe" ? WINDOWS_JSON : DISKUTIL_PLIST;
    };
    await createVolumeIdentityProbe({
      platform: "win32",
      run,
      timeoutMs: 1234,
    })?.("D:\\media");
    expect(seen).toEqual([1234]);
  });

  it("reports a Windows failure reason without the command's output", async () => {
    const reasons: string[] = [];
    const run = async () => "this is not json";
    const probe = createVolumeIdentityProbe({
      platform: "win32",
      run,
      onWindowsFailure: (failure, detail) =>
        reasons.push(`${failure}:${detail}`),
    });

    await expect(probe?.("D:\\media")).resolves.toBeNull();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("malformed-output");
    expect(reasons[0]).not.toContain("this is not json");
  });
});
