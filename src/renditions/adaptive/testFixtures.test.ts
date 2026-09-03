import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishFixture } from "./testFixtures";

/**
 * The shared fixture cache, under the concurrency the runner actually applies.
 *
 * The cache is one fixed directory under `tmpdir()` used by every adaptive
 * suite, and it used to be written in place with `ffmpeg -y`. FFmpeg truncates
 * its destination the moment it starts, so a second worker checking `exists()`
 * saw a file that was empty, then partial, then briefly gone — which is how the
 * suite produced `moov atom not found` on one run and
 * `ENOENT: copyfile … source-epoch-2398.mp4` on another from a single cause.
 *
 * These tests use a synthetic builder rather than FFmpeg: the property under
 * test is the publication protocol, and a real encode would only make it slow
 * and harder to make deterministic.
 */

const temporaries: string[] = [];

afterEach(async () => {
  for (const directory of temporaries.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "seyirlik-fixture-race-"),
  );
  temporaries.push(directory);
  return directory;
}

/** A build that takes a while and writes its content in two halves. */
function slowBuilder(content: string, delayMs = 20) {
  return async (temporaryPath: string) => {
    await writeFile(temporaryPath, content.slice(0, 3), "utf8");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await writeFile(temporaryPath, content, "utf8");
  };
}

describe("publishing a fixture into the shared cache", () => {
  it("creates it once when nothing else is competing", async () => {
    const directory = await workspace();
    const target = path.join(directory, "source.mp4");
    await publishFixture(target, slowBuilder("complete-content"));
    expect(await readFile(target, "utf8")).toBe("complete-content");
  });

  /**
   * The regression. Ten workers race; every one must end up with a file that is
   * whole, and none may ever observe a partial one.
   */
  it("never exposes a partially built fixture to a competing worker", async () => {
    const directory = await workspace();
    const target = path.join(directory, "source.mp4");

    let builds = 0;
    const build = async (temporaryPath: string) => {
      builds += 1;
      await slowBuilder("complete-content")(temporaryPath);
    };

    await Promise.all(
      Array.from({ length: 10 }, () => publishFixture(target, build)),
    );

    /*
     * Several workers may legitimately build — they cannot know in advance who
     * will win — but exactly one file is published, and it is complete.
     */
    expect(builds).toBeGreaterThanOrEqual(1);
    expect(await readFile(target, "utf8")).toBe("complete-content");
  });

  /**
   * Immutability is the half that `rename` would not have given: replacing a
   * fixture another suite is mid-copy from is the same torn read one layer down.
   */
  it("never replaces a fixture that already exists", async () => {
    const directory = await workspace();
    const target = path.join(directory, "source.mp4");

    await publishFixture(target, slowBuilder("first"));
    await publishFixture(target, slowBuilder("second-and-different"));

    expect(await readFile(target, "utf8")).toBe("first");
  });

  /** Nothing of a losing or failing build may be left behind. */
  it("leaves no temporary files behind, on success or on failure", async () => {
    const directory = await workspace();
    const target = path.join(directory, "source.mp4");

    await Promise.all(
      Array.from({ length: 6 }, () =>
        publishFixture(target, slowBuilder("content")),
      ),
    );
    await expect(
      publishFixture(path.join(directory, "broken.mp4"), async () => {
        throw new Error("ffmpeg failed");
      }),
    ).rejects.toThrow("ffmpeg failed");

    const left = (await readdir(directory)).filter((entry) =>
      entry.startsWith(".building-"),
    );
    expect(left).toEqual([]);
  });

  /** A failed build must not publish anything at all. */
  it("publishes nothing when the build fails", async () => {
    const directory = await workspace();
    const target = path.join(directory, "source.mp4");
    await expect(
      publishFixture(target, async () => {
        throw new Error("ffmpeg failed");
      }),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  /**
   * A build that fails *because* a competitor already published is not a
   * failure. Without this a losing worker would fail its whole suite for having
   * been slower.
   */
  it("treats losing the race as success even if the build threw", async () => {
    const directory = await workspace();
    const target = path.join(directory, "source.mp4");
    await publishFixture(target, slowBuilder("winner"));

    await expect(
      publishFixture(target, async () => {
        throw new Error("ffmpeg failed");
      }),
    ).resolves.toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("winner");
  });

  /** Repeating the whole thing changes nothing: publication is idempotent. */
  it("is idempotent", async () => {
    const directory = await workspace();
    const target = path.join(directory, "source.mp4");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await publishFixture(target, slowBuilder("content"));
    }
    expect(await readFile(target, "utf8")).toBe("content");
    expect(await readdir(directory)).toEqual(["source.mp4"]);
  });

  /** Two different fixtures in one directory do not interfere. */
  it("keeps distinct fixtures independent", async () => {
    const directory = await workspace();
    await Promise.all([
      publishFixture(path.join(directory, "a.mp4"), slowBuilder("aaa")),
      publishFixture(path.join(directory, "b.mp4"), slowBuilder("bbb")),
    ]);
    expect(await readFile(path.join(directory, "a.mp4"), "utf8")).toBe("aaa");
    expect(await readFile(path.join(directory, "b.mp4"), "utf8")).toBe("bbb");
  });
});
