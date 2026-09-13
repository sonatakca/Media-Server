import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../i18n/LanguageContext";
import { LoadingSpinner } from "./LoadingSpinner";

describe("LoadingSpinner", () => {
  it("uses the animated brand mark with a reduced-motion still", () => {
    const view = render(
      <LanguageProvider>
        <LoadingSpinner label="" variant="brand" />
      </LanguageProvider>,
    );

    expect(screen.getByRole("status")).toHaveAccessibleName();

    const images = view.container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute(
      "src",
      "/artwork/seyirlik/animations/seyirlik-loading.webp",
    );
    expect(images[0]).toHaveClass("motion-reduce:hidden");
    expect(images[1]).toHaveAttribute(
      "src",
      "/artwork/seyirlik/animations/seyirlik-loading-still.webp",
    );
    expect(images[1]).toHaveClass("motion-reduce:block");
  });
});
