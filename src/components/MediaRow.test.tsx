import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";
import { MediaRow } from "./MediaRow";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => false,
}));

vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./AnimatedText", () => ({
  AnimatedText: ({ value }: { value: string }) => value,
}));

vi.mock("./AnimatedWidth", () => ({
  AnimatedWidth: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("./MotionReveal", () => ({
  MotionReveal: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("./MediaCard", () => ({
  MediaCard: ({ item }: { item: MediaItem }) => (
    <div data-testid="media-card">{item.Name}</div>
  ),
}));

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

describe("MediaRow", () => {
  it("keeps the hover paint gutter on a track inside the scroller", () => {
    const item: MediaItem = {
      Id: "movie-1",
      Name: "Movie",
      Type: "Movie",
    };

    const { container } = render(
      <MemoryRouter>
        <MediaRow
          title="Latest"
          items={[item]}
          getItemTo={(mediaItem) => `/movies/${mediaItem.Id}`}
        />
      </MemoryRouter>,
    );

    const scroller = container.querySelector(".media-row-scroll");
    const track = container.querySelector(".media-row-scroll-track");

    expect(scroller).toBeInTheDocument();
    expect(track).toBeInTheDocument();
    expect(track?.parentElement).toBe(scroller);
    expect(scroller?.firstElementChild).toBe(track);
  });
});
