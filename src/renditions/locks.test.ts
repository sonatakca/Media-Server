import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireDirectoryLock } from "./locks";

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
