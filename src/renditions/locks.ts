import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface LockOwner {
  pid: number;
  hostname: string;
  createdAt: string;
  purpose: string;
}

export interface AcquiredLock {
  path: string;
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

async function staleLock(
  lockPath: string,
  maximumAgeMs: number,
): Promise<boolean> {
  try {
    const owner = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8"),
    ) as Partial<LockOwner>;
    const createdAt = Date.parse(owner.createdAt ?? "");
    const expired =
      !Number.isFinite(createdAt) || Date.now() - createdAt > maximumAgeMs;
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
      const owner: LockOwner = {
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
        purpose,
      };
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify(owner, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      let released = false;
      return {
        path: lockPath,
        release: async () => {
          if (released) return;
          released = true;
          await rm(lockPath, { recursive: true, force: true });
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
