import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedWidth } from "./AnimatedWidth";

type Observed = { callback: ResizeObserverCallback; target?: Element };

describe("AnimatedWidth", () => {
  let observers: Observed[] = [];
  let measured = 100;

  beforeEach(() => {
    observers = [];
    measured = 100;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private entry: Observed;
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        disconnect() {
          observers = observers.filter((o) => o !== this.entry);
        }
        unobserve() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: measured }) as DOMRect,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const frame = (container: HTMLElement) =>
    container.firstElementChild as HTMLElement;

  it("sizes the frame to the measured text", () => {
    const { container } = render(
      <AnimatedWidth value="Continue Watching">Continue Watching</AnimatedWidth>,
    );
    expect(frame(container).style.width).toBe("104px");
  });

  it("re-measures when the text changes size without its value changing", () => {
    // The web font swaps in over the fallback: same words, wider glyphs.
    const { container } = render(
      <AnimatedWidth value="İzlemeye Devam Et">İzlemeye Devam Et</AnimatedWidth>,
    );
    expect(frame(container).style.width).toBe("104px");

    measured = 160;
    act(() => {
      for (const o of observers) o.callback([], {} as ResizeObserver);
    });
    expect(frame(container).style.width).toBe("164px");
  });

  it("stops observing once unmounted", () => {
    const { unmount } = render(<AnimatedWidth value="Films">Films</AnimatedWidth>);
    expect(observers).toHaveLength(1);
    unmount();
    expect(observers).toHaveLength(0);
  });
});
