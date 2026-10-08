import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../lib/types";
import { MobileMediaCard } from "./MobileMediaCard";

vi.mock("framer-motion", () => ({
  motion: {
    article: ({
      children,
      layout: _layout,
      exit: _exit,
      ...props
    }: React.HTMLAttributes<HTMLElement> & {
      layout?: unknown;
      exit?: unknown;
    }) => <article {...props}>{children}</article>,
  },
  useReducedMotion: () => false,
}));

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key: string) => key }),
}));

vi.mock("../../lib/mediaApi", () => ({
  getLogoImageUrl: (itemId: string) => `https://media.test/${itemId}/logo.png`,
  getPrimaryImageUrl: (itemId: string) =>
    `https://media.test/${itemId}/poster.jpg`,
  getThumbImageUrl: (itemId: string) =>
    `https://media.test/${itemId}/thumb.jpg`,
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

function logo(): HTMLImageElement {
  const found = screen
    .getAllByAltText("Dune")
    .filter((element) => element.getAttribute("src")?.endsWith("logo.png"));
  expect(found).toHaveLength(1);
  return found[0] as HTMLImageElement;
}

function renderCard(item: MediaItem, variant?: "poster" | "landscape") {
  render(
    <MemoryRouter>
      <MobileMediaCard item={item} to="/movies/item-1" variant={variant} />
    </MemoryRouter>,
  );
}

describe("a phone poster card's logo", () => {
  it("stands where the artwork tool placed it, at that size", () => {
    renderCard(movie({ x: 0.5, y: 0.13, width: 0.86, shadow: 1.4 }));
    const placed = logo().closest('[data-logo-layout="true"]') as HTMLElement;
    expect(placed).not.toBeNull();
    expect(placed.style.left).toBe("50%");
    expect(placed.style.top).toBe("13%");
    // Padded by the shadow's reach, so its 86% logo box holds all of it.
    expect(placed.style.width).toMatch(/^calc\(86% \+ \d+px\)$/);
    expect(placed.style.padding).not.toBe("");
    const shadow = logo().closest('[data-logo-shadow="true"]') as HTMLElement;
    expect(shadow.style.filter).toContain("drop-shadow");
    expect(shadow.style.padding).not.toBe("");
    expect(logo().style.filter).toBe("");
  });

  it("keeps its foot placement when it was never placed", () => {
    renderCard(movie());
    expect(logo().closest('[data-logo-layout="true"]')).toBeNull();
  });

  it("keeps its foot placement on a landscape tile", () => {
    renderCard(movie({ x: 0.5, y: 0.13, width: 0.86, shadow: 1 }), "landscape");
    expect(logo().closest('[data-logo-layout="true"]')).toBeNull();
  });
});
