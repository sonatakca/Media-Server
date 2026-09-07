import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  GripVertical,
  Loader2,
  ListChecks,
  RefreshCw,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatTemplate } from "../../lib/format";
import { notify } from "../../lib/notifications/notificationStore";
import {
  cancelMaintenanceTask,
  reorderMaintenanceQueue,
  type MaintenanceSnapshot,
} from "../../lib/maintenanceApi";
import {
  isConcluded,
  lifecycleOf,
} from "../../lib/maintenance/maintenanceTasks";
import {
  MAINTENANCE_OUTCOME_TABS,
  applyOrderOverride,
  canReorderTask,
  elapsedSeconds,
  moveBlock,
  moveItem,
  partitionMaintenanceTasks,
  type MaintenanceOutcomeTab,
} from "../../lib/maintenance/maintenanceView";
import { useMaintenanceTasks } from "../../hooks/useMaintenanceTasks";
import { formatDuration } from "./processingModel";
import { MaintenanceTaskDetails } from "./MaintenanceTaskDetails";
import {
  activityOf,
  headlineOf,
  lifecycleLabel,
  measureText,
  outcomeLabel,
  overallOf,
  percentOf,
  toneOf,
  type TaskTone,
} from "./maintenanceTaskPresentation";
import { useQueueSortable } from "./useQueueSortable";

/**
 * What the server is actually doing, and what it has done.
 *
 * The panel reads one canonical snapshot and renders it. There is no local
 * store of tasks that outlives a reload, no progress synthesised from a timer,
 * and nothing on a row that the executor did not write — a task whose stage
 * has no denominator gets a count and no bar, and the absence is the message.
 */

const CARD = "rounded-2xl border border-white/10 bg-white/[0.03] p-4";
/** The elapsed clocks tick locally; the data behind them still comes from a poll. */
const CLOCK_TICK_MS = 1_000;

const TONE_BADGE: Record<TaskTone, string> = {
  running: "border-[var(--accent)] bg-[var(--accent)]/12 text-[var(--accent)]",
  waiting: "border-white/30 bg-white/[0.06] text-white/55",
  good: "border-emerald-400 bg-emerald-400/10 text-emerald-100",
  warn: "border-amber-400 bg-amber-400/10 text-amber-100",
  bad: "border-red-400 bg-red-400/10 text-red-100",
  muted: "border-white bg-white/[0.04] text-white/40",
};

export interface MaintenanceTasksPanelProps {
  acceptedIds?: readonly string[];
  /** Injected in tests; the real calls are the admin maintenance endpoints. */
  load?: () => Promise<MaintenanceSnapshot>;
  reorder?: (taskIds: readonly string[]) => Promise<{
    moved: string[];
    queue: string[];
  }>;
  cancel?: (taskId: string) => Promise<void>;
  poll?: boolean;
  /** Frozen in tests so an elapsed clock is not a source of flake. */
  now?: () => number;
}

export function MaintenanceTasksPanel({
  load,
  acceptedIds,
  reorder = reorderMaintenanceQueue,
  cancel = cancelMaintenanceTask,
  poll,
  now,
}: MaintenanceTasksPanelProps = {}) {
  const { t } = useLanguage();
  /*
   * One offset per tab, kept apart so paging into the history and coming back
   * does not land the running list somewhere the operator never scrolled to.
   */
  const [activeOffset, setActiveOffset] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);

  const { tasks, pages, loading, failed, refresh } = useMaintenanceTasks({
    ...(load ? { load } : {}),
    ...(acceptedIds ? { taskIds: acceptedIds } : {}),
    ...(poll === undefined ? {} : { poll }),
    activeOffset,
    historyOffset,
  });

  const [outcomeTab, setOutcomeTab] = useState<MaintenanceOutcomeTab>("active");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  /** The order the operator last committed, held until the server confirms it. */
  const [queueOverride, setQueueOverride] = useState<string[] | null>(null);
  /** The order the list is pinned to for the length of a gesture. */
  const [dragFreeze, setDragFreeze] = useState<string[] | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);

  const clock = now ?? Date.now;
  const [nowMs, setNowMs] = useState(() => clock());
  useEffect(() => {
    if (now) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [now]);

  const { active, concluded } = useMemo(
    () => partitionMaintenanceTasks(tasks),
    [tasks],
  );

  /*
   * The optimistic order stops being applied the moment it stops being useful:
   * either the server has confirmed it, or the queue is no longer the same set
   * of rows and the override describes a line that does not exist. Derived
   * during the render rather than cleared from an effect, so there is never a
   * frame in which a superseded arrangement is on screen — and comparing the
   * server's answer rather than trusting the request is what keeps a rejected
   * reorder from leaving an order the worker will not follow.
   */
  const effectiveOverride = useMemo(() => {
    if (!queueOverride) return null;
    const confirmed = active.filter(canReorderTask).map((task) => task.id);
    const sameLength = confirmed.length === queueOverride.length;
    const sameOrder =
      sameLength && confirmed.every((id, index) => id === queueOverride[index]);
    const sameSet =
      sameLength && confirmed.every((id) => queueOverride.includes(id));
    return sameOrder || !sameSet ? null : queueOverride;
  }, [active, queueOverride]);

  /*
   * The running half, with the operator's own arrangement laid over the
   * server's. The freeze goes on top of the override so a poll landing inside
   * a gesture cannot move the ground under the pointer.
   */
  const activeOrdered = useMemo(
    () =>
      applyOrderOverride(
        applyOrderOverride(active, effectiveOverride),
        dragFreeze,
      ),
    [active, dragFreeze, effectiveOverride],
  );
  const movable = useMemo(
    () => activeOrdered.filter(canReorderTask),
    [activeOrdered],
  );
  const movableIds = useMemo(() => movable.map((task) => task.id), [movable]);
  const visible = outcomeTab === "active" ? activeOrdered : concluded;

  /** How many tasks share each run, so a row can say it belongs to one. */
  const runSizes = useMemo(() => {
    const sizes = new Map<string, number>();
    for (const task of tasks) {
      if (!task.runId) continue;
      sizes.set(task.runId, (sizes.get(task.runId) ?? 0) + 1);
    }
    return sizes;
  }, [tasks]);

  const commitOrder = useCallback(
    async (orderedIds: string[]) => {
      setQueueOverride(orderedIds);
      setReorderBusy(true);
      try {
        const answer = await reorder(orderedIds);
        /*
         * The server's own line, not the one that was asked for. A row claimed
         * by a worker between the drag and the drop comes back absent from
         * `moved`, and the queue it returns is the arrangement to reconcile
         * against.
         */
        setQueueOverride(answer.queue.length > 0 ? answer.queue : null);
      } catch (error) {
        // The override goes immediately on a refusal: leaving it up would show
        // an order the worker is not going to follow, which is worse than the
        // row visibly springing back.
        setQueueOverride(null);
        notify({
          tone: "error",
          title:
            error instanceof Error
              ? error.message
              : t("maintenance.queueOrder.failed"),
        });
      } finally {
        setReorderBusy(false);
        await refresh();
      }
    },
    [refresh, reorder, t],
  );

  const sortable = useQueueSortable({
    ids: movableIds,
    disabled: reorderBusy,
    onDragStart: setDragFreeze,
    onDragEnd: () => setDragFreeze(null),
    onCommit: (orderedIds) => void commitOrder(orderedIds),
  });

  /*
   * A queue that changed shape underneath the gesture — the head of the line
   * claimed by a worker, a task cancelled from another tab — no longer matches
   * the geometry the drag was measured against. Ending it puts the row back
   * where the server says it is rather than dropping it into a slot that moved.
   */
  const cancelDrag = sortable.cancel;
  useEffect(() => {
    if (!dragFreeze) return;
    const waiting = new Set(
      active.filter(canReorderTask).map((task) => task.id),
    );
    const intact =
      waiting.size === dragFreeze.length &&
      dragFreeze.every((id) => waiting.has(id));
    if (!intact) cancelDrag();
  }, [active, cancelDrag, dragFreeze]);

  /*
   * The selection, kept honest against a queue that moves on its own.
   *
   * A ticked task that has since been claimed is no longer something a group
   * move can carry. Rather than pruning the stored set from an effect, every
   * read of the selection goes through the movable ids first — so a stale
   * entry is inert by construction and cannot be sent to the server in an
   * order it would refuse.
   */
  const selectedInOrder = useMemo(
    () => movableIds.filter((id) => selectedIds.has(id)),
    [movableIds, selectedIds],
  );

  const toggleSelection = useCallback((taskId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(taskId)) next.add(taskId);
      return next;
    });
  }, []);

  /**
   * The rows a press should carry: the selection when the row is part of it,
   * and the row alone when it is not. Grabbing an unticked row is the ordinary
   * single-row drag and must keep working while a selection is standing.
   */
  const blockFor = useCallback(
    (taskId: string) =>
      selectedIds.has(taskId) && selectedInOrder.length > 1
        ? selectedInOrder
        : undefined,
    [selectedIds, selectedInOrder],
  );

  const nudge = useCallback(
    (taskId: string, delta: -1 | 1) => {
      if (reorderBusy) return;
      const from = movableIds.indexOf(taskId);
      if (from < 0) return;
      const to = from + delta;
      if (to < 0 || to >= movableIds.length) return;
      void commitOrder(moveItem(movableIds, from, to));
    },
    [commitOrder, movableIds, reorderBusy],
  );

  const sendTo = useCallback(
    (edge: "front" | "back") => {
      if (selectedInOrder.length === 0) return;
      const arranged = moveBlock(movableIds, selectedInOrder, edge);
      if (arranged.every((id, index) => id === movableIds[index])) return;
      void commitOrder(arranged);
    },
    [commitOrder, movableIds, selectedInOrder],
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      setCancellingId(taskId);
      try {
        await cancel(taskId);
      } catch (error) {
        notify({
          tone: "error",
          title:
            error instanceof Error
              ? error.message
              : t("maintenance.tasks.cancelFailed"),
        });
      } finally {
        setCancellingId(null);
        await refresh();
      }
    },
    [cancel, refresh, t],
  );

  /*
   * The figure on each tab is what the server counted, not what this page
   * happens to be holding. They were the same thing while everything fitted in
   * one read; they stopped being the same the first time a library produced
   * more than fifty concluded jobs, and the tab has been under-reporting since.
   */
  const counts = {
    active: pages.active.total,
    concluded: pages.concluded.total,
  };
  const page = outcomeTab === "active" ? pages.active : pages.concluded;
  const pageOffset = outcomeTab === "active" ? activeOffset : historyOffset;
  const setPageOffset =
    outcomeTab === "active" ? setActiveOffset : setHistoryOffset;
  const pageCount = Math.max(
    1,
    Math.ceil(page.total / Math.max(1, page.limit)),
  );
  const pageNumber = Math.floor(pageOffset / Math.max(1, page.limit)) + 1;

  return (
    <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
          <ListChecks size={15} />
          {t("maintenance.tasks.title")}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black text-white/60 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          {t("maintenance.tasks.refresh")}
        </button>
      </div>

      <div
        role="tablist"
        aria-label={t("maintenance.tasks.label")}
        className="mt-4 inline-flex rounded-2xl border border-white/10 bg-white/[0.04] p-1"
      >
        {MAINTENANCE_OUTCOME_TABS.map((tab) => {
          const selected = outcomeTab === tab;
          return (
            <button
              key={tab}
              id={`maintenance-outcome-${tab}`}
              type="button"
              role="tab"
              aria-controls={`maintenance-outcome-panel-${tab}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setOutcomeTab(tab)}
              className={`rounded-xl px-3.5 py-1.5 text-xs font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                selected
                  ? "bg-[var(--accent)] text-black"
                  : "text-white/50 hover:text-white"
              }`}
            >
              {formatTemplate(
                t(
                  tab === "active"
                    ? "maintenance.tasks.activeCount"
                    : "maintenance.tasks.concludedCount",
                ),
                { count: counts[tab] },
              )}
            </button>
          );
        })}
      </div>

      {failed ? (
        <p
          role="status"
          className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm font-bold text-amber-100"
        >
          {t("maintenance.tasks.failed")}
        </p>
      ) : null}

      {/*
       * The selection's controls, on a line of their own and only once there
       * is more than one waiting row to arrange.
       */}
      {outcomeTab === "active" && movableIds.length > 1 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setSelectedIds(
                selectedInOrder.length === movableIds.length
                  ? new Set()
                  : new Set(movableIds),
              )
            }
            className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black text-white/60 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {t(
              selectedInOrder.length === movableIds.length
                ? "maintenance.queueOrder.clear"
                : "maintenance.queueOrder.selectAll",
            )}
          </button>
          {selectedInOrder.length > 0 ? (
            <>
              <span className="text-xs font-black text-white/45">
                {formatTemplate(t("maintenance.queueOrder.selectedCount"), {
                  count: selectedInOrder.length,
                })}
              </span>
              <button
                type="button"
                onClick={() => sendTo("front")}
                className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black text-white/60 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {t("maintenance.queueOrder.front")}
              </button>
              <button
                type="button"
                onClick={() => sendTo("back")}
                className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-black text-white/60 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {t("maintenance.queueOrder.back")}
              </button>
              <span className="text-xs font-semibold text-white/30">
                {t("maintenance.queueOrder.hint")}
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div
          id={`maintenance-outcome-panel-${outcomeTab}`}
          role="tabpanel"
          aria-labelledby={`maintenance-outcome-${outcomeTab}`}
          className="mt-4 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center"
        >
          <p className="text-sm font-black text-white/60">
            {t(
              loading
                ? "maintenance.tasks.loading"
                : outcomeTab === "active"
                  ? "maintenance.tasks.emptyActive"
                  : "maintenance.tasks.emptyConcluded",
            )}
          </p>
          {!loading ? (
            <p className="mt-1 text-xs font-semibold text-white/35">
              {t(
                outcomeTab === "active"
                  ? "maintenance.tasks.emptyActiveHint"
                  : "maintenance.tasks.emptyConcludedHint",
              )}
            </p>
          ) : null}
        </div>
      ) : (
        /*
         * The panel is the wrapper rather than the list itself: a `ul` carrying
         * `role="tabpanel"` stops being a list, and every row inside it stops
         * being a list item.
         */
        <div
          id={`maintenance-outcome-panel-${outcomeTab}`}
          role="tabpanel"
          aria-labelledby={`maintenance-outcome-${outcomeTab}`}
          className="mt-4"
        >
          <ul className="flex flex-col gap-2">
            {visible.map((task) => {
              const headline = headlineOf(task, t);
              const lifecycle = lifecycleOf(task, nowMs);
              const tone = toneOf(task, nowMs);
              const overall = overallOf(task);
              const percent = percentOf(overall);
              const measure = measureText(overall, t);
              const outcome = outcomeLabel(task, t);
              const elapsed = elapsedSeconds(task, nowMs);
              const draggable = outcomeTab === "active" && canReorderTask(task);
              /*
               * The number on the row is the number the drop would give it.
               * Reading it from the drag's own preview rather than from the
               * saved queue is what stops the badges disagreeing with the
               * order under the cursor.
               */
              const position = draggable
                ? (sortable.previewOrder ?? movableIds).indexOf(task.id) + 1
                : 0;
              const held = draggable && sortable.isActive(task.id);
              const lifted =
                held || (draggable && sortable.isSettling(task.id));
              const selected = draggable && selectedIds.has(task.id);
              const expanded = expandedId === task.id;
              const title = headline.scope
                ? `${headline.operation} · ${headline.scope}`
                : headline.operation;

              return (
                <li
                  key={task.id}
                  ref={draggable ? sortable.registerRow(task.id) : undefined}
                  style={draggable ? sortable.rowStyle(task.id) : undefined}
                  data-task-id={task.id}
                  data-queue-slot={draggable ? position : undefined}
                  className={`${CARD} ${
                    lifted
                      ? "border-white/25 shadow-[0_20px_45px_-18px_rgba(0,0,0,0.9)]"
                      : selected
                        ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.04]"
                        : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    {draggable ? (
                      <label className="-m-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleSelection(task.id)}
                          aria-label={formatTemplate(
                            t("maintenance.queueOrder.select"),
                            { title },
                          )}
                          className={`h-5 w-5 cursor-pointer appearance-none rounded-full border-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                            selected
                              ? "border-[var(--accent)] bg-[var(--accent)] shadow-[inset_0_0_0_3px_rgba(0,0,0,0.6)]"
                              : "border-white/25 bg-transparent hover:border-white/50"
                          }`}
                        />
                      </label>
                    ) : null}
                    {draggable ? (
                      <button
                        type="button"
                        aria-label={
                          selected && selectedInOrder.length > 1
                            ? formatTemplate(
                                t("maintenance.queueOrder.groupHandle"),
                                { count: selectedInOrder.length, title },
                              )
                            : formatTemplate(
                                t("maintenance.queueOrder.handle"),
                                {
                                  title,
                                  position,
                                  total: movableIds.length,
                                },
                              )
                        }
                        title={t("maintenance.queueOrder.hint")}
                        onPointerDown={(event) =>
                          sortable.startDrag(event, task.id, blockFor(task.id))
                        }
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp") {
                            event.preventDefault();
                            nudge(task.id, -1);
                          } else if (event.key === "ArrowDown") {
                            event.preventDefault();
                            nudge(task.id, 1);
                          }
                        }}
                        className={`inline-flex h-9 w-9 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-lg border text-white/35 transition-colors hover:bg-white/[0.08] hover:text-white/70 active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                          held
                            ? "cursor-grabbing border-white/25 bg-white/[0.1] text-white/80"
                            : "border-white/10"
                        }`}
                      >
                        <GripVertical size={18} aria-hidden="true" />
                      </button>
                    ) : null}

                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-black text-white">
                        {headline.operation}
                      </span>
                      {headline.scope ? (
                        <span className="truncate text-[11px] font-semibold text-white/45">
                          {headline.scope}
                        </span>
                      ) : null}
                    </span>

                    {draggable ? (
                      <span className="shrink-0 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white/45">
                        {formatTemplate(t("maintenance.queueOrder.position"), {
                          position,
                        })}
                      </span>
                    ) : null}

                    <span
                      className={`shrink-0 rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em] ${TONE_BADGE[tone]}`}
                    >
                      {lifecycleLabel(lifecycle, t)}
                    </span>

                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : task.id)}
                      aria-expanded={expanded}
                      aria-label={formatTemplate(
                        t(
                          expanded
                            ? "maintenance.tasks.collapse"
                            : "maintenance.tasks.expand",
                        ),
                        { title },
                      )}
                      className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-black text-white/50 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      {t(
                        expanded
                          ? "maintenance.tasks.hideDetails"
                          : "maintenance.tasks.details",
                      )}
                      <ChevronDown
                        size={14}
                        aria-hidden="true"
                        className={
                          expanded ? "rotate-180 transition" : "transition"
                        }
                      />
                    </button>

                    {!isConcluded(task) ? (
                      <button
                        type="button"
                        onClick={() => void cancelTask(task.id)}
                        disabled={cancellingId === task.id}
                        className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-black text-white/50 transition hover:bg-red-400/10 hover:text-red-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        {cancellingId === task.id ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : null}
                        {t(
                          cancellingId === task.id
                            ? "maintenance.tasks.cancelling"
                            : "maintenance.tasks.cancel",
                        )}
                      </button>
                    ) : null}
                  </div>

                  {/*
                   * The line the operator reads at a glance: what the worker
                   * says it is doing, what it has counted, and how long it has
                   * been at it. Nothing on it is derived from a clock.
                   */}
                  <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-white/60">
                      {activityOf(task, t, nowMs)}
                    </span>
                    {measure ? (
                      <span className="shrink-0 text-[12px] font-black tabular-nums text-white/75">
                        {measure}
                      </span>
                    ) : null}
                    {/*
                     * A percentage exists only where the executor wrote both
                     * halves of a fraction. There is deliberately no fallback.
                     */}
                    {percent !== null ? (
                      <span className="shrink-0 text-[12px] font-black tabular-nums text-[var(--accent)]">
                        {percent}%
                      </span>
                    ) : null}
                    {elapsed !== null ? (
                      <span className="shrink-0 text-[11px] font-bold tabular-nums text-white/35">
                        {formatTemplate(t("maintenance.timing.elapsedValue"), {
                          value: formatDuration(elapsed),
                        })}
                      </span>
                    ) : null}
                    {outcome ? (
                      <span className="shrink-0 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] font-bold text-white/50">
                        {outcome}
                      </span>
                    ) : null}
                  </div>

                  {percent !== null ? (
                    <div
                      className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.08]"
                      role="progressbar"
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={title}
                    >
                      <div
                        className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  ) : null}

                  {expanded ? (
                    <MaintenanceTaskDetails
                      task={task}
                      runSize={task.runId ? (runSizes.get(task.runId) ?? 0) : 0}
                      nowMs={nowMs}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/*
       * The pager, shown only when there is more than one page of this tab.
       *
       * Both lists used to end wherever their limit did — fifty concluded rows,
       * two hundred running ones — with nothing on screen to say that anything
       * followed. What is under the list now is the whole extent of it: which
       * page this is, how many there are, and the range these rows occupy.
       */}
      {pageCount > 1 ? (
        <nav
          aria-label={t("maintenance.tasks.pagerLabel")}
          className="mt-3 flex flex-wrap items-center justify-between gap-3"
        >
          <p className="text-xs font-semibold text-white/35">
            {formatTemplate(t("maintenance.tasks.pageRange"), {
              from: page.total === 0 ? 0 : pageOffset + 1,
              to: Math.min(page.total, pageOffset + visible.length),
              total: page.total,
            })}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setPageOffset(Math.max(0, pageOffset - page.limit))
              }
              disabled={pageOffset === 0}
              className="inline-flex h-9 items-center rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[11px] font-black text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-white/[0.04] disabled:hover:text-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {t("maintenance.tasks.previousPage")}
            </button>
            <span className="text-xs font-black text-white/50">
              {formatTemplate(t("maintenance.tasks.pageOf"), {
                page: pageNumber,
                pages: pageCount,
              })}
            </span>
            <button
              type="button"
              onClick={() => setPageOffset(pageOffset + page.limit)}
              disabled={pageNumber >= pageCount}
              className="inline-flex h-9 items-center rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[11px] font-black text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-white/[0.04] disabled:hover:text-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {t("maintenance.tasks.nextPage")}
            </button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}
