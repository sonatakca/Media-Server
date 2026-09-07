/**
 * Dragging a queued maintenance task, in a real browser.
 *
 * The panel reuses the processing queue's gesture wholesale — the same
 * `useQueueSortable`, the same planner — so this suite is deliberately not a
 * second copy of that one's geometry proofs. What it asserts is the wiring
 * that is new: that the maintenance rows are the ones offered to the gesture,
 * that the list rearranges under the cursor *before* the button is released,
 * that nothing is left behind in the row's old slot, and that the order the
 * screen showed is the order that reaches the server.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { commands, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MaintenanceSnapshot } from "../../lib/maintenanceApi";
import type { MaintenanceTaskDto } from "../../lib/maintenance/maintenanceTasks";

// The real stylesheet: without it these cards have no borders, no gap and no
// heights, and a geometry test against bare list items measures nothing the
// operator sees.
import "../../index.css";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

vi.mock("../../lib/notifications/notificationStore", () => ({
  notify: vi.fn(),
}));

const WAITING = ["alpha", "bravo", "charlie", "delta"];

function task(
  id: string,
  over: Partial<MaintenanceTaskDto> = {},
): MaintenanceTaskDto {
  return {
    id,
    operation: "library.scan",
    status: "queued",
    reorderable: true,
    scope: { kind: "library", label: id },
    attempts: 0,
    maxAttempts: 3,
    progress: null,
    result: null,
    errorCode: null,
    queuedAt: "2026-09-06T10:00:00.000Z",
    runAfter: "2026-09-06T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    progressAt: null,
    ...over,
  };
}

/*
 * A running row at the head, and one queued row taller than the others.
 *
 * Both are the fixture's whole point: the running row must not be draggable
 * and must not be displaced, and rows of differing height are what a drag that
 * assumes a uniform row size gets wrong.
 */
function snapshot(order: readonly string[]): MaintenanceSnapshot {
  const tasks = [
    task("running", {
      status: "running",
      reorderable: false,
      startedAt: "2026-09-06T10:01:00.000Z",
      progress: {
        revision: 1,
        phase: "reading",
        measure: { kind: "counter", counted: 4281, unit: "files" },
        at: "2026-09-06T10:02:00.000Z",
      },
    }),
    ...order.map((id) =>
      id === "bravo"
        ? task(id, {
            attempts: 2,
            runAfter: "2099-01-01T00:00:00.000Z",
            errorCode: "unavailable",
          })
        : task(id),
    ),
  ];
  return {
    tasks,
    queue: [...order],
    pages: {
      active: { total: tasks.length, offset: 0, limit: 200 },
      concluded: { total: 0, offset: 0, limit: 50 },
    },
  };
}

let order: string[] = [...WAITING];
const reorder = vi.fn(async (ids: readonly string[]) => {
  order = [...ids];
  return { moved: [...ids], queue: [...ids] };
});

let Panel: typeof import("./MaintenanceTasksPanel").MaintenanceTasksPanel;

function rowFor(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

function handleFor(id: string): HTMLElement {
  const handle = rowFor(id).querySelector<HTMLElement>(
    'button[aria-label^="maintenance.queueOrder"]',
  );
  if (!handle) throw new Error(`no handle for ${id}`);
  return handle;
}

/** The rows in the order the screen currently draws them, top to bottom. */
function paintedOrder(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-task-id]")]
    .map((row) => ({
      id: row.dataset.taskId as string,
      top: row.getBoundingClientRect().top,
    }))
    .sort((a, b) => a.top - b.top)
    .map((entry) => entry.id);
}

/** The slot numbers the rows are claiming, which is what a release would save. */
function slotOrder(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-queue-slot]")]
    .sort((a, b) => Number(a.dataset.queueSlot) - Number(b.dataset.queueSlot))
    .map((row) => row.dataset.taskId as string);
}

function centreOf(element: Element): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** Waits until a row has stopped moving, however fast the browser draws. */
async function atRest(id: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  let previous = Number.NaN;
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const top = rowFor(id).getBoundingClientRect().top;
    stable = Math.abs(top - previous) < 0.5 ? stable + 1 : 0;
    previous = top;
    if (stable >= 2) return;
  }
}

async function pickUp(id: string, toY: number) {
  const grip = centreOf(handleFor(id));
  await commands.pointer("move", grip.x, grip.y);
  await commands.pointer("down");
  // A small first step, so the activation threshold is a threshold rather than
  // something the first move jumps straight over.
  await commands.pointer("move", grip.x, grip.y + 6);
  await commands.pointer("move", grip.x, toY);
}

beforeEach(async () => {
  order = [...WAITING];
  reorder.mockClear();
  Panel = (await import("./MaintenanceTasksPanel")).MaintenanceTasksPanel;
  await page.viewport(1200, 1000);
  render(
    <Panel
      load={async () => snapshot(order)}
      reorder={reorder}
      cancel={async () => undefined}
      poll={false}
    />,
  );
  await waitFor(() => expect(slotOrder()).toEqual(WAITING));
  rowFor("running").scrollIntoView({ block: "start" });
  await new Promise((resolve) => requestAnimationFrame(resolve));
});

afterEach(async () => {
  await commands.pointer("up");
  cleanup();
});

describe("dragging a queued maintenance task with a real mouse", () => {
  it("offers a handle to the waiting rows and none to the running one", () => {
    expect(() => handleFor("running")).toThrow();
    for (const id of WAITING) expect(handleFor(id)).toBeTruthy();
  });

  it("rearranges the list under the cursor and saves what it showed", async () => {
    await pickUp("alpha", centreOf(rowFor("charlie")).y);

    // Before the button is released: the list has already made room.
    await waitFor(() =>
      expect(slotOrder()).toEqual(["bravo", "charlie", "alpha", "delta"]),
    );
    await waitFor(() =>
      expect(paintedOrder()).toEqual([
        "running",
        "bravo",
        "charlie",
        "alpha",
        "delta",
      ]),
    );

    await commands.pointer("up");
    await waitFor(() =>
      expect(reorder).toHaveBeenCalledWith([
        "bravo",
        "charlie",
        "alpha",
        "delta",
      ]),
    );
  });

  it("leaves nothing behind in the slot the row came from", async () => {
    const before = rowFor("bravo").getBoundingClientRect();
    await pickUp("alpha", centreOf(rowFor("delta")).y);
    await waitFor(() => expect(slotOrder()[0]).toBe("bravo"));

    // The row below has moved up into the gap rather than the gap being held
    // open by a ghost of the row being carried. Waited for rather than read
    // once: the slot number changes on the frame the plan does, and the rows
    // take the length of the reflow to arrive where it put them.
    await waitFor(() =>
      expect(rowFor("bravo").getBoundingClientRect().top).toBeLessThan(
        before.top - 1,
      ),
    );
    await commands.pointer("up");
  });

  it("never displaces the row that is already running", async () => {
    const before = rowFor("running").getBoundingClientRect().top;
    await pickUp("delta", centreOf(rowFor("alpha")).y);
    await waitFor(() => expect(slotOrder()[0]).toBe("delta"));
    await atRest("delta");
    expect(rowFor("running").getBoundingClientRect().top).toBeCloseTo(
      before,
      0,
    );
    await commands.pointer("up");
  });

  it("carries the whole selection when a selected row is grabbed", async () => {
    const boxes = screen.getAllByRole("checkbox");
    // alpha and charlie: rows 1 and 3 of the waiting line.
    await userEvent.click(boxes[0]!);
    await userEvent.click(boxes[2]!);

    await pickUp("alpha", centreOf(rowFor("delta")).y);
    await waitFor(() =>
      expect(slotOrder()).toEqual(["bravo", "delta", "alpha", "charlie"]),
    );

    await commands.pointer("up");
    await waitFor(() =>
      expect(reorder).toHaveBeenCalledWith([
        "bravo",
        "delta",
        "alpha",
        "charlie",
      ]),
    );
  });

  it("puts everything back when the gesture is abandoned", async () => {
    await pickUp("alpha", centreOf(rowFor("charlie")).y);
    await waitFor(() => expect(slotOrder()[0]).toBe("bravo"));

    await userEvent.keyboard("{Escape}");
    await commands.pointer("up");
    await atRest("alpha");

    await waitFor(() => expect(slotOrder()).toEqual(WAITING));
    expect(reorder).not.toHaveBeenCalled();
  });
});
