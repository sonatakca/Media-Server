import { TaskDetails } from "./TaskDetails";
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  CornerUpRight,
  Ban,
  ChevronDown,
  ChevronUp,
  Info,
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
import { resolveNotificationAccent } from "../../lib/notifications/notificationAccent";
import {
  COLLAPSED_HEADROOM_PX,
  MAX_EXPANDED_NOTIFICATIONS,
  planNotificationStack,
} from "../../lib/notifications/notificationStack";
import {
  BOTTOM_CHROME_MOTION,
  getBottomChrome,
  subscribeToBottomChrome,
} from "../../lib/layout/bottomChrome";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatTemplate } from "../../lib/format";

/**
 * A spinner whose painted weight stays centred throughout a rotation.
 *
 * A single nearly-complete arc is geometrically centred, but its missing
 * segment moves the glyph's visual centre around the box as it turns. These
 * two opposed arcs carry the same amount of ink on both sides of the centre,
 * so the notification icon reads as stationary while it spins.
 */
function BalancedSpinner({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true" data-notification-spinner>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="block h-full w-full"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          pathLength="360"
          strokeDasharray="140 40 140 40"
          className="notification-spinner-ring"
        />
      </svg>
    </span>
  );
}

const TONE_ICONS: Record<
  NotificationTone,
  typeof Info | typeof BalancedSpinner
> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  progress: BalancedSpinner,
};

/*
 * Colour comes from `resolveNotificationAccent`, which reads the ramp off the
 * logo: warm for the two states a person has to act on, and the cool run for
 * healthy work, stepped by how far through the pipeline the job is. Both the
 * glyph and the bar along the foot take the same value, so a card is one
 * colour rather than a collection of them.
 */

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
  /**
   * The cards the column is actually made of, by id.
   *
   * A card on its way out is still in the DOM — `AnimatePresence` holds it for
   * the length of its exit — and it leaves by sliding *down*, past the foot of
   * the column. Counted as part of the column's extent, it reports an overrun
   * that is nothing of the sort, and the fade that answers it lies over the
   * one thing at that end: the progress bar along the foot of the card in
   * front. So the bar disappeared for as long as the departing row took to go,
   * and came back when it went — a bar that blinks off every time anything
   * leaves the pile. A row that is leaving is not somewhere the column reaches.
   */
  present: RefObject<ReadonlySet<string>>,
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
        if (
          card instanceof HTMLElement &&
          card.dataset.cardId !== undefined &&
          !present.current?.has(card.dataset.cardId)
        )
          continue;
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
      /*
       * A box with nothing to scroll is running past nothing.
       *
       * The rectangles above are read from live geometry, and live geometry
       * during an animation includes the animation: a card being projected
       * into its new row, or one folding to no height, dips a pixel or two
       * past the end of a column that is at that moment not scrollable at all.
       * That was enough to switch the fade on for the length of the fold — and
       * a fade at this end lies over the progress bar along the foot of the
       * front card, so the bar washed out for a fifth of a second every time
       * the pile was folded and came back once the movement stopped.
       *
       * Asked of the box rather than of its children: whether anything is
       * clipped is a property of the scroll container, and no transform on a
       * child can make an unscrollable box scroll.
       */
      const scrollable = list.scrollHeight - list.clientHeight > 1;
      const next = scrollable
        ? {
            top: Math.round(Math.min(Math.max(above, 0), PILE_FADE_PX)),
            bottom: Math.round(Math.min(Math.max(below, 0), PILE_FADE_PX)),
          }
        : { top: 0, bottom: 0 };
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
  }, [listRef, signal, present]);

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
  reduceMotion,
  onDetailAnimationUpdate,
  onDetailAnimationComplete,
}: {
  notification: SeyirlikNotification;
  isCollapsed: boolean;
  isColumnTop: boolean;
  isColumnBottom: boolean;
  isPaused: boolean;
  isOpen: boolean;
  onToggle: () => void;
  reduceMotion: boolean;
  onDetailAnimationUpdate: (id: string) => void;
  onDetailAnimationComplete: (id: string) => void;
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
          ? CornerUpRight
          : TONE_ICONS[notification.tone];
  const accent = resolveNotificationAccent(notification.tone, task?.type);
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
  const detail = (
    <div id={bodyId} className="w-0 min-w-full px-3.5 pb-3.5 pl-[2.9rem]">
      {notification.description ? (
        <p className="text-xs font-semibold leading-5 text-white/75">
          {notification.description}
        </p>
      ) : null}

      {task && <TaskDetails notification={notification} />}
    </div>
  );

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
      style={{ "--notification-accent": accent } as React.CSSProperties}
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
          {/* Opposed dashes keep the painted weight centred. Their phase moves
              around a fixed circle instead of rotating any element because
              Safari's zoomed compositor shifts transformed geometry. */}
          {/* The glyph carries its job's colour, and nothing else on the card
              does: it is the one thing that has to be recognised down a
              column, not a surface to light up. */}
          <Icon
            className={`mt-0.5 h-4 w-4 shrink-0 text-[color:var(--notification-accent)] ${
              notification.tone === "progress" ? "block" : ""
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
          {/*
           * The figure, and nothing else, at the end of the line.
           *
           * The waiting line's count used to stand here beside it. It took the
           * room the title needed — the one name in the pile long enough to
           * matter was the one cut short — and it moved the percentage left by
           * its own width, so no two cards put their figures in the same place
           * and the column could not be read down. It is a fact about the
           * queue rather than about this title, so it now sits with the
           * controls that are also about the queue.
           */}
          {trailing ? (
            <span
              className={`min-w-[2.5rem] shrink-0 text-right text-xs font-bold leading-5 tabular-nums ${
                percentText ? accent : "text-white/60"
              }`}
            >
              {trailing}
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

      {/* Everything the server knows, one press away. Its height changes
          continuously, while the text inside stays at its natural scale. */}
      <AnimatePresence initial={false}>
        {isOpen && !isCollapsed ? (
          <motion.div
            key="notification-detail"
            data-notification-detail
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: {
                duration: reduceMotion ? 0 : 0.4,
                ease: [0.22, 1, 0.36, 1],
              },
              opacity: { duration: reduceMotion ? 0 : 0.2 },
            }}
            className="overflow-hidden"
            onUpdate={() => onDetailAnimationUpdate(notification.id)}
            onAnimationComplete={() =>
              onDetailAnimationComplete(notification.id)
            }
          >
            {/* Filled, but never measured. The column takes its width from the
                one-line header, so detail cannot widen the pile. */}
            {detail}
          </motion.div>
        ) : null}
      </AnimatePresence>

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
            className="h-full bg-[color:var(--notification-accent)] transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** How long the pile takes to fold its rows away, and to unfold them. */
const PILE_CLOSE_S = 0.2;
const PILE_OPEN_S = 0.34;
/** The rows are unmounted a beat after they have finished folding. */
const PILE_UNMOUNT_MS = 220;
/** Below this, the pile is the width it already was — a rounding, or a reflow. */
const PILE_WIDTH_EPSILON_PX = 1;
/**
 * How long the pin may keep asking the column whether it agrees yet.
 *
 * Longer than the exit it is waiting on, and short enough that a column which
 * never agrees is not held at a stale width for anything a person would notice.
 */
const PILE_PIN_SETTLE_MS = 600;

/**
 * How much of the page the opened pile may stand in.
 *
 * Half of it while it is a list of headlines, which is as much as a column of
 * one-line cards can fill and still leave the view it reports on readable.
 * Reading one of them is a different request: a card opened for its detail
 * may take the pile to three quarters, and no further — past that the pile
 * has become the page rather than a report on it.
 */
const PILE_VIEWPORT = "50dvh";
const PILE_DETAIL_VIEWPORT = "75dvh";

/** Below this, the lift did not really change — a rounding, or a resync. */
const LANE_EPSILON_PX = 1;

/**
 * Lifts the pile clear of chrome that has claimed the bottom-right corner, and
 * sets it back down when the corner is free again.
 *
 * The pile is laid out on `--notification-lane-floor` — where it stands with
 * nothing in front of it — and never moves off it. What travels is a
 * transform, from wherever it currently is to however far above the floor the
 * standing claim reaches (`lib/layout/bottomChrome`).
 *
 * Animating to a target rather than easing the lane itself is what keeps this
 * still. The lane is a `max()`, and a `transition` on a `max()` length freezes
 * the property outright in WebKit — it computes a transition it then never
 * advances. Replaying the jump as a transform instead works, but only if the
 * transform is on the element the same frame the jump lands, and a motion
 * value is written to the DOM on the next one: the pile flashes at its new
 * layout position before the replay puts it back. Off a fixed floor there is
 * no jump to replay and no frame to lose — the layout position never changes,
 * and the transform simply runs from where it is to where it should be.
 *
 * Interruptible by construction, since the target is absolute: a control that
 * leaves and comes straight back turns the pile around from wherever it had
 * got to rather than restarting it.
 */
function useLaneTravel(
  hostRef: RefObject<HTMLDivElement | null>,
  reduceMotion: boolean,
): ReturnType<typeof useMotionValue<number>> {
  const lift = useMotionValue(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    /*
     * How far above its floor the pile has to stand, as a transform: negative
     * because it travels up the screen, and never positive, since chrome
     * shorter than the floor is already cleared.
     *
     * The floor is read off the element rather than tracked, so a breakpoint
     * or a safe-area change needs no bookkeeping, and it is read as a used
     * value, which no transform on the element can disturb.
     */
    const targetLift = () =>
      -Math.max(
        0,
        getBottomChrome() -
          (Number.parseFloat(window.getComputedStyle(host).bottom) || 0),
      );

    let travel: { stop: () => void } | undefined;

    const settle = (animated: boolean) => {
      const target = targetLift();
      if (Math.abs(target - lift.get()) < LANE_EPSILON_PX) return;

      travel?.stop();
      if (!animated || reduceMotion) {
        lift.set(target);
        return;
      }
      travel = animate(lift, target, {
        duration: BOTTOM_CHROME_MOTION.durationS,
        delay: BOTTOM_CHROME_MOTION.delayS,
        ease: BOTTOM_CHROME_MOTION.ease,
      });
    };

    // A pile that mounts into an occupied corner belongs above it already;
    // there was nothing on screen for it to travel.
    settle(false);

    const onLaneChange = () => settle(true);
    /*
     * A resize moves the floor under the pile — it steps at the `sm`
     * breakpoint — but that is the viewport changing shape, not the corner
     * changing hands, and it has no movement of its own to keep time with.
     */
    const onResize = () => settle(false);

    const unsubscribe = subscribeToBottomChrome(onLaneChange);
    window.addEventListener("resize", onResize);
    return () => {
      unsubscribe();
      window.removeEventListener("resize", onResize);
      travel?.stop();
    };
    // Resubscribing when the motion preference changes costs one measurement,
    // and the preference changes about once a year.
  }, [hostRef, lift, reduceMotion]);

  return lift;
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
  const [isPileClosing, setIsPileClosing] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const [openIds, setOpenIds] = useState<readonly string[]>([]);
  const [expandedDetailHeight, setExpandedDetailHeight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const pileWidthTravel = useRef<{ stop: () => void } | undefined>(undefined);
  /** Where the pile stood when the press landed, and what will remain of it. */
  const pileWidthFrom = useRef<{ width: number; keepId?: string } | null>(null);
  /*
   * Written straight to the element rather than through a render. The pin is
   * a property of the box for the length of one gesture, nothing else on the
   * card reads it, and React never set `width` here — so it is neither state
   * the component has to carry nor a style React will take back.
   */
  /** A frame we are waiting on to try lifting the pin again. */
  const pileWidthSettle = useRef<number | undefined>(undefined);
  const stopPileWidthSettle = useCallback(() => {
    if (pileWidthSettle.current !== undefined)
      cancelAnimationFrame(pileWidthSettle.current);
    pileWidthSettle.current = undefined;
  }, []);
  /*
   * The pin comes off when taking it off changes nothing, and not before.
   *
   * It used to come off on an event that was believed to mean the leaving rows
   * had gone — and mostly did. But `onExitComplete` fires when the exiting set
   * empties, and a pile whose membership changes while it folds empties that
   * set more than once: the first time it fires, the rows of the second batch
   * are still standing in the column at their full width. Lifting the pin
   * there handed the column back to those rows, which is a column that widens
   * for as long as they take to go and then narrows again — the jump, and then
   * the jump back.
   *
   * So the question is asked of the column rather than of the calendar: clear
   * the width, read what the column makes of itself, and if that is wider than
   * the figure being held, put the figure back and ask again next frame. The
   * read is synchronous, so no frame is painted between the clearing and the
   * restoring and nothing flashes. The deadline is what keeps a column that
   * never agrees from staying pinned forever — after it, the column gets its
   * width back regardless, because sizing itself is the correct behaviour and
   * a stuck pin is worse than one late reflow.
   */
  const releasePileWidth = useCallback(() => {
    pileWidthTravel.current?.stop();
    pileWidthTravel.current = undefined;
    if (pileWidthSettle.current !== undefined) return;
    const deadline = performance.now() + PILE_PIN_SETTLE_MS;
    const attempt = () => {
      pileWidthSettle.current = undefined;
      const list = listRef.current;
      if (!list) return;
      const held = Number.parseFloat(list.style.width);
      if (!Number.isFinite(held)) return;
      list.style.width = "";
      if (
        list.getBoundingClientRect().width - held <= PILE_WIDTH_EPSILON_PX ||
        performance.now() > deadline
      )
        return;
      list.style.width = `${held}px`;
      pileWidthSettle.current = requestAnimationFrame(attempt);
    };
    attempt();
  }, []);
  // A travel outliving the column it was moving would go on writing to a node
  // nothing can see.
  useEffect(
    () => () => {
      pileWidthTravel.current?.stop();
      if (pileWidthSettle.current !== undefined)
        cancelAnimationFrame(pileWidthSettle.current);
    },
    [],
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const laneLift = useLaneTravel(hostRef, Boolean(shouldReduceMotion));
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

  /* Keep the scrolling viewport in place while its rows fold back into a
     pile. Removing the cap in the first frame lets all exiting rows take
     their natural height, which is the downward jump seen in Safari. */
  useEffect(() => {
    if (!isPileClosing) return;
    const timer = window.setTimeout(
      () => setIsPileClosing(false),
      PILE_UNMOUNT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isPileClosing]);

  /*
   * Opening a detail should add room, not take the same room away from the
   * other cards. `scrollHeight` is the final natural height even while the
   * visible wrapper is midway through its zero-to-auto animation.
   */
  const measureExpandedDetailHeight = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    let height = 0;
    for (const detail of list.querySelectorAll<HTMLElement>(
      "[data-notification-detail]",
    ))
      height += detail.scrollHeight;
    setExpandedDetailHeight((current) =>
      Math.abs(current - height) < 0.5 ? current : height,
    );
  }, []);
  useLayoutEffect(() => {
    measureExpandedDetailHeight();
  }, [openIds, measureExpandedDetailHeight]);

  const stack = useMemo(
    () =>
      planNotificationStack(
        notifications,
        isExpanded || isPileClosing
          ? notifications.length
          : MAX_EXPANDED_NOTIFICATIONS,
      ),
    [isExpanded, isPileClosing, notifications],
  );

  /*
   * How many titles are waiting behind everything that is running.
   *
   * Summed across the kinds of work that keep a line, because they are
   * separate lines with separate leads and a person reading the pile wants to
   * know how much is left, not how it divides. Each lead already counts only
   * what is *waiting*: nothing running is in this figure, and neither is the
   * lead itself.
   */
  const waitingCount = useMemo(
    () =>
      notifications.reduce(
        (total, entry) => total + (entry.task?.queuedCount ?? 0),
        0,
      ),
    [notifications],
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
  const keepTransitioningCardInView = useCallback((id: string) => {
    const anchor = pinned.current;
    const list = listRef.current;
    if (!anchor || anchor.id !== id || !list) return;
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
    const current = box.top - view.top;
    const correction = current - wanted;
    if (Math.abs(correction) > 0.25) list.scrollTop += correction;
  }, []);
  useLayoutEffect(() => {
    const id = pinned.current?.id;
    if (id) keepTransitioningCardInView(id);
  }, [openIds, keepTransitioningCardInView]);

  /*
   * The pile's width, across a change of membership.
   *
   * A column sized to its content is as wide as the widest card standing in
   * it, so opening and closing the pile changes its width — and the change
   * landed at the wrong moment in both directions. Closing, the rows on their
   * way out went on setting the width until they unmounted, a fifth of a
   * second after the fold had finished: the pile folded down, and then, as a
   * separate event, narrowed. Opening, the arriving rows set it before they
   * had arrived: the pile jumped to its full width and the cards slid into it
   * afterwards.
   *
   * So the width is pinned across the change and travelled over it, on the
   * fold's own curve and duration. Both ends are measured off the real column
   * — the far end by taking the leaving rows out of the measurement for the
   * length of one synchronous read, inside a layout effect, which no frame is
   * painted between — and the pin is lifted once the column would size itself
   * to the same answer unaided.
   */

  useLayoutEffect(() => {
    const list = listRef.current;
    const start = pileWidthFrom.current;
    pileWidthFrom.current = null;
    if (!list || !start) return;

    pileWidthTravel.current?.stop();
    // A pin still looking for its moment must not clear the one set below.
    stopPileWidthSettle();
    list.style.width = "";
    const leaving = start.keepId
      ? Array.from(list.querySelectorAll<HTMLElement>("[data-card]")).filter(
          (card) => card.dataset.cardId !== start.keepId,
        )
      : [];
    for (const card of leaving) card.style.display = "none";
    const target = list.getBoundingClientRect().width;
    for (const card of leaving) card.style.display = "";

    if (Math.abs(target - start.width) < PILE_WIDTH_EPSILON_PX) return;
    if (shouldReduceMotion) return;

    list.style.width = `${start.width}px`;
    pileWidthTravel.current = animate(start.width, target, {
      duration: isExpanded ? PILE_OPEN_S : PILE_CLOSE_S,
      ease: isExpanded ? [0.22, 1, 0.36, 1] : [0.4, 0, 0.2, 1],
      onUpdate: (width) => {
        list.style.width = `${width}px`;
      },
      // Closing, the pin is lifted by the timer that unmounts the rows the
      // target was measured without; there is nothing to lift it onto yet.
      ...(isExpanded ? { onComplete: releasePileWidth } : {}),
    });
  }, [isExpanded, releasePileWidth, shouldReduceMotion, stopPileWidthSettle]);

  /*
   * Which ends of the column are overrun, and so which ends fade. Recomputed
   * whenever the shape of the column can have changed: a card opening, the
   * pile opening, or one arriving or leaving.
   */
  /*
   * Kept in a ref rather than passed as a value: the measurement runs on scroll
   * and on animation frames, and re-subscribing it every time the pile's
   * membership changes would be a new observer per card that arrives.
   */
  const presentCardIds = useRef<ReadonlySet<string>>(new Set());
  presentCardIds.current = useMemo(
    () => new Set(stack.entries.map((entry) => entry.notification.id)),
    [stack.entries],
  );
  const overrun = useColumnOverrun(
    listRef,
    `${isExpanded}:${openIds.join()}:${stack.entries.length}`,
    presentCardIds,
  );
  /*
   * One frame of a card opening or closing.
   *
   * The fade at the ends of the column has to travel with the card that is
   * moving them, not be told about it once it has stopped. Suppressing it for
   * the length of the animation and restoring it at the end is what made the
   * treatment appear a beat after a card had finished folding away, and vanish
   * the instant one was pressed open — the edge of the column changing state
   * twice, in one step each, around a movement that was continuous.
   *
   * The measurement behind it is already coalesced onto an animation frame, so
   * asking on every frame of the animation costs one reading per frame.
   */
  const onDetailFrame = useCallback(
    (id: string) => {
      keepTransitioningCardInView(id);
      overrun.remeasure();
    },
    [keepTransitioningCardInView, overrun],
  );
  const hasPeek = stack.entries.some((entry) => entry.isCollapsed);
  const holdsExpandedViewport = isExpanded || isPileClosing;

  return (
    <motion.div
      ref={hostRef}
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
      /*
       * Laid out on the floor of the page and lifted off it by `useLaneTravel`
       * for as long as chrome holds the bottom-right corner — today the hero's
       * carousel control, which used to be laid out straight through these
       * cards on desktop. The pile travels that distance in step with whatever
       * claimed the corner instead of jumping it; the hook says why the lift
       * cannot live on `bottom` itself.
       *
       * The height still comes off the lane rather than the floor, because the
       * lane is the room the pile actually has once it is standing there —
       * and is capped short of it, so the pile never becomes the page it is
       * reporting on. Both limits live in `--notification-pile-max-height`.
       */
      style={{ y: laneLift }}
      className="pointer-events-none fixed bottom-[var(--notification-lane-floor)] right-[max(1rem,env(safe-area-inset-right))] z-[200] flex max-h-[var(--notification-pile-max-height)] flex-col-reverse items-end gap-1"
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
        <motion.div
          ref={listRef}
          data-notification-list
          animate={{
            paddingTop: hasPeek || isPileClosing ? COLLAPSED_HEADROOM_PX : 0,
          }}
          transition={{
            duration: shouldReduceMotion ? 0 : isPileClosing ? 0.2 : 0,
            ease: [0.4, 0, 0.2, 1],
          }}
          /*
           * Half the page at most, and the rest by scrolling. The bar itself
           * is hidden: it appears and disappears with the pile, and a column
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
            ...(holdsExpandedViewport || expandedDetailHeight > 0
              ? {
                  maxHeight: expandedDetailHeight
                    ? `min(calc(${PILE_VIEWPORT} + ${expandedDetailHeight}px), ${PILE_DETAIL_VIEWPORT})`
                    : PILE_VIEWPORT,
                }
              : {}),
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
          } ${holdsExpandedViewport ? "pointer-events-auto max-h-[50dvh]" : ""}`}
        >
          {/*
           * The pin on the column's width comes off here, and nowhere else on
           * the way down.
           *
           * Clearing `isPileClosing` does not remove the folded rows: it hands
           * them to `AnimatePresence`, which keeps them mounted for the length
           * of one more exit. A release timed off that state therefore landed
           * while they were still standing in the column, so the column went
           * back to sizing itself to them — its full opened width — and then
           * narrowed a second time when they finally went. Across that pair of
           * renders the front card's box moved sideways, and a `layout`
           * projection animates a box that moves: the card jumped left and
           * slid back into place, a beat after the fold had finished.
           *
           * By the time the exit is complete the column measures the width the
           * travel already arrived at — the target was taken without those
           * rows — so lifting the pin here changes nothing and leaves nothing
           * to animate.
           */}
          <AnimatePresence initial={false} onExitComplete={releasePileWidth}>
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
                  opacity:
                    isPileClosing && !entry.isColumnBottom ? 0 : entry.opacity,
                  x: 0,
                  y: entry.offsetY,
                  scale: shouldReduceMotion ? 1 : entry.scale,
                  // Collapsed cards overlap the one in front instead of taking a
                  // row of their own.
                  height:
                    entry.isCollapsed ||
                    (isPileClosing && !entry.isColumnBottom)
                      ? 0
                      : "auto",
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
                  duration: shouldReduceMotion
                    ? 0.18
                    : isPileClosing
                      ? 0.2
                      : 0.34,
                  ease: isPileClosing ? [0.4, 0, 0.2, 1] : [0.22, 1, 0.36, 1],
                  opacity: {
                    duration: shouldReduceMotion
                      ? 0.18
                      : isPileClosing
                        ? 0.2
                        : 0.28,
                  },
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
                    reduceMotion={Boolean(shouldReduceMotion)}
                    onDetailAnimationUpdate={onDetailFrame}
                    onDetailAnimationComplete={(id) => {
                      keepTransitioningCardInView(id);
                      if (pinned.current?.id === id) pinned.current = null;
                      window.requestAnimationFrame(measureExpandedDetailHeight);
                      overrun.remeasure();
                    }}
                  />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      </div>

      {notifications.length > 0 ? (
        <div className="pointer-events-auto flex items-center gap-1.5">
          {/* Always, not only with the pile open: something to dismiss is
              something a person may want to be rid of, and having to open the
              pile first to find the control that empties it is a step that
              exists for no reason. */}
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
            className="rounded-full border border-white/10 bg-black/70 px-2 py-1 min-h-[1.5rem] text-[0.68rem] font-black text-white/75 backdrop-blur transition hover:border-white/25 hover:text-white/85"
          >
            {t("notifications.dismissAll")}
          </button>

          {/*
           * How long the line is, where the line's own controls are.
           *
           * One statement about the queue rather than one per card: the count
           * belongs to the work waiting, not to whichever title happens to be
           * leading it, and on a card it was read as something about that
           * title.
           */}
          {waitingCount > 0 ? (
            <span className="rounded-full border border-white/10 bg-black/70 px-2 py-1 min-h-[1.5rem] text-[0.68rem] font-black tabular-nums text-white/55 backdrop-blur">
              {formatTemplate(t("notifications.waiting"), {
                count: new Intl.NumberFormat(language).format(waitingCount),
              })}
            </span>
          ) : null}

          {overflowCount > 0 || isExpanded ? (
            <button
              type="button"
              onClick={() => {
                const width =
                  listRef.current?.getBoundingClientRect().width ?? 0;
                if (isExpanded) {
                  pinned.current = null;
                  const bottomId = stack.entries.find(
                    (entry) => entry.isColumnBottom,
                  )?.notification.id;
                  // Only the front card survives the fold; the two that peek out
                  // behind it are hung out of flow and set no width of their own.
                  pileWidthFrom.current = { width, keepId: bottomId };
                  setOpenIds((current) =>
                    current.filter((id) => id === bottomId),
                  );
                  setIsPileClosing(true);
                  setIsExpanded(false);
                } else {
                  // Everything is mounted by the time the effect reads the
                  // target, so nothing has to be taken out of the measurement.
                  pileWidthFrom.current = { width };
                  setIsPileClosing(false);
                  setIsExpanded(true);
                }
              }}
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
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
}
