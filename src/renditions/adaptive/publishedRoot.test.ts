import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PUBLICATION_GENERATIONS,
  PUBLICATION_POINTER,
  resolvePublishedTitleRoot,
} from "./publishedRoot";

const roots: string[] = [];
async function root() {
  const directory = await mkdtemp(path.join(tmpdir(), "seyirlik-pointer-"));
  roots.push(directory);
  await mkdir(path.join(directory, ".seyirlik"));
  return directory;
}
afterEach(async () => {
  for (const directory of roots.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("publication root", () => {
  it("reads legacy packages without a pointer", async () => {
    const directory = await root();
    expect(await resolvePublishedTitleRoot(directory)).toBe(directory);
  });
  it("pins a reader to the generation selected at resolution", async () => {
    const directory = await root();
    const generations = ["a".repeat(64), "b".repeat(64)];
    for (const generation of generations)
      await mkdir(path.join(directory, PUBLICATION_GENERATIONS, generation), {
        recursive: true,
      });
    const activate = (generation: string) =>
      writeFile(
        path.join(directory, PUBLICATION_POINTER),
        JSON.stringify({ schemaVersion: 1, generation }),
      );
    await activate(generations[0]!);
    const pinned = await resolvePublishedTitleRoot(directory);
    await activate(generations[1]!);
    expect(pinned).toBe(
      await realpath(
        path.join(directory, PUBLICATION_GENERATIONS, generations[0]!),
      ),
    );
    expect(await resolvePublishedTitleRoot(directory)).not.toBe(pinned);
  });
  it.each(["../outside", "/outside", "C:\\outside", "a".repeat(63)])(
    "rejects malformed generation %s",
    async (generation) => {
      const directory = await root();
      await writeFile(
        path.join(directory, PUBLICATION_POINTER),
        JSON.stringify({ schemaVersion: 1, generation }),
      );
      await expect(resolvePublishedTitleRoot(directory)).rejects.toThrow(
        "invalid",
      );
    },
  );
  it("rejects a generation junction or symlink outside the title", async () => {
    const directory = await root();
    const outside = await root();
    const generation = "a".repeat(64);
    await mkdir(path.join(directory, PUBLICATION_GENERATIONS));
    await symlink(
      outside,
      path.join(directory, PUBLICATION_GENERATIONS, generation),
      "junction",
    );
    await writeFile(
      path.join(directory, PUBLICATION_POINTER),
      JSON.stringify({ schemaVersion: 1, generation }),
    );
    await expect(resolvePublishedTitleRoot(directory)).rejects.toThrow(
      "escaped",
    );
  });
});
