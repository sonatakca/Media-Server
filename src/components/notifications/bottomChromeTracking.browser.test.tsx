import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
  releaseBottomChrome("scrolling-control");
  cleanup();
  resetNotificationsForTests();
});

/**
 * A control that scrolls with the page, as the home hero's does.
 *
 * The pile used to answer every scroll frame of it by restarting a one-second
 * eased journey with a delay in front, so it stood still for as long as the
 * page moved and caught up once it stopped. And it followed the control all
 * the way up, until the room left under the masthead squeezed it to a sliver.
 */
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const pileBox = () =>
  document
    .querySelector<HTMLElement>("[data-notification-host]")!
    .getBoundingClientRect();

function show() {
  render(
    <MemoryRouter>
      <NotificationHost />
    </MemoryRouter>,
  );
  act(() => {
    for (const title of ["Mad Max: Fury Road", "Dune", "Arcane"]) {
      notify({ title, tone: "progress", life: "persistent" });
    }
  });
}

/**
 * Settles before measuring: headless WebKit animates at a few frames a second,
 * and a sine journey's first frame moves less than a pixel, so stillness has
 * to hold for a run of frames rather than one.
 */
async function rest() {
  let last = Number.NaN;
  let still = 0;
  for (let i = 0; i < 600 && still < 10; i += 1) {
    await frame();
    const bottom = pileBox().bottom;
    still = Math.abs(bottom - last) < 0.5 ? still + 1 : 0;
    last = bottom;
  }
}

it("follows a control that scrolls with the page, frame by frame", async () => {
  await page.viewport(1440, 900);
  show();

  // The control rests in the corner: 160 px of it, from the bottom edge up.
  act(() => claimBottomChrome("scrolling-control", 160, { bottomPx: 40 }));
  await rest();
  expect(Math.round(window.innerHeight - pileBox().bottom)).toBe(160);

  // Then the page scrolls it up a few pixels a frame. Every frame, the pile
  // stands on top of it — not where it was when the scroll began.
  for (let top = 164; top <= 220; top += 4) {
    act(() =>
      claimBottomChrome("scrolling-control", top, {
        bottomPx: top - 120,
        tracking: true,
      }),
    );
    await frame();
    await frame();
    expect(
      Math.abs(window.innerHeight - pileBox().bottom - top),
    ).toBeLessThanOrEqual(1);
  }
});

it("goes back to its floor once it fits under the control, unsqueezed", async () => {
  await page.viewport(1440, 900);
  show();
  act(() => claimBottomChrome("scrolling-control", 160, { bottomPx: 40 }));
  await rest();
  const restingHeight = pileBox().height;

  // Scrolled until the control is high on the screen, far above the pile's
  // own height: the pile belongs back on its floor, below the control.
  for (let top = 160; top <= 760; top += 30) {
    act(() =>
      claimBottomChrome("scrolling-control", top, {
        bottomPx: top - 120,
        tracking: true,
      }),
    );
    await frame();
  }
  await rest();

  const box = pileBox();
  const floor = Number.parseFloat(
    window.getComputedStyle(
      document.querySelector<HTMLElement>("[data-notification-host]")!,
    ).bottom,
  );
  expect(Math.round(window.innerHeight - box.bottom)).toBe(Math.round(floor));
  // Below the control, clear of it…
  expect(window.innerHeight - box.top).toBeLessThanOrEqual(760 - 120);
  // …and not squeezed by a lane it no longer stands on.
  expect(box.height).toBeGreaterThanOrEqual(restingHeight - 1);
});

it("stands above a control that was there before its first card", async () => {
  await page.viewport(1440, 900);
  render(
    <MemoryRouter>
      <NotificationHost />
    </MemoryRouter>,
  );
  // The corner is taken while the pile is still empty — when it would fit
  // anywhere — and the cards only arrive afterwards.
  act(() => claimBottomChrome("scrolling-control", 202, { bottomPx: 5 }));
  await rest();
  act(() => {
    for (const title of ["Mad Max: Fury Road", "Dune", "Arcane"]) {
      notify({ title, tone: "progress", life: "persistent" });
    }
  });
  await rest();
  expect(Math.round(window.innerHeight - pileBox().bottom)).toBe(202);
});
