/**
 * The Processes tab, rendered through the real page.
 *
 * Four claims are under test, and they are the four the operator can see: the
 * tab is split into what is happening and what happened; the waiting list reads
 * downwards from the encode that is running; a card dragged by its handle
 * rearranges the list *while it is still held*, so the order on screen is the
 * order a release would save; and that order is what reaches the server.
 *
 * jsdom has no layout, so the rows are given heights here. That is not a
 * pixel-level assertion dressed up as a fixture: the drag is geometry, and a
 * list of zero-height rows would let a broken implementation pass.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type {
  ProcessingJob,
  ProcessingOverview,
} from "../../lib/processingApi";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

vi.mock("../../lib/mediaApi", () => ({
  getUserViews: async () => [],
  getVideoItemsForLibrary: async () => [],
  getPrimaryImageUrl: () => "",
}));

const reorderProcessingQueue = vi.fn(async () => ({ reordered: [] }));

let overview: ProcessingOverview;

vi.mock("../../lib/processingApi", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/processingApi")
  >("../../lib/processingApi");
  return {
    ...actual,
    getProcessingOverview: async () => overview,
    previewProcessing: async () => {
      throw new Error("no preview in this suite");
    },
    getProcessingJob: async () => null,
    reorderProcessingQueue: (...args: unknown[]) =>
      reorderProcessingQueue(...(args as [])),
  };
});

vi.mock("../../lib/notifications/notificationStore", () => ({
  notify: vi.fn(),
}));

// ------------------------------------------------------------- fixtures

function job(overrides: Partial<ProcessingJob> & { id: string }) {
  return {
    itemId: `${overrides.id}-item`,
    mediaFileId: `${overrides.id}-file`,
    profile: "cmaf-hls-aligned-v2",
    state: "queued",
    stage: "waiting",
    stageProgress: 0,
    overallProgress: 0,
    bytesProcessed: 0,
    actualOutputBytes: 0,
    outputBytes: null,
    estimatedOutputBytes: null,
    estimatedStagingBytes: null,
    speed: null,
    fps: null,
    etaSeconds: null,
    hardwareAdapter: null,
    videoEncoder: null,
    decision: null,
    validation: null,
    warnings: [],
    sourceDamage: null,
    errorCode: null,
    errorMessage: null,
    publishedVersion: null,
    attempts: 0,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
    epochCount: null,
    epochIndex: null,
    completedEpochs: 0,
    protectedSeconds: 0,
    encodedSeconds: 0,
    sourceDurationSeconds: null,
    epochStartSeconds: null,
    epochEndSeconds: null,
    checkpointBytes: 0,
    freeBytes: null,
    queuePriority: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as ProcessingJob;
}

function baseOverview(jobs: ProcessingJob[]): ProcessingOverview {
  return {
    counts: {
      pending: 0,
      queued: 0,
      running: 0,
      paused: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    hardware: {
      platform: "darwin",
      probedAt: new Date().toISOString(),
      adapters: [],
      selected: { h264: "", hevc: "", hevcTenBit: "" },
      selectedAdapter: { h264: "", hevc: "", hevcTenBit: "" },
    },
    jobs,
    stages: [],
    profile: "cmaf-hls-aligned-v2",
    storage: {
      root: "/media",
      state: "healthy",
      summary: "",
      reason: "",
      faultCount: 0,
      missingRoots: [],
      firstFaultAt: null,
      lastFaultAt: null,
      changedAt: new Date().toISOString(),
      verifiedAt: null,
      mayStartWork: true,
      automaticResumeBlocked: false,
      awaitingVerification: false,
      awaitingResume: false,
    },
    movies: [],
    series: [],
    /*
     * The server sends the labels with the jobs, and the queue rows are
     * identified by them. Without these every row would read as a truncated
     * item id, which is precisely what the labels exist to prevent.
     */
    jobTitles: jobs.map((entry) => ({
      jobId: entry.id,
      kind: "movie" as const,
      title: entry.id,
    })),
  } as ProcessingOverview;
}

/**
 * One encode underway and three waiting, deliberately handed over in an order
 * that is neither the queue's nor its reverse — so a passing assertion cannot
 * be the fixture's own ordering leaking through.
 */
const MIXED = [
  job({ id: "third", queuePriority: 102 }),
  job({ id: "encoding", state: "running", startedAt: "2026-09-01T01:00:00Z" }),
  job({ id: "first", queuePriority: 100 }),
  job({
    id: "done",
    state: "succeeded",
    finishedAt: "2026-09-01T05:00:00.000Z",
  }),
  job({ id: "second", queuePriority: 101 }),
];

async function renderQueue() {
  const { MediaProcessingPage } = await import("./MediaProcessingPage");
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <MediaProcessingPage />
    </MemoryRouter>,
  );
  await screen.findByText("processing.title");
  await user.click(await screen.findByRole("tab", { name: /tabs.processes/ }));
  return user;
}

/** The titles of the rows now on screen, top to bottom. */
function rowTitles(): string[] {
  return screen
    .getAllByRole("listitem")
    .map(titleOf)
    .filter((title) => title.length > 0);
}

function titleOf(row: HTMLElement): string {
  return within(row).getAllByText(/^[a-z]+$/)[0]?.textContent ?? "";
}

/**
 * The waiting rows in the order the queue is currently showing them.
 *
 * Read from the slot each row says it is in rather than from where it sits in
 * the DOM: during a drag the rows are moved by transform and the DOM order is
 * deliberately held still, so the slot is the only honest answer to "what
 * would this drop save".
 */
function slotOrder(): string[] {
  return screen
    .getAllByRole("listitem")
    .filter((row) => row.dataset.queueSlot)
    .sort((a, b) => Number(a.dataset.queueSlot) - Number(b.dataset.queueSlot))
    .map(titleOf);
}

const ROW_HEIGHT = 100;
const ROW_GAP = 8;

/** Gives the rendered rows the heights jsdom will not give them. */
function stubRowLayout(): void {
  screen.getAllByRole("listitem").forEach((row, index) => {
    const top = 100 + index * (ROW_HEIGHT + ROW_GAP);
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: top,
      top,
      bottom: top + ROW_HEIGHT,
      left: 0,
      right: 900,
      width: 900,
      height: ROW_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect);
  });
}

/** Presses a handle and moves the pointer, without letting go. */
function pickUp(handle: HTMLElement, travel: number): void {
  stubRowLayout();
  fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientY: 0 });
  fireEvent.pointerMove(window, { pointerId: 7, clientY: travel });
}

function release(travel: number): void {
  fireEvent.pointerUp(window, { pointerId: 7, clientY: travel });
}

/** The waiting rows, in the order the server's own priorities put them. */
const nameOrder = ["first", "second", "third"];

beforeEach(() => {
  overview = baseOverview(MIXED);
  reorderProcessingQueue.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ tests

describe("the two halves of the Processes tab", () => {
  it("offers in-progress and concluded, and starts on in-progress", async () => {
    await renderQueue();

    const active = await screen.findByRole("tab", { name: /outcome.active/ });
    const finished = await screen.findByRole("tab", {
      name: /outcome.finished/,
    });
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(finished).toHaveAttribute("aria-selected", "false");
  });

  it("keeps the finished job out of the queue and in the history", async () => {
    const user = await renderQueue();

    expect(rowTitles()).not.toContain("done");

    await user.click(screen.getByRole("tab", { name: /outcome.finished/ }));
    await waitFor(() => expect(rowTitles()).toEqual(["done"]));
  });
});

describe("the order of the waiting list", () => {
  it("reads downwards from the encode that is running", async () => {
    await renderQueue();

    await waitFor(() =>
      expect(rowTitles()).toEqual(["encoding", "first", "second", "third"]),
    );
  });
});

describe("rearranging the queue", () => {
  it("gives a handle to every waiting job and none to the encode underway", async () => {
    await renderQueue();

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /queueOrder.handle/ }),
      ).toHaveLength(3),
    );
  });

  it("sends the whole new order when a waiting job is moved up", async () => {
    const user = await renderQueue();

    const handles = await screen.findAllByRole("button", {
      name: /queueOrder.handle/,
    });
    // The third waiting row, moved one place towards the front.
    handles[2]!.focus();
    await user.keyboard("{ArrowUp}");

    await waitFor(() =>
      expect(reorderProcessingQueue).toHaveBeenCalledWith([
        "first",
        "third",
        "second",
      ]),
    );
  });

  it("refuses to move the front of the queue past itself", async () => {
    const user = await renderQueue();

    const handles = await screen.findAllByRole("button", {
      name: /queueOrder.handle/,
    });
    handles[0]!.focus();
    await user.keyboard("{ArrowUp}");

    // Nothing above it but the encode, which has already been claimed.
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });

  it("gives the encode underway no handle to be dragged by", async () => {
    await renderQueue();
    await waitFor(() =>
      expect(rowTitles()).toEqual(["encoding", "first", "second", "third"]),
    );
    const [encoding] = screen.getAllByRole("listitem");

    expect(
      within(encoding!).queryByRole("button", { name: /queueOrder.handle/ }),
    ).toBeNull();
    expect(encoding!.dataset.queueSlot).toBeUndefined();
  });

  it("shows the dragged order straight away, before the server has answered", async () => {
    let release: (() => void) | undefined;
    reorderProcessingQueue.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ reordered: [] });
        }),
    );
    const user = await renderQueue();

    const handles = await screen.findAllByRole("button", {
      name: /queueOrder.handle/,
    });
    handles[2]!.focus();
    await user.keyboard("{ArrowUp}");

    // The overview still reports the old order; the row has moved regardless.
    await waitFor(() =>
      expect(rowTitles()).toEqual(["encoding", "first", "third", "second"]),
    );
    release?.();
  });
});

describe("dragging a card through the queue", () => {
  /** The handle on the row currently at the front of the waiting list. */
  async function firstHandle() {
    const handles = await screen.findAllByRole("button", {
      name: /queueOrder.handle/,
    });
    return handles[0]!;
  }

  it("rearranges the list while the card is still held", async () => {
    await renderQueue();
    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));

    // One row and one gap below its own slot: far enough past the midpoint
    // for the row underneath to have moved out of the way.
    pickUp(await firstHandle(), ROW_HEIGHT + ROW_GAP);

    expect(slotOrder()).toEqual(["second", "first", "third"]);
    // ...and nothing has been saved yet: the pointer is still down.
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
    release(ROW_HEIGHT + ROW_GAP);
  });

  it("keeps the same row under the cursor as it passes several slots", async () => {
    await renderQueue();
    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));
    const handle = await firstHandle();

    pickUp(handle, 20);
    expect(slotOrder()).toEqual(["first", "second", "third"]);

    fireEvent.pointerMove(window, { pointerId: 7, clientY: 120 });
    expect(slotOrder()).toEqual(["second", "first", "third"]);

    fireEvent.pointerMove(window, { pointerId: 7, clientY: 240 });
    expect(slotOrder()).toEqual(["second", "third", "first"]);

    // ...and back up again, without the card ever leaving the operator's hand.
    fireEvent.pointerMove(window, { pointerId: 7, clientY: 20 });
    expect(slotOrder()).toEqual(["first", "second", "third"]);
    release(20);
  });

  it("saves exactly the order that was on screen when the pointer was released", async () => {
    await renderQueue();
    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));

    pickUp(await firstHandle(), 2 * (ROW_HEIGHT + ROW_GAP));
    expect(slotOrder()).toEqual(["second", "third", "first"]);
    release(2 * (ROW_HEIGHT + ROW_GAP));

    await waitFor(() =>
      expect(reorderProcessingQueue).toHaveBeenCalledWith([
        "second",
        "third",
        "first",
      ]),
    );
    expect(reorderProcessingQueue).toHaveBeenCalledTimes(1);
    // The new order stands on the page while the server is still answering.
    expect(rowTitles()).toEqual(["encoding", "second", "third", "first"]);
  });

  it("takes the last waiting row to the front", async () => {
    await renderQueue();
    const handles = await screen.findAllByRole("button", {
      name: /queueOrder.handle/,
    });

    pickUp(handles[2]!, -2 * (ROW_HEIGHT + ROW_GAP));
    expect(slotOrder()).toEqual(["third", "first", "second"]);
    release(-2 * (ROW_HEIGHT + ROW_GAP));

    await waitFor(() =>
      expect(reorderProcessingQueue).toHaveBeenCalledWith([
        "third",
        "first",
        "second",
      ]),
    );
  });

  it("saves nothing when the card is put back where it came from", async () => {
    await renderQueue();
    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));

    pickUp(await firstHandle(), 30);
    fireEvent.pointerMove(window, { pointerId: 7, clientY: 6 });
    release(6);

    expect(slotOrder()).toEqual(nameOrder);
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });

  it("treats a press that never moves as a press, not a drag", async () => {
    await renderQueue();
    const handle = await firstHandle();

    stubRowLayout();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 7, clientY: 2 });
    release(2);

    expect(slotOrder()).toEqual(nameOrder);
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });

  it("puts the queue back when the drag is abandoned", async () => {
    await renderQueue();
    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));

    pickUp(await firstHandle(), 2 * (ROW_HEIGHT + ROW_GAP));
    expect(slotOrder()).toEqual(["second", "third", "first"]);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(slotOrder()).toEqual(nameOrder);
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
    // The pointer coming up afterwards must not save the abandoned order.
    release(2 * (ROW_HEIGHT + ROW_GAP));
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });

  it("holds the previewed order against a refresh landing mid-drag", async () => {
    await renderQueue();
    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));

    pickUp(await firstHandle(), ROW_HEIGHT + ROW_GAP);
    expect(slotOrder()).toEqual(["second", "first", "third"]);

    /*
     * The page polls while the card is held. A poll that carried the queue's
     * own order back into the list would move the row out from under the
     * cursor — which is the whole reason the order is frozen for the gesture.
     */
    overview = baseOverview(
      MIXED.map((entry) =>
        entry.id === "third" ? { ...entry, overallProgress: 0.4 } : entry,
      ),
    );
    fireEvent.focus(window);
    await waitFor(() => expect(reorderProcessingQueue).not.toHaveBeenCalled());

    expect(slotOrder()).toEqual(["second", "first", "third"]);
    release(ROW_HEIGHT + ROW_GAP);
    await waitFor(() =>
      expect(reorderProcessingQueue).toHaveBeenCalledWith([
        "second",
        "first",
        "third",
      ]),
    );
  });

  it("gives the queue back to the server when the save is refused", async () => {
    reorderProcessingQueue.mockRejectedValueOnce(new Error("nope"));
    await renderQueue();
    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));

    pickUp(await firstHandle(), ROW_HEIGHT + ROW_GAP);
    release(ROW_HEIGHT + ROW_GAP);

    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));
    expect(rowTitles()).toEqual(["encoding", "first", "second", "third"]);
  });

  it("numbers the rows by the slots they are being dragged into", async () => {
    await renderQueue();
    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));

    pickUp(await firstHandle(), ROW_HEIGHT + ROW_GAP);

    const rows = screen.getAllByRole("listitem");
    const held = rows.find((row) => titleOf(row) === "first")!;
    const displaced = rows.find((row) => titleOf(row) === "second")!;
    // The badges agree with the slots: no row claims a position twice.
    expect(held.dataset.queueSlot).toBe("2");
    expect(displaced.dataset.queueSlot).toBe("1");
    release(ROW_HEIGHT + ROW_GAP);
  });

  it("moves the held row itself and leaves no copy behind", async () => {
    await renderQueue();
    await waitFor(() => expect(slotOrder()).toEqual(nameOrder));

    pickUp(await firstHandle(), ROW_HEIGHT + ROW_GAP);

    const rows = screen.getAllByRole("listitem");
    expect(rows.filter((row) => titleOf(row) === "first")).toHaveLength(1);
    const held = rows.find((row) => titleOf(row) === "first")!;
    const displaced = rows.find((row) => titleOf(row) === "second")!;
    // The row under the cursor has gone down and the row it passed has come
    // up. Nothing is left dimmed in the old slot, because nothing was copied.
    expect(held.style.transform).toContain("108px");
    expect(displaced.style.transform).toContain("-108px");
    expect(held.style.opacity).toBe("");
    release(ROW_HEIGHT + ROW_GAP);
  });
});
