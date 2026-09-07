import { subscribeTasksChanged } from "../lib/tasksChanged";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getMaintenanceTasks,
  MAINTENANCE_ACTIVE_PAGE_SIZE,
  MAINTENANCE_HISTORY_PAGE_SIZE,
  type MaintenancePage,
  type MaintenanceSnapshot,
} from "../lib/maintenanceApi";
import {
  isConcluded,
  type MaintenanceTaskDto,
} from "../lib/maintenance/maintenanceTasks";
import { mergeSnapshot } from "../lib/maintenance/maintenanceView";

/**
 * The Library Scan task list, kept current from the server's own snapshot.
 *
 * Polled rather than streamed, and deliberately so: the page needs the whole
 * queue including its order and its history, the queue is small, and one
 * canonical read is the only thing that survives a reload, a reconnect and a
 * second browser reordering the line. There is no event channel to fall behind
 * and no client-side store pretending to be the database — what is on screen
 * is a read of the queue, at most one poll old.
 *
 * Exactly one request is in flight at a time. That is what makes the ordering
 * safe without a sequence number: two snapshots cannot cross, so a slow
 * response can never overwrite a newer one.
 */

/*
 * While something is running or waiting, the queue is worth re-reading often.
 *
 * The same beat the notification cards run at, deliberately: two surfaces
 * reading the same rows at different rates show different numbers for the same
 * job, and no amount of agreeing on how to round fixes a reading that is a
 * second older than the one beside it.
 */
const ACTIVE_POLL_MS = 1_000;
/** With nothing outstanding, a slower beat is enough to notice new work. */
const IDLE_POLL_MS = 10_000;

export interface MaintenanceTasksState {
  tasks: MaintenanceTaskDto[];
  /** The waiting rows in the order the worker will claim them. */
  queue: string[];
  /**
   * How much there is, per tab, whatever this page happens to hold.
   *
   * The counts a tab labels itself with come from here rather than from the
   * length of `tasks`: a page of fifty out of eight hundred would otherwise
   * report fifty, which is the page size rather than an answer.
   */
  pages: { active: MaintenancePage; concluded: MaintenancePage };
  loading: boolean;
  /** True once a read has failed and no newer one has succeeded. */
  failed: boolean;
  refreshedAt: number | null;
  refresh: () => Promise<void>;
}

const EMPTY_PAGES = {
  active: { total: 0, offset: 0, limit: MAINTENANCE_ACTIVE_PAGE_SIZE },
  concluded: { total: 0, offset: 0, limit: MAINTENANCE_HISTORY_PAGE_SIZE },
};

export function useMaintenanceTasks(options?: {
  /** Injected in tests; the real call is the admin snapshot endpoint. */
  load?: () => Promise<MaintenanceSnapshot>;
  taskIds?: readonly string[];
  /** Off in tests that assert one render of one snapshot. */
  poll?: boolean;
  /** Which page of each tab to read. Changing either re-reads immediately. */
  activeOffset?: number;
  historyOffset?: number;
}): MaintenanceTasksState {
  const idsKey = (options?.taskIds ?? []).join(",");
  const activeOffset = options?.activeOffset ?? 0;
  const historyOffset = options?.historyOffset ?? 0;
  const load =
    options?.load ??
    (() =>
      getMaintenanceTasks({
        taskIds: options?.taskIds ?? [],
        activeOffset,
        historyOffset,
      }));
  const poll = options?.poll ?? true;

  const [tasks, setTasks] = useState<MaintenanceTaskDto[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [pages, setPages] = useState(EMPTY_PAGES);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  /** The read currently in flight, so callers join it rather than start another. */
  const inFlightRef = useRef<Promise<void> | null>(null);
  /** The callback below, so it can re-enter itself once a read has settled. */
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    const request = (async () => {
      do {
        dirtyRef.current = false;
        try {
          const snapshot = await loadRef.current();
          if (!mountedRef.current) return;
          /*
           * The arriving snapshot replaces what was held, except for a progress
           * record of the same attempt whose revision is higher than the one
           * arriving. See `mergeSnapshot`.
           */
          setTasks((held) => mergeSnapshot(held, snapshot.tasks));
          setQueue(snapshot.queue);
          if (snapshot.pages) setPages(snapshot.pages);
          setFailed(false);
          setRefreshedAt(Date.now());
        } catch {
          // Kept quiet rather than raised as a toast: this runs on a timer, and
          // a server restart would otherwise stack a notification every beat.
          if (mountedRef.current) setFailed(true);
        } finally {
          if (mountedRef.current) setLoading(false);
        }
      } while (dirtyRef.current && mountedRef.current);
    })();
    inFlightRef.current = request;
    await request.finally(() => {
      if (inFlightRef.current === request) inFlightRef.current = null;
      // Also cover an invalidation queued between the loop settling and this
      // promise cleanup. Joining an already-resolved read must not lose it.
      // Reached through the ref rather than by name: this is the callback
      // calling itself, and a direct reference would read its own binding
      // before it is initialised.
      if (dirtyRef.current && mountedRef.current) void refreshRef.current?.();
    });
  }, []);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  const invalidate = useCallback(() => {
    // A GET begun before acceptance may already hold an old DB snapshot.
    // Coalesce invalidations, but always read again after that request settles.
    dirtyRef.current = true;
    void refresh();
  }, [refresh]);
  useEffect(() => subscribeTasksChanged(invalidate), [invalidate]);
  useEffect(() => {
    if (idsKey) invalidate();
  }, [idsKey, invalidate]);
  /*
   * A page change is a different read, not a later one, so it does not wait for
   * the poll: the operator clicked "next" and the list has to follow.
   */
  const pagedOnce = useRef(false);
  useEffect(() => {
    if (!pagedOnce.current) {
      pagedOnce.current = true;
      return;
    }
    invalidate();
  }, [activeOffset, historyOffset, invalidate]);

  const outstanding = tasks.some((task) => !isConcluded(task));

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(
      () => void refresh(),
      outstanding ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );
    /*
     * A tab that was hidden while a scan finished is a tab holding a snapshot
     * from before it did. Re-reading on the way back is cheaper than polling
     * fast enough to have caught it.
     */
    const whenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", whenVisible);
    window.addEventListener("focus", whenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", whenVisible);
      window.removeEventListener("focus", whenVisible);
    };
  }, [outstanding, poll, refresh]);

  return { tasks, queue, pages, loading, failed, refreshedAt, refresh };
}
