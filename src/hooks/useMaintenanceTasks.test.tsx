/**
 * Recovering the truth after a reload, a reconnect and a slow response.
 *
 * The hook is the page's whole model of what the server is doing, so what is
 * tested here is what it refuses to do: start a second read while one is in
 * flight, keep a fresher progress record when an older one arrives late, and
 * raise a toast every two seconds because the server is restarting.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MaintenanceSnapshot } from "../lib/maintenanceApi";
import type { MaintenanceTaskDto } from "../lib/maintenance/maintenanceTasks";
import { useMaintenanceTasks } from "./useMaintenanceTasks";

/** These tests are about reconciliation, not paging; every page is empty. */
const EMPTY_PAGES = {
  active: { total: 0, offset: 0, limit: 200 },
  concluded: { total: 0, offset: 0, limit: 50 },
};

function task(
  over: Partial<MaintenanceTaskDto> & { id: string },
): MaintenanceTaskDto {
  return {
    operation: "library.scan",
    status: "running",
    reorderable: false,
    attempts: 1,
    maxAttempts: 3,
    progress: null,
    result: null,
    errorCode: null,
    queuedAt: "2026-09-06T10:00:00.000Z",
    runAfter: "2026-09-06T10:00:00.000Z",
    startedAt: "2026-09-06T10:01:00.000Z",
    finishedAt: null,
    progressAt: null,
    ...over,
  };
}

function counted(revision: number) {
  return {
    revision,
    phase: "reading" as const,
    measure: {
      kind: "counter" as const,
      counted: revision * 100,
      unit: "files" as const,
    },
    at: "2026-09-06T10:05:00.000Z",
  };
}

function Probe({
  load,
  onRefresh,
}: {
  load: () => Promise<MaintenanceSnapshot>;
  onRefresh?: (refresh: () => Promise<void>) => void;
}) {
  const state = useMaintenanceTasks({ load, poll: false });
  onRefresh?.(state.refresh);
  return (
    <div>
      <span data-testid="counted">
        {state.tasks[0]?.progress?.measure.kind === "counter"
          ? state.tasks[0].progress.measure.counted
          : ""}
      </span>
      <span data-testid="ids">
        {state.tasks.map((entry) => entry.id).join(",")}
      </span>
      <span data-testid="failed">{String(state.failed)}</span>
      <span data-testid="loading">{String(state.loading)}</span>
    </div>
  );
}

describe("reading the maintenance snapshot", () => {
  it("holds the newer counter when a slow response arrives late", async () => {
    const snapshots: MaintenanceSnapshot[] = [
      {
        tasks: [task({ id: "a", progress: counted(40) })],
        queue: [],
        pages: EMPTY_PAGES,
      },
      {
        tasks: [task({ id: "a", progress: counted(31) })],
        queue: [],
        pages: EMPTY_PAGES,
      },
    ];
    let next = 0;
    let refresh: () => Promise<void> = async () => undefined;

    render(
      <Probe
        load={async () => snapshots[Math.min(next++, snapshots.length - 1)]!}
        onRefresh={(fn) => {
          refresh = fn;
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("counted")).toHaveTextContent("4000"),
    );

    await act(async () => {
      await refresh();
    });

    // The stale snapshot's numbers are discarded; a counter that walks
    // backwards is worse than no counter at all.
    expect(screen.getByTestId("counted")).toHaveTextContent("4000");
  });

  it("never has two reads in flight at once", async () => {
    let started = 0;
    let release: (() => void) | null = null;
    let refresh: () => Promise<void> = async () => undefined;

    render(
      <Probe
        load={async () => {
          started += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { tasks: [], queue: [], pages: EMPTY_PAGES };
        }}
        onRefresh={(fn) => {
          refresh = fn;
        }}
      />,
    );

    await waitFor(() => expect(started).toBe(1));
    // A second caller joins the read already running rather than starting one.
    const joined = refresh();
    expect(started).toBe(1);

    await act(async () => {
      release?.();
      await joined;
    });
  });

  it("says a read failed without losing the snapshot it is holding", async () => {
    let broken = false;
    let refresh: () => Promise<void> = async () => undefined;

    render(
      <Probe
        load={async () => {
          if (broken) throw new Error("the server restarted");
          return { tasks: [task({ id: "a" })], queue: [], pages: EMPTY_PAGES };
        }}
        onRefresh={(fn) => {
          refresh = fn;
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("ids")).toHaveTextContent("a"),
    );

    broken = true;
    await act(async () => {
      await refresh();
    });

    expect(screen.getByTestId("failed")).toHaveTextContent("true");
    expect(screen.getByTestId("ids")).toHaveTextContent("a");

    broken = false;
    await act(async () => {
      await refresh();
    });
    expect(screen.getByTestId("failed")).toHaveTextContent("false");
  });

  it("stops reporting itself as loading once the first read lands", async () => {
    render(
      <Probe
        load={async () => ({ tasks: [], queue: [], pages: EMPTY_PAGES })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
  });

  it("recovers a task list it has never seen, which is what a reload is", async () => {
    render(
      <Probe
        load={async () => ({
          tasks: [task({ id: "a" }), task({ id: "b", status: "succeeded" })],
          queue: [],
          pages: EMPTY_PAGES,
        })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("ids")).toHaveTextContent("a,b"),
    );
  });
});

describe("polling", () => {
  it("re-reads while work is outstanding, and slows down when nothing is", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      let outstanding = true;
      function Poller() {
        useMaintenanceTasks({
          load: async () => {
            reads += 1;
            return {
              tasks: [
                task({
                  id: "a",
                  status: outstanding ? "running" : "succeeded",
                }),
              ],
              queue: [],
              pages: EMPTY_PAGES,
            };
          },
        });
        return null;
      }
      render(<Poller />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(reads).toBe(1);

      // One active beat, which is a second while anything is running.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(reads).toBe(2);

      outstanding = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      const afterIdle = reads;

      // Nothing outstanding: the fast beat stops.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(reads).toBe(afterIdle);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_100);
      });
      expect(reads).toBeGreaterThan(afterIdle);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("follows a pre-acceptance snapshot with one fresh read after invalidation", async () => {
  const { signalTasksChanged } = await import("../lib/tasksChanged");
  let finish!: (snapshot: MaintenanceSnapshot) => void;
  const load = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<MaintenanceSnapshot>((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({
      tasks: [task({ id: "fast", status: "succeeded" })],
      queue: [],
      pages: EMPTY_PAGES,
    });
  render(<Probe load={load} />);
  await act(async () => {
    signalTasksChanged();
    signalTasksChanged();
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({ tasks: [], queue: [], pages: EMPTY_PAGES });
  });
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("ids")).toHaveTextContent("fast");
});
