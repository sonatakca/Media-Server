import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginLoadingActivity } from "../lib/loadingActivity";
import { NavbarWordmark, WORDMARK_FRAME_MS } from "./NavbarWordmark";

function shownAccent(container: HTMLElement): string | null {
  return container
    .querySelector("[data-wordmark-accent]")!
    .getAttribute("data-wordmark-accent");
}

function advanceFrames(count: number) {
  act(() => {
    vi.advanceTimersByTime(WORDMARK_FRAME_MS * count);
  });
}

describe("NavbarWordmark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.dataset.accentTheme = "Gold";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset.accentTheme;
  });

  it("rests on the accent colour when nothing is loading", () => {
    const { container } = render(<NavbarWordmark />);

    expect(shownAccent(container)).toBe("Gold");
    advanceFrames(12);
    expect(shownAccent(container)).toBe("Gold");
  });

  it("cycles in palette order while loading and comes round to the accent", () => {
    const { container } = render(<NavbarWordmark />);
    let end = () => {};
    act(() => {
      end = beginLoadingActivity();
    });

    advanceFrames(1);
    expect(shownAccent(container)).toBe("Olive");
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Green");
    advanceFrames(2);
    expect(shownAccent(container)).toBe("Warm Red");

    act(() => end());
    // Still mid-lap: it keeps going rather than snapping back.
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Amber");
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Gold");
    advanceFrames(6);
    expect(shownAccent(container)).toBe("Gold");
  });

  it("does not animate for a load shorter than one frame", () => {
    const { container } = render(<NavbarWordmark />);

    act(() => {
      const end = beginLoadingActivity();
      end();
    });
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Gold");
  });

  it("follows an accent change", async () => {
    const { container } = render(<NavbarWordmark />);

    await act(async () => {
      document.documentElement.dataset.accentTheme = "Teal";
      await Promise.resolve();
    });
    expect(shownAccent(container)).toBe("Teal");
  });
});
