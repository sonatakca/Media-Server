import { describe, expect, it } from "vitest";
import {
  describeMedium,
  parseDiskutilPlist,
  requiresOperatorAfterUncleanRestart,
  satisfiesRecovery,
  unknownIdentity,
  type VolumeIdentity,
} from "./storageIdentity";

/**
 * Telling the failed drive from a file pretending to be one.
 *
 * The incident behind this file: a disk image with a partition named
 * `Expansion` was mounted for tests while the failed physical `Expansion` HDD
 * was unplugged. `mount` reported `/dev/disk4s1 on /Volumes/Expansion (exfat)`,
 * and every path-based check in the system agreed that the dangerous drive was
 * back. It was a 2.9 GB image holding synthetic `E2E Title (2026)` media.
 *
 * Nothing here touches a volume: identities are plain objects, and the one
 * `diskutil` test parses a captured plist string.
 */

/** The failed drive, as it would have been recorded when quarantined. */
const EXPANSION: VolumeIdentity = {
  volumeUuid: "11111111-2222-3333-4444-555555555555",
  deviceNode: "/dev/disk6s1",
  medium: "physical-external",
  fsType: "exfat",
  mountPath: "/Volumes/Expansion",
};

/** The E2E image, which has turned up at the same path. */
const E2E_IMAGE: VolumeIdentity = {
  volumeUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  deviceNode: "/dev/disk4s2",
  medium: "disk-image",
  fsType: "hfs",
  mountPath: "/Volumes/SeyirlikE2EMedia",
};

/** Some other USB drive an operator plugged in. */
const OTHER_EXTERNAL: VolumeIdentity = {
  volumeUuid: "99999999-8888-7777-6666-555555555555",
  deviceNode: "/dev/disk6s1",
  medium: "physical-external",
  fsType: "exfat",
  mountPath: "/Volumes/Expansion",
};

describe("what can satisfy recovery for a quarantined drive", () => {
  it("accepts the same physical volume coming back", () => {
    expect(satisfiesRecovery(EXPANSION, { ...EXPANSION })).toEqual({
      ok: true,
    });
  });

  /**
   * Requirement 2. This is the false negative that matters: if mounting an
   * image at the quarantined path satisfied recovery, anyone could hand back a
   * green light for hardware nobody has repaired.
   */
  it("refuses a disk image mounted where the drive used to be", () => {
    const verdict = satisfiesRecovery(EXPANSION, {
      ...E2E_IMAGE,
      mountPath: "/Volumes/Expansion",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("a disk image");
  });

  /** Requirement 3. A different drive at the same path is not the same drive. */
  it("refuses a different external volume at the same path", () => {
    const verdict = satisfiesRecovery(EXPANSION, OTHER_EXTERNAL);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(
      "A different volume",
    );
  });

  /**
   * Requirement 4, stated directly: the decision must not be derivable from the
   * path. Both of these sit at `/Volumes/Expansion`; one is the drive and one
   * is not.
   */
  it("does not decide from the mount path", () => {
    const atSamePath = { ...E2E_IMAGE, mountPath: "/Volumes/Expansion" };
    expect(atSamePath.mountPath).toBe(EXPANSION.mountPath);
    expect(satisfiesRecovery(EXPANSION, atSamePath).ok).toBe(false);

    // And the genuine drive is still recognised when it comes back elsewhere.
    const movedPath = { ...EXPANSION, mountPath: "/Volumes/Expansion 1" };
    expect(satisfiesRecovery(EXPANSION, movedPath)).toEqual({ ok: true });
  });

  it("refuses when nothing is mounted there at all", () => {
    expect(satisfiesRecovery(EXPANSION, null).ok).toBe(false);
  });

  it("refuses a volume that reports no identity", () => {
    expect(
      satisfiesRecovery(EXPANSION, unknownIdentity("/Volumes/Expansion")).ok,
    ).toBe(false);
  });

  /**
   * An incident carried across the upgrade that added identity has nothing to
   * compare. It must not pass silently, or the check is decorative for exactly
   * the incidents that predate it — which includes the one that motivated it.
   */
  it("refuses to auto-satisfy a quarantine recorded without an identity", () => {
    const verdict = satisfiesRecovery(
      { ...EXPANSION, volumeUuid: null },
      EXPANSION,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(
      "without a volume identity",
    );
  });

  /** A reformat is a different filesystem wearing a recycled identity. */
  it("refuses a volume that has been reformatted", () => {
    const verdict = satisfiesRecovery(EXPANSION, {
      ...EXPANSION,
      fsType: "apfs",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("reformatted");
  });
});

describe("which volumes need an operator after an unclean restart", () => {
  /**
   * Requirement 5. Holding the E2E suite for an operator because its image sits
   * under `/Volumes` would make the whole mechanism something people learn to
   * click through.
   */
  it("does not hold work on a disk image", () => {
    expect(
      requiresOperatorAfterUncleanRestart(
        E2E_IMAGE,
        "/Volumes/SeyirlikE2EMedia",
      ),
    ).toBe(false);
  });

  it("holds work on external physical media", () => {
    expect(
      requiresOperatorAfterUncleanRestart(EXPANSION, "/Volumes/Expansion"),
    ).toBe(true);
  });

  it("holds work on a network volume", () => {
    expect(
      requiresOperatorAfterUncleanRestart(
        { ...EXPANSION, medium: "network" },
        "/mnt/library",
      ),
    ).toBe(true);
  });

  it("does not hold work on an internal disk", () => {
    expect(
      requiresOperatorAfterUncleanRestart(
        { ...EXPANSION, medium: "physical-internal" },
        "/srv/media",
      ),
    ).toBe(false);
  });

  /**
   * With no identity available the path heuristic stands, which is both the
   * cautious direction and exactly the behaviour that shipped before identity
   * existed.
   */
  it("falls back to the path when identity is unavailable", () => {
    expect(
      requiresOperatorAfterUncleanRestart(null, "/Volumes/Expansion/media"),
    ).toBe(true);
    expect(requiresOperatorAfterUncleanRestart(null, "/srv/media")).toBe(false);
    expect(
      requiresOperatorAfterUncleanRestart(
        unknownIdentity("/Volumes/Expansion"),
        "/Volumes/Expansion/media",
      ),
    ).toBe(true);
  });
});

describe("reading a volume's identity from diskutil", () => {
  /** The shape macOS actually returns for an attached USB disk. */
  it("recognises external physical media", () => {
    const identity = parseDiskutilPlist(
      `<plist><dict>
         <key>VolumeUUID</key><string>11111111-2222-3333-4444-555555555555</string>
         <key>DeviceNode</key><string>/dev/disk6s1</string>
         <key>BusProtocol</key><string>USB</string>
         <key>DeviceInternal</key><false/>
         <key>FilesystemType</key><string>exfat</string>
       </dict></plist>`,
      "/Volumes/Expansion",
    );
    expect(identity.medium).toBe("physical-external");
    expect(identity.volumeUuid).toBe("11111111-2222-3333-4444-555555555555");
    expect(identity.fsType).toBe("exfat");
  });

  /** And for the image that caused the confusion. */
  it("recognises a disk image, however it is named or mounted", () => {
    const identity = parseDiskutilPlist(
      `<plist><dict>
         <key>VolumeUUID</key><string>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</string>
         <key>DeviceNode</key><string>/dev/disk4s2</string>
         <key>BusProtocol</key><string>Disk Image</string>
         <key>DeviceInternal</key><false/>
         <key>VirtualOrPhysical</key><string>Virtual</string>
         <key>FilesystemType</key><string>hfs</string>
       </dict></plist>`,
      "/Volumes/Expansion",
    );
    /*
     * Mounted at the dangerous path, reporting `DeviceInternal false` exactly
     * as a USB disk does. Only the protocol tells them apart, which is why the
     * path was never going to be enough.
     */
    expect(identity.medium).toBe("disk-image");
  });

  it("recognises an internal disk", () => {
    const identity = parseDiskutilPlist(
      `<plist><dict>
         <key>BusProtocol</key><string>PCI-Express</string>
         <key>DeviceInternal</key><true/>
       </dict></plist>`,
      "/",
    );
    expect(identity.medium).toBe("physical-internal");
  });

  /** A probe that cannot say must say so, not guess. */
  it("reports unknown rather than inventing a medium", () => {
    const identity = parseDiskutilPlist("<plist><dict></dict></plist>", "/x");
    expect(identity.medium).toBe("unknown");
    expect(identity.volumeUuid).toBeNull();
  });

  it("does not throw on malformed output", () => {
    expect(() => parseDiskutilPlist("not a plist at all", "/x")).not.toThrow();
  });
});

describe("how a medium is described to an operator", () => {
  it("uses words that distinguish the two that were confused", () => {
    expect(describeMedium("physical-external")).toBe("external physical media");
    expect(describeMedium("disk-image")).toBe("a disk image");
  });
});

/**
 * The durability audit, stated as the ten cases that decide whether a
 * quarantine can be satisfied.
 *
 * The rule under test: a volume UUID is the only authoritative identity. A
 * device node is a diagnostic; a medium and a filesystem are attributes; a
 * mount path is a location. None of the last three, alone or together,
 * identifies a disk.
 */
describe("what is and is not a durable storage identity", () => {
  /** 1. Disk numbers are assigned in attachment order, so they move. */
  it("treats the same UUID at a different /dev/diskN as the same volume", () => {
    const reconnected = { ...EXPANSION, deviceNode: "/dev/disk9s1" };
    expect(satisfiesRecovery(EXPANSION, reconnected)).toEqual({ ok: true });
  });

  /** 2. macOS mounts a second volume of the same name at "Expansion 1". */
  it("treats the same UUID at a different mount path as the same volume", () => {
    const moved = { ...EXPANSION, mountPath: "/Volumes/Expansion 1" };
    expect(satisfiesRecovery(EXPANSION, moved)).toEqual({ ok: true });
  });

  /** 3. The converse: the old number handed to a different disk. */
  it("treats a different UUID at the same /dev/diskN as a different volume", () => {
    const impostor = {
      ...EXPANSION,
      volumeUuid: "00000000-0000-0000-0000-000000000000",
    };
    expect(satisfiesRecovery(EXPANSION, impostor).ok).toBe(false);
  });

  /** 4. And the same at the quarantined path. */
  it("treats a different UUID at /Volumes/Expansion as a different volume", () => {
    expect(
      satisfiesRecovery(EXPANSION, {
        ...OTHER_EXTERNAL,
        mountPath: "/Volumes/Expansion",
      }).ok,
    ).toBe(false);
  });

  /**
   * 5. The case that most tempts a shortcut: everything matches except the one
   * field that identifies anything. "external + exfat at /Volumes/Expansion"
   * describes a great many disks.
   */
  it("refuses a volume matching on medium, filesystem and path but not UUID", () => {
    const lookalike: VolumeIdentity = {
      volumeUuid: "deadbeef-0000-0000-0000-000000000000",
      deviceNode: EXPANSION.deviceNode,
      medium: EXPANSION.medium,
      fsType: EXPANSION.fsType,
      mountPath: EXPANSION.mountPath,
    };
    expect(lookalike.medium).toBe(EXPANSION.medium);
    expect(lookalike.fsType).toBe(EXPANSION.fsType);
    expect(lookalike.mountPath).toBe(EXPANSION.mountPath);
    expect(satisfiesRecovery(EXPANSION, lookalike).ok).toBe(false);
  });

  /** 6. The image that started all of this. */
  it("never accepts a disk image as the physical Expansion storage", () => {
    const namedExpansion: VolumeIdentity = {
      ...E2E_IMAGE,
      mountPath: "/Volumes/Expansion",
    };
    const verdict = satisfiesRecovery(EXPANSION, namedExpansion);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("a disk image");
  });

  /** 7. No identity, after a hard quarantine, is a refusal — never a pass. */
  it("fails closed when the current volume reports no UUID", () => {
    expect(
      satisfiesRecovery(EXPANSION, { ...EXPANSION, volumeUuid: null }).ok,
    ).toBe(false);
    expect(satisfiesRecovery(EXPANSION, unknownIdentity()).ok).toBe(false);
    expect(satisfiesRecovery(EXPANSION, null).ok).toBe(false);
  });

  /**
   * 8. A reboot renumbers everything. The drive that was `/dev/disk6s1` may come
   * back as `/dev/disk4s1`, and an unrelated disk may take `/dev/disk6s1` — so
   * matching on the node would both reject the real drive and accept a stranger.
   */
  it("cannot be satisfied by device-node reuse across a reboot", () => {
    const strangerOnOldNode: VolumeIdentity = {
      volumeUuid: "77777777-7777-7777-7777-777777777777",
      deviceNode: "/dev/disk6s1",
      medium: "physical-external",
      fsType: "exfat",
      mountPath: "/Volumes/Expansion",
    };
    expect(strangerOnOldNode.deviceNode).toBe(EXPANSION.deviceNode);
    expect(satisfiesRecovery(EXPANSION, strangerOnOldNode).ok).toBe(false);

    // And the genuine drive on a new node is still accepted.
    expect(
      satisfiesRecovery(EXPANSION, { ...EXPANSION, deviceNode: "/dev/disk4s1" })
        .ok,
    ).toBe(true);
  });

  /** 9. The E2E image cannot release the drive, wherever it is mounted. */
  it("never lets SeyirlikE2EMedia release Expansion", () => {
    for (const mountPath of [
      "/Volumes/SeyirlikE2EMedia",
      "/Volumes/Expansion",
      "/Volumes/Expansion 1",
    ]) {
      expect(satisfiesRecovery(EXPANSION, { ...E2E_IMAGE, mountPath }).ok).toBe(
        false,
      );
    }
  });

  /**
   * 10. The node is still worth having — it is what an operator types into
   * `diskutil` — but it is carried, never compared.
   */
  it("keeps the device node for diagnostics without giving it authority", () => {
    const parsed = parseDiskutilPlist(
      `<plist><dict>
         <key>VolumeUUID</key><string>11111111-2222-3333-4444-555555555555</string>
         <key>DeviceNode</key><string>/dev/disk6s1</string>
         <key>BusProtocol</key><string>USB</string>
         <key>DeviceInternal</key><false/>
       </dict></plist>`,
      "/Volumes/Expansion",
    );
    expect(parsed.deviceNode).toBe("/dev/disk6s1");

    /*
     * Authority test: hold the node constant and vary only the UUID, then hold
     * the UUID constant and vary only the node. If the node had any authority
     * the two would not disagree.
     */
    const sameNodeDifferentUuid = {
      ...EXPANSION,
      volumeUuid: "55555555-5555-5555-5555-555555555555",
    };
    const differentNodeSameUuid = { ...EXPANSION, deviceNode: "/dev/disk11s3" };
    expect(satisfiesRecovery(EXPANSION, sameNodeDifferentUuid).ok).toBe(false);
    expect(satisfiesRecovery(EXPANSION, differentNodeSameUuid).ok).toBe(true);
  });
});
