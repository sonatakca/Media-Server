import { TaskDetails } from "./TaskDetails";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Ban,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  Pause,
  X,
  XCircle,
} from "lucide-react";
import {
  NOTIFICATION_LIFETIMES_MS,
  dismissAllNotifications,
  dismissNotification,
  getNotifications,
  subscribeToNotifications,
  type NotificationTone,
  type SeyirlikNotification,
} from "../../lib/notifications/notificationStore";
import { progressPercent } from "../../lib/notifications/taskNotifications";
import {
  MAX_EXPANDED_NOTIFICATIONS,
  planNotificationStack,
} from "../../lib/notifications/notificationStack";
import { useLanguage } from "../../i18n/LanguageContext";

const TONE_ICONS: Record<NotificationTone, typeof Info | typeof CheckCircle2> =
  {
    info: Info,
    success: CheckCircle2,
    warning: AlertTriangle,
    error: XCircle,
    progress: Loader2,
  };

const TONE_ACCENTS: Record<NotificationTone, string> = {
  info: "text-sky-300",
  success: "text-emerald-300",
  warning: "text-amber-300",
  error: "text-rose-300",
  progress: "text-sky-300",
};

/** The bar wears the card's own colour, so a held encode reads as held. */
const TONE_BARS: Record<NotificationTone, string> = {
  info: "bg-sky-300",
  success: "bg-emerald-300",
  warning: "bg-amber-300",
  error: "bg-rose-300",
  progress: "bg-sky-300",
};

/**
 * Expires a notification on its own schedule.
 *
 * A timer per card rather than one sweep, so a card that arrives while another
 * is halfway through its life still gets its full time.
 */
function useExpiry(
  notification: SeyirlikNotification,
  isPaused: boolean,
): void {
  const { id, life, createdAt } = notification;

  const clock = useRef({ createdAt: -1, remaining: 0 });
  useEffect(() => {
    if (life === "persistent") return;
    if (clock.current.createdAt !== createdAt)
      clock.current = {
        createdAt,
        remaining: Math.max(
          0,
          NOTIFICATION_LIFETIMES_MS[life] - (Date.now() - createdAt),
        ),
      };
    if (isPaused) return;
    const started = Date.now();
    const timer = window.setTimeout(
      () => dismissNotification(id),
      clock.current.remaining,
    );
    return () => {
      window.clearTimeout(timer);
      clock.current.remaining = Math.max(
        0,
        clock.current.remaining - (Date.now() - started),
      );
    };
  }, [createdAt, id, isPaused, life]);
}

function NotificationCard({
  notification,
  isCollapsed,
  isPaused,
  isOpen,
  onToggle,
}: {
  notification: SeyirlikNotification;
  isCollapsed: boolean;
  isPaused: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { t, language } = useLanguage();
  useExpiry(notification, isPaused);

  const task = notification.task;
  const kind = task?.titleKey ? t(task.titleKey) : notification.title;
  const Icon =
    task?.status === "cancelled"
      ? Ban
      : task?.status === "paused"
        ? Pause
        : task?.status === "queued"
          ? Clock
          : TONE_ICONS[notification.tone];
  const accent = TONE_ACCENTS[notification.tone];
  const hasProgress =
    typeof notification.progress === "number" &&
    Number.isFinite(notification.progress) &&
    (!task ||
      ((task.status === "running" || task.status === "paused") &&
        task.determinate));
  /*
   * A tenth of a per cent, when the figure behind it is media seconds: at
   * feature length a whole per cent is a minute and a half of film, and a
   * number that only moves once a minute reads as a stalled encode. Floored
   * either way — "100%" on work that is still running is the one reading
   * somebody would act on.
   */
  const decimals = task?.encoding ? 1 : 0;
  const percent = hasProgress
    ? progressPercent(notification.progress as number, decimals)
    : undefined;
  const percentText =
    percent === undefined
      ? undefined
      : new Intl.NumberFormat(language, {
          style: "percent",
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(percent / 100);

  /*
   * What the work is about leads, because that is what tells two cards apart:
   * twelve episodes of one series all say "Media processing" and only one of
   * them is the one you are looking for. The kind of work moves into the body,
   * a line below.
   */
  const subject = task?.subject;
  const heading =
    (subject?.deleted
      ? t("tasks.deleted")
      : subject?.unnamed
        ? t("tasks.unnamed")
        : (subject?.label ?? subject?.code)) ?? kind;
  // The short form on the line; the episode's own name waits inside.
  const place = subject?.label ? subject.code : undefined;
  /*
   * A figure when there is one, and otherwise the state — except "running",
   * which the turning spinner at the head of the line has already said. The
   * word only ever took room from the name it sat beside.
   */
  const trailing =
    percentText ??
    (task && task.status !== "running" ? t(`tasks.${task.status}`) : undefined);
  const bodyId = `notification-body-${notification.id}`;

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-white/[0.12] bg-[#0b0b10]/90 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl">
      <div className="flex items-start gap-1">
        {/* The whole line is the control: one press opens it, one closes it,
            and nothing opens by being passed over with a cursor. */}
        <button
          type="button"
          // A card in the pile answers for the pile: the press that lands on it
          // reaches past it to open the stack, and never opens the card itself.
          onClick={isCollapsed ? undefined : onToggle}
          aria-expanded={isOpen}
          {...(isOpen && !isCollapsed ? { "aria-controls": bodyId } : {})}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-2xl p-3.5 text-left transition hover:bg-white/[0.04]"
        >
          <Icon
            className={`mt-0.5 h-4 w-4 shrink-0 ${accent} ${
              notification.tone === "progress" ? "motion-safe:animate-spin" : ""
            }`}
          />
          {/* One line, always: what it is about, then which part of it. The
              part gives way first when there is not room for both, and the
              whole of it is a press away. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-5">
            <span className="truncate font-bold text-white/90">{heading}</span>
            {place ? (
              <span className="shrink-0 font-semibold tabular-nums text-white/55">
                {place}
              </span>
            ) : null}
          </span>
          {/* The figure for this title first, then the line behind it: the
              percentage belongs to the name it sits beside, and reading the
              queue's count between the two made it look like part of neither. */}
          {trailing ? (
            <span
              className={`shrink-0 text-xs font-bold leading-5 tabular-nums ${
                percentText ? accent : "text-white/60"
              }`}
            >
              {trailing}
            </span>
          ) : null}
          {task?.queuedCount ? (
            <span className="mt-px shrink-0 rounded-full bg-white/10 px-1 text-[0.6875rem] font-bold leading-[1.15rem] tabular-nums text-white/70">
              {`+${new Intl.NumberFormat(language).format(task.queuedCount)}`}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          onClick={(event) => {
            // Dismissing must not also toggle the pile it sits in.
            event.stopPropagation();
            const host = event.currentTarget.closest(
              "[data-notification-host]",
            );
            const buttons = Array.from(
              host?.querySelectorAll<HTMLButtonElement>("button") ?? [],
            );
            const next = buttons.find(
              (button) =>
                button !== event.currentTarget &&
                !event.currentTarget.closest("[data-card]")?.contains(button),
            );
            if (document.activeElement === event.currentTarget)
              (next ?? (host as HTMLElement))?.focus();
            dismissNotification(notification.id);
          }}
          aria-label={t("notifications.dismiss")}
          // Still a finger wide to press, but the box it reserves on the line
          // is the glyph's, not the target's.
          className="relative m-1 mt-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/75 transition after:absolute after:-inset-1 after:content-[''] hover:bg-white/10 hover:text-white/80"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Everything the server knows, one press away. A collapsed card is a
          depth cue rather than something to read, so it never opens. Shut, it
          is not in the page at all: nothing to read out, nothing to tab into,
          and no clock ticking behind a card nobody opened. */}
      {isOpen && !isCollapsed ? (
        /*
         * Filled, but never measured. A column that sizes itself to its
         * content must take that size from the one line every card has —
         * otherwise opening a card with a long sentence inside it widens the
         * whole stack behind it.
         */
        <div id={bodyId} className="w-0 min-w-full px-3.5 pb-3.5 pl-[2.9rem]">
          {notification.description ? (
            <p className="text-xs font-semibold leading-5 text-white/75">
              {notification.description}
            </p>
          ) : null}

          {task && <TaskDetails notification={notification} />}
        </div>
      ) : null}

      {/* Along the foot of the card, in both states. How far along a job is is
          the one thing worth knowing without opening anything — and a card
          that showed it only once opened was a card that showed it never. */}
      {percent !== undefined && !isCollapsed ? (
        <div
          role="progressbar"
          aria-label={heading}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1 w-full bg-white/[0.14]"
        >
          <div
            className={`h-full ${TONE_BARS[notification.tone]} transition-[width] duration-500 ease-out motion-reduce:transition-none`}
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The notification column, anchored at the bottom right.
 *
 * Rendered once at the root and driven by a module-level store, so anything at
 * all can report — including code that is nowhere near a component.
 */
export function NotificationHost() {
  const { t, language } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const notifications = useSyncExternalStore(
    subscribeToNotifications,
    getNotifications,
    getNotifications,
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const [openIds, setOpenIds] = useState<readonly string[]>([]);
  const announced = useRef(new Map<string, string>());
  const liveRegion = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const updates: string[] = [];
    for (const entry of notifications) {
      const detail = entry.task;
      const title = detail?.titleKey ? t(detail.titleKey) : entry.title;
      const bucket =
        detail?.determinate && entry.progress !== undefined
          ? Math.floor(entry.progress / 25)
          : "";
      const signature = detail
        ? `${detail.status}:${detail.stage ?? ""}:${detail.attempts}:${bucket}`
        : `${entry.title}:${entry.description ?? ""}`;
      if (announced.current.get(entry.id) === signature) continue;
      announced.current.set(entry.id, signature);
      /*
       * Read out the way the card is read: which title, which episode, then
       * what is being done to it. A screen reader hearing "Media processing.
       * Queued." twelve times over is the same failure as seeing it.
       */
      const named = [
        detail?.subject?.label,
        detail?.subject?.code,
        detail?.subject?.detail,
      ]
        .filter(Boolean)
        .join(", ");
      const name = named ? `${named}. ${title}` : title;
      updates.push(
        detail
          ? `${name}. ${t(`tasks.${detail.status}`)}${detail.stage ? `. ${t(`tasks.${detail.stage}`)}` : ""}${bucket !== "" ? `. ${new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(progressPercent(entry.progress ?? 0) / 100)}` : ""}`
          : `${entry.title}. ${entry.description ?? ""}`,
      );
    }
    // Cards that are gone can never be announced again; keeping their
    // signatures would only grow a map for the life of the tab.
    if (announced.current.size > notifications.length)
      for (const id of announced.current.keys())
        if (!notifications.some((entry) => entry.id === id))
          announced.current.delete(id);
    if (updates.length && liveRegion.current)
      liveRegion.current.textContent = updates.join(". ");
  }, [notifications, t, language]);

  const overflowCount = Math.max(
    0,
    notifications.length - MAX_EXPANDED_NOTIFICATIONS,
  );

  // Nothing left to open means nothing left to close; otherwise the control
  // would linger after the pile it belonged to had drained away.
  if (overflowCount === 0 && isExpanded) setIsExpanded(false);

  const stack = useMemo(
    () =>
      planNotificationStack(
        notifications,
        isExpanded ? notifications.length : MAX_EXPANDED_NOTIFICATIONS,
      ),
    [isExpanded, notifications],
  );

  // Reading the pile takes longer than four seconds, so nothing expires while
  // it is open — otherwise cards would vanish from under the cursor.
  const isPaused = isExpanded || isInteracting || openIds.length > 0;

  return (
    <div
      data-notification-host
      tabIndex={-1}
      onFocusCapture={() => setIsInteracting(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setIsInteracting(false);
      }}
      onMouseEnter={() => setIsInteracting(true)}
      onMouseLeave={(event) =>
        setIsInteracting(event.currentTarget.contains(document.activeElement))
      }
      className="pointer-events-none fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-[200] flex max-h-[calc(100dvh-7rem-env(safe-area-inset-bottom)-env(safe-area-inset-top))] flex-col-reverse items-end gap-2 sm:bottom-[max(1.5rem,env(safe-area-inset-bottom))] sm:max-h-[calc(100dvh-3rem-env(safe-area-inset-bottom)-env(safe-area-inset-top))]"
    >
      <div
        ref={liveRegion}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      ></div>
      <div
        data-notification-list
        /*
         * Four rows at most, and the rest by scrolling. The bar itself is
         * hidden: it appears and disappears with the pile, and a column pinned
         * to the right edge jumps sideways by its width every time it does.
         */
        /*
         * As wide as its widest card and no wider — and every card that width,
         * because a column of cards that each sized themselves would show a
         * ragged edge in the pile behind the front one. A fixed width did the
         * opposite harm: it clipped the one thing a card exists to say, and
         * left a gulf between the title and the figure on every card whose
         * name was short.
         */
        className={`scrollbar-none flex min-h-0 w-fit min-w-[16rem] max-w-[min(30rem,calc(100vw-2rem-env(safe-area-inset-right)))] flex-col-reverse items-stretch gap-2 overflow-y-auto overflow-x-hidden overscroll-contain pt-5 ${
          isExpanded ? "pointer-events-auto max-h-[14rem]" : ""
        }`}
      >
        <AnimatePresence initial={false}>
          {stack.entries.map((entry) => (
            <motion.div
              key={entry.notification.id}
              /*
               * Position only. A card that opens changes size, and animating
               * size means animating a scale — which stretches every glyph
               * inside it on the way there and squashes them on the way back.
               * The box takes its new size at once; what animates is where the
               * cards around it sit.
               */
              layout={shouldReduceMotion ? false : "position"}
              style={{ zIndex: entry.zIndex }}
              data-card
              aria-hidden={entry.isCollapsed || undefined}
              className="pointer-events-auto relative shrink-0"
              onClick={
                entry.isCollapsed ? () => setIsExpanded(true) : undefined
              }
              // Movement is skipped when motion is reduced, but the fade stays:
              // appearing and disappearing without one is what reads as a
              // glitch rather than as a change.
              initial={{
                opacity: 0,
                y: shouldReduceMotion ? 0 : 16,
                x: shouldReduceMotion ? 0 : 16,
                scale: shouldReduceMotion ? 1 : 0.94,
              }}
              animate={{
                opacity: entry.opacity,
                x: 0,
                y: entry.offsetY,
                scale: shouldReduceMotion ? 1 : entry.scale,
                // Collapsed cards overlap the one in front instead of taking a
                // row of their own.
                height: entry.isCollapsed ? 0 : "auto",
                marginBottom: entry.isCollapsed ? -8 : 0,
              }}
              /*
               * A card on its way out gives its row back as it goes. Fading in
               * place and then vanishing is what made the controls above the
               * column sit still through the whole animation and then jump.
               */
              exit={{
                opacity: 0,
                y: shouldReduceMotion ? 0 : 10,
                x: shouldReduceMotion ? 0 : 24,
                scale: shouldReduceMotion ? 1 : 0.94,
                height: 0,
                marginBottom: -8,
              }}
              transition={{
                duration: shouldReduceMotion ? 0.18 : 0.34,
                ease: [0.22, 1, 0.36, 1],
                opacity: { duration: shouldReduceMotion ? 0.18 : 0.28 },
              }}
            >
              <div
                className={
                  entry.isCollapsed
                    ? "pointer-events-none absolute inset-x-0 bottom-0 h-4 overflow-hidden rounded-t-2xl"
                    : ""
                }
                {...(entry.isCollapsed ? { inert: "" } : {})}
              >
                <NotificationCard
                  notification={entry.notification}
                  isCollapsed={entry.isCollapsed}
                  isPaused={isPaused}
                  isOpen={openIds.includes(entry.notification.id)}
                  onToggle={() =>
                    setOpenIds((current) =>
                      current.includes(entry.notification.id)
                        ? current.filter((id) => id !== entry.notification.id)
                        : [...current, entry.notification.id],
                    )
                  }
                />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {overflowCount > 0 || isExpanded ? (
        <div className="pointer-events-auto flex items-center gap-1.5">
          {isExpanded ? (
            <button
              type="button"
              onClick={(event) => {
                (
                  event.currentTarget.closest(
                    "[data-notification-host]",
                  ) as HTMLElement
                )?.focus();
                dismissAllNotifications();
              }}
              className="rounded-full border border-white/10 bg-black/70 px-3 py-2 min-h-11 text-[0.68rem] font-black text-white/75 backdrop-blur transition hover:border-white/25 hover:text-white/85"
            >
              {t("notifications.dismissAll")}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            aria-expanded={isExpanded}
            className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/70 px-3 py-2 min-h-11 text-[0.68rem] font-black text-white/80 backdrop-blur transition hover:border-white/25 hover:text-white/90"
          >
            {isExpanded ? (
              <>
                <ChevronDown className="h-3 w-3" />
                {t("notifications.showLess")}
              </>
            ) : (
              <>
                <ChevronUp className="h-3 w-3" />
                {t("notifications.more").replace(
                  "{count}",
                  new Intl.NumberFormat(language).format(overflowCount),
                )}
              </>
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}
