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

function movie(layout?: MediaItem["LogoLayout"]): MediaItem {
  return {
    Id: "item-1",
    Name: "Dune",
    Type: "Movie",
    ProductionYear: 2021,
    ImageTags: { Primary: "p", Logo: "l" },
    ...(layout ? { LogoLayout: layout } : {}),
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

describe("media card logo layout", () => {
  it("keeps an unadjusted logo in the block with the year tag", () => {
    // This is where every logo already sat, so nothing about a title nobody has
    // touched may move.
    renderCard(movie());

    const container = logo().parentElement;
    expect(container?.className).toContain("-bottom-0");
    expect(container?.textContent).toContain("2021");
  });

  it("places an adjusted logo where the layout puts it", () => {
    renderCard(movie({ x: 0.25, y: 0.4, width: 0.6 }));

    const style = logo().style;
    expect(style.left).toBe("25%");
    expect(style.top).toBe("40%");
    expect(style.width).toBe("60%");
    // Anchored by its centre, which is what makes dragging track the pointer.
    expect(style.transform).toBe("translate(-50%, -50%)");
  });

  it("draws an adjusted logo once, outside the tag block", () => {
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5 }));

    expect(logos()).toHaveLength(1);
    // The block at the foot of the card owns the tags and their gradient; an
    // adjusted logo has to have left it rather than be drawn in both places.
    const tagBlock = screen.getByText("2021").closest(".-bottom-0");
    expect(tagBlock).not.toBeNull();
    expect(tagBlock?.contains(logo())).toBe(false);
  });

  it("still shows the year tag when the logo has moved away from it", () => {
    // The tags belong at the foot of the card whatever the logo does; moving
    // the logo must not take them with it.
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5 }));
    expect(screen.getByText("2021")).toBeInTheDocument();
  });
});
