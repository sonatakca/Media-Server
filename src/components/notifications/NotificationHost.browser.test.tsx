import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationHost } from "./NotificationHost";
import {
  notify,
  resetNotificationsForTests,
} from "../../lib/notifications/notificationStore";
import "../../index.css";
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key: string) => key }),
}));
afterEach(() => {
  cleanup();
  resetNotificationsForTests();
});
/**
 * A box's geometry once it has stopped moving.
 *
 * The entrance carries a scale and an offset, and headless WebKit runs it at
 * about five frames a second — so a rect read the moment an element appears is
 * a frame of the animation, not the layout. Sampled until two readings agree
 * rather than slept on: a fixed wait is the same gamble with extra seconds.
 */
async function atRest(box: () => DOMRect): Promise<DOMRect> {
  let previous = box();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const current = box();
    if (
      Math.abs(current.width - previous.width) < 0.01 &&
      Math.abs(current.right - previous.right) < 0.01 &&
      current.width > 0
    )
      return current;
    previous = current;
  }
}
it.each([
  [1280, 800],
  [390, 844],
])(
  "anchors newest below older cards within a %s by %s viewport",
  async (width, height) => {
    await page.viewport(width, height);
    render(<NotificationHost />);
    act(() => {
      for (let i = 0; i < 8; i++)
        notify({
          title: `Task ${i}`,
          description: "Detailed status with wrapping text. ".repeat(3),
          tone: "error",
        });
    });
    const host = document.querySelector<HTMLElement>(
      "[data-notification-host]",
    )!;
    const list = document.querySelector<HTMLElement>(
      "[data-notification-list]",
    )!;
    const rect = (text: string) =>
      screen.getByText(text).closest("[data-card]")!.getBoundingClientRect();
    await waitFor(() => {
      const newest = rect("Task 7");
      expect(newest.bottom).toBeLessThanOrEqual(height);
      expect(newest.right).toBeLessThanOrEqual(width);
      expect(newest.left).toBeGreaterThanOrEqual(0);
      // One card is laid out; the two behind it only peek.
      expect(rect("Task 6").bottom).toBeLessThan(newest.top);
    });
    expect(getComputedStyle(host).position).toBe("fixed");
    expect(getComputedStyle(host).pointerEvents).toBe("none");
    const peek = screen.getByText("Task 6").closest("[data-card]")!;
    expect(peek.getAttribute("aria-hidden")).toBe("true");
    expect(peek.querySelector("[inert]")).not.toBeNull();
    const anchor = list.getBoundingClientRect().bottom;
    const rightEdge = (await atRest(() => rect("Task 7"))).right;
    act(() => {
      screen.getByText("notifications.more").click();
    });
    await waitFor(() => {
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
      expect(list.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      expect(
        Math.abs(list.getBoundingClientRect().bottom - anchor),
      ).toBeLessThan(2);
    });
    // Four rows at most, and the rest by scrolling.
    expect(list.clientHeight).toBeLessThanOrEqual(224);
    expect(getComputedStyle(list).overflowY).toBe("auto");
    // Opening the pile must not shove the column sideways: a scrollbar that
    // appears with it would move every card by its own width, and unlike the
    // entrance transform that settles, that shift never comes back.
    await waitFor(() =>
      expect(Math.abs(rect("Task 7").right - rightEdge)).toBeLessThan(1),
    );
    list.scrollTop = -list.scrollHeight;
    expect(list.scrollTop).toBeLessThan(0);
    if (width < 640)
      expect(
        height - host.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(95);
  },
);

it("never stretches its own text while opening or closing", async () => {
  // Animating a card's *size* means animating a scale, and a scale distorts
  // every glyph inside it on the way there and back — dramatically, on a card
  // that doubles in height when it opens. Position is what may animate here.
  await page.viewport(760, 820);
  render(<NotificationHost />);
  act(() => {
    notify({
      title: "Media processing",
      tone: "progress",
      progress: 36.42,
      task: {
        titleKey: "tasks.mediaProcess",
        determinate: true,
        status: "running",
        stage: "video",
        subject: {
          type: "media",
          label: "House of the Dragon",
          code: "S01E03",
          detail: "Second of His Name",
        },
        encoding: { completedSeconds: 1_381, totalSeconds: 3_794 },
        remainingSeconds: 1_975,
        attempts: 1,
        maxAttempts: 3,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    });
  });
  const heading = screen.getByText("House of the Dragon");
  // The entrance has a scale of its own, so the resting height is whatever the
  // glyphs settle at — never whatever they happen to measure on arrival.
  const height = () => heading.getBoundingClientRect().height;
  let rest = 0;
  await waitFor(() => {
    const seen = height();
    const settled = seen > 0 && Math.abs(seen - rest) < 0.01;
    rest = seen;
    expect(settled).toBe(true);
  });
  const row = document.querySelector<HTMLButtonElement>("[aria-expanded]")!;

  // Sampled across both transitions rather than at either end: a distortion
  // that has finished distorting is invisible to a measurement taken at rest.
  const heights: number[] = [];
  for (const _ of [0, 1]) {
    act(() => {
      row.click();
    });
    for (let sample = 0; sample < 10; sample += 1) {
      await new Promise((resolve) => setTimeout(resolve, 45));
      heights.push(heading.getBoundingClientRect().height);
    }
  }
  expect(Math.max(...heights) - rest).toBeLessThan(1);
  expect(rest - Math.min(...heights)).toBeLessThan(1);
});

it("takes its width from its content, and gives every card the same one", async () => {
  /*
   * A fixed width did two harms at once: it clipped long names behind an
   * ellipsis, and on short ones it left a gulf between the title and the
   * figure at the other end of the line. Sizing to content fixes both — but
   * cards that each sized themselves would show a ragged edge in the pile, so
   * the column takes one width and hands it to all of them.
   *
   * Measured as layout, not as a rect: the pile scales the cards behind the
   * front one on purpose, and that depth cue is not a difference in width.
   */
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  const card = (label: string) =>
    screen.getByText(label).closest("[data-card]") as HTMLElement;
  act(() => {
    notify({ title: "Probe", tone: "info" });
  });
  await waitFor(() => expect(card("Probe").offsetWidth).toBeGreaterThan(0));
  const narrow = card("Probe").offsetWidth;
  // Never so narrow it stops reading as a card, and never the old fixed width
  // when the content does not need it.
  expect(narrow).toBeGreaterThanOrEqual(256);
  expect(narrow).toBeLessThan(400);

  act(() => {
    notify({
      title: "Media processing",
      tone: "progress",
      progress: 76.2,
      task: {
        titleKey: "tasks.mediaProcess",
        determinate: true,
        status: "running",
        stage: "video",
        subject: {
          type: "media",
          label: "House of the Dragon",
          code: "S01E08",
        },
        encoding: { completedSeconds: 3_090, totalSeconds: 4_052 },
        queuedCount: 18,
        attempts: 1,
        maxAttempts: 3,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    });
  });
  const long = "House of the Dragon";
  await waitFor(() => expect(card(long).offsetWidth).toBeGreaterThan(narrow));
  const wide = card(long).offsetWidth;
  // The short card grew with it rather than sitting narrower behind it.
  expect(card("Probe").offsetWidth).toBe(wide);
  // And nothing runs past the cap.
  expect(wide).toBeLessThanOrEqual(480);
  // Wide enough that the name it is about is not the thing that gave way —
  // the complaint that started this was a show's name behind an ellipsis on a
  // card with room to spare at the other end of the line.
  expect(screen.getByText(long).scrollWidth).toBeLessThanOrEqual(
    screen.getByText(long).clientWidth,
  );

  // Opening a card must not widen the column: the body wraps inside the width
  // the one line every card has has already settled on.
  const rightEdge = (await atRest(() => card(long).getBoundingClientRect()))
    .right;
  act(() => {
    card(long).querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
  });
  await waitFor(() =>
    expect(screen.getByText("tasks.video")).toBeInTheDocument(),
  );
  expect(card(long).offsetWidth).toBe(wide);
  expect(
    Math.abs(
      (await atRest(() => card(long).getBoundingClientRect())).right -
        rightEdge,
    ),
  ).toBeLessThan(1);

  // Past the cap the ellipsis comes back, and should: a card is a line, not a
  // paragraph, and a name long enough to need one has to give way somewhere.
  act(() => {
    notify({ title: `Absurdly long ${"name ".repeat(20)}`, tone: "info" });
  });
  await waitFor(() => expect(card("Probe").offsetWidth).toBe(480));
});
