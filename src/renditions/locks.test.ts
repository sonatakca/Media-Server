import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  LOCK_LEASE_TIMEOUT_MS,
  acquireDirectoryLock,
  staleLock,
} from "./locks";

/**
 * Whether a rendition lock is still held by living work.
 *
 * The incident these guard: an external volume was pulled out mid-encode. The
 * encoder died, the media server did not, and the lock's `owner.json` recorded
 * the *server's* pid — which was still very much alive. Every retry was
 * refused with "Rendition lock is already held" until the directory was
 * deleted by hand and the backend restarted.
 */

async function lockDir(owner: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-lock-"));
  const lockPath = path.join(root, "media.adaptive.lock");
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify(owner, null, 2),
    "utf8",
  );
  return lockPath;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("rendition directory locks", () => {
  it("rejects a concurrent owner and permits acquisition after release", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rendition-lock-"));
    const lockPath = path.join(root, "media.lock");
    const first = await acquireDirectoryLock(lockPath, "first");
    await expect(acquireDirectoryLock(lockPath, "second")).rejects.toThrow(
      "already held",
    );
    await first.release();
    const second = await acquireDirectoryLock(lockPath, "second");
    await second.release();
    await rm(root, { recursive: true, force: true });
  });

  it("recovers a stale lock owned by a dead local process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rendition-lock-stale-"));
    const lockPath = path.join(root, "media.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 999_999_999,
        hostname: process.env.HOSTNAME ?? "",
        createdAt: new Date(0).toISOString(),
        purpose: "stale",
      }),
    );
    const lock = await acquireDirectoryLock(lockPath, "replacement", 1);
    await lock.release();
    await rm(root, { recursive: true, force: true });
  });
});

/**
 * A process that is certainly alive and certainly not this one. `launchd` is
 * always running, and signalling it as an ordinary user fails with `EPERM`,
 * which is how liveness is established without permission to interfere.
 */
const LIVE_FOREIGN_PID = 1;

/**
 * A pid that named a real process and no longer does — a worker killed
 * mid-encode, in miniature. Taken from a child that has already exited and
 * been reaped, rather than a guessed number that some other process may own.
 */
const DEAD_PID = spawnSync("/usr/bin/true").pid as number;

describe("deciding whether a rendition lock is still alive", () => {
  /**
   * The exact record from the live incident: a lock owned by the long-running
   * media server, whose encode had already died.
   */
  it("reclaims a lock whose lease went quiet, even though the server pid lives", async () => {
    const now = Date.now();
    const lockPath = await lockDir({
      // The media server's own pid — alive, and irrelevant.
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date(now - 20 * 60_000).toISOString(),
      purpose: "adaptive:7ada79bd",
      leaseId: "attempt-1",
      heartbeatAt: new Date(now - 10 * 60_000).toISOString(),
    });

    expect(await staleLock(lockPath, DAY_MS, () => now)).toBe(true);
  });

  /**
   * A lock being refreshed right now is genuinely held and must be left alone.
   *
   * Held by a different process — a live one, `launchd`, which stands in for
   * the other Seyirlik process here. A pid that does not exist would prove
   * nothing about heartbeats, because a holder this host can see is gone is
   * reclaimed on that evidence alone.
   */
  it("refuses to steal a lock whose holder is still heartbeating", async () => {
    const now = Date.now();
    const lockPath = await lockDir({
      pid: LIVE_FOREIGN_PID,
      hostname: os.hostname(),
      createdAt: new Date(now - 20 * 60_000).toISOString(),
      purpose: "adaptive:7ada79bd",
      leaseId: "attempt-1",
      heartbeatAt: new Date(now - 2_000).toISOString(),
    });

    expect(await staleLock(lockPath, DAY_MS, () => now)).toBe(false);
  });

  /**
   * One late write must not cost a live encode its lock, so the timeout is
   * several heartbeat intervals rather than one.
   */
  it("tolerates a heartbeat that is merely late", async () => {
    const now = Date.now();
    const lockPath = await lockDir({
      pid: LIVE_FOREIGN_PID,
      hostname: os.hostname(),
      createdAt: new Date(now - 20 * 60_000).toISOString(),
      purpose: "adaptive:7ada79bd",
      leaseId: "attempt-1",
      // Well past one interval, comfortably inside the lease.
      heartbeatAt: new Date(now - LOCK_LEASE_TIMEOUT_MS / 2).toISOString(),
    });

    expect(await staleLock(lockPath, DAY_MS, () => now)).toBe(false);
  });

  /**
   * The restart case.
   *
   * Restarting the worker mid-encode kills the holder without giving it a
   * chance to release, leaving a lock whose heartbeat is seconds old. The
   * replacement requeues the job immediately, and if that lock were honoured
   * the job would be refused by the remains of its own previous attempt — which
   * is exactly what happened, and the queue recorded it as a permanent failure.
   */
  it("reclaims a lock whose holder no longer exists, however fresh the heartbeat", async () => {
    const now = Date.now();
    const lockPath = await lockDir({
      // A pid that has been reaped; the process it named is gone.
      pid: DEAD_PID,
      hostname: os.hostname(),
      createdAt: new Date(now - 30_000).toISOString(),
      purpose: "adaptive:7ada79bd",
      leaseId: "attempt-1",
      heartbeatAt: new Date(now - 1_000).toISOString(),
    });

    expect(await staleLock(lockPath, DAY_MS, () => now)).toBe(true);
  });

  it("leaves a lock held on another host alone, whoever owns the pid here", async () => {
    // Nothing can be concluded about a pid on a machine this one cannot see,
    // so the heartbeat is the only evidence and it says the work is live.
    const now = Date.now();
    const lockPath = await lockDir({
      pid: DEAD_PID,
      hostname: `${os.hostname()}-other`,
      createdAt: new Date(now - 30_000).toISOString(),
      purpose: "adaptive:7ada79bd",
      leaseId: "attempt-1",
      heartbeatAt: new Date(now - 1_000).toISOString(),
    });

    expect(await staleLock(lockPath, DAY_MS, () => now)).toBe(false);
  });

  /** A lock written before leases existed still has to be judged somehow. */
  it("falls back to the process check for a lock with no lease", async () => {
    const now = Date.now();
    const alive = await lockDir({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date(now - 60_000).toISOString(),
      purpose: "adaptive:legacy",
    });
    const dead = await lockDir({
      // A pid that cannot be running.
      pid: 2 ** 30,
      hostname: os.hostname(),
      createdAt: new Date(now - 60_000).toISOString(),
      purpose: "adaptive:legacy",
    });

    expect(await staleLock(alive, DAY_MS, () => now)).toBe(false);
    expect(await staleLock(dead, DAY_MS, () => now)).toBe(true);
  });

  it("treats an unreadable or absent owner record as reclaimable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-lock-"));
    const empty = path.join(root, "empty.adaptive.lock");
    await mkdir(empty, { recursive: true });

    expect(await staleLock(empty, DAY_MS)).toBe(true);
  });

  /** The end-to-end shape: a real acquisition writes a lease and releases it. */
  it("records a lease when acquiring and clears the lock on release", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-lock-"));
    const lockPath = path.join(root, "acquire.adaptive.lock");

    const lock = await acquireDirectoryLock(lockPath, "adaptive:test");
    const owner = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8"),
    );

    expect(owner.leaseId).toEqual(expect.any(String));
    expect(owner.heartbeatAt).toEqual(expect.any(String));
    expect(lock.leaseId).toBe(owner.leaseId);
    // Held right now, so nobody may take it.
    expect(await staleLock(lockPath, DAY_MS)).toBe(false);

    await lock.release();
    // And a fresh acquisition succeeds once it is gone.
    await expect(
      acquireDirectoryLock(lockPath, "adaptive:test"),
    ).resolves.toBeDefined();
  });

  /**
   * The remount case the acceptance test caught.
   *
   * The volume returns seconds after it went, so the recorded heartbeat is
   * still fresh — yet the attempt that wrote it died with the unmount. Because
   * this process wrote the lock and is not holding that lease, it can say so
   * with certainty and reclaim immediately, instead of making recovery wait
   * out the lease timeout.
   */
  it("reclaims its own lock at once when the attempt behind it has ended", async () => {
    const now = Date.now();
    const lockPath = await lockDir({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date(now - 30_000).toISOString(),
      purpose: "adaptive:test",
      leaseId: "attempt-killed-by-unmount",
      // Fresh: it was beating right up to the moment the volume vanished.
      heartbeatAt: new Date(now - 2_000).toISOString(),
    });

    expect(await staleLock(lockPath, DAY_MS, () => now)).toBe(true);
    const reclaimed = await acquireDirectoryLock(lockPath, "adaptive:test");
    await reclaimed.release();
  });

  /**
   * The recovery the incident needed: after a remount the old lock reappears,
   * its lease long expired, and the next attempt takes it without help.
   */
  it("lets the next attempt acquire a lock left behind by a dead one", async () => {
    const now = Date.now();
    const lockPath = await lockDir({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date(now - 3 * 60 * 60_000).toISOString(),
      purpose: "adaptive:7ada79bd",
      leaseId: "attempt-that-died",
      heartbeatAt: new Date(now - 3 * 60 * 60_000).toISOString(),
    });

    const reclaimed = await acquireDirectoryLock(lockPath, "adaptive:7ada79bd");
    const owner = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8"),
    );

    expect(owner.leaseId).not.toBe("attempt-that-died");
    expect(reclaimed.leaseId).toBe(owner.leaseId);
    await reclaimed.release();
  });
});
