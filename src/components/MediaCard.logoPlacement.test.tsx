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
    `https://media.test/${itemId}/poster.jpg`,
}));

function movie(placement?: MediaItem["LogoPlacement"]): MediaItem {
  return {
    Id: "item-1",
    Name: "Dune",
    Type: "Movie",
    ProductionYear: 2021,
    ImageTags: { Primary: "p", Logo: "l" },
    ...(placement ? { LogoPlacement: placement } : {}),
  } as MediaItem;
}

function renderCard(item: MediaItem) {
  return render(
    <MemoryRouter>
      <MediaCard item={item} to="/movies/item-1" />
    </MemoryRouter>,
  );
}

/**
 * The card's logo, whichever layer it ended up in. Selected by source because
 * the poster underneath carries the same alt text.
 */
function logos(): HTMLImageElement[] {
  return screen
    .getAllByAltText("Dune")
    .filter((element): element is HTMLImageElement =>
      element.getAttribute("src")?.endsWith("logo.png") ?? false,
    );
}

function logo(): HTMLImageElement {
  const found = logos();
  expect(found).toHaveLength(1);
  return found[0] as HTMLImageElement;
}

describe("media card logo placement", () => {
  it("keeps an unconfigured logo in the block with the year tag", () => {
    // This is where every logo already sat, so nothing about a title nobody has
    // touched may move.
    renderCard(movie());

    const container = logo().parentElement;
    expect(container?.className).toContain("-bottom-0");
    expect(container?.textContent).toContain("2021");
  });

  it("lifts a top-placed logo into its own layer at the top of the card", () => {
    renderCard(movie("top"));

    const container = logo().parentElement;
    expect(container?.className).toContain("top-0");
    // It must leave the tag block behind rather than being drawn twice.
    expect(container?.textContent).not.toContain("2021");
  });

  it("centres a middle-placed logo", () => {
    renderCard(movie("middle"));

    expect(logo().parentElement?.className).toContain("-translate-y-1/2");
  });

  it("still shows the year tag when the logo has moved away from it", () => {
    // The tags belong at the foot of the card whatever the logo does; moving
    // the logo must not take them with it.
    renderCard(movie("top"));
    expect(screen.getByText("2021")).toBeInTheDocument();
  });
});
