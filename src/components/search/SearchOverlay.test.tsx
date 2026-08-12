import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchItems } from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";
import { SearchOverlay } from "./SearchOverlay";

const navigate = vi.fn();

vi.mock("../../lib/mediaApi", () => ({
  searchItems: vi.fn(),
  getPrimaryImageUrl: () => "",
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );

  return { ...actual, useNavigate: () => navigate };
});

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        "search.title": "Search",
        "search.placeholder": "Search media",
        "search.close": "Close search",
        "search.hint": "Start typing",
        "search.noResults": "No results for “{query}”.",
        "search.failed": "Search failed",
        "search.groupMovies": "Movies",
        "search.groupShows": "Shows",
        "search.groupEpisodes": "Episodes",
      })[key] ?? key,
  }),
}));

const mockedSearchItems = vi.mocked(searchItems);

function item(id: string, name: string, type: MediaItem["Type"]): MediaItem {
  return { Id: id, Name: name, Type: type };
}

function renderOverlay(onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <SearchOverlay isOpen onClose={onClose} />
    </MemoryRouter>,
  );

  return onClose;
}

describe("SearchOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedSearchItems.mockReset();
    navigate.mockReset();
  });

  it("waits for a searchable query before calling the API", async () => {
    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a" } });
    await vi.advanceTimersByTimeAsync(500);

    expect(mockedSearchItems).not.toHaveBeenCalled();
    expect(screen.getByText("Start typing")).toBeInTheDocument();
  });

  it("groups results by kind", async () => {
    mockedSearchItems.mockResolvedValue([
      item("episode-1", "Pilot", "Episode"),
      item("movie-1", "Arrival", "Movie"),
      item("series-1", "Severance", "Series"),
    ]);

    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arr" },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(screen.getByText("Movies")).toBeInTheDocument();
    });

    expect(mockedSearchItems).toHaveBeenCalledWith("arr");
    expect(screen.getByText("Shows")).toBeInTheDocument();
    expect(screen.getByText("Episodes")).toBeInTheDocument();

    // Movies group renders before shows, which renders before episodes.
    const headings = screen
      .getAllByText(/^(Movies|Shows|Episodes)$/)
      .map((node) => node.textContent);
    expect(headings).toEqual(["Movies", "Shows", "Episodes"]);
  });

  it("opens the highlighted result on Enter", async () => {
    mockedSearchItems.mockResolvedValue([
      item("movie-1", "Arrival", "Movie"),
      item("movie-2", "Annihilation", "Movie"),
    ]);

    const onClose = renderOverlay();
    const input = screen.getByRole("searchbox");

    fireEvent.change(input, { target: { value: "a" .repeat(3) } });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(screen.getByText("Arrival")).toBeInTheDocument();
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith("/movies/movie-2");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const onClose = renderOverlay();

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("reports a failed search without clearing the query", async () => {
    mockedSearchItems.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arr" },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(screen.getByText("Search failed")).toBeInTheDocument();
    });

    warn.mockRestore();
  });
});
