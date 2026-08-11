import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import {
  NOTIFICATION_LIFETIMES_MS,
  dismissNotification,
  getNotifications,
  subscribeToNotifications,
  type NotificationTone,
  type SeyirlikNotification,
} from "../../lib/notifications/notificationStore";
import { planNotificationStack } from "../../lib/notifications/notificationStack";
import { useLanguage } from "../../i18n/LanguageContext";

const TONE_ICONS: Record<
  NotificationTone,
  typeof Info | typeof CheckCircle2
> = {
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

/**
 * Expires a notification on its own schedule.
 *
 * A timer per card rather than one sweep, so a card that arrives while another
 * is halfway through its life still gets its full time.
 */
function useExpiry(notification: SeyirlikNotification): void {
  const { id, life, createdAt } = notification;

  useEffect(() => {
    if (life === "persistent") return undefined;

    const elapsed = Date.now() - createdAt;
    const remaining = NOTIFICATION_LIFETIMES_MS[life] - elapsed;
    const timer = window.setTimeout(
      () => dismissNotification(id),
      Math.max(0, remaining),
    );
    return () => window.clearTimeout(timer);
    // `createdAt` is included so a keyed notification that is replaced in place
    // restarts its life rather than expiring on the original schedule.
  }, [createdAt, id, life]);
}

function NotificationCard({
  notification,
  isCollapsed,
}: {
  notification: SeyirlikNotification;
  isCollapsed: boolean;
}) {
  const { t } = useLanguage();
  useExpiry(notification);

  const Icon = TONE_ICONS[notification.tone];
  const accent = TONE_ACCENTS[notification.tone];
  const hasProgress =
    typeof notification.progress === "number" &&
    Number.isFinite(notification.progress);

  return (
    <div className="pointer-events-auto w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/[0.12] bg-[#0b0b10]/90 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl">
      <div className="flex items-start gap-3 p-3.5">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${accent} ${
            notification.tone === "progress" ? "animate-spin" : ""
          }`}
        />

        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold leading-5 text-white/90">
            {notification.title}
          </p>
          {/* A collapsed card is a depth cue, not something to read, so it
              carries only its title. */}
          {notification.description && !isCollapsed ? (
            <p className="mt-0.5 text-xs font-semibold leading-5 text-white/50">
              {notification.description}
            </p>
          ) : null}

          {hasProgress && !isCollapsed ? (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-sky-300 transition-[width] duration-500"
                style={{
                  width: `${Math.min(100, Math.max(0, notification.progress as number))}%`,
                }}
              />
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => dismissNotification(notification.id)}
          aria-label={t("notifications.dismiss")}
          className="-m-1 shrink-0 rounded-full p-1 text-white/35 transition hover:bg-white/10 hover:text-white/80"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * The notification column, top right.
 *
 * Rendered once at the root and driven by a module-level store, so anything at
 * all can report — including code that is nowhere near a component.
 */
export function NotificationHost() {
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const notifications = useSyncExternalStore(
    subscribeToNotifications,
    getNotifications,
    getNotifications,
  );

  const stack = useMemo(
    () => planNotificationStack(notifications),
    [notifications],
  );

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 top-4 z-[200] flex flex-col items-end gap-2 sm:right-6 sm:top-6"
    >
      <AnimatePresence initial={false}>
        {stack.entries.map((entry) => (
          <motion.div
            key={entry.notification.id}
            layout={!shouldReduceMotion}
            style={{ zIndex: entry.zIndex }}
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{
              opacity: entry.opacity,
              y: entry.offsetY,
              scale: entry.scale,
              // Collapsed cards overlap the one in front instead of taking a
              // row of their own.
              marginTop: entry.isCollapsed ? -52 : 0,
            }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{
              duration: shouldReduceMotion ? 0 : 0.24,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <NotificationCard
              notification={entry.notification}
              isCollapsed={entry.isCollapsed}
            />
          </motion.div>
        ))}
      </AnimatePresence>

      {stack.hiddenCount > 0 ? (
        <span className="pointer-events-none rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-[0.68rem] font-black text-white/50 backdrop-blur">
          {t("notifications.more").replace(
            "{count}",
            String(stack.hiddenCount),
          )}
        </span>
      ) : null}
    </div>
  );
}
