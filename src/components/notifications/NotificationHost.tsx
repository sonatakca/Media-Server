import { TaskDetails } from "./TaskDetails";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
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
  COLLAPSED_HEADROOM_PX,
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

/** How far a fading end reaches once something is running past it. */
const PILE_FADE_PX = 20;

/**
 * How far the column overruns each of its own ends.
 *
 * The fade has to be measured rather than assumed. An end that nothing is
 * crossing needs no fade at all, and one applied anyway is not a soft edge —
 * it is a veil over whatever happens to be last, which in this column is the
 * progress bar along the foot of the card at the front.
 *
 * Measured as geometry rather than from `scrollTop`, because a `column-reverse`
 * box does not agree with itself across browsers about which end zero is. Two
 * rectangles either overlap or they do not, everywhere.
 *
 * The answer is a length, not a flag, so an end that is nearly reached fades
 * by nearly nothing: the treatment arrives and leaves with the overrun instead
 * of switching on at some threshold.
 */
function useColumnOverrun(
  listRef: RefObject<HTMLDivElement | null>,
  signal: unknown,
): { top: number; bottom: number; remeasure: () => void } {
  const [ends, setEnds] = useState({ top: 0, bottom: 0 });
  /*
   * Held in a ref so a card can ask for a fresh reading when it stops moving
   * without every card re-subscribing each time any of them does.
   */
  const again = useRef(() => {});

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const view = list.getBoundingClientRect();
      let above = 0;
      let below = 0;
      for (const card of list.querySelectorAll("[data-card]")) {
        /*
         * A collapsed card is a row of no height with its visible strip hung
         * above it, so the row on its own would under-report where the pile
         * actually reaches.
         */
        const box = card.getBoundingClientRect();
        const strip = card.firstElementChild?.getBoundingClientRect();
        above = Math.max(
          above,
          view.top - Math.min(box.top, strip?.top ?? box.top),
        );
        below = Math.max(
          below,
          Math.max(box.bottom, strip?.bottom ?? box.bottom) - view.bottom,
        );
      }
      const next = {
        top: Math.round(Math.min(Math.max(above, 0), PILE_FADE_PX)),
        bottom: Math.round(Math.min(Math.max(below, 0), PILE_FADE_PX)),
      };
      setEnds((current) =>
        current.top === next.top && current.bottom === next.bottom
          ? current
          : next,
      );
    };
    // Coalesced: a scroll fires far more often than the answer can change.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    again.current = schedule;
    measure();
    list.addEventListener("scroll", schedule, { passive: true });
    /*
     * A card changing size without the column scrolling — one opening, or a
     * title arriving that wraps — moves the ends too. Optional because the
     * measurement above is already correct without it, and an environment
     * without a `ResizeObserver` is one without a layout to observe.
     */
    const sizes =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    sizes?.observe(list);
    for (const card of list.querySelectorAll("[data-card]"))
      sizes?.observe(card);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      list.removeEventListener("scroll", schedule);
      sizes?.disconnect();
      again.current = () => {};
    };
  }, [listRef, signal]);

  return { ...ends, remeasure: () => again.current() };
}

function NotificationCard({
  notification,
  isCollapsed,
  isColumnTop,
  isColumnBottom,
  isPaused,
  isOpen,
  onToggle,
}: {
  notification: SeyirlikNotification;
  isCollapsed: boolean;
  isColumnTop: boolean;
  isColumnBottom: boolean;
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

  /*
   * The column is one block, so a card only rounds the edge that is an end of
   * it, and only carries the hairline on the side that has no neighbour to
   * share one with. Two cards each drawing their own border made every seam
   * twice the weight of the outline around the whole thing.
   *
   * A collapsed card is not part of the run: it is a strip lying on top of it,
   * and shows its own head.
   */
  const corners = isCollapsed
    ? "rounded-t-2xl"
    : `${isColumnTop ? "rounded-t-2xl" : ""} ${isColumnBottom ? "rounded-b-2xl" : ""}`;
  const seam = isCollapsed || isColumnTop ? "" : "border-t-0";

  return (
    /*
     * No shadow here. The column it sits in is a scrolling box, which clips
     * everything its children paint outside themselves — so a shadow on a card
     * could never reach the page, only the seams between the cards and the cut
     * edge of the box, which on a light page drew a grey rectangle with a hard
     * corner. The pile is one thing that floats, so the pile casts the shadow.
     */
    <div
      className={`w-full overflow-hidden border border-white/[0.12] bg-[#0b0b10]/[0.97] backdrop-blur-xl ${corners} ${seam}`}
    >
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
          {/* Turned about its own middle, which is where the arc's circle is
              centred: the glyph is a three-quarter arc of a circle drawn at
              the centre of its box, so the default origin is already the one
              the ring lies on. Measured over a full turn at this size, the
              fitted centre of the ring moves under a fifth of a pixel and its
              radius under a thirtieth — so there is nothing here for a layer
              hint or a nudged origin to correct, and both were removed. */}
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
            <span className="mt-px shrink-0 rounded-full bg-white/10 pl-1 pr-1.5 text-[0.6875rem] font-bold leading-[1.15rem] tabular-nums text-white/70">
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
  const listRef = useRef<HTMLDivElement>(null);
  /** The card a press is about, and where its top edge was when pressed. */
  const pinned = useRef<{ id: string; top: number } | null>(null);
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

  /*
   * The card that was pressed stays where it was pressed.
   *
   * The column is anchored at its foot, so a card that grows takes the room
   * out of the top of the pile: opening one carried it up past the head of the
   * list, and the thing you had just asked to read was the thing that left the
   * view. Holding its top edge still spends the new height downwards instead,
   * which is the direction the press came from.
   *
   * Its place in the window is what is held, not its place on the page, so the
   * reading survives the column scrolling under it.
   */
  const toggleCard = (id: string) => {
    const list = listRef.current;
    const card = list?.querySelector(`[data-card-id="${id}"]`);
    pinned.current =
      list && card
        ? {
            id,
            top:
              card.getBoundingClientRect().top -
              list.getBoundingClientRect().top,
          }
        : null;
    setOpenIds((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  };
  useLayoutEffect(() => {
    const anchor = pinned.current;
    pinned.current = null;
    const list = listRef.current;
    if (!anchor || !list) return;
    const card = list.querySelector(`[data-card-id="${anchor.id}"]`);
    if (!card) return;

    const view = list.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    /*
     * Holding the anchor is the whole rule while the card still fits. When it
     * does not, holding it alone would be obeying the letter of the request
     * and losing its point: pressing the card nearest the foot spent all of
     * its new height below the edge of the window, so the press looked like it
     * had done nothing at all.
     *
     * So the card comes up — but never further than its own top edge, which is
     * the line the press was aimed at. Between those two bounds the card ends
     * up wherever it already was.
     */
    const room = Math.max(0, view.height - box.height);
    const wanted = Math.min(Math.max(anchor.top, 0), room);
    const settled = box.top - view.top;

    /*
     * Two moves, because they are two different things. Putting the card back
     * where the reflow took it from is a correction and has to be invisible,
     * so it happens now, in the same frame the layout changed. Bringing it up
     * into view is a movement the reader should see, so it is scrolled.
     */
    const correction = settled - anchor.top;
    if (Math.abs(correction) > 0.5) list.scrollTop += correction;
    const reveal = anchor.top - wanted;
    if (Math.abs(reveal) > 0.5)
      list.scrollBy({
        top: reveal,
        behavior: shouldReduceMotion ? "auto" : "smooth",
      });
  }, [openIds, shouldReduceMotion]);

  /*
   * Which ends of the column are overrun, and so which ends fade. Recomputed
   * whenever the shape of the column can have changed: a card opening, the
   * pile opening, or one arriving or leaving.
   */
  const overrun = useColumnOverrun(
    listRef,
    `${isExpanded}:${openIds.join()}:${stack.entries.length}`,
  );
  const hasPeek = stack.entries.some((entry) => entry.isCollapsed);

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
      className="pointer-events-none fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-[200] flex max-h-[calc(100dvh-7rem-env(safe-area-inset-bottom)-env(safe-area-inset-top))] flex-col-reverse items-end gap-1 sm:bottom-[max(1.5rem,env(safe-area-inset-bottom))] sm:max-h-[calc(100dvh-3rem-env(safe-area-inset-bottom)-env(safe-area-inset-top))]"
    >
      <div
        ref={liveRegion}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      ></div>
      {/*
       * The pile floats above the page, so the pile is what casts the shadow.
       *
       * It cannot be the cards: the column below is a scrolling box, and a
       * scrolling box clips whatever its children paint outside themselves. A
       * shadow on a card therefore never reached the page — it reached the
       * seams between the cards and the cut edges of the box, which on a light
       * page drew a grey rectangle with four hard corners around the whole
       * column. Out here there is nothing to clip it.
       */}
      <div className="pointer-events-none flex min-h-0 w-fit rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
        <div
          ref={listRef}
          data-notification-list
          /*
           * Four rows at most, and the rest by scrolling. The bar itself is
           * hidden: it appears and disappears with the pile, and a column
           * pinned to the right edge jumps sideways by its width every time it
           * does.
           */
          /*
           * As wide as its widest card and no wider — and every card that
           * width, because a column of cards that each sized themselves would
           * show a ragged edge in the pile behind the front one. A fixed width
           * did the opposite harm: it clipped the one thing a card exists to
           * say, and left a gulf between the title and the figure on every
           * card whose name was short.
           */
          /*
           * No gap. The cards are one block lying on each other, and the band
           * of page a gap put through every seam was the thing that made the
           * column read as a handful of separate strips. What separates them
           * now is the hairline each one carries.
           */
          style={{
            // Exactly the room the peeking cards need above the front one, and
            // none when there are none: an empty strip at the head of the
            // column is somewhere for the rounded corner and the shadow to sit
            // where no card is.
            paddingTop: hasPeek ? COLLAPSED_HEADROOM_PX : 0,
            ...(overrun.top || overrun.bottom
              ? {
                  ["--pile-fade-top" as string]: `${overrun.top}px`,
                  ["--pile-fade-bottom" as string]: `${overrun.bottom}px`,
                }
              : {}),
          }}
          className={`scrollbar-none flex min-h-0 w-fit min-w-[16rem] max-w-[min(30rem,calc(100vw-2rem-env(safe-area-inset-right)))] flex-col-reverse items-stretch overflow-y-auto overflow-x-hidden overscroll-contain ${
            /* A column that runs out of room should run out of view rather
               than be sliced through — but only at an end something is
               actually running past. */
            overrun.top || overrun.bottom ? "notification-pile-fade" : ""
          } ${isExpanded ? "pointer-events-auto max-h-[14rem]" : ""}`}
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
                data-card-id={entry.notification.id}
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
                }}
                transition={{
                  duration: shouldReduceMotion ? 0.18 : 0.34,
                  ease: [0.22, 1, 0.36, 1],
                  opacity: { duration: shouldReduceMotion ? 0.18 : 0.28 },
                }}
                /* A card arrives from below the anchor and travels up into its
                   row, overrunning the foot of the column the whole way. None
                   of that changes a size, so the column is told when the card
                   stops rather than left waiting for an observer that will
                   never fire. */
                onAnimationComplete={overrun.remeasure}
                onLayoutAnimationComplete={overrun.remeasure}
              >
                <div
                  className={
                    entry.isCollapsed
                      ? // Hung from its peek line and running *down* behind the
                        // card in front, so what shows is a strip of its top and
                        // never a band of the page under its bottom edge.
                        "pointer-events-none absolute inset-x-0 top-0 h-4 overflow-hidden rounded-t-2xl"
                      : ""
                  }
                  {...(entry.isCollapsed ? { inert: "" } : {})}
                >
                  <NotificationCard
                    notification={entry.notification}
                    isCollapsed={entry.isCollapsed}
                    isColumnTop={entry.isColumnTop}
                    isColumnBottom={entry.isColumnBottom}
                    isPaused={isPaused}
                    isOpen={openIds.includes(entry.notification.id)}
                    onToggle={() => toggleCard(entry.notification.id)}
                  />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
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
            className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/70 px-2 py-1 min-h-[1.5rem] text-[0.68rem] font-black text-white/80 backdrop-blur transition hover:border-white/25 hover:text-white/90"
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
