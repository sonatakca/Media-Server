import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationHost } from "./NotificationHost";
import {
  getNotifications,
  notify,
  resetNotificationsForTests,
} from "../../lib/notifications/notificationStore";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({
      children,
      // Motion-only props must not reach the DOM or React warns about each one.
      layout: _layout,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    }: Record<string, unknown> & { children?: React.ReactNode }) => (
      <div {...(props as object)}>{children}</div>
    ),
  },
  useReducedMotion: () => true,
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetNotificationsForTests();
});

describe("notification host", () => {
  it("shows a notification raised from anywhere, without a provider", () => {
    render(<NotificationHost />);

    act(() => {
      notify({ title: "Library scan", description: "Reading disc" });
    });

    expect(screen.getByText("Library scan")).toBeInTheDocument();
    expect(screen.getByText("Reading disc")).toBeInTheDocument();
  });

  it("expires a short notification on its own", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Saved", tone: "success" });
    });

    act(() => {
      vi.advanceTimersByTime(4_100);
    });

    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("keeps a long notification well past a short one's life", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Careful", tone: "warning" });
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("Careful")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText("Careful")).toBeNull();
  });

  it("never expires a persistent notification", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Broken", tone: "error" });
    });

    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });

    expect(screen.getByText("Broken")).toBeInTheDocument();
  });

  it("closes a notification when its dismiss control is used", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Broken", tone: "error" });
    });

    act(() => {
      screen.getByRole("button", { name: "notifications.dismiss" }).click();
    });

    expect(screen.queryByText("Broken")).toBeNull();
    expect(getNotifications()).toHaveLength(0);
  });

  it("gives a replaced notification its full life again", () => {
    // A scan that ran for a minute would otherwise show its result for no time
    // at all, because the card would already be older than its lifetime.
    render(<NotificationHost />);
    act(() => {
      notify({ key: "scan", title: "Scanning", tone: "progress" });
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
      notify({ key: "scan", title: "Scan finished", tone: "success" });
    });

    expect(screen.getByText("Scan finished")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText("Scan finished")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByText("Scan finished")).toBeNull();
  });

  it("restarts the timer when a card is replaced without changing its life", () => {
    // The expiry effect keys off `createdAt`. If it only watched the id and the
    // life, a replacement of the same kind would silently inherit the previous
    // card's deadline — so this replaces short with short, where nothing else
    // about the card changes.
    render(<NotificationHost />);
    act(() => {
      notify({ key: "save", title: "Saved once", tone: "success" });
    });

    act(() => {
      vi.advanceTimersByTime(3_000);
      notify({ key: "save", title: "Saved again", tone: "success" });
    });

    // Under the old schedule this would already be a second from expiry.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("Saved again")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(screen.queryByText("Saved again")).toBeNull();
  });

  it("shows how many are hidden once the pile is deep", () => {
    render(<NotificationHost />);
    act(() => {
      for (let index = 0; index < 9; index += 1) {
        notify({ title: `Entry ${index}`, tone: "error" });
      }
    });

    expect(screen.getByText("notifications.more")).toBeInTheDocument();
  });

  it("hides the description of a collapsed card, which is only a depth cue", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Oldest", description: "Buried", tone: "error" });
      for (let index = 0; index < 3; index += 1) {
        notify({ title: `Newer ${index}`, tone: "error" });
      }
    });

    expect(screen.getByText("Oldest")).toBeInTheDocument();
    expect(screen.queryByText("Buried")).toBeNull();
  });
});
