// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeAll } from "vitest";
import { SwapText, splitSwappableValue } from "./SwapText";

/**
 * The label a quality menu keeps rewriting.
 *
 * "Otomatik (2160p HDR)" changes whenever the rung does, so the animation has
 * to survive being retriggered rather than assume it gets a quiet second to
 * finish.
 */

beforeAll(() => {
  // jsdom has no matchMedia; the component asks it about reduced motion.
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  }
});

describe("choosing which part of a label changes", () => {
  /** The stable name stays put; only the bracketed reading is exchanged. */
  it("separates a trailing bracketed reading from the name", () => {
    expect(splitSwappableValue("Otomatik (2160p HDR)")).toEqual({
      stable: "Otomatik ",
      swapped: "(2160p HDR)",
    });
  });

  /** A bare subtitle has no stable half, so all of it is the changing part. */
  it("treats a label with no brackets as entirely changeable", () => {
    expect(splitSwappableValue("1080p HDR")).toEqual({
      stable: "",
      swapped: "1080p HDR",
    });
  });

  /** Brackets that are the whole label are still the changing part. */
  it("does not leave an empty name in front of a bracketed value", () => {
    expect(splitSwappableValue("(720p HDR)")).toEqual({
      stable: "",
      swapped: "(720p HDR)",
    });
  });

  it("ignores brackets that are not at the end", () => {
    expect(splitSwappableValue("Auto (HDR) preview")).toEqual({
      stable: "",
      swapped: "Auto (HDR) preview",
    });
  });
});

describe("swapping a value in place", () => {
  it("shows the value it is given", () => {
    const { container } = render(<SwapText value="Otomatik (2160p HDR)" />);
    expect(container.textContent).toBe("Otomatik (2160p HDR)");
  });

  /** The name is rendered once and never re-animated. */
  it("keeps the stable name outside the fading part", () => {
    const { container, rerender } = render(
      <SwapText value="Otomatik (2160p HDR)" />,
    );
    rerender(<SwapText value="Otomatik (1080p HDR)" />);

    // "Otomatik " appears exactly once even while two readings overlap.
    expect(container.textContent?.match(/Otomatik/g)).toHaveLength(1);
    expect(container.textContent).toContain("(1080p HDR)");
  });

  it("shows the new value after a change", () => {
    const { rerender } = render(<SwapText value="2160p HDR" />);
    rerender(<SwapText value="1080p HDR" />);

    // Both may be present for the length of the swap; the accessible name is
    // always the current one, so a screen reader never hears the old value.
    expect(screen.getByLabelText("1080p HDR")).toBeTruthy();
  });

  /**
   * A label refreshed on a timer hands back the same string constantly. If
   * that restarted the movement the text would never come to rest — which is
   * exactly what made the per-character animation unreadable here.
   */
  it("does not restart when handed the same value again", () => {
    const { container, rerender } = render(<SwapText value="1080p HDR" />);
    const settled = container.innerHTML;

    rerender(<SwapText value="1080p HDR" />);
    rerender(<SwapText value="1080p HDR" />);

    expect(container.innerHTML).toBe(settled);
  });

  it("renders plain text when motion is reduced", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    const { container } = render(<SwapText value="720p HDR" />);
    expect(container.textContent).toBe("720p HDR");
    // One layer only: nothing is translated or faded.
    expect(container.querySelectorAll("span")).toHaveLength(1);

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  });
});
