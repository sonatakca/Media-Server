import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { NotificationHistoryButton } from "./NotificationHistoryButton";
import {
  clearNotificationHistory,
  dismissAllNotifications,
  dismissNotification,
  notify,
} from "../../lib/notifications/notificationStore";
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key: string) => key }),
}));
beforeEach(() => {
  dismissAllNotifications();
  clearNotificationHistory();
});
it("retains one dismissed notification with timestamps and closes with Escape", () => {
  const id = notify({ title: "Import complete", description: "1 movie added" });
  dismissNotification(id);
  notify({ title: "Import complete", description: "1 movie added" });
  render(<NotificationHistoryButton />);
  const button = screen.getByRole("button", { name: "notifications.history" });
  fireEvent.click(button);
  expect(screen.getAllByText("Import complete")).toHaveLength(1);
  expect(screen.getByText("1 movie added")).toBeTruthy();
  expect(document.querySelector("time")?.getAttribute("datetime")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("region")).toBeNull();
  expect(document.activeElement).toBe(button);
});
