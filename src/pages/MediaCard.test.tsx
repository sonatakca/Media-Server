import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MediaCard } from "../components/MediaCard";
import { clearContinueWatchingHistory } from "../lib/continueWatchingActions";
import type { JellyfinItem } from "../lib/types";

// 1. Mock the Jellyfin API URL builders
vi.mock("../lib/jellyfinApi", () => ({
  getPrimaryImageUrl: vi.fn((id) => `/mock-primary-${id}.jpg`),
  getLogoImageUrl: vi.fn((id) => `/mock-logo-${id}.png`),
}));

vi.mock("../lib/continueWatchingActions", () => ({
  clearContinueWatchingHistory: vi.fn(),
}));

// 2. Mock the Language Context
vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
    language: "en",
  }),
}));

// 3. Mock Framer Motion to prevent animation delays in tests
vi.mock("framer-motion", () => ({
  motion: {
    div: ({
      children,
      whileTap,
      initial,
      whileInView,
      viewport,
      transition,
      ...props
    }: any) => <div {...props}>{children}</div>,
    img: ({
      whileTap,
      initial,
      whileInView,
      viewport,
      transition,
      ...props
    }: any) => <img {...props} />,
    span: ({ children, initial, animate, transition, ...props }: any) => (
      <span {...props}>{children}</span>
    ),
  },
  useReducedMotion: () => true,
}));

const mockMovie: JellyfinItem = {
  Id: "movie-123",
  Name: "The Matrix",
  Type: "Movie",
  ProductionYear: 1999,
  ImageTags: {
    Primary: "primary-tag-abc",
  },
};

describe("MediaCard Component", () => {
  it("renders the movie title and primary image", () => {
    render(
      <MemoryRouter>
        <MediaCard item={mockMovie} to={`/item/${mockMovie.Id}`} />
      </MemoryRouter>,
    );

    // Check title rendering
    expect(screen.getAllByText("The Matrix").length).toBeGreaterThan(0);

    // Check that the image source is built properly
    const image = screen.getByAltText("The Matrix");
    expect(image).toHaveAttribute("src", "/mock-primary-movie-123.jpg");
  });

  it("shows a clear watched indicator for completed items", () => {
    render(
      <MemoryRouter>
        <MediaCard
          item={{ ...mockMovie, UserData: { Played: true } }}
          to={`/item/${mockMovie.Id}`}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("details.watched")).toBeInTheDocument();
  });

  it("shows a full progress bar for items Jellyfin marks played", () => {
    render(
      <MemoryRouter>
        <MediaCard
          item={{ ...mockMovie, UserData: { Played: true } }}
          to={`/item/${mockMovie.Id}`}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("media-card-progress-fill")).toHaveStyle({
      width: "100%",
    });
  });

  it("offers to mark incomplete playable items as watched", () => {
    render(
      <MemoryRouter>
        <MediaCard
          item={mockMovie}
          to={`/item/${mockMovie.Id}`}
          onWatchedStatusReset={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("button", { name: "details.markWatchedStatus" }),
    ).toBeInTheDocument();
  });

  it("renders a collection mosaic when a BoxSet has no primary image", () => {
    const collection: JellyfinItem = {
      Id: "collection-1",
      Name: "Example Collection",
      Type: "BoxSet",
    };
    const collectionItems: JellyfinItem[] = [
      {
        Id: "movie-1",
        Name: "Example",
        Type: "Movie",
        ImageTags: { Primary: "poster-1" },
      },
      {
        Id: "movie-2",
        Name: "Example 2",
        Type: "Movie",
        ImageTags: { Primary: "poster-2" },
      },
    ];

    render(
      <MemoryRouter>
        <MediaCard
          item={collection}
          to={`/library/${collection.Id}`}
          collectionItems={collectionItems}
        />
      </MemoryRouter>,
    );

    expect(screen.getByAltText("Example")).toHaveAttribute(
      "src",
      "/mock-primary-movie-1.jpg",
    );
    expect(screen.getByAltText("Example 2")).toHaveAttribute(
      "src",
      "/mock-primary-movie-2.jpg",
    );
  });

  it("renders a play button overlay for playable items", () => {
    render(
      <MemoryRouter>
        <MediaCard item={mockMovie} to={`/item/${mockMovie.Id}`} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("common.play The Matrix")).toBeInTheDocument();
  });

  it("renders start over only when a continue-watching row opts in", () => {
    const { rerender } = render(
      <MemoryRouter>
        <MediaCard item={mockMovie} to={`/item/${mockMovie.Id}`} />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole("button", { name: "home.startOver The Matrix" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "home.clearHistory The Matrix",
      }),
    ).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <MediaCard
          item={mockMovie}
          to={`/item/${mockMovie.Id}`}
          showRestartWatching
          onClearContinueWatching={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("button", { name: "home.startOver The Matrix" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "home.clearHistory The Matrix" }),
    ).toBeInTheDocument();
  });

  it("uses the shared clear workflow for both continue-watching actions", async () => {
    const user = userEvent.setup();
    const onClearContinueWatching = vi.fn();

    vi.mocked(clearContinueWatchingHistory).mockResolvedValue(mockMovie);

    render(
      <MemoryRouter>
        <MediaCard
          item={mockMovie}
          to={`/item/${mockMovie.Id}`}
          showRestartWatching
          onClearContinueWatching={onClearContinueWatching}
        />
      </MemoryRouter>,
    );

    await user.click(
      screen.getByRole("button", { name: "home.clearHistory The Matrix" }),
    );
    await user.click(
      screen.getByRole("button", { name: "home.startOver The Matrix" }),
    );

    expect(clearContinueWatchingHistory).toHaveBeenCalledTimes(2);
    expect(clearContinueWatchingHistory).toHaveBeenNthCalledWith(1, mockMovie);
    expect(clearContinueWatchingHistory).toHaveBeenNthCalledWith(2, mockMovie);
    expect(onClearContinueWatching).toHaveBeenCalledWith(mockMovie);
  });
});
