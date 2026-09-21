import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LanguageProvider } from "../../i18n/LanguageContext";
import { PlayerOverlay } from "./PlayerOverlay";

describe("PlayerOverlay", () => {
  it("uses the branded animation while playback is buffering", () => {
    const view = render(
      <MemoryRouter>
        <LanguageProvider>
          <PlayerOverlay
            title="Example"
            backTo="/movies/example"
            visible={false}
            isPlaying
            isPlayPauseLoading
            onTogglePlay={vi.fn()}
          />
        </LanguageProvider>
      </MemoryRouter>,
    );

    const centerControl = view.container.querySelector(
      ".seyirlik-player-center-toggle",
    );

    expect(centerControl).toHaveClass("bg-transparent");
    expect(
      centerControl?.querySelector(
        'img[src="/artwork/seyirlik/animations/seyirlik-loading.webp"]',
      ),
    ).toBeInTheDocument();
    expect(
      centerControl?.querySelector(
        'img[src="/artwork/seyirlik/animations/seyirlik-loading-still.webp"]',
      ),
    ).toBeInTheDocument();
    expect(
      centerControl?.querySelector("svg.lucide-loader-circle"),
    ).not.toBeInTheDocument();
  });
});
