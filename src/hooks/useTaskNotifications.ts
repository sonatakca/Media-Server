import { useEffect, useRef } from "react";
import { getTasks } from "../lib/mediaApi";
import {
  notify,
  getNotifications,
  dismissNotification,
} from "../lib/notifications/notificationStore";
import {
  describeTask,
  isSpokenForByLead,
  selectChangedTasks,
  selectProcessingLead,
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
  const hasPolledRef = useRef(false);
  const cardsRef = useRef(new Map<string, string>());
  const leadRef = useRef("");

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      let hasActiveWork = false;

      try {
        const tasks = await getTasks();
        if (cancelled) return;

        const { changed, next } = selectChangedTasks(
          tasks,
          seenRef.current,
          !hasPolledRef.current,
        );
        seenRef.current = next;
        const wasFirstPoll = !hasPolledRef.current;
        hasPolledRef.current = true;
        hasActiveWork = tasks.some(
          (task) => task.status === "running" || task.status === "queued",
        );

        /*
         * The waiting line moving is news the lead's own card carries, and
         * nothing else about that task has to change for the count on it to be
         * wrong — so a changed count is what re-raises it.
         */
        const lead = selectProcessingLead(tasks);
        const leadSignature = lead ? `${lead.taskId}:${lead.queuedCount}` : "";
        const leadTask =
          lead && leadSignature !== leadRef.current && !wasFirstPoll
            ? tasks.find((task) => task.id === lead.taskId)
            : undefined;
        leadRef.current = leadSignature;
        const due =
          leadTask && !changed.some((task) => task.id === leadTask.id)
            ? [...changed, leadTask]
            : changed;

        /*
         * A title the lead has taken over for stops being a card and becomes a
         * number on the lead's. Leaving the old one standing is how a single
         * press of "pause all" left a column of cards for titles the card at
         * the front was already counting.
         */
        for (const task of tasks) {
          if (!isSpokenForByLead(task, lead)) continue;
          const card = cardsRef.current.get(task.id);
          if (card === undefined) continue;
          dismissNotification(card);
          // Forgotten as well as dismissed: this title may yet reach the head
          // of the line, and a card it raises then is news of its own.
          cardsRef.current.delete(task.id);
        }

        // Insert older tasks first so the newest queued work is nearest the bottom.
        for (const task of [...due].sort(
          (a, b) =>
            (Date.parse(a.queuedAt) || 0) - (Date.parse(b.queuedAt) || 0),
        )) {
          // One card speaks for the whole waiting line; the titles behind the
          // lead are a count on it, not a card each.
          if (isSpokenForByLead(task, lead)) continue;
          const described = describeTask(
            task,
            task.id === lead?.taskId ? lead.queuedCount : 0,
          );
          if (!described) continue;

          const previousCard = cardsRef.current.get(task.id);
          if (
            previousCard &&
            !getNotifications().some((card) => card.id === previousCard)
          )
            continue;
          const cardId = notify({
            key: described.key,
            tone: described.tone,
            title: t(described.titleKey),
            task: described.task,
            progress: described.progress,
            life: described.life,
          });
          cardsRef.current.set(task.id, cardId);
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
