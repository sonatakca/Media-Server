import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeriesLibraryDetails } from "./SeriesLibraryDetails";
import type { JellyfinItem } from "../lib/types";

vi.mock("../lib/jellyfinApi", () => ({
  getAllSeriesEpisodes: vi.fn(() => Promise.resolve([])),
  getItem: vi.fn(),
  getLocalTrailers: vi.fn(() =>
    Promise.resolve([
      {
        Id: "trailer-1",
        Name: "Trailer",
        Type: "Video",
        MediaType: "Video",
      },
    ]),
  ),
  getLogoImageUrl: vi.fn(() => "/logo.png"),
  getPrimaryImageUrl: vi.fn(() => "/primary.jpg"),
  getSeasonEpisodes: vi.fn(() => Promise.resolve([])),
  getSeriesSeasons: vi.fn(() => Promise.resolve([])),
  getSimilarItems: vi.fn(() =>
    Promise.resolve([
      {
        Id: "similar-1",
        Name: "Similar Movie",
        Type: "Movie",
      },
    ]),
  ),
}));

vi.mock("../lib/pageTitle", () => ({
  setPageTitle: vi.fn(),
}));

vi.mock("../i18n/LanguageContext", () => {
  const messages: Record<string, string> = {
    "details.noOverview": "No overview.",
    "format.hourShort": "h",
    "format.minuteShort": "m",
    "media.episodeCardTitle": "Episode {number}",
    "media.episodePlural": "{count} episodes",
    "media.episodeSingular": "1 episode",
    "media.seasonNumber": "Season {number}",
    "media.seasonPlural": "{count} seasons",
    "media.seasonSingular": "1 season",
  };

  return {
    useLanguage: () => ({
      language: "en",
      t: (key: string) => messages[key] ?? key,
    }),
  };
});

vi.mock("./MotionReveal", () => ({
  MotionReveal: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

vi.mock("./MediaCard", () => ({
  MediaCard: ({ item }: { item: JellyfinItem }) => <div>{item.Name}</div>,
}));

vi.mock("./mobile/MobileMediaCard", () => ({
  MobileMediaCard: ({ item }: { item: JellyfinItem }) => <div>{item.Name}</div>,
}));

describe("SeriesLibraryDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    class ResizeObserverMock {
      observe = vi.fn();
      disconnect = vi.fn();
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  it("renders movie details without the series-only season and episode shelf", async () => {
    const movie: JellyfinItem = {
      Id: "movie-1",
      Name: "Example Movie",
      Type: "Movie",
      Overview: "Movie overview",
      Genres: ["Drama"],
      Studios: [{ Name: "Example Studio" }],
      People: [
        {
          Id: "person-1",
          Name: "Example Actor",
          Role: "Lead",
          Type: "Actor",
        },
      ],
    } as JellyfinItem;

    render(
      <MemoryRouter>
        <SeriesLibraryDetails
          initialItem={movie}
          variant="desktop"
          canonicalPath="/library/movie-1"
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "Scroll Trailers left" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Scroll Similar left" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Cast and crew")).toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
    expect(screen.getByText("Movie overview")).toBeInTheDocument();
    expect(screen.getByText("Example Actor")).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Scroll Episodes left" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select season")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No episodes were found for this season."),
    ).not.toBeInTheDocument();
  });
});
