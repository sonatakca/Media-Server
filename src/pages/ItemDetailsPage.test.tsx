import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getItem } from "../lib/jellyfinApi";
import type { JellyfinItem } from "../lib/types";
import { DesktopItemDetailsPage } from "./desktop/DesktopItemDetailsPage";
import { MobileItemDetailsPage } from "./mobile/MobileItemDetailsPage";

vi.mock("../lib/jellyfinApi", () => ({
  getBackdropImageUrl: vi.fn(() => "/backdrop.jpg"),
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
  const t = (key: string) => key;

  return {
    useLanguage: () => ({ t }),
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
});
