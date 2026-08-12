import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";
import { MediaCard } from "./MediaCard";

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => false,
}));

vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key: string) => key }),
}));

vi.mock("../lib/mediaApi", () => ({
  getLogoImageUrl: (itemId: string) => `https://media.test/${itemId}/logo.png`,
  getPrimaryImageUrl: (itemId: string) =>
    `https://media.test/${itemId}/primary.jpg`,
  getThumbImageUrl: (itemId: string) =>
    `https://media.test/${itemId}/thumb.jpg`,
}));

function renderCard(item: MediaItem, variant: "poster" | "landscape") {
  return render(
    <MemoryRouter>
      <MediaCard item={item} to="/watch/x" variant={variant} />
    </MemoryRouter>,
  );
}

function sources(): string[] {
  return screen
    .getAllByRole("img", { hidden: true })
    .map((image) => image.getAttribute("src") ?? "");
}

describe("episode artwork", () => {
  it("shows the episode still, which is stored as a thumb", () => {
    // An episode has no poster of its own. Looking only for a primary image
    // left every episode card blank while the still sat in the catalogue.
    renderCard(
      {
        Id: "episode-1",
        Name: "Pilot",
        Type: "Episode",
        SeriesId: "series-1",
        ImageTags: { Thumb: "t" },
      } as MediaItem,
      "landscape",
    );

    expect(sources()).toContain("https://media.test/episode-1/thumb.jpg");
  });

  it("uses the episode's own still, not the series poster it could borrow", () => {
    // An episode carries the series poster separately for the vertical case;
    // a wide card must not fall back to it while the still exists.
    renderCard(
      {
        Id: "episode-1",
        Name: "Pilot",
        Type: "Episode",
        SeriesId: "series-1",
        SeriesPrimaryImageTag: "sp",
        ImageTags: { Thumb: "t" },
      } as MediaItem,
      "landscape",
    );

    expect(sources()).toContain("https://media.test/episode-1/thumb.jpg");
    expect(sources()).not.toContain("https://media.test/series-1/primary.jpg");
  });

  it("still prefers a poster for anything that has one", () => {
    renderCard(
      {
        Id: "movie-1",
        Name: "Dune",
        Type: "Movie",
        ImageTags: { Primary: "p", Thumb: "t" },
      } as MediaItem,
      "poster",
    );

    expect(sources()).toContain("https://media.test/movie-1/primary.jpg");
    expect(sources()).not.toContain("https://media.test/movie-1/thumb.jpg");
  });

  it("falls back to a thumb for a non-episode that has no poster", () => {
    renderCard(
      {
        Id: "series-1",
        Name: "The Sopranos",
        Type: "Series",
        ImageTags: { Thumb: "t" },
      } as MediaItem,
      "poster",
    );

    expect(sources()).toContain("https://media.test/series-1/thumb.jpg");
  });
});
