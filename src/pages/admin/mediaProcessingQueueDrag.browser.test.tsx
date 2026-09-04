/**
 * The queue reorder gesture, in a real browser, on the real page.
 *
 * jsdom can prove that the model and the page agree; it cannot prove the thing
 * the operator complained about, because it has no layout and no pointer. Here
 * the cards have the heights the stylesheet actually gives them, the mouse is
 * a real mouse held down across several moves, and the assertions are the ones
 * you would make while watching over somebody's shoulder: the row you are
 * holding is the row that moves, nothing is left behind in its old slot, the
 * list rearranges before you let go, and what it showed you is what is saved.
 *
 * Chromium and WebKit both, because the gesture is pointer events and a
 * transform, and Safari is where this project's operators actually are.
 */

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { commands, page, userEvent } from "vitest/browser";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProcessingJob,
  ProcessingOverview,
} from "../../lib/processingApi";

// The page's real stylesheet: without it these cards have no borders, no gap
// and no heights, and a geometry test against a stack of bare list items
// would be measuring something the operator never sees.
import "../../index.css";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

/*
 * Only the three calls the Titles tab makes are stubbed. The rest of the
 * module is left alone: this is a real browser loading real modules, and a
 * mock that dropped an export would break whoever else imports it.
 */
vi.mock("../../lib/mediaApi", async () => ({
  ...(await vi.importActual<typeof import("../../lib/mediaApi")>(
    "../../lib/mediaApi",
  )),
  getUserViews: async () => [],
  getVideoItemsForLibrary: async () => [],
  getPrimaryImageUrl: () => "",
}));

vi.mock("../../lib/notifications/notificationStore", () => ({
  notify: vi.fn(),
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
    queuePriority: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as ProcessingJob;
}

/**
 * One encode underway and four waiting, one of which is being held by the
 * storage guard and so carries an extra panel. That card is taller than the
 * others on purpose: a queue of identical rows would let a model that assumes
 * a fixed row height pass this suite.
 */
const QUEUE: ProcessingJob[] = [
  job({ id: "encoding", state: "running", startedAt: "2026-09-01T01:00:00Z" }),
  job({ id: "alpha", queuePriority: 100 }),
  job({
    id: "bravo",
    queuePriority: 101,
    pauseRequested: true,
    pausedReason: "storage-unavailable",
  }),
  job({ id: "charlie", queuePriority: 102 }),
  job({ id: "delta", queuePriority: 103 }),
];

function baseOverview(jobs: ProcessingJob[]): ProcessingOverview {
  return {
    jobs,
    storage: null,
    incidents: [],
    capacity: null,
    jobTitles: jobs.map((entry) => ({
      jobId: entry.id,
      kind: "movie" as const,
      title: entry.id,
    })),
  } as unknown as ProcessingOverview;
}

const WAITING = ["alpha", "bravo", "charlie", "delta"];

// -------------------------------------------------------------- helpers

function titleOf(row: HTMLElement): string {
  return within(row).getAllByText(/^[a-z]+$/)[0]?.textContent ?? "";
}

function waitingRows(): HTMLElement[] {
  return screen.getAllByRole("listitem").filter((row) => row.dataset.queueSlot);
}

/** The waiting rows in the order the queue says they are in, right now. */
function slotOrder(): string[] {
  return [...waitingRows()]
    .sort((a, b) => Number(a.dataset.queueSlot) - Number(b.dataset.queueSlot))
    .map(titleOf);
}

/** The waiting rows in the order they are actually painted, top to bottom. */
function paintedOrder(): string[] {
  return waitingRows()
    .map((row) => ({
      title: titleOf(row),
      top: row.getBoundingClientRect().top,
    }))
    .sort((a, b) => a.top - b.top)
    .map((entry) => entry.title);
}

function rowFor(title: string): HTMLElement {
  return waitingRows().find((row) => titleOf(row) === title)!;
}

function handleFor(title: string): HTMLElement {
  return within(rowFor(title)).getByRole("button", {
    name: /queueOrder.handle/,
  });
}

function centreOf(element: Element): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

function rectOf(title: string): DOMRect {
  return rowFor(title).getBoundingClientRect();
}

/** How far two rows are drawn on top of each other, in pixels. */
function overlapOf(a: string, b: string): number {
  const left = rectOf(a);
  const right = rectOf(b);
  return Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
}

/** Long enough for the reflow and the magnet to have finished moving. */
function settled() {
  return new Promise((resolve) => setTimeout(resolve, 260));
}

let Page: typeof import("./MediaProcessingPage").MediaProcessingPage;

async function openQueue() {
  await page.viewport(1400, 1000);
  render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  );
  await screen.findByText("processing.title");
  await userEvent.click(
    await screen.findByRole("tab", { name: /tabs.processes/ }),
  );
  await waitFor(() => expect(slotOrder()).toEqual(WAITING));
  // The whole queue in view, so a drag never runs into an edge and starts the
  // page scrolling underneath itself.
  rowFor("alpha").scrollIntoView({ block: "start" });
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Presses the handle of a row and moves the mouse, without letting go. */
async function pickUp(title: string, toY: number) {
  const grip = centreOf(handleFor(title));
  await commands.pointer("move", grip.x, grip.y);
  await commands.pointer("down");
  // A small first step, so the activation threshold is a threshold rather
  // than something the first event jumps straight over.
  await commands.pointer("move", grip.x, grip.y + 6);
  await commands.pointer("move", grip.x, toY);
}

beforeEach(async () => {
  overview = baseOverview(QUEUE);
  reorderProcessingQueue.mockClear();
  Page = (await import("./MediaProcessingPage")).MediaProcessingPage;
  await openQueue();
});

afterEach(async () => {
  await commands.pointer("up");
  cleanup();
});

describe("dragging a queued encode with a real mouse", () => {
  it("has built a queue of cards that are not all the same height", () => {
    // The fixture's premise, asserted rather than assumed: the card held by
    // the storage guard carries an extra panel and is taller than the rest.
    const heights = waitingRows().map(
      (row) => row.getBoundingClientRect().height,
    );
    expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights) + 8);
    expect(rowFor("bravo").getBoundingClientRect().height).toBe(
      Math.max(...heights),
    );
  });

  it("rearranges the list under the cursor and saves what it showed", async () => {
    await pickUp("alpha", centreOf(rowFor("charlie")).y);

    // Still held — and the queue already reads the way the drop will leave it.
    expect(slotOrder()).toEqual(["bravo", "charlie", "alpha", "delta"]);
    // The card settles into the slot rather than appearing in it, so this is
    // awaited: a card that arrived instantly would have had to teleport.
    await waitFor(() =>
      expect(paintedOrder()).toEqual(["bravo", "charlie", "alpha", "delta"]),
    );
    expect(reorderProcessingQueue).not.toHaveBeenCalled();

    // One card in one place: nothing was copied, so nothing is left behind.
    expect(
      waitingRows().filter((row) => titleOf(row) === "alpha"),
    ).toHaveLength(1);
    expect(rowFor("alpha").style.opacity).toBe("");

    await commands.pointer("up");
    await waitFor(() =>
      expect(reorderProcessingQueue).toHaveBeenCalledWith([
        "bravo",
        "charlie",
        "alpha",
        "delta",
      ]),
    );
    await waitFor(() =>
      expect(paintedOrder()).toEqual(["bravo", "charlie", "alpha", "delta"]),
    );
    expect(reorderProcessingQueue).toHaveBeenCalledTimes(1);
  });

  it("walks slot by slot, and back, while the button stays down", async () => {
    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");

    await commands.pointer("move", grip.x, grip.y + 8);
    expect(slotOrder()).toEqual(WAITING);

    await commands.pointer("move", grip.x, centreOf(rowFor("bravo")).y);
    expect(slotOrder()).toEqual(["bravo", "alpha", "charlie", "delta"]);

    await commands.pointer("move", grip.x, centreOf(rowFor("delta")).y);
    expect(slotOrder()).toEqual(["bravo", "charlie", "delta", "alpha"]);

    await commands.pointer("move", grip.x, grip.y + 8);
    expect(slotOrder()).toEqual(WAITING);

    await commands.pointer("up");
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });

  it("keeps the held card in the queue's own column", async () => {
    const before = centreOf(rowFor("alpha")).x;
    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");
    await commands.pointer("move", grip.x + 400, grip.y + 60);

    // The pointer went 400px to the right; the card did not follow it there.
    // It only lifts, which is symmetrical about the column it belongs to.
    expect(centreOf(rowFor("alpha")).x).toBeCloseTo(before, 0);
    await commands.pointer("up");
  });

  it("scrolls the page when the card is held against the bottom edge", async () => {
    // The queue is longer than the window, and a card dragged to the bottom of
    // it has to be able to keep going.
    expect(document.documentElement.scrollHeight).toBeGreaterThan(
      window.innerHeight,
    );
    window.scrollTo(0, 0);
    const before = window.scrollY;

    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");
    await commands.pointer("move", grip.x, grip.y + 20);
    await commands.pointer("move", grip.x, window.innerHeight - 12);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(window.scrollY).toBeGreaterThan(before);
    // ...and the card went with the page rather than being left behind by it.
    expect(slotOrder().at(-1)).toBe("alpha");
    await commands.pointer("up");
  });

  it("puts everything back when the drag is abandoned", async () => {
    await pickUp("delta", centreOf(rowFor("alpha")).y);
    expect(slotOrder()).toEqual(["delta", "alpha", "bravo", "charlie"]);

    await userEvent.keyboard("{Escape}");
    await commands.pointer("up");

    expect(slotOrder()).toEqual(WAITING);
    await waitFor(() => expect(paintedOrder()).toEqual(WAITING));
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });

  it("sits the held card in the gap the list opened for it", async () => {
    /*
     * The regression this whole change exists for. The order being previewed
     * was always right; the card was drawn wherever the pointer had dragged
     * it, so the list opened a gap in one place and the card hung in another,
     * across the title of the row below. What the operator saw was a card
     * floating over a queue rather than a card in a queue.
     */
    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");
    await commands.pointer("move", grip.x, grip.y + 8);
    await commands.pointer("move", grip.x, centreOf(rowFor("bravo")).y);
    await settled();

    expect(slotOrder()).toEqual(["bravo", "alpha", "charlie", "delta"]);

    /*
     * The card is in the space that opened between the two rows either side of
     * it, rather than somewhere between that space and the pointer. The few
     * pixels of slack are the magnet's give: the card answers the hand holding
     * it without leaving the slot.
     */
    const held = rectOf("alpha");
    expect(held.top).toBeGreaterThan(rectOf("bravo").bottom - 20);
    expect(held.bottom).toBeLessThan(rectOf("charlie").top + 20);

    // ...and so it covers no part of the cards around it that can be read.
    for (const other of ["bravo", "charlie", "delta"]) {
      expect(overlapOf("alpha", other)).toBeLessThan(20);
    }

    await commands.pointer("up");
  });

  it("keeps the held card off its neighbours all the way down the queue", async () => {
    // The same claim, made continuously rather than at one convenient stop:
    // no position of the pointer leaves the card sitting across another card's
    // text. A card crossing between two slots passes through quickly, so the
    // worst moment is still a small fraction of a card.
    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");
    await commands.pointer("move", grip.x, grip.y + 8);

    const start = grip.y;
    const span = centreOf(rowFor("delta")).y - start;
    let worst = 0;
    for (let step = 1; step <= 24; step += 1) {
      await commands.pointer("move", grip.x, start + (span * step) / 24);
      await settled();
      const held = rectOf("alpha");
      for (const other of ["bravo", "charlie", "delta"]) {
        worst = Math.max(worst, overlapOf("alpha", other));
      }
      // The card never leaves the column, and never leaves the list either.
      expect(held.height).toBeGreaterThan(0);
    }
    /*
     * The number that made this change necessary. Drawn at the bare pointer,
     * the held card sat across more than half of its neighbour at every
     * boundary — two cards' worth of statistics on top of each other. Held to
     * its slot, the worst moment of the whole gesture is a sliver of the
     * lifted card's own edge.
     */
    expect(worst).toBeLessThan(20);

    await commands.pointer("up");
  });

  it("treats a click on the handle as a click", async () => {
    await userEvent.click(handleFor("bravo"));

    expect(slotOrder()).toEqual(WAITING);
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
    // The press still puts the keyboard on the handle: the arrows move the
    // row for anybody who is not using a mouse at all.
    expect(document.activeElement).toBe(handleFor("bravo"));
  });

  it("leaves the buttons on the cards alone", async () => {
    await userEvent.click(
      within(rowFor("charlie")).getByRole("button", {
        name: "processing.inspect",
      }),
    );

    expect(slotOrder()).toEqual(WAITING);
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });
});
