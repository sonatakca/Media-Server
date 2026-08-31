import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface LockOwner {
  pid: number;
  hostname: string;
  createdAt: string;
  purpose: string;
  /**
   * Identity of the attempt holding the lock, not of the process that started
   * it. The two are very different lifetimes: `pid` is the media server, which
   * runs for days, while an attempt lasts minutes.
   */
  leaseId?: string;
  /**
   * Last time the holder proved it was still working. This is what makes a
   * lock reclaimable.
   *
   * Liveness used to mean "the recorded pid still exists", and the recorded pid
   * was the long-lived server. So when an encode died — the external volume
   * being pulled out from under it — the lock stayed valid for as long as the
   * server did, and every retry was refused with "Rendition lock is already
   * held" until someone deleted the directory by hand. A heartbeat ties the
   * lock to the work rather than to the process that happened to start it.
   */
  heartbeatAt?: string;
}

/** How often a live holder refreshes its lease. */
export const LOCK_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How long a lease survives without a heartbeat before it can be reclaimed.
 *
 * Deliberately several intervals: a machine under encode load, or a volume
 * that is slow rather than absent, must not have a genuinely live lock stolen
 * because one write was late.
 */
export const LOCK_LEASE_TIMEOUT_MS = 90_000;

/**
 * Leases this process is actively holding.
 *
 * The decisive fact in the incident: the server survived, the encode did not.
 * A lock recorded by *this* process whose lease is not in here belongs to an
 * attempt that has already ended, so it can be reclaimed at once rather than
 * waiting out the lease. Without this, recovery after a remount was blocked
 * for as long as the timeout — the very wait that had people deleting the
 * directory by hand.
 */
const liveLeases = new Set<string>();

export interface AcquiredLock {
  path: string;
  /** Identifies this holding, so a caller can prove a lock is its own. */
  leaseId: string;
  release: () => Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function staleLock(
  lockPath: string,
  maximumAgeMs: number,
  now: () => number = Date.now,
): Promise<boolean> {
  try {
    const owner = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8"),
    ) as Partial<LockOwner>;
    const createdAt = Date.parse(owner.createdAt ?? "");
    const expired =
      !Number.isFinite(createdAt) || now() - createdAt > maximumAgeMs;

    /*
     * A lease answers the question directly: is the *work* still going? A
     * holder refreshes while it runs, so a lease that has gone quiet for
     * longer than the timeout is finished one way or another — the encode
     * died, the volume vanished, the process was killed — and the lock is
     * reclaimable no matter what the recorded pid is doing.
     */
    /*
     * A lock this very process wrote, for an attempt that is no longer
     * running. Nobody else can be holding it, so there is nothing to wait for.
     */
    if (
      owner.hostname === os.hostname() &&
      owner.pid === process.pid &&
      typeof owner.leaseId === "string" &&
      !liveLeases.has(owner.leaseId)
    ) {
      return true;
    }

    const heartbeatAt = Date.parse(owner.heartbeatAt ?? "");
    if (Number.isFinite(heartbeatAt)) {
      return now() - heartbeatAt > LOCK_LEASE_TIMEOUT_MS || expired;
    }

    /*
     * A lock written before leases existed. The pid check is kept for those,
     * but only as a way to reclaim faster than the age limit — never as proof
     * of liveness on its own, which is what made the old behaviour wrong.
     */
    if (owner.hostname === os.hostname() && typeof owner.pid === "number") {
      return !isProcessAlive(owner.pid) || expired;
    }
    return expired;
  } catch {
    return true;
  }
}

export async function acquireDirectoryLock(
  lockPath: string,
  purpose: string,
  maximumAgeMs = 24 * 60 * 60 * 1_000,
): Promise<AcquiredLock> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      const ownerPath = path.join(lockPath, "owner.json");
      const owner: LockOwner = {
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
        purpose,
        leaseId: randomUUID(),
        heartbeatAt: new Date().toISOString(),
      };
      await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });

      /*
       * The lease is refreshed for as long as this holder is alive. If the
       * process dies, or the volume the lock lives on disappears, the writes
       * simply stop and the lease ages out — which is exactly the signal a
       * would-be acquirer needs. A failed write is therefore not an error to
       * raise: it is the mechanism working.
       */
      const heartbeat = setInterval(() => {
        void writeFile(
          ownerPath,
          `${JSON.stringify({ ...owner, heartbeatAt: new Date().toISOString() }, null, 2)}\n`,
          "utf8",
        ).catch(() => undefined);
      }, LOCK_HEARTBEAT_INTERVAL_MS);
      // Never hold the event loop open on account of a heartbeat.
      heartbeat.unref?.();

      liveLeases.add(owner.leaseId!);
      let released = false;
      return {
        path: lockPath,
        leaseId: owner.leaseId!,
        release: async () => {
          if (released) return;
          released = true;
          liveLeases.delete(owner.leaseId!);
          clearInterval(heartbeat);
          /*
           * The lock may live on storage that has gone away, in which case
           * removal fails and there is nothing to be done about it here. The
           * lease is already out of the live set, so the next acquisition
           * reclaims it — recovery does not depend on this succeeding.
           */
          await rm(lockPath, { recursive: true, force: true }).catch(
            () => undefined,
          );
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && (await staleLock(lockPath, maximumAgeMs))) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      throw new Error(`Rendition lock is already held: ${lockPath}`);
    }
  }
  throw new Error(`Could not acquire rendition lock: ${lockPath}`);
}
