import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";
import { getLogoShadowReach } from "../lib/logoLayout";
import { MediaCard } from "./MediaCard";

vi.mock("framer-motion", () => ({
  motion: {
    // The My List toggle morphs its strokes as motion paths.
    path: ({
      initial: _initial,
      animate,
      transition: _transition,
      ...props
    }: React.SVGProps<SVGPathElement> & {
      initial?: unknown;
      animate?: { d?: string };
      transition?: unknown;
    }) => <path {...props} d={animate?.d} />,
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
    .filter(
      (element): element is HTMLImageElement =>
        element.getAttribute("src")?.endsWith("logo.png") ?? false,
    );
}

function logo(): HTMLImageElement {
  const found = logos();
  expect(found).toHaveLength(1);
  return found[0] as HTMLImageElement;
}

/** The element the shadow is drawn on: around the logo, never the image. */
function logoShadow(): HTMLElement {
  const frame = logo().closest('[data-logo-shadow="true"]');
  expect(frame).not.toBeNull();
  return frame as HTMLElement;
}

function logoLayout(): HTMLElement {
  const layout = logo().closest('[data-logo-layout="true"]');
  expect(layout).not.toBeNull();
  return layout as HTMLElement;
}

describe("media card logo layout", () => {
  it("centres an unadjusted logo near the foot of the card", () => {
    renderCard(movie());

    expect(logoShadow().className).toContain("bottom-4");
    // Nothing else is drawn on the card: no gradient, no year, no rating.
    expect(screen.queryByText("2021")).toBeNull();
  });

  it("places an adjusted logo where the layout puts it", () => {
    renderCard(movie({ x: 0.25, y: 0.4, width: 0.6, shadow: 1 }));

    const style = logoLayout().style;
    expect(style.left).toBe("25%");
    expect(style.top).toBe("40%");
    // Widened and padded by the shadow's reach, so the logo's own box inside
    // stays 60% wide. On iPad this box becomes a layer as large as itself and
    // no larger, and a bare 60% box cut the shadow off at its edges.
    const reach = getLogoShadowReach(1);
    expect(reach).toBe(92);
    expect(style.width).toBe(`calc(60% + ${2 * reach}px)`);
    expect(style.padding).toBe(`${reach}px`);
    // Anchored by its centre, which is what makes dragging track the pointer.
    expect(style.transform).toBe("translate(-50%, -50%)");
  });

  it("draws the logo once", () => {
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5, shadow: 1 }));
    expect(logos()).toHaveLength(1);
  });

  it("shadows the logo, since nothing else separates it from the artwork", () => {
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5, shadow: 1 }));
    expect(logoShadow().style.filter).toContain("drop-shadow");
    // iOS WebKit can clip a filtered image to the image's own box, which drew
    // the shadow as a hard-edged rectangle. The frame is padded by the
    // shadow's reach and pulled back by as much, so it holds all of it.
    expect(logo().style.filter).toBe("");
    expect(logoShadow().style.padding).toBe("92px");
    expect(logoShadow().style.margin).toBe("-92px");
  });

  it("draws no shadow at all when it is turned off", () => {
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5, shadow: 0 }));
    expect(logoShadow().style.filter).toBe("");
  });

  it("deepens the shadow as the strength rises", () => {
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5, shadow: 2 }));
    expect(logoShadow().style.filter).toContain(
      "drop-shadow(0 0 2px rgba(0, 0, 0, 0.90))",
    );
    const backdrop = logoLayout().querySelector<HTMLElement>(
      "[data-logo-shadow-backdrop]",
    );
    expect(backdrop?.style.filter).toBe("");
    expect(backdrop?.style.background).toContain("rgba(0, 0, 0, 0.76) 0%");
  });

  it("falls back to the title when a card has no logo", () => {
    // A card with neither logo nor title would be unidentifiable.
    render(
      <MemoryRouter>
        <MediaCard
          item={
            {
              Id: "item-2",
              Name: "Arrival",
              Type: "Movie",
              ImageTags: { Primary: "p" },
            } as MediaItem
          }
          to="/movies/item-2"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Arrival")).toBeInTheDocument();
  });
});
