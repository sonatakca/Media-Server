import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBackdropImageUrl,
  getItem,
  getLogoImageUrl,
  getPrimaryImageUrl,
} from "../lib/jellyfinApi";
import type { JellyfinItem } from "../lib/types";
import { DesktopItemDetailsPage } from "./desktop/DesktopItemDetailsPage";
import { MobileItemDetailsPage } from "./mobile/MobileItemDetailsPage";

vi.mock("../lib/jellyfinApi", () => ({
  getBackdropImageUrl: vi.fn(() => "/backdrop.jpg"),
  getAllMovieAndSeriesItems: vi.fn(),
  getItem: vi.fn(),
  getLogoImageUrl: vi.fn(() => "/logo.png"),
  getPrimaryImageUrl: vi.fn(() => "/primary.jpg"),
}));

vi.mock("../lib/seo", () => ({
  setSeoMetadata: vi.fn(),
}));

vi.mock("../components/MotionReveal", () => ({
  MotionReveal: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../i18n/LanguageContext", () => {
  const messages: Record<string, string> = {
    "common.trailer": "Trailer",
    "details.trailerTitle": "{title} Trailer",
  };
  const t = (key: string) => messages[key] ?? key;

  return {
    useLanguage: () => ({ language: "en", t }),
  };
});

const episode: JellyfinItem = {
  Id: "episode-1",
  Name: "Aşk Ölümden Güçlüdür",
  Type: "Episode",
  SeriesName: "Ezel",
  SeriesId: "series-1",
  SeasonId: "season-1",
  ParentIndexNumber: 1,
  IndexNumber: 3,
  ParentLogoItemId: "series-1",
  ParentLogoImageTag: "logo-tag",
};

const movie: JellyfinItem = {
  Id: "movie-1",
  Name: "Film",
  Type: "Movie",
  ImageTags: {
    Logo: "logo-tag",
  },
};

function renderDetailsPage(
  Page: typeof DesktopItemDetailsPage | typeof MobileItemDetailsPage,
  item: JellyfinItem,
) {
  vi.mocked(getItem).mockResolvedValue(item);

  return render(
    <MemoryRouter initialEntries={[`/item/${item.Id}`]}>
      <Routes>
        <Route path="/item/:itemId" element={<Page />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderDetailsPageById(
  Page: typeof DesktopItemDetailsPage | typeof MobileItemDetailsPage,
  itemId: string,
) {
  return render(
    <MemoryRouter initialEntries={[`/item/${itemId}`]}>
      <Routes>
        <Route path="/item/:itemId" element={<Page />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("episode item details navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links the desktop episode logo to its series and code to its season", async () => {
    renderDetailsPage(DesktopItemDetailsPage, episode);

    expect(
      await screen.findByRole("link", { name: "Go to Ezel" }),
    ).toHaveAttribute("href", "/library/series-1");
    expect(screen.getByRole("link", { name: "Go to S1E3" })).toHaveAttribute(
      "href",
      "/library/season-1",
    );
  });

  it("links the mobile episode logo to its series and code to its season", async () => {
    renderDetailsPage(MobileItemDetailsPage, episode);

    expect(
      await screen.findByRole("link", { name: "Go to Ezel" }),
    ).toHaveAttribute("href", "/library/series-1");
    expect(screen.getByRole("link", { name: "Go to S1E3" })).toHaveAttribute(
      "href",
      "/library/season-1",
    );
  });

  it("does not add episode-context navigation to movies", async () => {
    const { unmount } = renderDetailsPage(DesktopItemDetailsPage, movie);

    await screen.findAllByText("Film");
    expect(
      screen.queryByRole("link", { name: /^Go to / }),
    ).not.toBeInTheDocument();

    unmount();
    renderDetailsPage(MobileItemDetailsPage, movie);

    await screen.findAllByText("Film");
    expect(
      screen.queryByRole("link", { name: /^Go to / }),
    ).not.toBeInTheDocument();
  });

  it("inherits desktop trailer metadata and artwork from its owner", async () => {
    const owner: JellyfinItem = {
      Id: "dune",
      Name: "Dune",
      Type: "Movie",
      ProductionYear: 2021,
      Overview: "Owner overview",
      Genres: ["Sci-Fi"],
      OfficialRating: "PG-13",
      CommunityRating: 8.1,
      ImageTags: {
        Primary: "owner-primary",
        Logo: "owner-logo",
      },
      BackdropImageTags: ["owner-backdrop"],
    };
    const trailer: JellyfinItem = {
      Id: "trailer-1",
      Name: "Trailer",
      Type: "Video",
      MediaType: "Video",
      ExtraType: "Trailer",
      ParentId: owner.Id,
      Path: "D:\\Media\\Movies\\Dune (2021)\\trailers\\trailer.mp4",
      ProductionYear: 1988,
      Overview: "Wrong trailer overview",
      Genres: ["Wrong"],
      ImageTags: {
        Primary: "trailer-primary",
        Logo: "trailer-logo",
      },
      BackdropImageTags: ["trailer-backdrop"],
      RunTimeTicks: 120_000_000,
    };

    vi.mocked(getItem).mockImplementation(async (itemId) =>
      itemId === owner.Id ? owner : trailer,
    );

    renderDetailsPageById(DesktopItemDetailsPage, trailer.Id);

    expect(await screen.findAllByAltText("Dune Trailer")).not.toHaveLength(0);
    expect(screen.getByText("Owner overview")).toBeInTheDocument();
    expect(screen.getAllByText("Sci-Fi").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2021").length).toBeGreaterThan(0);
    expect(screen.getAllByText("PG-13").length).toBeGreaterThan(0);
    expect(screen.getAllByText("8.1").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("Wrong trailer overview"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Wrong")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(getPrimaryImageUrl).toHaveBeenCalledWith(
        owner.Id,
        "owner-primary",
        760,
      );
      expect(getBackdropImageUrl).toHaveBeenCalledWith(
        owner.Id,
        "owner-backdrop",
        1800,
      );
      expect(getLogoImageUrl).toHaveBeenCalledWith(
        owner.Id,
        "owner-logo",
        1100,
      );
    });
    expect(getPrimaryImageUrl).not.toHaveBeenCalledWith(
      trailer.Id,
      "trailer-primary",
      760,
    );
  });
});
