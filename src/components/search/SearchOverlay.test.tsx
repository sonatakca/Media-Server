import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLatestMediaItems, searchItems } from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";
import { SearchOverlay } from "./SearchOverlay";

const navigate = vi.fn();

vi.mock("../../lib/mediaApi", () => ({
  searchItems: vi.fn(),
  getLatestMediaItems: vi.fn(),
  getPrimaryImageUrl: (id: string) => `primary:${id}`,
  getThumbImageUrl: (id: string) => `thumb:${id}`,
  getLogoImageUrl: (id: string) => `logo:${id}`,
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
        "search.suggestions": "Suggestions",
      })[key] ?? key,
  }),
}));

const mockedSearchItems = vi.mocked(searchItems);
const mockedGetLatestMediaItems = vi.mocked(getLatestMediaItems);

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
    mockedGetLatestMediaItems.mockReset();
    mockedGetLatestMediaItems.mockResolvedValue([]);
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

    fireEvent.change(input, { target: { value: "a".repeat(3) } });
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

  it("offers recently added titles before anything is typed", async () => {
    mockedGetLatestMediaItems.mockResolvedValue([
      item("movie-1", "Arrival", "Movie"),
      item("series-1", "Severance", "Series"),
    ]);

    renderOverlay();

    await waitFor(() => {
      expect(screen.getByText("Suggestions")).toBeInTheDocument();
    });

    expect(screen.getByText("Arrival")).toBeInTheDocument();
    expect(screen.getByText("Severance")).toBeInTheDocument();
    // Suggestions are one list, not split by kind.
    expect(screen.queryByText("Movies")).not.toBeInTheDocument();
    expect(mockedSearchItems).not.toHaveBeenCalled();
  });

  it("opens a suggestion with the keyboard", async () => {
    mockedGetLatestMediaItems.mockResolvedValue([
      item("movie-1", "Arrival", "Movie"),
    ]);

    renderOverlay();

    await waitFor(() => {
      expect(screen.getByText("Arrival")).toBeInTheDocument();
    });

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith("/movies/movie-1");
  });

  it("falls back to the hint when suggestions cannot be loaded", async () => {
    mockedGetLatestMediaItems.mockRejectedValue(new Error("offline"));

    renderOverlay();

    await waitFor(() => {
      expect(screen.getByText("Start typing")).toBeInTheDocument();
    });
  });

  it("gives an episode its own still, and a movie its poster", async () => {
    mockedSearchItems.mockResolvedValue([
      {
        ...item("movie-1", "Arrival", "Movie"),
        ImageTags: { Primary: "poster-tag" },
      },
      {
        ...item("episode-1", "Pilot", "Episode"),
        ImageTags: { Primary: "still-tag" },
      },
    ]);

    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arr" },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(screen.getByText("Pilot")).toBeInTheDocument();
    });

    const episodeArtwork = screen
      .getByText("Pilot")
      .closest("button")
      ?.querySelector("span > img");
    const movieArtwork = screen
      .getByText("Arrival")
      .closest("button")
      ?.querySelector("span > img");

    // The episode shows its own frame, not the series poster.
    expect(episodeArtwork).toHaveAttribute("src", "primary:episode-1");
    expect(episodeArtwork?.parentElement?.className).toContain("aspect-video");
    expect(movieArtwork?.parentElement?.className).toContain("aspect-[2/3]");
  });
});
