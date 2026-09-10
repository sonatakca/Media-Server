import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Bell, X } from "lucide-react";
import {
  getNotificationHistory,
  subscribeToNotifications,
} from "../../lib/notifications/notificationStore";
import { useLanguage } from "../../i18n/LanguageContext";
import { TaskDetails } from "./TaskDetails";

export function NotificationHistoryButton() {
  const { t, language } = useLanguage();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const history = useSyncExternalStore(
    subscribeToNotifications,
    getNotificationHistory,
    getNotificationHistory,
  );
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
  const date = (time: number) => new Date(time).toLocaleString(language);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={t("notifications.history")}
        title={t("notifications.history")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/75 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Bell size={18} />
      </button>
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
                    button.current?.focus();
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
