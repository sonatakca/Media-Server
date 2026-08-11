import { useEffect, useRef } from "react";
import { getTasks } from "../lib/mediaApi";
import { notify } from "../lib/notifications/notificationStore";
import {
  describeTask,
  selectChangedTasks,
} from "../lib/notifications/taskNotifications";
import { useLanguage } from "../i18n/LanguageContext";

/** Fast enough to feel live, slow enough not to be a load in its own right. */
const ACTIVE_POLL_MS = 2_000;
/** Nothing is running; check occasionally in case something is queued. */
const IDLE_POLL_MS = 15_000;

/**
 * Reports background work as it happens.
 *
 * The server has always tracked progress and outcome for every queued job, and
 * nothing read it — so a library scan ran in complete silence and the only way
 * to know it had finished was to reload a page. This closes that loop.
 *
 * Polls rather than subscribes because the job surface is a plain REST list;
 * the interval backs off to idle whenever nothing is running, so a quiet server
 * is not woken twice a second forever.
 */
export function useTaskNotifications(enabled: boolean): void {
  const { t } = useLanguage();
  const seenRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      let hasActiveWork = false;

      try {
        const tasks = await getTasks();
        if (cancelled) return;

        const { changed, next } = selectChangedTasks(tasks, seenRef.current);
        seenRef.current = next;
        hasActiveWork = tasks.some((task) => task.status === "running");

        for (const task of changed) {
          const described = describeTask(task);
          if (!described) continue;

          notify({
            key: described.key,
            tone: described.tone,
            title: t(described.titleKey),
            ...(described.description === undefined
              ? {}
              : { description: described.description }),
            ...(described.progress === undefined
              ? {}
              : { progress: described.progress }),
            life: described.life,
          });
        }
      } catch {
        // A failed poll is not itself news — the next one will catch up, and a
        // card saying the task list could not be read would be noise about
        // noise.
      }

      if (cancelled) return;
      timer = window.setTimeout(
        () => void poll(),
        hasActiveWork ? ACTIVE_POLL_MS : IDLE_POLL_MS,
      );
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, t]);
}
