import {
  BookMarked,
  Film,
  FolderTree,
  Images,
  Loader2,
  TextCursorInput,
  Tv,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { signalTasksChanged } from "../../lib/tasksChanged";
import { useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { notify } from "../../lib/notifications/notificationStore";
import {
  runLibraryMaintenance,
  type MaintenanceAcceptance,
  type MaintenanceAction,
} from "../../lib/mediaApi";
import { formatTemplate, type ActionResult } from "./libraryMaintenanceModel";

/**
 * The maintenance action group, in the order the work actually happens.
 *
 * "All in one" leads because it is the whole sequence; the six behind it are
 * the same stages on their own, for when only one of them is wanted. Renaming
 * and moving are separate entries on purpose — one changes a filename, the
 * other changes a folder, and a button that quietly did both would be the one
 * thing a person could not undo.
 */
const MAINTENANCE_BUTTONS: ReadonlyArray<{
  action: MaintenanceAction;
  labelKey: TranslationKey;
  Icon: LucideIcon;
  primary?: boolean;
}> = [
  {
    action: "all",
    labelKey: "maintenance.allInOne",
    Icon: WandSparkles,
    primary: true,
  },
  { action: "scan-movies", labelKey: "maintenance.scanMovies", Icon: Film },
  { action: "scan-shows", labelKey: "maintenance.scanShows", Icon: Tv },
  { action: "scan-books", labelKey: "maintenance.scanBooks", Icon: BookMarked },
  {
    action: "trickplay",
    labelKey: "maintenance.generateTrickplays",
    Icon: Images,
  },
  {
    action: "rename",
    labelKey: "maintenance.renameFiles",
    Icon: TextCursorInput,
  },
  { action: "organize", labelKey: "maintenance.moveFiles", Icon: FolderTree },
];

/** Actions whose reply counts libraries, and can honestly count none. */
const CATEGORY_ACTIONS: ReadonlySet<MaintenanceAction> = new Set([
  "scan-movies",
  "scan-shows",
  "scan-books",
]);

export interface LibraryMaintenanceActionsProps {
  /** Injected in tests; the real call is the admin maintenance endpoint. */
  onAccepted?: (taskIds: string[]) => void;
  run?: (action: MaintenanceAction) => Promise<MaintenanceAcceptance>;
}

export function LibraryMaintenanceActions({
  run = runLibraryMaintenance,
  onAccepted,
}: LibraryMaintenanceActionsProps) {
  const { t } = useLanguage();
  /*
   * One result per action, never one shared flag.
   *
   * These seven do different work on different libraries; a book scan has no
   * reason to grey out "Generate trickplay" while it is being accepted, and a
   * single boolean is how a page ends up unusable for the length of the
   * slowest request on it. Overlap is safe because the durable queue collapses
   * duplicate work onto the attempt already due.
   */
  const [results, setResults] = useState<
    Partial<Record<MaintenanceAction, ActionResult>>
  >({});

  const handle = async (action: MaintenanceAction) => {
    setResults((current) => ({
      ...current,
      [action]: { state: "loading", message: t("maintenance.actionStarting") },
    }));

    try {
      const accepted = await run(action);
      if (accepted.taskIds.length > 0) {
        onAccepted?.(accepted.taskIds);
        signalTasksChanged();
      }
      /*
       * "Queued", never "completed". The request returned once the durable
       * rows existed; the scan, the rename and the trickplay all happen after
       * it, and the task cards are where they are watched.
       */
      const message = CATEGORY_ACTIONS.has(action)
        ? accepted.libraries === 0
          ? t("maintenance.actionNoLibraries")
          : formatTemplate(t("maintenance.actionQueuedCount"), {
              count: accepted.libraries,
            })
        : t("maintenance.actionQueued");
      setResults((current) => ({
        ...current,
        [action]: { state: "success", message },
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("maintenance.actionFailed");
      setResults((current) => ({
        ...current,
        [action]: { state: "error", message },
      }));
      notify({
        tone: "error",
        title: t("maintenance.actionFailed"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  return (
    <>
      <div
        role="group"
        aria-label={t("maintenance.actionsLabel")}
        className="relative mt-6 flex flex-wrap gap-2"
      >
        {MAINTENANCE_BUTTONS.map(({ action, labelKey, Icon, primary }) => {
          const busy = results[action]?.state === "loading";
          return (
            <button
              key={action}
              type="button"
              onClick={() => void handle(action)}
              /* Only this action's own request disables this button. */
              disabled={busy}
              aria-busy={busy}
              className={`inline-flex min-h-11 flex-none items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 ${
                primary
                  ? "bg-[var(--accent)] text-black shadow-[0_16px_40px_var(--accent-soft)] hover:bg-[var(--accent-hover)]"
                  : "border border-white/10 bg-white/[0.06] text-white/72 hover:bg-white/10 hover:text-white"
              }`}
            >
              {busy ? (
                <Loader2 size={17} className="animate-spin" />
              ) : (
                <Icon size={17} />
              )}
              {t(labelKey)}
            </button>
          );
        })}
      </div>

      {MAINTENANCE_BUTTONS.map(({ action, labelKey }) => {
        const state = results[action];
        if (!state?.message) return null;
        return (
          <p
            key={action}
            /* Announced when it arrives: the work itself is invisible from
               here, so the acceptance is the only feedback there is. */
            role="status"
            className={`relative mt-3 rounded-2xl border px-4 py-3 text-sm font-bold ${
              state.state === "error"
                ? "border-red-400/20 bg-red-400/10 text-red-100"
                : state.state === "success"
                  ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
                  : "border-white/10 bg-white/[0.06] text-white/62"
            }`}
          >
            {`${t(labelKey)}: ${state.message}`}
          </p>
        );
      })}
    </>
  );
}
