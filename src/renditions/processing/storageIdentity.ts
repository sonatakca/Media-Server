/**
 * Which volume this actually is — as opposed to which path it turned up at.
 *
 * Every identity check in this system was a string comparison on a mount path,
 * and a real incident showed what that is worth. A disk image containing a
 * partition named `Expansion` was mounted for tests while the failed physical
 * `Expansion` HDD was unplugged. `mount` reported
 * `/dev/disk4s1 on /Volumes/Expansion (exfat)`, every path-based check agreed
 * this was the dangerous drive, and it was in fact a 2.9 GB synthetic image
 * holding `E2E Title (2026)/video/{144p…720p}.mp4`.
 *
 * The failure runs both ways and both are unacceptable:
 *
 *  - **False positive.** A test image mounted at the quarantined path inherits
 *    the quarantine, so the E2E suite stops for a fault on hardware it has
 *    never touched.
 *  - **False negative, and far worse.** A quarantine recorded against a failing
 *    USB drive is *satisfied* by mounting any volume at the same path. Plug in a
 *    different disk, or attach an image, and the recovery check passes — which
 *    would hand back a green light for storage nobody has repaired.
 *
 * So identity is what the volume *is*: a UUID that survives remounting and
 * rebooting, and a medium that says whether it is physical external media, an
 * internal disk, a network mount, or a file pretending to be a disk. The path
 * is where it happens to be today and is never, on its own, evidence.
 *
 * Nothing here reads media. The probe asks the OS for volume metadata, is
 * injected everywhere it is used, and is never called in a loop.
 */

/**
 * What kind of storage this is.
 *
 * `disk-image` is a first-class answer rather than a footnote, because telling
 * it from `physical-external` is the whole point of this file: they look
 * identical from `/Volumes`, they are equally detachable, and exactly one of
 * them can put the machine into a kernel I/O storm.
 */
export type StorageMedium =
  /** USB, Thunderbolt, FireWire — media that can be unplugged and can fail. */
  | "physical-external"
  /** The boot disk or another fixed internal device. */
  | "physical-internal"
  /** A `.dmg`, a sparse bundle, anything backed by a file. */
  | "disk-image"
  /** SMB, NFS, AFP. Detachable, but its failures are not a local disk's. */
  | "network"
  /** The probe could not say. Treated cautiously by every caller. */
  | "unknown";

export interface VolumeIdentity {
  /**
   * The volume's own UUID. Stable across unmount, remount and reboot, which is
   * exactly what a device node is not.
   */
  volumeUuid: string | null;
  /** `/dev/disk4s1`. Useful for an operator, useless as identity: it is
   * reassigned on every mount. */
  deviceNode: string | null;
  medium: StorageMedium;
  /** `exfat`, `hfs`, `apfs`. Recorded because a reformat is a different volume. */
  fsType: string | null;
  /** The mount path it was found at, for reporting only. */
  mountPath: string | null;
}

/** Asks the OS what is mounted at a path. Injected everywhere. */
export type StorageIdentityProbe = (
  path: string,
) => Promise<VolumeIdentity | null>;

export function unknownIdentity(
  mountPath: string | null = null,
): VolumeIdentity {
  return {
    volumeUuid: null,
    deviceNode: null,
    medium: "unknown",
    fsType: null,
    mountPath,
  };
}

/**
 * Whether losing this volume is an ordinary event that a person should be asked
 * about before a multi-hour encode restarts unattended.
 *
 * This is what replaces the `root.startsWith("/Volumes/")` test. The old test
 * was wrong in both directions at once: it held up work on a synthetic image
 * mounted under `/Volumes` (which is why the E2E suite must be exempt), and it
 * would have waved through a failing external drive mounted anywhere else.
 *
 * A disk image is deliberately *not* included. It is detachable, but its
 * disappearance is somebody stopping a test, not a bridge chip failing, and
 * making the E2E suite wait for an operator would teach everyone to click
 * through the prompt.
 */
export function requiresOperatorAfterUncleanRestart(
  identity: VolumeIdentity | null,
  fallbackPath: string,
): boolean {
  if (identity && identity.medium !== "unknown") {
    return (
      identity.medium === "physical-external" || identity.medium === "network"
    );
  }
  /*
   * No identity available — the probe failed, or this deployment has no
   * implementation. Fall back to the path heuristic, because being cautious
   * about a volume nobody can identify is the safe direction, and it preserves
   * exactly the behaviour that shipped before identity existed.
   */
  return (
    fallbackPath.startsWith("/Volumes/") ||
    fallbackPath.startsWith("/media/") ||
    fallbackPath.startsWith("/mnt/") ||
    fallbackPath.startsWith("/net/")
  );
}

export type RecoveryIdentityVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Whether the volume present now is the one the quarantine was recorded
 * against.
 *
 * The rule is deliberately strict and deliberately fails closed, because the
 * cost of the two errors is wildly asymmetric. Refusing a genuine drive costs
 * an operator a support question. Accepting the wrong one hands back a green
 * light for hardware nobody has repaired, and the last time this system got a
 * storage question wrong the machine had to be power-cycled twice.
 */
export function satisfiesRecovery(
  recorded: VolumeIdentity | null,
  current: VolumeIdentity | null,
): RecoveryIdentityVerdict {
  if (!current) {
    return { ok: false, reason: "No volume is mounted at that path." };
  }

  /*
   * A quarantine recorded before identity was captured — an incident carried
   * across the upgrade that added this file, or one written while the probe was
   * unavailable. There is nothing to compare against, so this cannot be
   * *automatically* satisfied; the operator's explicit resume is what clears it.
   * Silently passing would make the check decorative for exactly the incidents
   * that predate it.
   */
  if (!recorded || recorded.volumeUuid === null) {
    return {
      ok: false,
      reason:
        "The quarantine was recorded without a volume identity, so it cannot be matched automatically.",
    };
  }

  /*
   * The medium is checked before the UUID, because it is the check that catches
   * the mistake that actually happened: a disk image standing in for physical
   * media at the same path. A synthetic volume can be given any name; what it
   * cannot be is a USB disk.
   */
  if (current.medium !== recorded.medium) {
    return {
      ok: false,
      reason: `The volume at that path is ${describeMedium(current.medium)}, but the quarantine was recorded against ${describeMedium(recorded.medium)}.`,
    };
  }

  if (current.volumeUuid === null) {
    return {
      ok: false,
      reason: "The volume at that path did not report an identity.",
    };
  }

  if (current.volumeUuid !== recorded.volumeUuid) {
    return {
      ok: false,
      reason:
        "A different volume is mounted at that path than the one that was quarantined.",
    };
  }

  /*
   * A reformat produces the same path and, on some systems, a recycled UUID
   * while being a different filesystem entirely. Cheap to check and it costs
   * nothing to be sure.
   */
  if (
    recorded.fsType !== null &&
    current.fsType !== null &&
    recorded.fsType !== current.fsType
  ) {
    return {
      ok: false,
      reason: "The volume at that path has been reformatted.",
    };
  }

  return { ok: true };
}

export function describeMedium(medium: StorageMedium): string {
  switch (medium) {
    case "physical-external":
      return "external physical media";
    case "physical-internal":
      return "an internal disk";
    case "disk-image":
      return "a disk image";
    case "network":
      return "a network volume";
    case "unknown":
      return "storage of an unknown kind";
  }
}

/**
 * Reads `diskutil info -plist` for a mount path.
 *
 * Bounded, and metadata only: it asks the volume manager what it already knows
 * and never opens a file on the volume. Kept behind the injectable probe type
 * so no test ever runs it, and so a non-macOS deployment simply has no identity
 * and falls back to the path heuristic above.
 *
 * The parse is deliberately tolerant. A missing key means "unknown", never a
 * throw — an identity probe that can fail loudly during recovery would be one
 * more thing standing between an operator and a repaired drive.
 */
export function parseDiskutilPlist(
  plist: string,
  mountPath: string,
): VolumeIdentity {
  const stringValue = (key: string): string | null => {
    const pattern = new RegExp(
      `<key>${key}</key>\\s*<string>([^<]*)</string>`,
      "i",
    );
    const found = pattern.exec(plist);
    return found?.[1]?.trim() || null;
  };
  const boolValue = (key: string): boolean | null => {
    const pattern = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`, "i");
    const found = pattern.exec(plist);
    return found ? found[1]?.toLowerCase() === "true" : null;
  };

  const protocol = stringValue("BusProtocol") ?? stringValue("Protocol");
  const internal = boolValue("DeviceInternal");
  const virtualOrPhysical = stringValue("VirtualOrPhysical");

  let medium: StorageMedium = "unknown";
  if (
    protocol === "Disk Image" ||
    virtualOrPhysical === "Virtual" ||
    boolValue("DiskImage") === true
  ) {
    medium = "disk-image";
  } else if (protocol && /smb|nfs|afp|network/i.test(protocol)) {
    medium = "network";
  } else if (internal === true) {
    medium = "physical-internal";
  } else if (internal === false) {
    medium = "physical-external";
  }

  return {
    volumeUuid: stringValue("VolumeUUID"),
    deviceNode: stringValue("DeviceNode"),
    medium,
    fsType: stringValue("FilesystemType") ?? stringValue("FilesystemName"),
    mountPath,
  };
}

/**
 * The macOS identity probe.
 *
 * Bounded and metadata-only: `diskutil info` asks the volume manager what it
 * already knows and never opens a file on the volume, which matters because
 * this runs at exactly the moment a disk is least worth exercising. Returns
 * `null` on any failure — a probe that threw during recovery would be one more
 * thing between an operator and a repaired drive, and `null` already fails
 * closed everywhere it is consumed.
 */
export function createDiskutilIdentityProbe(options: {
  run: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string>;
  timeoutMs?: number;
}): StorageIdentityProbe {
  return async (path: string) => {
    try {
      const stdout = await options.run(
        "/usr/sbin/diskutil",
        ["info", "-plist", path],
        options.timeoutMs ?? 10_000,
      );
      const identity = parseDiskutilPlist(stdout, path);
      /*
       * A parse that found nothing at all is not an identity. Returning it
       * would let `medium: "unknown"` masquerade as a reading, when the honest
       * answer is that nothing was learned.
       */
      return identity.volumeUuid === null && identity.medium === "unknown"
        ? null
        : identity;
    } catch {
      return null;
    }
  };
}
