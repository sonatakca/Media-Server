import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissAllNotifications,
  dismissNotification,
  getNotifications,
  notify,
  resetNotificationsForTests,
  subscribeToNotifications,
  updateNotification,
} from "./notificationStore";

afterEach(() => {
  resetNotificationsForTests();
});

describe("notification store", () => {
  it("puts the newest first, which is where it is looked for", () => {
    notify({ title: "First" });
    notify({ title: "Second" });

    expect(getNotifications().map((entry) => entry.title)).toEqual([
      "Second",
      "First",
    ]);
  });

  it("replaces a keyed notification instead of stacking another", () => {
    // A scan reporting every few per cent must not leave a column of
    // near-identical cards behind it.
    const first = notify({ key: "scan", title: "Scanning", progress: 10 });
    const second = notify({ key: "scan", title: "Scanning", progress: 60 });

    expect(second).toBe(first);
    expect(getNotifications()).toHaveLength(1);
    expect(getNotifications()[0]?.progress).toBe(60);
  });

  it("restarts the clock when a keyed notification is replaced", () => {
    // The host expires a card from `createdAt`. Without this the outcome of a
    // long job inherits the age of its first progress update, and a success
    // card that should last nine seconds is already expired when it appears.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00Z"));
    notify({ key: "scan", title: "Scanning", tone: "progress" });
    const startedAt = getNotifications()[0]?.createdAt;

    vi.setSystemTime(new Date("2026-08-11T00:00:30Z"));
    notify({ key: "scan", title: "Done", tone: "success" });

    const replaced = getNotifications()[0];
    expect(replaced?.title).toBe("Done");
    expect(replaced?.life).toBe("short");
    expect(replaced?.createdAt).toBe(Date.now());
    expect(replaced?.createdAt).toBeGreaterThan(startedAt as number);
    vi.useRealTimers();
  });

  it("drops a stale description and progress when a card is replaced", () => {
    // A finished job has no percentage, and its old message under a new title
    // would describe work that is over.
    notify({
      key: "scan",
      title: "Scanning",
      description: "Reading disc",
      progress: 40,
      tone: "progress",
    });
    notify({ key: "scan", title: "Done", tone: "success" });

    expect(getNotifications()[0]?.description).toBeUndefined();
    expect(getNotifications()[0]?.progress).toBeUndefined();
  });

  it("chooses a life that matches how much it would cost to miss it", () => {
    notify({ title: "Saved", tone: "success" });
    notify({ title: "Careful", tone: "warning" });
    notify({ title: "Broken", tone: "error" });
    notify({ title: "Working", tone: "progress" });

    const byTitle = new Map(
      getNotifications().map((entry) => [entry.title, entry.life]),
    );
    expect(byTitle.get("Saved")).toBe("short");
    expect(byTitle.get("Careful")).toBe("long");
    // Neither an error nor unfinished work should disappear on a timer.
    expect(byTitle.get("Broken")).toBe("persistent");
    expect(byTitle.get("Working")).toBe("persistent");
  });

  it("lets an explicit life override the tone's default", () => {
    notify({ title: "Broken", tone: "error", life: "short" });
    expect(getNotifications()[0]?.life).toBe("short");
  });

  it("dismisses by id and frees the key for reuse", () => {
    const id = notify({ key: "scan", title: "Scanning" });
    dismissNotification(id);
    expect(getNotifications()).toHaveLength(0);

    // A later job with the same key starts a fresh card rather than reviving a
    // dismissed one.
    notify({ key: "scan", title: "Scanning again" });
    expect(getNotifications()).toHaveLength(1);
  });

  it("caps how many it keeps, dropping the oldest", () => {
    for (let index = 0; index < 20; index += 1) {
      notify({ title: `Entry ${index}` });
    }

    const titles = getNotifications().map((entry) => entry.title);
    expect(titles).toHaveLength(12);
    expect(titles[0]).toBe("Entry 19");
    expect(titles).not.toContain("Entry 0");
  });

  it("tells subscribers about every change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToNotifications(listener);

    const id = notify({ title: "One" });
    updateNotification(id, { progress: 50 });
    dismissNotification(id);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    notify({ title: "Two" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not wake subscribers for a change that changed nothing", () => {
    const listener = vi.fn();
    subscribeToNotifications(listener);

    updateNotification("missing", { title: "Nope" });
    dismissNotification("missing");
    dismissAllNotifications();

    expect(listener).not.toHaveBeenCalled();
  });

  it("returns a stable reference so a subscriber does not re-render for nothing", () => {
    notify({ title: "One" });
    expect(getNotifications()).toBe(getNotifications());
  });
});
