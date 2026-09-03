/**
 * Real, separately mounted filesystems for the storage tests.
 *
 * The failures these support — a volume disappearing mid-encode, a volume
 * filling up mid-write — cannot be produced honestly on the filesystem the
 * test process is running on. A `chmod` produces `EACCES` where an unmount
 * produces a path that has stopped existing, and no amount of mocking makes
 * `write(2)` return `ENOSPC` on a disk with room on it. Both are the errno the
 * production classifier keys on, so a test that fabricates them proves only
 * that the fabrication was read correctly.
 *
 * `hdiutil` gives a genuine mount: its own device, its own free-space
 * accounting, its own `statfs`, and it can be pulled out from under an open
 * file. Nothing here needs elevated privileges.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The device currently mounted at a path, or null when nothing is. */
async function deviceMountedAt(target: string): Promise<string | null> {
  const { stdout } = await run("/sbin/mount", []).catch(() => ({ stdout: "" }));
  const resolved = target.startsWith("/private") ? target : `/private${target}`;
  for (const line of stdout.split("\n")) {
    const match = /^(\S+) on (.+?) \(/.exec(line);
    if (!match) continue;
    if (match[2] === target || match[2] === resolved) return match[1]!;
  }
  return null;
}

/**
 * Detaches whatever is mounted at a path, with retries.
 *
 * A volume an encoder has just stopped using stays busy for a moment
 * afterwards and `hdiutil` refuses rather than waiting.
 */
async function detachPath(where: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!(await deviceMountedAt(where))) return true;
    await run("/usr/bin/hdiutil", ["detach", where, "-force"], {
      timeout: 60_000,
    }).catch(() => undefined);
    if (!(await deviceMountedAt(where))) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return !(await deviceMountedAt(where));
}

export interface MountedImage {
  /** Where the volume is mounted. Paths under here live on its filesystem. */
  mountPoint: string;
  /** The backing image file, so a detached volume can be brought back. */
  imagePath: string;
  /** Total capacity, as asked for. */
  sizeMb: number;
  attached: boolean;
  /** Pulls the volume out. `force` models a disconnection rather than an eject. */
  detach(options?: { force?: boolean }): Promise<void>;
  /**
   * The same, but blocking until the volume is really gone.
   *
   * Needed from synchronous progress callbacks. An awaited detach started from
   * a callback the caller does not await is a race the encoder usually wins —
   * the job finished before the volume went, which tested nothing.
   */
  detachSync(options?: { force?: boolean }): void;
  /** Brings the same volume back at the same mount point. */
  attach(): Promise<void>;
  /**
   * Mounts this volume at somebody else's mount point.
   *
   * The only way to produce the case identity exists for: two different
   * volumes appearing, at different times, at one configured path.
   */
  attachAt(mountPoint: string): Promise<void>;
  /** Detaches if needed and deletes the backing file. */
  dispose(): Promise<void>;
}

/** Whether this host can mount disk images at all. */
export async function diskImagesAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await run("/usr/bin/hdiutil", ["help"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates and mounts a filesystem of an exact size.
 *
 * Mounted at a caller-chosen point rather than under `/Volumes`, so a test
 * cannot collide with a real volume of the same name and a leaked mount is
 * obviously a test's.
 */
export async function createMountedImage({
  directory,
  name,
  sizeMb,
}: {
  directory: string;
  name: string;
  sizeMb: number;
}): Promise<MountedImage> {
  const imagePath = path.join(directory, `${name}.dmg`);
  const mountPoint = path.join(directory, `mnt-${name}`);
  await mkdir(mountPoint, { recursive: true });
  await rm(imagePath, { force: true });

  await run(
    "/usr/bin/hdiutil",
    [
      "create",
      "-size",
      `${sizeMb}m`,
      "-fs",
      "HFS+",
      "-volname",
      name,
      "-type",
      "UDIF",
      "-quiet",
      imagePath.replace(/\.dmg$/, ""),
    ],
    { timeout: 120_000 },
  );

  /** Where it is mounted right now, which is not always its own mount point. */
  let mountedAt = mountPoint;

  const image: MountedImage = {
    mountPoint,
    imagePath,
    sizeMb,
    attached: false,
    async attach() {
      if (image.attached) return;
      await run(
        "/usr/bin/hdiutil",
        ["attach", imagePath, "-nobrowse", "-mountpoint", mountPoint],
        { timeout: 120_000 },
      );
      image.attached = true;
      mountedAt = mountPoint;
    },
    async attachAt(where: string) {
      if (image.attached) await image.detach();
      await mkdir(where, { recursive: true });
      await run(
        "/usr/bin/hdiutil",
        ["attach", imagePath, "-nobrowse", "-mountpoint", where],
        { timeout: 120_000 },
      );
      image.attached = true;
      mountedAt = where;
    },
    async detach({ force = true } = {}) {
      if (!image.attached) return;
      /*
       * Retried, because a volume an encoder has just stopped using stays busy
       * for a moment afterwards and `hdiutil` refuses rather than waiting.
       * A single attempt leaked mounted images across a test run, which then
       * accumulated on the host and consumed real disk.
       */
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await run(
            "/usr/bin/hdiutil",
            ["detach", mountedAt, ...(force ? ["-force"] : [])],
            { timeout: 120_000 },
          );
          image.attached = false;
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      // Already gone is success, not failure.
      if (!(await stat(mountedAt).catch(() => null))) {
        image.attached = false;
        return;
      }
      throw lastError;
    },
    detachSync({ force = true } = {}) {
      if (!image.attached) return;
      execFileSync(
        "/usr/bin/hdiutil",
        ["detach", mountedAt, ...(force ? ["-force"] : [])],
        { timeout: 120_000, stdio: "ignore" },
      );
      image.attached = false;
    },
    async dispose() {
      /*
       * Detach first, and prove it, before anything is deleted.
       *
       * Removing the mount point while a volume is still mounted on it orphans
       * that volume: the path it was attached at no longer exists, so it can
       * no longer be detached by path at all, and it survives the test process
       * to accumulate on the host. Both places it might be attached are tried,
       * because `attachAt` can leave it at another image's mount point.
       */
      for (const where of new Set([mountedAt, mountPoint])) {
        await detachPath(where);
      }
      image.attached = false;

      /*
       * Last resort: something is still mounted there, so it is detached by
       * device instead. `hdiutil` refuses a busy volume, and a volume that was
       * being written to a moment ago is often briefly busy.
       */
      for (const where of new Set([mountedAt, mountPoint])) {
        const device = await deviceMountedAt(where);
        if (!device) continue;
        await run("/usr/bin/hdiutil", ["detach", device, "-force"], {
          timeout: 60_000,
        }).catch(() => undefined);
      }

      const stillMounted =
        (await deviceMountedAt(mountedAt)) ??
        (await deviceMountedAt(mountPoint));
      if (stillMounted) {
        // Reported rather than thrown: a leaked image is not worth failing a
        // suite over, but it must not be silent either.
        console.warn(
          `[test] ${stillMounted} is still mounted at ${mountedAt}; leaving the mount point in place so it can be detached.`,
        );
        await rm(imagePath, { force: true }).catch(() => undefined);
        return;
      }

      await rm(imagePath, { force: true }).catch(() => undefined);
      await rm(mountPoint, { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
  };

  await image.attach();
  return image;
}

/** Free bytes on the filesystem holding `target`. */
export async function freeBytes(target: string): Promise<number> {
  const { statfs } = await import("node:fs/promises");
  const info = await statfs(target);
  return info.bavail * info.bsize;
}

/**
 * Consumes all but `leaveBytes` of a volume's free space, blocking.
 *
 * The synchronous form exists for progress callbacks: a fill the caller does
 * not await is a race the writer usually wins, and the operation then
 * completes on a disk that was never actually full.
 */
export function fillVolumeSync(
  target: string,
  {
    leaveBytes = 0,
    availableBytes,
  }: { leaveBytes?: number; availableBytes: number },
): string {
  const balloon = path.join(target, `.seyirlik-test-balloon-${process.pid}`);
  const size = Math.max(0, availableBytes - leaveBytes);
  try {
    execFileSync(
      "/bin/dd",
      [
        "if=/dev/zero",
        `of=${balloon}`,
        "bs=1m",
        `count=${Math.ceil(size / (1024 * 1024))}`,
      ],
      { stdio: "ignore" },
    );
  } catch {
    // `dd` exits non-zero when it hits ENOSPC, which is the intended end state.
  }
  return balloon;
}

/**
 * Consumes all but `leaveBytes` of a volume's free space.
 *
 * Used to fill a filesystem at a chosen moment rather than by choosing a size
 * in advance, which is what makes a *write-time* `ENOSPC` reachable: a
 * publication that passed its free-space preflight and then ran out is a
 * different code path from one that was refused before it started, and only
 * this can reach the first.
 */
export async function fillVolume(
  target: string,
  { leaveBytes = 0 }: { leaveBytes?: number } = {},
): Promise<string> {
  const balloon = path.join(target, `.seyirlik-test-balloon-${process.pid}`);
  const available = await freeBytes(target);
  const size = Math.max(0, available - leaveBytes);
  await run("/bin/dd", [
    "if=/dev/zero",
    `of=${balloon}`,
    "bs=1m",
    `count=${Math.ceil(size / (1024 * 1024))}`,
  ]).catch(() => undefined);
  return balloon;
}

/** Whether a path is on the filesystem mounted at `mountPoint`. */
export async function onSameDevice(
  target: string,
  mountPoint: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([stat(target), stat(mountPoint)]);
  return left.dev === right.dev;
}
