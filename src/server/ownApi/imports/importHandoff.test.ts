// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createImportHandoff } from "./importStarter";
import { createImportJobHandlers, IMPORT_JOB_TYPES } from "./importJobs";
import type { ImportRecord, ImportRepository } from "./importRepository";
import type { ImportService } from "./importService";

describe("handing finished downloads to the importer", () => {
  it("starts an import for each finished download that has none", async () => {
    const start = vi.fn(async (_id: string) => ({
      record: {} as ImportRecord,
      taskId: "t",
    }));
    const handOff = createImportHandoff({
      listFinished: async () => [{ id: "a" }, { id: "b" }, { id: "c" }],
      withImports: async () => new Set(["b"]),
      start,
      warn: () => undefined,
    });
    expect(await handOff()).toEqual({ started: 2, refused: 0 });
    expect(start.mock.calls.map(([id]) => id)).toEqual(["a", "c"]);
  });

  it("skips and names a download it cannot plan, and carries on", async () => {
    const warn = vi.fn();
    const handOff = createImportHandoff({
      listFinished: async () => [{ id: "outside" }, { id: "fine" }],
      withImports: async () => new Set(),
      start: vi.fn(async (id: string) => {
        if (id === "outside") {
          throw new Error("The finished download is outside the root.");
        }
        return { record: {} as ImportRecord, taskId: "t" };
      }),
      warn,
    });
    expect(await handOff()).toEqual({ started: 1, refused: 1 });
    expect(warn.mock.calls[0]![0]).toContain("outside");
  });

  it("does nothing when nothing has finished", async () => {
    const withImports = vi.fn(async () => new Set<string>());
    const start = vi.fn();
    await createImportHandoff({
      listFinished: async () => [],
      withImports,
      start,
    })();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("after an import lands", () => {
  function handlers(finalState: string, onImported = vi.fn(async () => {})) {
    const record = {
      id: "i1",
      state: "planned",
      libraryRoot: "D:\\media\\Movies",
    } as unknown as ImportRecord;
    let reads = 0;
    const repository = {
      get: vi.fn(async () => {
        reads += 1;
        // The last read is what the run reports and announces.
        return reads >= 3 ? { ...record, state: finalState } : record;
      }),
      listFiles: vi.fn(async () => [{}]),
    } as unknown as ImportRepository;
    const service = {
      plan: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({ state: finalState, committed: 1 })),
      cleanup: vi.fn(async () => undefined),
    } as unknown as ImportService;
    const all = createImportJobHandlers(service, repository, { onImported });
    return { run: all[IMPORT_JOB_TYPES.run]!, onImported };
  }

  const context = {
    job: { payload: { importId: "i1" } },
    reportProgress: async () => undefined,
  } as never;

  it("asks for the library to be read again", async () => {
    const { run, onImported } = handlers("complete");
    await run(context);
    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ id: "i1", libraryRoot: "D:\\media\\Movies" }),
    );
  });

  it("asks nothing when the import did not land", async () => {
    const { run, onImported } = handlers("needs_attention");
    await run(context);
    expect(onImported).not.toHaveBeenCalled();
  });

  it("does not fail an import whose files are in place when the scan cannot be queued", async () => {
    const { run } = handlers(
      "complete",
      vi.fn(async () => {
        throw new Error("queue down");
      }),
    );
    await expect(run(context)).resolves.toMatchObject({ state: "complete" });
  });
});
