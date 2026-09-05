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
/**
 * A box that has stopped moving down the window.
 *
 * `atRest` watches the width and the right edge, which a vertical scroll never
 * touches — so a card being revealed reads as "at rest" throughout the whole
 * of its travel.
 *
 * Sampled slowly and agreed three times over. Headless WebKit runs a scroll at
 * something like five frames a second, and two readings sixty milliseconds
 * apart land inside one of its frames often enough to call a scroll that has
 * barely started finished.
 */
async function atRestY(box: () => DOMRect): Promise<DOMRect> {
  let previous = box();
  let agreed = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const current = box();
    agreed =
      Math.abs(current.top - previous.top) < 0.01 && current.height > 0
        ? agreed + 1
        : 0;
    if (agreed >= 3) return current;
    previous = current;
  }
}

it.each([
  [1280, 800],
  [390, 844],
])(
  "anchors the front card at the foot of a %s by %s viewport",
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
      // The earliest holds the front, at the anchor; later ones stack in
      // behind and above it.
      const front = rect("Task 0");
      expect(front.bottom).toBeLessThanOrEqual(height);
      expect(front.right).toBeLessThanOrEqual(width);
      expect(front.left).toBeGreaterThanOrEqual(0);
      // One card is laid out; the two behind it only peek.
      expect(rect("Task 1").bottom).toBeLessThan(front.top);
    });
    expect(getComputedStyle(host).position).toBe("fixed");
    expect(getComputedStyle(host).pointerEvents).toBe("none");
    const peek = screen.getByText("Task 1").closest("[data-card]")!;
    expect(peek.getAttribute("aria-hidden")).toBe("true");
    expect(peek.querySelector("[inert]")).not.toBeNull();
    const anchor = list.getBoundingClientRect().bottom;
    const rightEdge = (await atRest(() => rect("Task 0"))).right;
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
      expect(Math.abs(rect("Task 0").right - rightEdge)).toBeLessThan(1),
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
  /*
   * Waited for by the transform rather than by two readings that agree: an
   * entrance that has not started yet also reports the same height twice, and
   * a "rest" taken there is the 0.94 the card arrives at rather than the 1 it
   * lands on — which is a measurement of the entrance, not of this test.
   */
  const card = heading.closest("[data-card]") as HTMLElement;
  await waitFor(() => {
    const transform = getComputedStyle(card).transform;
    expect(
      transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)",
    ).toBe(true);
  });
  const rest = height();
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

it("sizes a lone card to its own content", async () => {
  // A fixed width did two harms at once: it clipped long names behind an
  // ellipsis, and on short ones it left a gulf between the title and the
  // figure at the other end of the line.
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  act(() => {
    notify({ title: "Probe", tone: "info" });
  });
  const card = screen.getByText("Probe").closest("[data-card]") as HTMLElement;
  await waitFor(() => expect(card.offsetWidth).toBeGreaterThan(0));
  // Never so narrow it stops reading as a card, and never the old fixed width
  // when the content does not need it.
  expect(card.offsetWidth).toBeGreaterThanOrEqual(256);
  expect(card.offsetWidth).toBeLessThan(400);
});

it("gives every card in the column one width, taken from the widest", async () => {
  /*
   * Cards that each sized themselves would show a ragged edge in the pile, so
   * the column takes one width and hands it to all of them.
   *
   * Measured as layout, not as a rect: the pile scales the cards behind the
   * front one on purpose, and that depth cue is not a difference in width.
   */
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  const card = (label: string) =>
    screen.getByText(label).closest("[data-card]") as HTMLElement;
  const long = "House of the Dragon";
  // Raised first, so it is the one at the front of the pile.
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
        subject: { type: "media", label: long, code: "S01E08" },
        encoding: { completedSeconds: 3_090, totalSeconds: 4_052 },
        queuedCount: 18,
        attempts: 1,
        maxAttempts: 3,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    });
  });
  await waitFor(() => expect(card(long).offsetWidth).toBeGreaterThan(256));
  const wide = card(long).offsetWidth;
  expect(wide).toBeLessThanOrEqual(480);
  // Wide enough that the name it is about is not the thing that gave way —
  // the complaint that started this was a show's name behind an ellipsis on a
  // card with room to spare at the other end of the line.
  expect(screen.getByText(long).scrollWidth).toBeLessThanOrEqual(
    screen.getByText(long).clientWidth,
  );

  // A shorter card behind it takes the same width rather than sitting narrower.
  act(() => {
    notify({ title: "Probe", tone: "info" });
  });
  await waitFor(() => expect(card("Probe").offsetWidth).toBe(wide));

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
});

it("stops widening at the point a card would stop being a line", async () => {
  // Past the cap the ellipsis comes back, and should: a card is a line, not a
  // paragraph, and a name long enough to need one has to give way somewhere.
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  const title = `Absurdly long ${"name ".repeat(20)}`.trim();
  act(() => {
    notify({ title, tone: "info" });
  });
  const card = screen.getByText(title).closest("[data-card]") as HTMLElement;
  await waitFor(() => expect(card.offsetWidth).toBe(480));
  expect(screen.getByText(title).scrollWidth).toBeGreaterThan(
    screen.getByText(title).clientWidth,
  );
});

it("lies the pile against the card in front, with nothing showing between", async () => {
  // A card behind separated from the one in front by a band of the page reads
  // as a list of torn-off strips, not as depth — and faded most of the way out
  // it stops reading as a card at all.
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  act(() => {
    for (let index = 0; index < 4; index += 1)
      notify({ title: `Entry ${index}`, tone: "error" });
  });
  const card = (label: string) =>
    screen.getByText(label).closest("[data-card]") as HTMLElement;
  const front = await atRest(() => card("Entry 0").getBoundingClientRect());
  // The strip that is actually drawn, not the zero-height row holding it.
  const behind = card("Entry 1").firstElementChild!.getBoundingClientRect();
  // Touching or overlapping: never a gap.
  expect(behind.bottom).toBeGreaterThanOrEqual(front.top - 1);
  // And it peeks by enough to be seen, without becoming a row of its own.
  expect(front.top - behind.top).toBeGreaterThan(2);
  expect(front.top - behind.top).toBeLessThan(14);
  expect(Number(getComputedStyle(card("Entry 1")).opacity)).toBeGreaterThan(
    0.8,
  );
});

/** A pile deep enough to scroll, opened. */
async function openPile(count: number, detail = 4) {
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  act(() => {
    for (let index = 0; index < count; index += 1)
      notify({
        title: `Entry ${index}`,
        description: `Detail for ${index}. `.repeat(detail),
        tone: "error",
      });
  });
  act(() => {
    screen.getByText("notifications.more").click();
  });
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  // Opened, and then left alone until it has finished opening: a card pressed
  // while the column is still sliding is measured against a box that has not
  // arrived yet.
  await atRestY(() => cardFor("Entry 0").getBoundingClientRect());
  return list;
}

const cardFor = (label: string) =>
  screen.getByText(label).closest("[data-card]") as HTMLElement;

it("keeps a pressed card where it was pressed", async () => {
  /*
   * The column is anchored at its foot, so a card that grows takes the room
   * out of the top of the pile: opening one carried it up past the head of the
   * list, and the thing just asked for was the thing that left the view.
   */
  const list = await openPile(6);
  const card = cardFor("Entry 3");
  const view = () => list.getBoundingClientRect();
  const before = (await atRestY(() => card.getBoundingClientRect())).top;
  const belowBefore = cardFor("Entry 2").getBoundingClientRect().top;
  const shut = card.offsetHeight;
  act(() => {
    card.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
  });
  await waitFor(() => expect(card.offsetHeight).toBeGreaterThan(shut));
  const after = (await atRestY(() => card.getBoundingClientRect())).top;

  /*
   * Where it was, to within the room the window had left above it. A card that
   * grows past the foot of the window has to come up to show what it grew —
   * but never further than its own top edge, which is the line the press was
   * aimed at.
   */
  expect(after).toBeLessThanOrEqual(before + 2);
  expect(after).toBeGreaterThanOrEqual(view().top - 1);
  // It grew, and the growth went downwards from where it was pressed.
  const grown = card.getBoundingClientRect();
  expect(grown.bottom).toBeGreaterThan(after + shut);

  /*
   * And the room came from the cards beneath rather than from the head of the
   * pile. Read from the pressed card so the measurement does not depend on
   * where the column happens to be scrolled to: the card below it has moved
   * down by exactly what the pressed one gained.
   */
  const below = cardFor("Entry 2").getBoundingClientRect();
  expect(below.top - grown.top - (belowBefore - before)).toBeCloseTo(
    grown.height - shut,
    0,
  );
  // And is still lying against it, with none of the page between the two.
  expect(Math.abs(below.top - grown.bottom)).toBeLessThan(0.5);
});

it("shows what a pressed card grew, wherever in the pile it was", async () => {
  /*
   * Holding the anchor and stopping there is the letter of the request without
   * its point: the card nearest the foot spent all of its new height below the
   * edge of the window, so pressing it looked like it had done nothing at all.
   * The card nearest the head had the opposite fault — pressed while it was
   * half out of the top, it stayed half out of the top.
   */
  const list = await openPile(8);
  for (const label of ["Entry 0", "Entry 4", "Entry 7"]) {
    const card = cardFor(label);
    const shut = card.offsetHeight;
    act(() => {
      card.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
    });
    await waitFor(() => expect(card.offsetHeight).toBeGreaterThan(shut));
    const box = await atRestY(() => card.getBoundingClientRect());
    const view = list.getBoundingClientRect();
    // Its head is in the window, and so is a useful amount of what it opened.
    expect(box.top).toBeGreaterThanOrEqual(view.top - 1);
    expect(box.top).toBeLessThanOrEqual(view.bottom - shut);
    // Most of whatever the window had room to show of it, rather than the one
    // shut line the press started from.
    const shown =
      Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);
    expect(shown).toBeGreaterThan(Math.min(box.height, view.height) * 0.66);
    expect(shown).toBeGreaterThan(shut);
    act(() => {
      card.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
    });
    await waitFor(() => expect(card.offsetHeight).toBe(shut));
  }
});

it("closes the seams between the cards it lays out", async () => {
  // A band of the page through every seam is what made the column read as a
  // handful of torn-off strips rather than as one pile.
  const list = await openPile(5, 1);
  await atRest(() => cardFor("Entry 0").getBoundingClientRect());
  for (let index = 0; index < 3; index += 1) {
    const lower = cardFor(`Entry ${index}`).getBoundingClientRect();
    const upper = cardFor(`Entry ${index + 1}`).getBoundingClientRect();
    expect(Math.abs(lower.top - upper.bottom)).toBeLessThan(0.5);
  }
  // And the column, not the cards, is what floats: a shadow on a card inside a
  // scrolling box only ever reaches the seams and the cut edge of the box.
  const surface = cardFor("Entry 0").querySelector("[aria-expanded]")!
    .parentElement!.parentElement as HTMLElement;
  expect(getComputedStyle(surface).boxShadow).toBe("none");
  expect(
    getComputedStyle(list.parentElement as HTMLElement).boxShadow,
  ).not.toBe("none");
});

it("fades only the ends a card is actually running past", async () => {
  /*
   * A gradient at an edge nothing is crossing is not a soft edge, it is a veil
   * over whatever happens to be last — and what it veiled here was the
   * progress bar along the foot of the card at the front.
   */
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  act(() => {
    // Raised first, so it holds the front of the pile — and determinate, so
    // it is the case the fade used to eat: a bar along the foot of the column.
    notify({ title: "Entry 0", tone: "progress", progress: 42, life: "long" });
    for (let index = 1; index < 6; index += 1)
      notify({
        title: `Entry ${index}`,
        description: `Detail for ${index}.`,
        tone: "error",
      });
  });
  act(() => {
    screen.getByText("notifications.more").click();
  });
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  const front = cardFor("Entry 0");
  await atRestY(() => front.getBoundingClientRect());
  await waitFor(() =>
    expect(list.style.getPropertyValue("--pile-fade-top")).not.toBe(""),
  );
  // The column overruns its head and rests on its foot.
  expect(
    Number.parseFloat(list.style.getPropertyValue("--pile-fade-top")),
  ).toBeGreaterThan(0);
  expect(list.style.getPropertyValue("--pile-fade-bottom")).toBe("0px");
  // So the last thing on the last card is whole.
  const bar = front
    .querySelector("[role=progressbar]")!
    .getBoundingClientRect();
  expect(bar.bottom).toBeLessThanOrEqual(
    list.getBoundingClientRect().bottom + 1,
  );
});

it("leaves a column that fits with no fade at all", async () => {
  // Nothing is running past either end, so neither end is treated.
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  act(() => {
    notify({ title: "Alone", tone: "info" });
  });
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  await atRest(() => cardFor("Alone").getBoundingClientRect());
  await waitFor(() =>
    expect(list.className.includes("notification-pile-fade")).toBe(false),
  );
});

it("keeps the geometry when motion is reduced, and stops moving", async () => {
  /*
   * Reduced motion is about movement, not about correctness: the card still
   * holds its place under the press and still shows what it opened. What goes
   * is the travel — the reveal arrives at once rather than gliding there.
   */
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((query: string) =>
    query.includes("prefers-reduced-motion")
      ? {
          matches: true,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }
      : real(query)) as typeof window.matchMedia;
  try {
    const list = await openPile(8);
    const card = cardFor("Entry 0");
    const shut = card.offsetHeight;
    const view = list.getBoundingClientRect();
    const before = card.getBoundingClientRect().top - view.top;
    act(() => {
      card.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
    });
    await waitFor(() => expect(card.offsetHeight).toBeGreaterThan(shut));
    const box = await atRestY(() => card.getBoundingClientRect());
    // Still anchored at or above where it was pressed, still inside the window.
    expect(box.top - view.top).toBeLessThanOrEqual(before + 2);
    expect(box.top).toBeGreaterThanOrEqual(view.top - 1);
    const shown =
      Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);
    expect(shown).toBeGreaterThan(shut);
    // And no card is left carrying a transform it was meant to animate away.
    for (const entry of list.querySelectorAll("[data-card]")) {
      const transform = getComputedStyle(entry).transform;
      expect(
        transform === "none" || transform.startsWith("matrix(1, 0, 0, 1"),
      ).toBe(true);
    }
  } finally {
    window.matchMedia = real;
  }
});
