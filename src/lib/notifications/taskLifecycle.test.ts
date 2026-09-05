import { afterEach, expect, it, vi } from "vitest";
import {
  notify,
  getNotifications,
  resetNotificationsForTests,
} from "./notificationStore";
import type { TaskDetail } from "./taskNotifications";
const running: TaskDetail = {
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  startedAt: null,
  finishedAt: null,
  determinate: true,
};
afterEach(() => {
  resetNotificationsForTests();
  vi.useRealTimers();
});
it("updates in place without restarting clocks or moving progress backward, resetting on retry", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const id = notify({
    key: "task:a",
    title: "Probe",
    tone: "progress",
    task: running,
    progress: 42,
  });
  vi.setSystemTime(5000);
  notify({
    key: "task:a",
    title: "Probe",
    tone: "progress",
    task: running,
    progress: 20,
  });
  expect(getNotifications()[0]).toMatchObject({
    id,
    progress: 42,
    createdAt: 1000,
  });
  notify({
    key: "task:a",
    title: "Probe",
    tone: "progress",
    task: { ...running, attempts: 2 },
    progress: 0,
  });
  expect(getNotifications()[0]?.progress).toBe(0);
  notify({ key: "task:b", title: "Other", task: running });
  expect(getNotifications()).toHaveLength(2);
});
it("gives the outcome its full lifetime exactly once and clears stale detail", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  notify({
    key: "task:a",
    title: "Probe",
    task: running,
    tone: "progress",
    progress: 42,
  });
  vi.setSystemTime(60000);
  const done = {
    key: "task:a",
    title: "Probe",
    tone: "success" as const,
    life: "long" as const,
    task: { ...running, status: "succeeded" as const },
  };
  notify(done);
  expect(getNotifications()[0]).toMatchObject({
    createdAt: 60000,
    progress: undefined,
  });
  vi.setSystemTime(65000);
  notify(done);
  expect(getNotifications()[0]?.createdAt).toBe(60000);
  notify({
    ...done,
    tone: "error",
    life: "persistent",
    task: { ...running, status: "failed", errorKey: "tasks.safeFailure" },
  });
  expect(getNotifications()[0]).toMatchObject({
    life: "persistent",
    task: { errorKey: "tasks.safeFailure" },
  });
});
