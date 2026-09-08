// @vitest-environment node
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImportService, type ImportService } from "./importService";
import { createImportOperations } from "./importOperations";
import { createNodeReadFileSystem } from "./importFileSystem";
import {
  createMemoryRepository,
  withFault,
  type Fault,
  type MemoryRepository,
} from "./importTestHarness";
import type { DestinationTarget } from "./importDestination";

/*
 * What happens when the destination is not empty.
 *
 * Every case here is one where the wrong answer costs somebody a film, so the
 * assertions are as much about what is *still there* afterwards as about what
 * the import decided.
 */
let workspace: string;
let sourceRoot: string;
let libraryRoot: string;
let repository: MemoryRepository;

const RELEASE = "Dune.2021.2160p.BluRay";
const TARGET: DestinationTarget = { kind: "movie", title: "Dune", year: 2021 };
const DESTINATION = "Dune (2021)/src/Dune (2021).mkv";
const NEW_CONTENTS = "the better release";
const OLD_CONTENTS = "the release already in the library";

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-import-clash-"));
  sourceRoot = path.join(workspace, "downloads");
  libraryRoot = path.join(workspace, "library");
  await mkdir(path.join(sourceRoot, RELEASE), { recursive: true });
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, RELEASE, "dune.mkv"), NEW_CONTENTS);
  repository = createMemoryRepository();
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function service(fault: Fault | null = null): ImportService {
  return createImportService({
    repository,
    operationsFor: (source, library) =>
      withFault(createImportOperations(source, library), fault),
    sourceFileSystemFor: (root) => createNodeReadFileSystem(root),
    targetFor: async () => TARGET,
  });
}

async function newImport(isUpgrade = false): Promise<string> {
  const created = await repository.create({
    target: { kind: "movie", title: "Dune", year: 2021 },
    sourceRoot,
    libraryRoot,
    sourceRelative: RELEASE,
    isUpgrade,
  });
  return created.id;
}

async function occupyDestination(contents: string): Promise<void> {
  await mkdir(path.join(libraryRoot, "Dune (2021)", "src"), {
    recursive: true,
  });
  await writeFile(path.join(libraryRoot, DESTINATION), contents);
}

async function srcDirectory(): Promise<string[]> {
  return (await readdir(path.join(libraryRoot, "Dune (2021)", "src"))).sort();
}

/** Imports an earlier release so the library file is one Seyirlik owns. */
async function importAnEarlierRelease(): Promise<void> {
  const earlier = "Dune.2021.1080p.WEB-DL";
  await mkdir(path.join(sourceRoot, earlier), { recursive: true });
  await writeFile(path.join(sourceRoot, earlier, "dune.mkv"), OLD_CONTENTS);
  const first = await repository.create({
    target: { kind: "movie", title: "Dune", year: 2021 },
    sourceRoot,
    libraryRoot,
    sourceRelative: earlier,
  });
  const svc = service();
  await svc.plan(first.id);
  await svc.execute(first.id);
  await svc.cleanup(first.id);
}

describe("the destination is empty", () => {
  it("imports normally", async () => {
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    expect((await svc.execute(importId)).state).toBe("committed");
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      NEW_CONTENTS,
    );
  });
});

describe("the destination holds this import's own work", () => {
  it("adopts it instead of doing it again", async () => {
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    await svc.execute(importId);
    await svc.execute(importId);

    expect(await srcDirectory()).toEqual(["Dune (2021).mkv"]);
  });
});

describe("the destination holds a file nobody here imported", () => {
  it("stops and asks, and changes nothing", async () => {
    await occupyDestination("a film somebody put there by hand");
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    const outcome = await svc.execute(importId);

    expect(outcome.state).toBe("needs_attention");
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "a film somebody put there by hand",
    );
  });

  it("will not replace it even when the release is marked an upgrade", async () => {
    /*
     * An upgrade replaces media Seyirlik put in the library. A file with no
     * import behind it is somebody's own, and being told "this release is
     * better" says nothing about a file nobody has any record of.
     */
    await occupyDestination("a film somebody put there by hand");
    const importId = await newImport(true);
    const svc = service();
    await svc.plan(importId);
    const outcome = await svc.execute(importId);

    expect(outcome.state).toBe("needs_attention");
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "a film somebody put there by hand",
    );
  });

  it("leaves the download alone so nothing has been lost", async () => {
    await occupyDestination("someone else's");
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    await svc.execute(importId);
    expect(
      await readFile(path.join(sourceRoot, RELEASE, "dune.mkv"), "utf8"),
    ).toBe(NEW_CONTENTS);
  });
});

describe("upgrading media this system imported before", () => {
  it("refuses without being told the release is better", async () => {
    // The importer never works out on its own that one file beats another.
    await importAnEarlierRelease();
    const importId = await newImport(false);
    const svc = service();
    await svc.plan(importId);
    expect((await svc.execute(importId)).state).toBe("needs_attention");
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      OLD_CONTENTS,
    );
  });

  it("replaces it when it was told, and keeps nothing stale behind", async () => {
    await importAnEarlierRelease();
    const importId = await newImport(true);
    const svc = service();
    await svc.plan(importId);
    expect((await svc.execute(importId)).state).toBe("committed");

    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      NEW_CONTENTS,
    );
    expect(await srcDirectory()).toEqual(["Dune (2021).mkv"]);
  });

  it("keeps the old file whole until the replacement is recorded", async () => {
    /*
     * The rule an upgrade must never break: the old media stays valid until
     * the new one is durable. Crashing between the two renames leaves both
     * files on disk, under names that say which is which.
     */
    await importAnEarlierRelease();
    const importId = await newImport(true);
    await service().plan(importId);
    await service({ operation: "activate" })
      .execute(importId)
      .catch(() => undefined);

    const present = await srcDirectory();
    const retired = present.filter((name) => name.includes("retired"));
    expect(retired).toHaveLength(1);
    expect(
      await readFile(
        path.join(libraryRoot, "Dune (2021)", "src", retired[0]!),
        "utf8",
      ),
    ).toBe(OLD_CONTENTS);
  });

  it("finishes an interrupted replacement rather than starting over", async () => {
    await importAnEarlierRelease();
    const importId = await newImport(true);
    await service().plan(importId);
    await service({ operation: "activate" })
      .execute(importId)
      .catch(() => undefined);

    const recovery = service();
    await recovery.reconcile(importId);
    await recovery.execute(importId);

    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      NEW_CONTENTS,
    );
    expect(await srcDirectory()).toEqual(["Dune (2021).mkv"]);
  });

  it("never leaves the library with neither file", async () => {
    // At every point of an interrupted upgrade, at least one whole copy of the
    // film is on disk under a name that identifies it.
    await importAnEarlierRelease();
    for (const fault of [
      { operation: "activate" },
      { operation: "activate", afterEffect: true },
      { operation: "retire", afterEffect: true },
    ] as Fault[]) {
      const importId = await newImport(true);
      await service().plan(importId);
      await service(fault)
        .execute(importId)
        .catch(() => undefined);

      const present = await srcDirectory();
      const readable = await Promise.all(
        present.map((name) =>
          readFile(path.join(libraryRoot, "Dune (2021)", "src", name), "utf8"),
        ),
      );
      expect(
        readable.some((body) => body === OLD_CONTENTS || body === NEW_CONTENTS),
      ).toBe(true);
    }
  });
});

describe("two releases that want one name", () => {
  it("refuses the second, having committed the first", async () => {
    const second = "Dune.2021.1080p.Other";
    await mkdir(path.join(sourceRoot, second), { recursive: true });
    await writeFile(path.join(sourceRoot, second, "dune.mkv"), "another rip");

    const firstId = await newImport();
    const svc = service();
    await svc.plan(firstId);
    await svc.execute(firstId);

    const secondRecord = await repository.create({
      target: { kind: "movie", title: "Dune", year: 2021 },
      sourceRoot,
      libraryRoot,
      sourceRelative: second,
    });
    await svc.plan(secondRecord.id);
    expect((await svc.execute(secondRecord.id)).state).toBe("needs_attention");

    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      NEW_CONTENTS,
    );
    expect(await srcDirectory()).toEqual(["Dune (2021).mkv"]);
  });
});

describe("names that differ only in case", () => {
  it("treats them as the same destination", async () => {
    /*
     * The library filesystem may be case-insensitive, where `Dune (2021).mkv`
     * and `DUNE (2021).MKV` are one file. The destination key is folded so the
     * record agrees with the filesystem rather than with the string.
     */
    await occupyDestination(OLD_CONTENTS);
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    const files = await repository.listFiles(importId);
    expect(files[0]!.destinationKey).toBe(
      files[0]!.destinationKey!.toLowerCase(),
    );
  });
});

describe("sidecars beside an occupied destination", () => {
  it("does not import the film's subtitle when the film is refused", async () => {
    await mkdir(path.join(sourceRoot, RELEASE, "Subs"), { recursive: true });
    await writeFile(
      path.join(sourceRoot, RELEASE, "Subs", "2_English.srt"),
      "subtitle",
    );
    await occupyDestination("someone else's");

    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    expect((await svc.execute(importId)).state).toBe("needs_attention");

    // The subtitle may have been staged, but nothing was published beside a
    // film this import does not own.
    const published = (await srcDirectory()).filter(
      (name) => !name.startsWith(".seyirlik"),
    );
    expect(published).toEqual(["Dune (2021).mkv"]);
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "someone else's",
    );
  });
});

describe("what may be deleted inside the library", () => {
  it("refuses to discard anything that is not staging or retirement", async () => {
    const operations = createImportOperations(sourceRoot, libraryRoot);
    await occupyDestination(OLD_CONTENTS);
    await expect(operations.discardStaging(DESTINATION)).rejects.toThrow();
    expect(await stat(path.join(libraryRoot, DESTINATION))).toBeTruthy();
  });

  it("refuses to retire a file to anything but a retirement name", async () => {
    const operations = createImportOperations(sourceRoot, libraryRoot);
    await occupyDestination(OLD_CONTENTS);
    await expect(
      operations.retire(DESTINATION, "Dune (2021)/src/somewhere-else.mkv"),
    ).rejects.toThrow();
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      OLD_CONTENTS,
    );
  });
});
