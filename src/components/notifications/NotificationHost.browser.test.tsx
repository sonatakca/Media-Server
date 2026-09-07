import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationHost } from "./NotificationHost";
import {
  notify,
  resetNotificationsForTests,
} from "../../lib/notifications/notificationStore";
import {
  claimBottomChrome,
  releaseBottomChrome,
} from "../../lib/layout/bottomChrome";
import "../../index.css";
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key: string) => key }),
}));
afterEach(() => {
  cleanup();
  resetNotificationsForTests();
  releaseBottomChrome("test-chrome");
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
      // Enough rows that the opened column overruns half the page, which is
      // where it is capped: a pile that fits proves nothing about scrolling.
      // The store keeps twelve, and the first raised has to be among them.
      for (let i = 0; i < 12; i++)
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
    // Half the page at most, and the rest by scrolling.
    expect(list.clientHeight).toBeLessThanOrEqual(height / 2 + 1);
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

it("keeps the progress bar present through a smooth lone-card resize", async () => {
  await page.viewport(760, 820);
  render(<NotificationHost />);
  act(() => {
    notify({
      title: "Encoding",
      description: "A detail line that gives the card room to grow.",
      tone: "progress",
      progress: 42,
      life: "long",
    });
  });
  const card = cardFor("Encoding");
  await atRest(() => card.getBoundingClientRect());
  const row = card.querySelector<HTMLButtonElement>("[aria-expanded]")!;
  const bar = card.querySelector<HTMLElement>("[role=progressbar]")!;
  const shut = card.getBoundingClientRect().height;

  act(() => row.click());
  const opening: number[] = [];
  for (let sample = 0; sample < 8; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 55));
    const box = card.getBoundingClientRect();
    const progress = bar.getBoundingClientRect();
    opening.push(box.height);
    expect(progress.height).toBeGreaterThan(0);
    expect(progress.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
  }
  expect(opening.at(-1)).toBeGreaterThan(shut);
  expect(
    opening.some((height) => height > shut && height < opening.at(-1)!),
  ).toBe(true);

  act(() => row.click());
  const closing: number[] = [];
  for (let sample = 0; sample < 8; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 55));
    const box = card.getBoundingClientRect();
    const progress = bar.getBoundingClientRect();
    closing.push(box.height);
    expect(progress.height).toBeGreaterThan(0);
    expect(progress.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
  }
  expect(closing.at(-1)).toBeCloseTo(shut, 0);
  expect(closing.some((height) => height > shut && height < closing[0]!)).toBe(
    true,
  );
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

it("keeps the expanded viewport capped until Show less finishes", async () => {
  const list = await openPile(5, 1);
  const expandedHeight = list.getBoundingClientRect().height;
  act(() => {
    screen.getByText("notifications.showLess").click();
  });

  // The old implementation removed this cap in the click frame, briefly
  // letting every exiting row take its full natural height before snapping.
  expect(list.className).toContain("max-h-[50dvh]");
  for (let sample = 0; sample < 6; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(list.getBoundingClientRect().height).toBeLessThanOrEqual(
      expandedHeight + 1,
    );
  }
  await waitFor(() => expect(list.className).not.toContain("max-h-[50dvh]"));
  expect(list.getBoundingClientRect().height).toBeLessThan(expandedHeight);
});

it("adds an opened pile card's detail height to the expanded viewport", async () => {
  const list = await openPile(6, 3);
  const baseMaximum = Number.parseFloat(getComputedStyle(list).maxHeight);
  const card = cardFor("Entry 3");
  const row = card.querySelector<HTMLButtonElement>("[aria-expanded]")!;

  act(() => row.click());
  const detail = await waitFor(() => {
    const element = card.querySelector<HTMLElement>(
      "[data-notification-detail]",
    );
    expect(element).not.toBeNull();
    return element!;
  });
  const naturalDetailHeight = detail.scrollHeight;
  await waitFor(() =>
    expect(Number.parseFloat(getComputedStyle(list).maxHeight)).toBeCloseTo(
      baseMaximum + naturalDetailHeight,
      0,
    ),
  );

  act(() => row.click());
  await waitFor(() =>
    expect(Number.parseFloat(getComputedStyle(list).maxHeight)).toBeCloseTo(
      baseMaximum,
      0,
    ),
  );
});

it("stands in half the page as a list, and three quarters once one is read", async () => {
  /*
   * Two heights, one for each thing the pile is being asked to be. Opened, it
   * is a list of headlines, and half the page is as much of that as anyone
   * reads while the page behind it is the point. Opening a card is a different
   * request — the detail is now the thing being read — so the column may take
   * three quarters, and no more: past that the pile has become the page rather
   * than a report on it.
   */
  const height = 800;
  await page.viewport(1280, height);
  render(<NotificationHost />);
  act(() => {
    for (let index = 0; index < 12; index += 1)
      notify({
        title: `Entry ${index}`,
        description: `Detail for ${index}. `.repeat(40),
        tone: "error",
      });
  });
  act(() => {
    screen.getByText("notifications.more").click();
  });
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  await atRestY(() => cardFor("Entry 0").getBoundingClientRect());

  // It wanted more room than it was given, and stopped at half the page.
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  await waitFor(() => expect(list.clientHeight).toBeCloseTo(height / 2, -1));
  expect(list.clientHeight).toBeLessThanOrEqual(height / 2 + 1);

  const card = cardFor("Entry 3");
  act(() => {
    card.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
  });
  await waitFor(() =>
    expect(list.clientHeight).toBeGreaterThan(height / 2 + 1),
  );
  // Grown for the detail, and still short of three quarters of the page.
  expect(list.clientHeight).toBeLessThanOrEqual((height * 3) / 4 + 1);

  // And back to half once the detail is shut again.
  act(() => {
    card.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
  });
  await waitFor(() =>
    expect(list.clientHeight).toBeLessThanOrEqual(height / 2 + 1),
  );
});

it("Show less closes other details and preserves the bottom card", async () => {
  await openPile(5, 1);
  for (const label of ["Entry 0", "Entry 2", "Entry 4"]) {
    act(() =>
      cardFor(label)
        .querySelector<HTMLButtonElement>("[aria-expanded]")!
        .click(),
    );
    await atRest(() => cardFor(label).getBoundingClientRect());
  }
  act(() => screen.getByText("notifications.showLess").click());
  await waitFor(() => expect(screen.queryByText("Entry 4")).toBeNull());
  expect(cardFor("Entry 0").querySelector("[aria-expanded]")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  act(() => screen.getByText("notifications.more").click());
  await waitFor(() => expect(screen.getByText("Entry 4")).toBeInTheDocument());
  for (const label of ["Entry 2", "Entry 4"])
    expect(cardFor(label).querySelector("[aria-expanded]")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
});

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
    // Deep enough to run past the head of a column capped at half the page,
    // and no deeper than the store keeps: Entry 0 has to survive.
    for (let index = 1; index < 12; index += 1)
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

/**
 * The pile standing clear of chrome that has taken the bottom-right corner.
 *
 * Both ends of the movement matter, and only one of them can be measured at
 * rest. Where it finishes is arithmetic; how it gets there is the whole point,
 * and a lane change that lands as a jump — or worse, throws the pile past the
 * lane and eases it back — is invisible to any reading taken once it is over.
 * So the travel is sampled throughout, and what is asserted is that every
 * frame of it lies between the two ends.
 *
 * Run in WebKit as well as Chromium on purpose: the lane is a `max()`, and a
 * `transition` on one of those never advances in WebKit, which is why the
 * movement is a transform off a fixed floor rather than an eased `bottom`.
 */
async function sampleTravel(foot: () => number, forMs: number) {
  const samples: number[] = [];
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    samples.push(foot());
  }
  return samples;
}

it("travels between lanes rather than jumping between them", async () => {
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  act(() => {
    notify({ title: "Encoding", tone: "error" });
  });

  const host = document.querySelector<HTMLElement>("[data-notification-host]")!;
  const foot = () => host.getBoundingClientRect().bottom;
  const onTheFloor = (await atRestY(() => host.getBoundingClientRect())).bottom;
  // Tall enough to be unmistakable, and taller than the floor it is measured
  // against, or there would be nothing for the pile to clear.
  const claim = 800 - onTheFloor + 180;
  const lifted = 800 - claim;

  claimBottomChrome("test-chrome", claim);
  const rising = await sampleTravel(foot, 1_600);

  // Never below where it started, never above where it is going: the pile
  // arrives at the lane rather than overshooting it and settling back.
  expect(Math.max(...rising)).toBeLessThanOrEqual(onTheFloor + 1);
  expect(Math.min(...rising)).toBeGreaterThanOrEqual(lifted - 1);
  // And it was seen on the way, rather than only at the two ends.
  expect(
    rising.some((sample) => sample < onTheFloor - 20 && sample > lifted + 20),
  ).toBe(true);
  expect(Math.abs(rising[rising.length - 1] - lifted)).toBeLessThan(2);

  releaseBottomChrome("test-chrome");
  const falling = await sampleTravel(foot, 1_600);

  expect(Math.max(...falling)).toBeLessThanOrEqual(onTheFloor + 1);
  expect(Math.min(...falling)).toBeGreaterThanOrEqual(lifted - 1);
  expect(
    falling.some((sample) => sample < onTheFloor - 20 && sample > lifted + 20),
  ).toBe(true);
  expect(Math.abs(falling[falling.length - 1] - onTheFloor)).toBeLessThan(2);
});

it("stops short of the page it is reporting on", async () => {
  /*
   * A card with a great deal to say used to run the pile from the lane to the
   * masthead: a scan reporting on the library covered the library. Three
   * quarters of the viewport, measured from the bottom, is the whole of what
   * the pile may take, however much is opened inside it.
   */
  const height = 620;
  await page.viewport(1280, height);
  render(<NotificationHost />);
  act(() => {
    notify({
      title: "Library scan",
      tone: "success",
      life: "long",
      task: {
        titleKey: "tasks.libraryScan",
        determinate: true,
        status: "succeeded",
        metrics: [
          "itemsCreated",
          "itemsUpdated",
          "itemsMarkedMissing",
          "itemsDeleted",
          "filesCreated",
          "filesChanged",
          "filesMarkedMissing",
          "filesDeleted",
          "probesQueued",
          "itemsConsidered",
          "created",
          "updated",
          "unchanged",
          "skippedConflict",
          "skippedNotApplicable",
          "matched",
          "ambiguous",
          "notFound",
          "probed",
        ].map((metric, index) => ({
          metric: metric as "itemsUpdated",
          value: index + 1,
        })),
        attempts: 1,
        maxAttempts: 3,
        startedAt: "2026-09-05T00:00:00Z",
        finishedAt: "2026-09-05T00:00:21Z",
      },
    });
  });
  const host = document.querySelector(
    "[data-notification-host]",
  ) as HTMLElement;
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  const card = cardFor("tasks.libraryScan");
  await atRest(() => card.getBoundingClientRect());
  act(() => {
    card.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
  });
  await waitFor(() =>
    expect(screen.getByText("tasks.probesQueued")).toBeInTheDocument(),
  );
  await atRestY(() => host.getBoundingClientRect());

  // It really did want the room — otherwise the cap below proves nothing.
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  expect(host.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    height / 4 - 1,
  );
});

it("narrows as the pile folds rather than after it has folded", async () => {
  /*
   * The rows on their way out went on setting the column's width until they
   * unmounted, a fifth of a second after the fold had finished — so the pile
   * folded down and then, as a separate event, snapped narrower.
   */
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  const wide = "House of the Dragon";
  act(() => {
    // Raised first, so this short one is what the fold leaves standing; the
    // wide one is raised last, behind the two that go on peeking out.
    for (let index = 0; index < 5; index += 1)
      notify({ title: `Entry ${index}`, tone: "error" });
    notify({
      title: "Media processing",
      tone: "progress",
      progress: 76.2,
      task: {
        titleKey: "tasks.mediaProcess",
        determinate: true,
        status: "running",
        stage: "video",
        subject: { type: "media", label: wide, code: "S01E08" },
        encoding: { completedSeconds: 3_090, totalSeconds: 4_052 },
        queuedCount: 18,
        attempts: 1,
        maxAttempts: 3,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    });
  });
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  act(() => {
    screen.getByText("notifications.more").click();
  });
  await waitFor(() => expect(screen.getByText(wide)).toBeInTheDocument());
  const opened = (await atRest(() => list.getBoundingClientRect())).width;

  act(() => {
    screen.getByText("notifications.showLess").click();
  });
  let narrowedAt: number | undefined;
  let goneAt: number | undefined;
  const started = performance.now();
  for (let sample = 0; sample < 80 && goneAt === undefined; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const now = performance.now() - started;
    if (
      narrowedAt === undefined &&
      opened - list.getBoundingClientRect().width > 2
    )
      narrowedAt = now;
    if (screen.queryByText(wide) === null) goneAt = now;
  }
  expect(goneAt).toBeDefined();
  expect(narrowedAt).toBeDefined();
  // The width is already travelling while the rows that set it are still there.
  expect(narrowedAt!).toBeLessThan(goneAt!);
  const closed = (await atRest(() => list.getBoundingClientRect())).width;
  expect(closed).toBeLessThan(opened);
  // And the pin is lifted: the column sizes itself again once the rows go.
  await waitFor(() => expect(list.style.width).toBe(""));
});

it("never backtracks sideways as the pile folds", async () => {
  /*
   * The column narrows once, in one direction, and the card standing in it
   * goes with it.
   *
   * The pin that held the width across the fold used to be lifted beside the
   * state that unmounts the leaving rows rather than after it, so the column
   * went back to sizing itself for the frames while those rows were still
   * standing in it — wide again — and then narrowed a second time when they
   * finally went. The layout projection reads a box that moves, so the front
   * card jumped back left and slid right into place after the fold had
   * already finished.
   */
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  const wide = "House of the Dragon";
  act(() => {
    // The short one is raised first, so it is what the fold leaves standing.
    notify({ title: "Entry 0", tone: "error" });
    for (let index = 1; index < 5; index += 1)
      notify({ title: `Entry ${index}`, tone: "error" });
    notify({
      title: "Media processing",
      tone: "progress",
      progress: 76.2,
      task: {
        titleKey: "tasks.mediaProcess",
        determinate: true,
        status: "running",
        stage: "video",
        subject: { type: "media", label: wide, code: "S01E08" },
        encoding: { completedSeconds: 3_090, totalSeconds: 4_052 },
        queuedCount: 18,
        attempts: 1,
        maxAttempts: 3,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    });
  });
  act(() => {
    screen.getByText("notifications.more").click();
  });
  await waitFor(() => expect(screen.getByText(wide)).toBeInTheDocument());
  const front = () => cardFor("Entry 0").getBoundingClientRect();
  await atRest(front);

  act(() => {
    screen.getByText("notifications.showLess").click();
  });
  const lefts: number[] = [];
  for (let sample = 0; sample < 60; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    lefts.push(front().left);
  }
  // It narrowed at all, so there was a width change to backtrack over.
  expect(Math.max(...lefts) - Math.min(...lefts)).toBeGreaterThan(2);
  // And it only ever travelled right: no frame sits left of the one before it.
  for (let index = 1; index < lefts.length; index += 1)
    expect(lefts[index]).toBeGreaterThanOrEqual(lefts[index - 1] - 1);
  // The right edge is where it was throughout: the column narrows into the
  // corner it is pinned to rather than sliding across the page.
  expect(Math.abs(front().right - (await atRest(front)).right)).toBeLessThan(1);
});

it("fades the end an opening card is running past while it is running past it", async () => {
  /*
   * The treatment used to be switched off for the length of a card's own
   * animation and switched back on at the end of it, so the edge of the
   * column changed state twice, in one step each, around a movement that was
   * continuous — and a card long enough to run past the foot of the column
   * spent the whole of its travel sliced through instead of fading out.
   */
  await page.viewport(1280, 620);
  render(<NotificationHost />);
  act(() => {
    notify({
      title: "Library scan",
      description:
        "Detail long enough to run the card past the foot of the column. ".repeat(
          24,
        ),
      tone: "error",
      life: "long",
    });
  });
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  const card = cardFor("Library scan");
  await atRest(() => card.getBoundingClientRect());

  const fadeBottom = () =>
    Number.parseFloat(list.style.getPropertyValue("--pile-fade-bottom") || "0");
  expect(fadeBottom()).toBe(0);
  act(() => {
    card.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
  });
  const during: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 45));
    during.push(fadeBottom());
  }
  // Faded for the whole of the travel, not switched on once it had stopped.
  expect(during.filter((value) => value > 0).length).toBeGreaterThanOrEqual(5);
});

it("keeps the column narrow when the fold's rows leave in more than one batch", async () => {
  /*
   * The pin on the width has to come off when taking it off changes nothing —
   * not when one particular event says the rows have gone.
   */
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  const running = (index: number, label: string, done = 199) => ({
    key: `task:${index}`,
    title: label,
    tone: "progress" as const,
    progress: 40 + index,
    task: {
      titleKey: "tasks.trickplayGenerate" as const,
      determinate: true,
      status: "running" as const,
      stage: "trickplay" as const,
      subject: { type: "media" as const, label, code: `S01E0${index}` },
      counts: { completed: done, total: 356, unit: "frames" as const },
      queuedCount: index === 1 ? 224 : 0,
      attempts: 1,
      maxAttempts: 3,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    },
  });
  act(() => {
    // Short, concluded rows first — the last of them is what the fold leaves
    // standing — then the wide running ones that have to go.
    for (const title of ["Movies", "Series", "Books"])
      notify({ title, tone: "success", life: "long" });
    for (let index = 1; index <= 3; index += 1)
      notify(running(index, `Berlin and the Lady with an Ermine ${index}`));
  });
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  act(() => {
    screen.getByText("notifications.more").click();
  });
  await waitFor(() =>
    expect(
      screen.getByText("Berlin and the Lady with an Ermine 3"),
    ).toBeInTheDocument(),
  );
  const opened = (await atRest(() => list.getBoundingClientRect())).width;

  act(() => {
    screen.getByText("notifications.showLess").click();
  });
  const trace: string[] = [];
  const widths: number[] = [];
  for (let sample = 0; sample < 120; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 16));
    /*
     * The live page re-renders the host on every poll, and a poll lands inside
     * the fold as a matter of course. A pile that stands perfectly still for
     * the length of its own animation is the one thing the real one never is.
     */
    if (sample % 3 === 0)
      act(() => {
        for (let index = 1; index <= 3; index += 1)
          notify(
            running(
              index,
              `Berlin and the Lady with an Ermine ${index}`,
              199 + sample,
            ),
          );
      });
    const width = list.getBoundingClientRect().width;
    widths.push(width);
    trace.push(
      `${sample * 16}ms ${width.toFixed(1)} pin=${list.style.width || "-"}`,
    );
  }
  const settled = (await atRest(() => list.getBoundingClientRect())).width;
  expect(settled).toBeLessThan(opened - 2);
  for (let index = 1; index < widths.length; index += 1)
    expect(
      widths[index],
      `widened at sample ${index}\n${trace.slice(Math.max(0, index - 4), index + 4).join("\n")}`,
    ).toBeLessThanOrEqual(widths[index - 1] + 1);
});

it("puts every card's figure in the same place, whatever else the card carries", async () => {
  /*
   * A column of figures is read down, not one card at a time.
   *
   * The queue's count used to sit on the title line between the percentage and
   * the edge of the card, so a card that had one pushed its figure left by the
   * width of the count — and no two cards in the pile put their percentages in
   * the same place. It also took the room from the name: the title beside it
   * was the only one in the pile cut short.
   */
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  const card = (index: number, percent: number, queuedCount: number) => ({
    key: `task:${index}`,
    title: `Berlin and the Lady with an Ermine ${index}`,
    tone: "progress" as const,
    progress: percent,
    task: {
      titleKey: "tasks.trickplayGenerate" as const,
      determinate: true,
      status: "running" as const,
      stage: "trickplay" as const,
      subject: {
        type: "media" as const,
        label: `Berlin and the Lady with an Ermine ${index}`,
        code: `S01E0${index}`,
      },
      counts: { completed: percent, total: 100, unit: "frames" as const },
      queuedCount,
      attempts: 1,
      maxAttempts: 3,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    },
  });
  act(() => {
    notify(card(1, 4, 0));
    notify(card(2, 42, 218));
    notify(card(3, 100, 0));
  });
  // Opened: a collapsed pile is two scaled strips behind one card, and a strip
  // is deliberately smaller than the card in front of it. The figures line up
  // where the cards are actually read.
  act(() => {
    screen.getByText("notifications.more").click();
  });
  await waitFor(() => expect(screen.getByText("4%")).toBeInTheDocument());
  await atRest(() => screen.getByText("42%").getBoundingClientRect());

  const figures = ["4%", "42%", "100%"].map((text) =>
    screen.getByText(text).getBoundingClientRect(),
  );
  const rights = figures.map((box) => box.right);
  // Every figure ends on the same vertical line, so the column reads down.
  expect(
    Math.max(...rights) - Math.min(...rights),
    `rights: ${rights.join(", ")} | boxes: ${figures.map((b) => `${b.left.toFixed(1)},${b.top.toFixed(1)},${b.width.toFixed(1)}`).join(" / ")}`,
  ).toBeLessThan(1);

  // And the count is off the cards entirely: it belongs to the waiting line,
  // so it stands with the controls that are also about the line.
  // The translator is mocked to echo its key, so the label is the key itself;
  // what matters here is where it stands, not what it says.
  const count = screen.getByText("notifications.waiting");
  expect(count.closest("[data-card]")).toBeNull();
  expect(
    screen.getByText("notifications.dismissAll").closest("div"),
  ).toContainElement(count);
});

it("offers to clear the pile without opening it first", async () => {
  /*
   * Something to dismiss is something a person may want to be rid of, and the
   * control that empties the pile used to appear only once the pile had been
   * opened — so being rid of three cards took opening them first.
   */
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  act(() => {
    notify({ title: "Only one", tone: "error" });
  });
  await waitFor(() =>
    expect(screen.getByText("notifications.dismissAll")).toBeInTheDocument(),
  );
  // Nothing is hidden, so nothing offers to show more.
  expect(screen.queryByText(/notifications\.more/)).toBeNull();

  act(() => {
    screen.getByText("notifications.dismissAll").click();
  });
  await waitFor(() => expect(screen.queryByText("Only one")).toBeNull());
  // With nothing left, the controls go with it.
  expect(screen.queryByText("notifications.dismissAll")).toBeNull();
});

it("keeps the bar at the foot of the column while a card leaves past it", async () => {
  /*
   * A row on its way out slides down, past the foot of the column, and it is
   * held in the DOM for the length of that travel. Counted as part of the
   * column's extent it reported an overrun that was nothing of the sort, and
   * the fade that answers an overrun lay over the last thing at that end —
   * which in this column is the progress bar along the foot of the front card.
   * So the bar blinked out every time anything left the pile, and came back
   * when the row finally went.
   */
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  act(() => {
    notify({
      key: "task:front",
      title: "Berlin and the Lady with an Ermine",
      tone: "progress",
      progress: 67,
      task: {
        titleKey: "tasks.trickplayGenerate" as const,
        determinate: true,
        status: "running" as const,
        stage: "trickplay" as const,
        subject: { type: "media" as const, label: "Berlin", code: "S01E08" },
        counts: { completed: 330, total: 492, unit: "frames" as const },
        attempts: 1,
        maxAttempts: 3,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    });
    notify({ key: "task:leaving", title: "On its way out", tone: "error" });
  });
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  const bar = () =>
    document.querySelector('[role="progressbar"]') as HTMLElement | null;
  await waitFor(() => expect(bar()).not.toBeNull());
  await atRest(() => bar()!.getBoundingClientRect());

  const fadeBottom = () =>
    Number.parseFloat(list.style.getPropertyValue("--pile-fade-bottom") || "0");
  expect(fadeBottom()).toBe(0);

  act(() => {
    screen
      .getByText("On its way out")
      .closest("[data-card]")!
      .querySelector<HTMLButtonElement>('[aria-label="notifications.dismiss"]')!
      .click();
  });
  // Through the whole of the departing row's travel, nothing is laid over the
  // end the bar is at.
  for (let sample = 0; sample < 12; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fadeBottom()).toBe(0);
  }
  await waitFor(() => expect(screen.queryByText("On its way out")).toBeNull());
  expect(fadeBottom()).toBe(0);
  expect(bar()).not.toBeNull();
});

it("keeps the front card's bar through the whole of the fold", async () => {
  await page.viewport(1280, 800);
  render(<NotificationHost />);
  const running = (index: number) => ({
    key: `task:${index}`,
    title: `Berlin and the Lady with an Ermine ${index}`,
    tone: "progress" as const,
    progress: 30 + index * 10,
    task: {
      titleKey: "tasks.trickplayGenerate" as const,
      determinate: true,
      status: "running" as const,
      stage: "trickplay" as const,
      subject: {
        type: "media" as const,
        label: `Berlin ${index}`,
        code: `S01E0${index}`,
      },
      counts: {
        completed: 30 + index * 10,
        total: 100,
        unit: "frames" as const,
      },
      attempts: 1,
      maxAttempts: 3,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    },
  });
  act(() => {
    for (let index = 1; index <= 4; index += 1) notify(running(index));
  });
  const list = document.querySelector(
    "[data-notification-list]",
  ) as HTMLElement;
  act(() => {
    screen.getByText("notifications.more").click();
  });
  await waitFor(() => expect(screen.getByText("40%")).toBeInTheDocument());
  await atRest(() => screen.getByText("40%").getBoundingClientRect());

  const fadeBottom = () =>
    Number.parseFloat(list.style.getPropertyValue("--pile-fade-bottom") || "0");
  const bars = () => document.querySelectorAll('[role="progressbar"]').length;

  act(() => {
    screen.getByText("notifications.showLess").click();
  });
  const fades: number[] = [];
  const counts: number[] = [];
  for (let sample = 0; sample < 45; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    fades.push(fadeBottom());
    counts.push(bars());
  }
  // The front card keeps its bar for every frame of the fold and after it.
  expect(
    Math.min(...counts),
    `bars per frame: ${counts.join(",")}`,
  ).toBeGreaterThan(0);
  // And nothing is laid over the end that bar is at.
  expect(Math.max(...fades), `fade per frame: ${fades.join(",")}`).toBe(0);
});
