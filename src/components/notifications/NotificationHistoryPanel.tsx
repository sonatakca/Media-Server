import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  getNotificationHistory,
  subscribeToNotifications,
} from "../../lib/notifications/notificationStore";
import { useLanguage } from "../../i18n/LanguageContext";
import { NOTIFICATION_HISTORY_OPEN_EVENT } from "../../lib/notifications/notificationHistoryOpen";
import { TaskDetails } from "./TaskDetails";

/** Mounted once by the navbar; draws the history when asked for. */
export function NotificationHistoryPanel() {
  const { t, language } = useLanguage();
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const history = useSyncExternalStore(
    subscribeToNotifications,
    getNotificationHistory,
    getNotificationHistory,
  );
  useEffect(() => {
    const handleOpen = (event: Event) => {
      returnFocus.current = (event as CustomEvent<HTMLElement | null>).detail;
      setOpen(true);
    };
    window.addEventListener(NOTIFICATION_HISTORY_OPEN_EVENT, handleOpen);
    return () =>
      window.removeEventListener(NOTIFICATION_HISTORY_OPEN_EVENT, handleOpen);
  }, []);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        returnFocus.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
  const date = (time: number) => new Date(time).toLocaleString(language);
  return (
    <>
      {open
        ? createPortal(
            <section
              role="region"
              aria-label={t("notifications.history")}
              className="fixed inset-x-3 bottom-3 top-20 z-[150] flex flex-col rounded-2xl border border-white/15 bg-[#101010] p-5 shadow-xl sm:left-auto sm:w-[28rem]"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-bold text-white">
                  {t("notifications.history")}
                </h2>
                <button
                  ref={close}
                  aria-label={t("notifications.dismiss")}
                  className="flex h-11 w-11 items-center justify-center rounded-full text-white hover:bg-white/10"
                  onClick={() => {
                    setOpen(false);
                    returnFocus.current?.focus();
                  }}
                >
                  <X size={20} />
                </button>
              </div>
              <p className="mb-4 text-sm text-white/65">
                {t("notifications.historyNote")}
              </p>
              <div className="min-h-0 overflow-y-auto overscroll-contain">
                <ul className="divide-y divide-white/10">
                  {history.map((entry) => (
                    <li key={entry.id} className="py-4">
                      <p className="font-semibold text-white">{entry.title}</p>
                      <p className="mt-1 text-xs tabular-nums text-white/65">
                        {t("notifications.firstShown")}:{" "}
                        <time
                          dateTime={new Date(
                            entry.firstShownAt ?? entry.createdAt,
                          ).toISOString()}
                        >
                          {date(entry.firstShownAt ?? entry.createdAt)}
                        </time>
                      </p>
                      {entry.updatedAt &&
                      entry.updatedAt !== entry.firstShownAt ? (
                        <p className="text-xs tabular-nums text-white/65">
                          {t("notifications.updated")}:{" "}
                          <time
                            dateTime={new Date(entry.updatedAt).toISOString()}
                          >
                            {date(entry.updatedAt)}
                          </time>
                        </p>
                      ) : null}
                      {entry.task ? (
                        <TaskDetails notification={entry} />
                      ) : (
                        <p className="mt-2 text-sm text-white/75">
                          {entry.description}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {history.length === 0 ? (
                  <p className="text-sm text-white/65">
                    {t("notifications.historyEmpty")}
                  </p>
                ) : null}
              </div>
            </section>,
            document.body,
          )
        : null}
    </>
  );
}
