import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MediaCard } from "../components/MediaCard";
import type { JellyfinItem } from "../lib/types";

// 1. Mock the Jellyfin API URL builders
vi.mock("../lib/jellyfinApi", () => ({
  getPrimaryImageUrl: vi.fn((id) => `/mock-primary-${id}.jpg`),
  getLogoImageUrl: vi.fn((id) => `/mock-logo-${id}.png`),
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

  it("renders a play button overlay for playable items", () => {
    render(
      <MemoryRouter>
        <MediaCard item={mockMovie} to={`/item/${mockMovie.Id}`} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("common.play The Matrix")).toBeInTheDocument();
  });
});
