// @vitest-environment node
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MediaFileRow } from "../catalogue/catalogueRepository";
import type { BookToSearch } from "./bookSearch";
import { startBookPreindexing } from "./bookPreindexing";

const MEDIA_ROOT = path.resolve("/srv/media");

function file(itemId: string, relativePath: string, id = `file-${itemId}`) {
  return {
    id,
    itemId,
    relativePath,
    fingerprint: "fp",
  } as MediaFileRow;
}

type Preindex = (books: BookToSearch[]) => Promise<void>;

function setup(
  files: MediaFileRow[],
  preindex = vi.fn<Preindex>(async () => undefined),
) {
  const listBookFiles = vi.fn(async () => files);
  const warnings: string[] = [];
  const preindexing = startBookPreindexing({
    catalogue: { listBookFiles },
    mediaRoot: MEDIA_ROOT,
    search: { preindex },
    warn: (message) => warnings.push(message),
    firstSweepMs: 1_000,
    sweepEveryMs: 10_000,
  });
  return { preindexing, listBookFiles, preindex, warnings };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("preparing the library for search", () => {
  it("hands every book inside the media root to the search, keyed by its file", async () => {
    const { preindexing, preindex } = setup([
      file("book-1", "Books/1984/1984.epub"),
      file("book-2", "../outside.epub"),
    ]);
    await preindexing.sweep();
    preindexing.stop();
    expect(preindex).toHaveBeenCalledWith([
      {
        itemId: "book-1",
        filePath: path.join(MEDIA_ROOT, "Books", "1984", "1984.epub"),
        sourceKey: "file-book-1:fp",
      },
    ] satisfies BookToSearch[]);
  });

  it("sweeps shortly after start and then every hour, without help", async () => {
    vi.useFakeTimers();
    const { preindexing, listBookFiles } = setup([]);
    expect(listBookFiles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listBookFiles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listBookFiles).toHaveBeenCalledTimes(2);
    preindexing.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listBookFiles).toHaveBeenCalledTimes(2);
  });

  it("never runs two sweeps at once, and runs one more for a book added during one", async () => {
    let release = () => undefined as void;
    const preindex = vi.fn<Preindex>(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const { preindexing } = setup([file("book-1", "Books/a.epub")], preindex);

    const first = preindexing.sweep();
    await vi.waitFor(() => expect(preindex).toHaveBeenCalledTimes(1));
    void preindexing.sweep();
    void preindexing.sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(preindex).toHaveBeenCalledTimes(1);
    release();
    await first;
    await vi.waitFor(() => expect(preindex).toHaveBeenCalledTimes(2));
    release();
    preindexing.stop();
  });

  it("says so when a sweep fails, and sweeps again next time", async () => {
    const { preindexing, listBookFiles, warnings } = setup([]);
    listBookFiles.mockRejectedValueOnce(new Error("database unavailable"));
    await preindexing.sweep();
    expect(warnings).toEqual([
      "[Seyirlik] book search sweep failed: Error: database unavailable",
    ]);
    await preindexing.sweep();
    expect(listBookFiles).toHaveBeenCalledTimes(2);
    preindexing.stop();
  });
});
