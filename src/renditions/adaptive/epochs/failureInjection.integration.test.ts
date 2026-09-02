/**
 * Deliberate failure, injected rather than waited for.
 *
 * Every scenario here is one that used to cost the whole title. They are
 * provoked on purpose — an encoder killed part way, an I/O error the moment the
 * drive is pulled, a publish that cannot write — because the only way to know a
 * recovery works is to break something and watch it recover. None of it depends
 * on physically unplugging a disk.
 *
 * The single claim being tested throughout: whatever goes wrong, the completed
 * checkpoints survive it, and the next attempt continues from them.
 */

import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenditionPaths } from "../../analysis";
import { computeSourceFingerprint } from "../../registry";
import { runFfmpeg } from "../../processor";
import { createPauseController } from "../../processing/pauseController";
import { packageAdaptiveRendition } from "../packager";
import { ADAPTIVE_PROFILE_VERSION } from "../profile";
import {
  ensureAdaptiveEpochFixture,
  getAdaptiveFixtureDirectory,
} from "../testFixtures";
import { checkpointRoot, epochsRoot } from "./checkpoints";
import { epochDirectoryName, EPOCH_MANIFEST_FILE } from "./policy";

const MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const EPOCH_TARGET_SECONDS = 6;

let fixture: string | null = null;
let workspace = "";

type Runner = typeof runFfmpeg;

interface Harness {
  paths: RenditionPaths;
  sourcePath: string;
  titleRoot: string;
  fingerprint: string;
  checkpoints: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(workspace, "run-"));
  const paths: RenditionPaths = {
    mediaRoot: getAdaptiveFixtureDirectory(),
    renditionRoot: path.join(root, "renditions"),
    workRoot: path.join(root, "work"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
  };
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });

  const titleRoot = await mkdtemp(path.join(workspace, "title-"));
  const sourcePath = path.join(titleRoot, "failure-source.mp4");
  await copyFile(fixture!, sourcePath);
  const fingerprint = await computeSourceFingerprint(
    sourcePath,
    await stat(sourcePath),
  );
  return {
    paths,
    sourcePath,
    titleRoot,
    fingerprint,
    checkpoints: checkpointRoot(
      paths.workRoot,
      MEDIA_ID,
      ADAPTIVE_PROFILE_VERSION,
      fingerprint,
    ),
  };
}

async function runPackage(
  harness: Harness,
  overrides: Record<string, unknown> = {},
) {
  return packageAdaptiveRendition(
    {
      mediaId: MEDIA_ID,
      relativePath: path.basename(harness.sourcePath),
      sourceFingerprint: harness.fingerprint,
      sourcePath: harness.sourcePath,
    },
    harness.paths,
    {
      reserveBytes: 0,
      preset: "ultrafast",
      verifySourceFingerprint: false,
      epochTargetSeconds: EPOCH_TARGET_SECONDS,
      ...overrides,
    } as never,
  );
}

async function durableEpochs(harness: Harness): Promise<string[]> {
  return (await readdir(epochsRoot(harness.checkpoints)).catch(() => []))
    .filter((name) => /^\d{6}$/.test(name))
    .sort();
}

async function partialEpochs(harness: Harness): Promise<string[]> {
  return (
    await readdir(epochsRoot(harness.checkpoints)).catch(() => [])
  ).filter((name) => name.includes(".partial"));
}

/** Fails the nth encoder invocation and every one after it. */
function failingFrom(count: number, message: string): Runner {
  let seen = 0;
  return async (command, args, options) => {
    seen += 1;
    if (seen >= count) throw new Error(message);
    return runFfmpeg(command, args, options);
  };
}

/** Fails the nth encoder invocation with a chosen message. */
function failingAfter(count: number, message: string): Runner {
  let seen = 0;
  return async (command, args, options) => {
    seen += 1;
    if (seen === count) throw new Error(message);
    return runFfmpeg(command, args, options);
  };
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-failure-it-"));
  fixture = await ensureAdaptiveEpochFixture();
}, 300_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("the encoder dies part way through", () => {
  it("keeps every finished epoch and restarts only the one that was running", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    const first = await runPackage(harness, {
      runEncoder: failingAfter(3, "FFmpeg failed with exit code 1: killed"),
    });
    expect(first.status).toBe("failed");
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
    // A workspace that was being written must never survive under a name
    // anything would read as finished.
    expect(await partialEpochs(harness)).toEqual([]);

    let encodes = 0;
    const second = await runPackage(harness, {
      runEncoder: (async (command, args, options) => {
        encodes += 1;
        return runFfmpeg(command, args, options);
      }) satisfies Runner,
    });
    expect(second.status).toBe("ready");
    // Two epochs reused; the rest of the ladder plus one audio pass.
    expect(encodes).toBeLessThan(5);
  }, 900_000);
});

describe("the worker is killed and the machine restarts", () => {
  it("adopts the checkpoints on disk and clears what the dead attempt left", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    await runPackage(harness, {
      runEncoder: failingAfter(3, "FFmpeg failed with exit code 1: killed"),
    });
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);

    /*
     * What a SIGKILLed worker leaves behind: a workspace with an owner record
     * naming a process that no longer exists, and a rendition lock nobody
     * released. Both have to be reclaimed without touching anything durable.
     */
    const stalePartial = path.join(
      epochsRoot(harness.checkpoints),
      `${epochDirectoryName(2)}.partial-424242-deadbeef`,
    );
    await mkdir(path.join(stalePartial, "video", "360p"), { recursive: true });
    await writeFile(
      path.join(stalePartial, "OWNER.json"),
      JSON.stringify({
        pid: 424_242,
        hostname: (await import("node:os")).hostname(),
        attemptId: "dead",
        startedAt: new Date(Date.now() - 600_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
      }),
    );
    const lockPath = path.join(
      harness.paths.stateRoot,
      "locks",
      `${MEDIA_ID}.adaptive.lock`,
    );
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 424_242,
        hostname: (await import("node:os")).hostname(),
        createdAt: new Date(Date.now() - 600_000).toISOString(),
        purpose: `adaptive:${MEDIA_ID}`,
        leaseId: "dead",
        heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
      }),
    );

    const result = await runPackage(harness);
    expect(result.status).toBe("ready");
  }, 900_000);
});

describe("storage disappears mid-encode", () => {
  /**
   * An I/O error is ambiguous, and the ambiguity is resolved by asking again.
   *
   * The watchdog polls every five seconds, so the drive may already be gone and
   * the check simply not have run. The encoder therefore waits past a poll and
   * asks the storage a second time. Here the second answer is "gone", which
   * settles it: the job parks and waits rather than blaming the media.
   */
  it("waits for the volume when the re-check finds it has gone", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    let storageThere = true;
    const result = await runPackage(harness, {
      // The signature of a drive that has gone: an I/O error from the encoder.
      runEncoder: failingFrom(
        3,
        "FFmpeg failed with exit code 1: /Volumes/Expansion/x: Input/output error",
      ),
      // The watchdog catches up between the failure and the re-check.
      storageAvailable: () => {
        const answer = storageThere;
        storageThere = false;
        return answer;
      },
      missingRoots: () => (storageThere ? [] : ["/Volumes/Expansion"]),
      sourceIoBackoffMs: [0, 0, 0],
    });

    expect(result.status).toBe("interrupted");
    expect(result.interruption).toBe("storage");
    expect(result.error).toMatch(/I\/O error|unavailable/i);
    // Nothing durable was touched.
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
    expect(await partialEpochs(harness)).toEqual([]);
  }, 900_000);

  /**
   * A single I/O error on storage that stays healthy is not a dying disk.
   *
   * It is re-read, it succeeds, and the title finishes. Parking the job here —
   * which is what used to happen — meant a transient read error stopped a build
   * until a watchdog transition that was never going to come.
   */
  it("re-reads a source that failed once and finishes the title", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    const retries: Array<{ attempt: number; maxAttempts: number }> = [];
    const result = await runPackage(harness, {
      runEncoder: failingAfter(
        3,
        "FFmpeg failed with exit code 1: Input/output error",
      ),
      storageAvailable: () => true,
      missingRoots: () => [],
      sourceIoBackoffMs: [0, 0, 0],
      onEvent: (event: {
        type: string;
        attempt?: number;
        maxAttempts?: number;
      }) => {
        if (event.type === "source-io-retry") {
          retries.push({
            attempt: event.attempt!,
            maxAttempts: event.maxAttempts!,
          });
        }
      },
    });

    expect(result.status).toBe("ready");
    expect(retries).toEqual([{ attempt: 1, maxAttempts: 4 }]);
  }, 900_000);

  /**
   * The escalation. A volume that is present, readable and unchanged through
   * every re-check, with a source that will not read, is damaged media or a
   * failing disk. Waiting does not fix that, so the job ends and asks for a
   * person instead of parking itself for a watchdog with nothing to wait for.
   */
  it("gives up on a source that keeps failing while its volume stays healthy", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    let storageChecks = 0;
    const retries: number[] = [];
    const result = await runPackage(harness, {
      runEncoder: failingFrom(
        3,
        "FFmpeg failed with exit code 1: Input/output error",
      ),
      storageAvailable: () => {
        storageChecks += 1;
        return true;
      },
      missingRoots: () => [],
      sourceIoBackoffMs: [0, 0, 0],
      onEvent: (event: { type: string; attempt?: number }) => {
        if (event.type === "source-io-retry") retries.push(event.attempt!);
      },
    });

    // Terminal, and not a pause: nothing will ever requeue this on its own.
    expect(result.status).toBe("failed");
    expect(result.interruption).toBeUndefined();
    expect(result.error).toMatch(/damaged media|failing disk/i);
    // Bounded: it stopped, and it stopped where the policy says it stops.
    expect(retries).toEqual([1, 2, 3, 4]);
    expect(storageChecks).toBeGreaterThan(0);
    // And every checkpoint before the bad epoch is still there.
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
    expect(await partialEpochs(harness)).toEqual([]);
  }, 900_000);

  it("names the volume when the watchdog already knows it is missing", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const result = await runPackage(harness, {
      runEncoder: failingAfter(
        1,
        "ENOENT: no such file or directory, open '/Volumes/Expansion/out'",
      ),
      storageAvailable: () => false,
      missingRoots: () => ["/Volumes/Expansion"],
    });
    expect(result.interruption).toBe("storage");
    expect(result.error).toContain("/Volumes/Expansion");
  }, 900_000);

  it("continues from the last checkpoint once the volume is back", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    await runPackage(harness, {
      runEncoder: failingAfter(
        3,
        "FFmpeg failed with exit code 1: Input/output error",
      ),
      storageAvailable: () => false,
    });
    const protectedBefore = await durableEpochs(harness);
    expect(protectedBefore).toEqual(["000000", "000001"]);
    const manifests = new Map<string, string>();
    for (const name of protectedBefore) {
      manifests.set(
        name,
        await readFile(
          path.join(epochsRoot(harness.checkpoints), name, EPOCH_MANIFEST_FILE),
          "utf8",
        ),
      );
    }

    let reused = -1;
    const recovered = await runPackage(harness, {
      storageAvailable: () => true,
      onEvent: (event: { type: string; reusedEpochs?: number }) => {
        if (event.type === "epoch-plan") reused = event.reusedEpochs!;
      },
    });

    expect(recovered.status).toBe("ready");
    expect(reused).toBe(2);
  }, 900_000);
});

describe("cancellation", () => {
  it("stops the encoder and leaves every checkpoint where it is", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const controller = new AbortController();

    let encodes = 0;
    const result = await runPackage(harness, {
      signal: controller.signal,
      runEncoder: (async (command, args, options) => {
        encodes += 1;
        // Cancelled after the second epoch is durable, which is what pressing
        // Cancel during the third looks like from here.
        if (encodes === 3) {
          controller.abort();
          return runFfmpeg(command, args, options);
        }
        return runFfmpeg(command, args, options);
      }) satisfies Runner,
    });

    expect(result.status).toBe("interrupted");
    expect(result.interruption).toBe("cancelled");
    expect((await durableEpochs(harness)).length).toBeGreaterThanOrEqual(2);
  }, 900_000);

  it("retrying a cancelled job reuses what it had already protected", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const controller = new AbortController();
    let encodes = 0;
    await runPackage(harness, {
      signal: controller.signal,
      runEncoder: (async (command, args, options) => {
        encodes += 1;
        if (encodes === 3) controller.abort();
        return runFfmpeg(command, args, options);
      }) satisfies Runner,
    });
    const protectedEpochs = await durableEpochs(harness);
    expect(protectedEpochs.length).toBeGreaterThanOrEqual(2);

    let reused = -1;
    const retried = await runPackage(harness, {
      onEvent: (event: { type: string; reusedEpochs?: number }) => {
        if (event.type === "epoch-plan") reused = event.reusedEpochs!;
      },
    });
    expect(retried.status).toBe("ready");
    expect(reused).toBe(protectedEpochs.length);
  }, 900_000);
});

describe("publication fails after the encoding is done", () => {
  it("keeps the checkpoints, and the retry re-encodes no video at all", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    /*
     * A title folder that cannot be written to. Everything upstream of
     * publication succeeds, so this is the case where hours of encoding are at
     * their most exposed: the work is finished and the last step fails.
     */
    await chmod(harness.titleRoot, 0o555);
    let failed;
    try {
      failed = await runPackage(harness);
    } finally {
      await chmod(harness.titleRoot, 0o755);
    }
    expect(failed.status).not.toBe("ready");

    const durable = await durableEpochs(harness);
    expect(durable.length).toBeGreaterThan(0);

    let encodes = 0;
    let reused = -1;
    const retried = await runPackage(harness, {
      runEncoder: (async (command, args, options) => {
        encodes += 1;
        return runFfmpeg(command, args, options);
      }) satisfies Runner,
      onEvent: (event: { type: string; reusedEpochs?: number }) => {
        if (event.type === "epoch-plan") reused = event.reusedEpochs!;
      },
    });

    expect(retried.status).toBe("ready");
    expect(reused).toBe(durable.length);
    // Audio was already staged too, so a publish-only retry runs no encoder.
    expect(encodes).toBe(0);
  }, 900_000);
});

describe("pausing a live encoder", () => {
  it("suspends the process where it stands and continues it in place", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const controller = createPauseController();

    /*
     * A real FFmpeg, really suspended. The claim being tested is the one the
     * interface makes to an operator: pausing costs nothing, because the
     * process keeps its memory, its open files and its position in the source.
     */
    const output = path.join(harness.paths.logsRoot, "pause-probe.mp4");
    const encode = runFfmpeg(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-progress",
        "pipe:1",
        "-nostats",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=24:duration=30",
        "-c:v",
        "libx264",
        "-preset",
        "veryslow",
        output,
      ],
      {
        logPath: path.join(harness.paths.logsRoot, "pause-probe.log"),
        pauseController: controller,
        onProgress: (progress) => {
          samples.push(progress.processedSeconds);
        },
      },
    );
    const samples: number[] = [];

    await new Promise((resolve) => setTimeout(resolve, 700));
    controller.pause();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const atPause = samples[samples.length - 1] ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const whilePaused = samples[samples.length - 1] ?? 0;

    // A suspended encoder produces nothing: the counter stops rather than
    // creeping, which is what makes a pause honest on the page.
    expect(whilePaused).toBe(atPause);

    controller.resume();
    await encode;
    const finished = samples[samples.length - 1] ?? 0;
    expect(finished).toBeGreaterThan(whilePaused);
    expect((await stat(output)).size).toBeGreaterThan(0);
  }, 300_000);
});
