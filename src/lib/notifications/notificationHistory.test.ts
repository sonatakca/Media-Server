import { afterEach, expect, it, vi } from "vitest";
import {
  notify,
  dismissNotification,
  getNotifications,
  getNotificationHistory,
  resetNotificationsForTests,
  clearNotificationHistory,
} from "./notificationStore";
afterEach(() => {
  resetNotificationsForTests();
  vi.useRealTimers();
});
it("retains dismissed activity, updates it once, and preserves its first shown time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const id = notify({ key: "job:1", title: "Downloading", tone: "progress" });
  dismissNotification(id);
  vi.setSystemTime(5000);
  notify({
    key: "job:1",
    title: "Downloaded",
    tone: "success",
    historyOnly: true,
  });
  expect(getNotifications()).toHaveLength(0);
  expect(getNotificationHistory()).toMatchObject([
    { id, title: "Downloaded", firstShownAt: 1000, updatedAt: 5000 },
  ]);
});
it("deduplicates identical visible messages and bounds the history", () => {
  notify({ title: "Saved" });
  notify({ title: "Saved" });
  expect(getNotificationHistory()).toHaveLength(1);
  for (let i = 0; i < 150; i++) notify({ title: `Message ${i}` });
  expect(getNotificationHistory()).toHaveLength(100);
  clearNotificationHistory();
  expect(getNotificationHistory()).toHaveLength(0);
});
