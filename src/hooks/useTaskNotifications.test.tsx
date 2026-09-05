import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTaskNotifications } from "./useTaskNotifications";
import {
  dismissAllNotifications,
  getNotifications,
  resetNotificationsForTests,
} from "../lib/notifications/notificationStore";
import type { TaskDto } from "../api/ownApi/dto";
const getTasks = vi.fn();
const t = (key: string) => key;
vi.mock("../lib/mediaApi", () => ({ getTasks: () => getTasks() }));
vi.mock("../i18n/LanguageContext", () => ({ useLanguage: () => ({ t }) }));
const task: TaskDto = {
  id: "a",
  type: "media.probe",
  status: "running",
  progress: 0.42,
  progressMessage: "Analysed 42 of 100 files",
  attempts: 1,
  maxAttempts: 3,
  result: null,
  error: null,
  queuedAt: "",
  startedAt: null,
  finishedAt: null,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetNotificationsForTests();
  getTasks.mockReset();
});
it("restores current work, updates one card, and honors dismissal across polling", async () => {
  vi.useFakeTimers();
  getTasks.mockResolvedValue([task, { ...task, id: "old", status: "failed" }]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getNotifications()).toHaveLength(1);
  const id = getNotifications()[0]?.id;
  getTasks.mockResolvedValue([{ ...task, progress: 0.5 }]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()[0]).toMatchObject({ id, progress: 50 });
  act(() => dismissAllNotifications());
  getTasks.mockResolvedValue([{ ...task, progress: 0.6 }]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()).toHaveLength(0);
});

const processing = (
  id: string,
  status: TaskDto["status"],
  queuedAt: string,
): TaskDto => ({
  ...task,
  id,
  type: "media.process",
  status,
  progress: 0,
  progressMessage: null,
  attempts: 0,
  queuedAt,
});

it("raises one card for the whole waiting line and keeps its count current", async () => {
  // The server encodes one title at a time, so a dozen queued episodes are one
  // waiting line — reporting each of them produced a column of identical cards
  // that named none of them.
  vi.useFakeTimers();
  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    processing("q1", "queued", "2026-09-05T09:01:00Z"),
    processing("q2", "queued", "2026-09-05T09:02:00Z"),
    processing("q3", "queued", "2026-09-05T09:03:00Z"),
  ]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(getNotifications()).toHaveLength(1);
  expect(getNotifications()[0]?.task?.queuedCount).toBe(3);
  const id = getNotifications()[0]?.id;

  // The line shortening is news the same card carries, without becoming a
  // second one.
  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    processing("q1", "queued", "2026-09-05T09:01:00Z"),
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()).toHaveLength(1);
  expect(getNotifications()[0]).toMatchObject({ id, task: { queuedCount: 1 } });
});

it("still reports a queued title that fails on its own", async () => {
  // Being counted by the lead's card is not the same as being silenced: an
  // outcome has a name, a duration and a reason that no count can carry.
  vi.useFakeTimers();
  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    processing("q1", "queued", "2026-09-05T09:01:00Z"),
  ]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getNotifications()).toHaveLength(1);

  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    { ...processing("q1", "failed", "2026-09-05T09:01:00Z"), attempts: 3 },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()).toHaveLength(2);
  expect(getNotifications()[0]?.task?.status).toBe("failed");
});

it("keeps one card when a whole line is held, and leads with what runs next", async () => {
  /*
   * "Pause all" on eighteen episodes. Holding a queued title ends its queue
   * attempt as `succeeded` carrying a cancelled result, so the queue alone
   * showed eighteen finished titles: eighteen cards, every one of them saying
   * "Cancelled", led by the last in the line rather than the next to run.
   */
  vi.useFakeTimers();
  const queued = (id: string, at: string) => processing(id, "queued", at);
  getTasks.mockResolvedValue([
    queued("e09", "2026-09-05T09:01:00Z"),
    queued("e10", "2026-09-05T09:02:00Z"),
    queued("e11", "2026-09-05T09:03:00Z"),
  ]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getNotifications()).toHaveLength(1);

  const held = (id: string, at: string) => ({
    ...processing(id, "succeeded", at),
    result: { status: "cancelled" },
    presentation: { determinate: false, outcome: "paused" as const },
  });
  getTasks.mockResolvedValue([
    held("e09", "2026-09-05T09:01:00Z"),
    held("e10", "2026-09-05T09:02:00Z"),
    held("e11", "2026-09-05T09:03:00Z"),
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  const cards = getNotifications();
  expect(cards).toHaveLength(1);
  // The next title to run, not the last one in the line.
  expect(cards[0]?.task).toMatchObject({ status: "paused", queuedCount: 2 });
  expect(cards[0]?.task?.status).not.toBe("cancelled");
});

it("takes back a card once the lead starts answering for it", async () => {
  // A title that raised its own card and then joined the line behind the lead
  // must stop being a card; the lead already counts it.
  vi.useFakeTimers();
  getTasks.mockResolvedValue([
    processing("q1", "running", "2026-09-05T09:01:00Z"),
  ]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getNotifications()).toHaveLength(1);

  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    processing("q1", "queued", "2026-09-05T09:01:00Z"),
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()).toHaveLength(1);
  expect(getNotifications()[0]?.task?.queuedCount).toBe(1);

  // And it is a card again the moment it reaches the head of the line: the
  // dismissal must not be remembered as "the viewer closed this one".
  getTasks.mockResolvedValue([
    { ...processing("run", "succeeded", "2026-09-05T09:00:00Z") },
    processing("q1", "running", "2026-09-05T09:01:00Z"),
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(
    getNotifications().filter((card) => card.task?.status === "running"),
  ).toHaveLength(1);
});
