/**
 * The Library Scan task viewer, rendered through the real panel.
 *
 * The claims under test are the ones an operator can see and the ones the
 * whole feature exists for: the panel is split into what is happening and what
 * happened; a task with a real fraction shows a percentage; a task without one
 * shows a count and *no* percentage anywhere on the row; the details are what
 * the server said and nothing more; and an order the server refuses does not
 * stay on screen.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translations } from "../../i18n/translations";
import type { MaintenanceSnapshot } from "../../lib/maintenanceApi";
import type {
  MaintenanceProgress,
  MaintenanceTaskDto,
} from "../../lib/maintenance/maintenanceTasks";
import { MaintenanceTasksPanel } from "./MaintenanceTasksPanel";

const notify = vi.fn();
vi.mock("../../lib/notifications/notificationStore", () => ({
  notify: (...args: unknown[]) => notify(...(args as [])),
}));

/*
 * The real English table. A key-echoing stub would let a row whose label is a
 * missing key pass, and half of what this panel does is choose the right word
 * for a phase, a unit and an outcome.
 */
const translate = (key: string) =>
  (translations.en as Record<string, string>)[key] ?? key;
const language = { t: translate, language: "en" } as const;

vi.mock("../../i18n/LanguageContext", () => ({ useLanguage: () => language }));

const en = translations.en as Record<string, string>;
const NOW = Date.parse("2026-09-06T10:10:00.000Z");
const now = () => NOW;

function progress(
  over: Partial<MaintenanceProgress> = {},
): MaintenanceProgress {
  return {
    revision: 1,
    phase: "reading",
    measure: { kind: "indeterminate" },
    at: "2026-09-06T10:09:00.000Z",
    ...over,
  };
}

function task(
  over: Partial<MaintenanceTaskDto> & { id: string },
): MaintenanceTaskDto {
  return {
    operation: "library.scan",
    status: "queued",
    reorderable: over.status === undefined || over.status === "queued",
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

function snapshot(tasks: MaintenanceTaskDto[]): MaintenanceSnapshot {
  const active = tasks.filter(
    (entry) => entry.status === "queued" || entry.status === "running",
  ).length;
  return {
    tasks,
    queue: tasks.filter((entry) => entry.reorderable).map((entry) => entry.id),
    // One page holding everything, which is what these fixtures are.
    pages: {
      active: { total: active, offset: 0, limit: 200 },
      concluded: { total: tasks.length - active, offset: 0, limit: 50 },
    },
  };
}

function mount(
  tasks: MaintenanceTaskDto[],
  overrides: {
    reorder?: (ids: readonly string[]) => Promise<{
      moved: string[];
      queue: string[];
    }>;
    load?: () => Promise<MaintenanceSnapshot>;
  } = {},
) {
  const reorder =
    overrides.reorder ??
    vi.fn(async (ids: readonly string[]) => ({
      moved: [...ids],
      queue: [...ids],
    }));
  render(
    <MaintenanceTasksPanel
      load={overrides.load ?? (async () => snapshot(tasks))}
      reorder={reorder}
      cancel={async () => undefined}
      poll={false}
      now={now}
    />,
  );
  return { reorder };
}

function rows(): HTMLElement[] {
  return screen.getAllByRole("listitem");
}

beforeEach(() => {
  notify.mockClear();
});

describe("what the viewer shows", () => {
  it("separates what is happening from what happened", async () => {
    mount([
      task({ id: "a", status: "running", reorderable: false }),
      task({ id: "b" }),
      task({
        id: "c",
        status: "succeeded",
        reorderable: false,
        finishedAt: "2026-09-06T10:05:00.000Z",
      }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      screen.getByRole("tab", { name: /In progress \(2\)/ }),
    ).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("tab", { name: /Concluded \(1\)/ }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute("data-task-id", "c");
  });

  it("numbers the waiting rows in the order the worker will claim them", async () => {
    mount([
      task({ id: "running", status: "running", reorderable: false }),
      task({ id: "a", queuePosition: 1 }),
      task({ id: "b", queuePosition: 2 }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((row) => row.getAttribute("data-queue-slot"))).toEqual([
      null,
      "1",
      "2",
    ]);
  });

  it("shows a percentage for a task with a real fraction", async () => {
    mount([
      task({
        id: "a",
        status: "running",
        reorderable: false,
        startedAt: "2026-09-06T10:01:00.000Z",
        progress: progress({
          phase: "analysing",
          measure: { kind: "exact", completed: 37, total: 100, unit: "files" },
        }),
      }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0]!;
    expect(within(row).getByText("37 / 100 files")).toBeInTheDocument();
    expect(within(row).getByText("37%")).toBeInTheDocument();
    expect(within(row).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "37",
    );
  });

  it("shows a count and no percentage at all when the total is unknown", async () => {
    mount([
      task({
        id: "a",
        status: "running",
        reorderable: false,
        startedAt: "2026-09-06T10:01:00.000Z",
        progress: progress({
          measure: { kind: "counter", counted: 4_281, unit: "files" },
        }),
      }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0]!;
    expect(within(row).getByText("4,281 files")).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/\d+%/);
    expect(within(row).queryByRole("progressbar")).toBeNull();
  });

  it("shows no percentage for a task that has reported nothing", async () => {
    mount([task({ id: "a", status: "running", reorderable: false })]);

    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0]!;
    expect(row.textContent).not.toMatch(/\d+%/);
    /*
     * "Running" twice on purpose: once as the status badge, once as the
     * activity line, because falling back to the lifecycle is more truthful
     * than inventing a sentence about what the worker is doing.
     */
    expect(
      within(row).getAllByText(en["maintenance.lifecycle.running"]!),
    ).toHaveLength(2);
  });

  it("says what the worker is working on, in the worker's own words", async () => {
    mount([
      task({
        id: "a",
        status: "running",
        reorderable: false,
        progress: progress({
          phase: "analysing",
          current: { label: "Interstellar" },
        }),
      }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(
      screen.getByText(`${en["maintenance.phase.analysing"]} · Interstellar`),
    ).toBeInTheDocument();
  });

  it("keeps a partial failure visibly different from a clean success", async () => {
    mount([
      task({
        id: "a",
        status: "succeeded",
        reorderable: false,
        finishedAt: "2026-09-06T10:05:00.000Z",
        result: {
          counters: { moved: 997, movesFailed: 3 },
          failures: [
            {
              phase: "moving",
              reason: "permission-denied",
              subject: { label: "Dune" },
            },
          ],
          outcome: "completed-with-failures",
        },
      }),
    ]);

    await userEvent.click(screen.getByRole("tab", { name: /Concluded/ }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(
      screen.getByText(en["maintenance.outcome.completed-with-failures"]!),
    ).toBeInTheDocument();
  });

  it("has an empty state for each half", async () => {
    mount([]);
    await waitFor(() =>
      expect(
        screen.getByText(en["maintenance.tasks.emptyActive"]!),
      ).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("tab", { name: /Concluded/ }));
    expect(
      screen.getByText(en["maintenance.tasks.emptyConcluded"]!),
    ).toBeInTheDocument();
  });

  it("says so when the snapshot could not be read", async () => {
    mount([], {
      load: async () => {
        throw new Error("no server");
      },
    });

    await waitFor(() =>
      expect(
        screen.getByText(en["maintenance.tasks.failed"]!),
      ).toBeInTheDocument(),
    );
  });
});

describe("the details of one task", () => {
  it("shows identity, timing, counters and failures on demand", async () => {
    mount([
      task({
        id: "11111111-1111-4111-8111-111111111111",
        operation: "library.organize",
        status: "succeeded",
        reorderable: false,
        runId: "22222222-2222-4222-8222-222222222222",
        startedAt: "2026-09-06T10:01:00.000Z",
        finishedAt: "2026-09-06T10:06:00.000Z",
        result: {
          counters: { moved: 900, movesFailed: 3 },
          failures: [
            {
              phase: "moving",
              reason: "destination-exists",
              subject: { label: "Dune" },
            },
          ],
          outcome: "completed-with-failures",
        },
      }),
    ]);

    await userEvent.click(screen.getByRole("tab", { name: /Concluded/ }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    // Calm first: the diagnostics are not on the row.
    expect(
      screen.queryByText("11111111-1111-4111-8111-111111111111"),
    ).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Show details/ }));

    expect(
      screen.getByText("11111111-1111-4111-8111-111111111111"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("22222222-2222-4222-8222-222222222222"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(en["maintenance.counter.moved"]!),
    ).toBeInTheDocument();
    expect(screen.getByText("900")).toBeInTheDocument();
    expect(
      screen.getByText(
        `Dune — ${en["maintenance.reason.destination-exists"]} (${en["maintenance.phase.moving"]})`,
      ),
    ).toBeInTheDocument();
  });

  it("translates the failure rather than forwarding server prose", async () => {
    mount([
      task({
        id: "a",
        status: "failed",
        reorderable: false,
        errorCode: "library-deleted",
        finishedAt: "2026-09-06T10:05:00.000Z",
      }),
    ]);

    await userEvent.click(screen.getByRole("tab", { name: /Concluded/ }));
    await userEvent.click(screen.getByRole("button", { name: /Show details/ }));

    expect(
      screen.getByText(en["maintenance.error.library-deleted"]!),
    ).toBeInTheDocument();
  });

  it("renders no field it has nothing to put in", async () => {
    mount([task({ id: "a" })]);

    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /Show details/ }));

    // A queued task has no start, no finish and no counters; none of those
    // labels appear rather than appearing beside a dash.
    expect(screen.queryByText(en["maintenance.timing.startedAt"]!)).toBeNull();
    expect(screen.queryByText(en["maintenance.timing.finishedAt"]!)).toBeNull();
    expect(screen.queryByText(en["maintenance.detail.counters"]!)).toBeNull();
    expect(
      screen.getByText(en["maintenance.timing.queuedAt"]!),
    ).toBeInTheDocument();
  });
});

describe("arranging the waiting line", () => {
  it("moves a row with the keyboard and sends the whole order", async () => {
    const { reorder } = mount([
      task({ id: "a" }),
      task({ id: "b" }),
      task({ id: "c" }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(3));
    const handle = within(rows()[0]!).getByRole("button", { name: /Move/ });
    handle.focus();
    await userEvent.keyboard("{ArrowDown}");

    await waitFor(() => expect(reorder).toHaveBeenCalledWith(["b", "a", "c"]));
  });

  it("refuses to move a row off either end", async () => {
    const { reorder } = mount([task({ id: "a" }), task({ id: "b" })]);

    await waitFor(() => expect(rows()).toHaveLength(2));
    within(rows()[0]!).getByRole("button", { name: /Move/ }).focus();
    await userEvent.keyboard("{ArrowUp}");
    within(rows()[1]!).getByRole("button", { name: /Move/ }).focus();
    await userEvent.keyboard("{ArrowDown}");

    expect(reorder).not.toHaveBeenCalled();
  });

  it("offers no handle for a running row and none for a concluded one", async () => {
    mount([
      task({ id: "running", status: "running", reorderable: false }),
      task({ id: "a" }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      within(rows()[0]!).queryByRole("button", { name: /Move/ }),
    ).toBeNull();
    expect(
      within(rows()[1]!).getByRole("button", { name: /Move/ }),
    ).toBeInTheDocument();
  });

  it("puts the row back when the server refuses the order", async () => {
    const reorder = vi.fn(async () => {
      throw new Error("the queue moved on");
    });
    mount([task({ id: "a" }), task({ id: "b" })], { reorder });

    await waitFor(() => expect(rows()).toHaveLength(2));
    within(rows()[0]!).getByRole("button", { name: /Move/ }).focus();
    await userEvent.keyboard("{ArrowDown}");

    await waitFor(() => expect(notify).toHaveBeenCalled());
    // The server's own order is what is on screen, not the rejected one.
    await waitFor(() =>
      expect(rows().map((row) => row.getAttribute("data-task-id"))).toEqual([
        "a",
        "b",
      ]),
    );
  });

  it("applies the order the server answers with, not the one it was asked for", async () => {
    // The head of the line was claimed between the drag and the drop, so the
    // server moved only what it could.
    const reorder = vi.fn(async () => ({
      moved: ["b"],
      queue: ["b", "a"],
    }));
    mount([task({ id: "a" }), task({ id: "b" })], { reorder });

    await waitFor(() => expect(rows()).toHaveLength(2));
    within(rows()[1]!).getByRole("button", { name: /Move/ }).focus();
    await userEvent.keyboard("{ArrowUp}");

    await waitFor(() =>
      expect(rows().map((row) => row.getAttribute("data-task-id"))).toEqual([
        "b",
        "a",
      ]),
    );
  });
});

describe("selecting several waiting tasks", () => {
  it("ticks and unticks a row, and counts the selection", async () => {
    mount([task({ id: "a" }), task({ id: "b" })]);

    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("selects every waiting row and then clears them", async () => {
    mount([
      task({ id: "running", status: "running", reorderable: false }),
      task({ id: "a" }),
      task({ id: "b" }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(3));
    await userEvent.click(
      screen.getByRole("button", {
        name: en["maintenance.queueOrder.selectAll"],
      }),
    );
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: en["maintenance.queueOrder.clear"] }),
    );
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("sends the selected block to the front as one contiguous run", async () => {
    const { reorder } = mount([
      task({ id: "a" }),
      task({ id: "b" }),
      task({ id: "c" }),
      task({ id: "d" }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(4));
    const boxes = screen.getAllByRole("checkbox");
    await userEvent.click(boxes[1]!);
    await userEvent.click(boxes[3]!);
    await userEvent.click(
      screen.getByRole("button", { name: en["maintenance.queueOrder.front"] }),
    );

    await waitFor(() =>
      expect(reorder).toHaveBeenCalledWith(["b", "d", "a", "c"]),
    );
  });

  it("sends the selected block to the back as one contiguous run", async () => {
    const { reorder } = mount([
      task({ id: "a" }),
      task({ id: "b" }),
      task({ id: "c" }),
    ]);

    await waitFor(() => expect(rows()).toHaveLength(3));
    await userEvent.click(screen.getAllByRole("checkbox")[0]!);
    await userEvent.click(
      screen.getByRole("button", { name: en["maintenance.queueOrder.back"] }),
    );

    await waitFor(() => expect(reorder).toHaveBeenCalledWith(["b", "c", "a"]));
  });

  it("offers no tick to a row that cannot be moved", async () => {
    mount([task({ id: "running", status: "running", reorderable: false })]);

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
