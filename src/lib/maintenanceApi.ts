import { ownApiClient } from "../api/ownApi/client";
import type { MaintenanceTaskDto } from "./maintenance/maintenanceTasks";

/**
 * The Library Maintenance task surface, as the browser sees it.
 *
 * Two calls and one shape. The snapshot is the whole truth about what the
 * server is doing, read in one request so the page can never show a running
 * list and a history that were fetched a second apart; the reorder answers with
 * the line the server actually holds rather than with the line it was asked
 * for.
 */

/**
 * What one tab is showing, and how much there is.
 *
 * `total` is the count of everything that matches, not the length of this page
 * — it is the number the tab labels itself with, and the reason it is here at
 * all is that the two used to be the same figure and were therefore both wrong
 * whenever the list was longer than a page.
 */
export interface MaintenancePage {
  total: number;
  offset: number;
  limit: number;
}

export interface MaintenanceSnapshot {
  tasks: MaintenanceTaskDto[];
  /** The waiting rows, in the order the worker will claim them. */
  queue: string[];
  pages: { active: MaintenancePage; concluded: MaintenancePage };
}

export interface MaintenanceTaskQuery {
  /** Concluded rows per page, and how far into them to start. */
  history?: number;
  historyOffset?: number;
  /** Running and waiting rows per page, and how far into them to start. */
  active?: number;
  activeOffset?: number;
  taskIds?: readonly string[];
}

/** What the server assumes when a caller names neither page size. */
export const MAINTENANCE_HISTORY_PAGE_SIZE = 50;
export const MAINTENANCE_ACTIVE_PAGE_SIZE = 200;

const EMPTY_PAGE: MaintenancePage = { total: 0, offset: 0, limit: 0 };

export async function getMaintenanceTasks(
  options: MaintenanceTaskQuery = {},
): Promise<MaintenanceSnapshot> {
  const ids = [...new Set(options.taskIds ?? [])];
  const tasks = new Map<string, MaintenanceTaskDto>();
  let queue: string[] = [];
  let pages = { active: EMPTY_PAGE, concluded: EMPTY_PAGE };
  // Bound each exact-ID read, even for an action spanning many libraries.
  for (let offset = 0; offset < Math.max(1, ids.length); offset += 100) {
    const query = new URLSearchParams();
    /*
     * A first page asks for exactly what it always asked for.
     *
     * Zero is the server's own default for both offsets, so sending it would
     * add query string to every ordinary read while naming the behaviour that
     * read already had — a different URL for an identical request.
     */
    for (const [key, value] of [
      ["history", options.history],
      ["historyOffset", options.historyOffset || undefined],
      ["active", options.active],
      ["activeOffset", options.activeOffset || undefined],
    ] as const) {
      if (value !== undefined) query.set(key, String(value));
    }
    if (ids.length)
      query.set("include", ids.slice(offset, offset + 100).join(","));
    const snapshot = await ownApiClient.request<MaintenanceSnapshot>(
      `/admin/maintenance/tasks${query.size ? `?${query}` : ""}`,
    );
    for (const task of snapshot.tasks) tasks.set(task.id, task);
    queue = snapshot.queue;
    if (snapshot.pages) pages = snapshot.pages;
  }
  return { tasks: [...tasks.values()], queue, pages };
}

/**
 * Rewrites the order of the waiting maintenance jobs.
 *
 * The whole order is sent, never a single move: two people dragging at once
 * would otherwise each get back a queue neither of them arranged. `moved` names
 * the rows the server genuinely repositioned — a job claimed by a worker
 * between the drag and the drop comes back absent from it rather than being
 * silently reported as moved — and `queue` is the line to reconcile against.
 */
export function reorderMaintenanceQueue(
  taskIds: readonly string[],
): Promise<{ moved: string[]; queue: string[] }> {
  return ownApiClient.request<{ moved: string[]; queue: string[] }>(
    "/admin/maintenance/queue/order",
    { method: "POST", body: { taskIds: [...taskIds] } },
  );
}

export function cancelMaintenanceTask(taskId: string): Promise<void> {
  return ownApiClient
    .request<void>(`/admin/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      body: {},
    })
    .then(() => undefined);
}
