import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeLoginConfettiPending,
  markDailyHomeConfettiShown,
  shouldShowDailyHomeConfetti,
} from "../../lib/homeConfetti";
import {
  getContinueWatchingItems,
  getLatestMediaItems,
  getUserViews,
} from "../../lib/jellyfinApi";
import { DesktopHomePage } from "./DesktopHomePage";

vi.mock("../../lib/jellyfinApi");
vi.mock("../../lib/homeConfetti");
vi.mock("../../lib/seo");
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
}));
vi.mock("../../hooks/useStandaloneWebApp", () => ({
  useStandaloneWebApp: () => false,
}));
vi.mock("../../i18n/LanguageContext", () => {
  const t = (key: string) => key;

  return {
    useLanguage: () => ({ t }),
  };
});
vi.mock("../../components/HeroSection", () => ({
  HeroSection: ({ onHeroReady }: { onHeroReady?: () => void }) => (
    <button type="button" onClick={onHeroReady}>
      hero-ready
    </button>
  ),
}));
vi.mock("../../components/MediaRow", () => ({
  MediaRow: () => <div />,
}));
vi.mock("../../components/AnimatedText", () => ({
  AnimatedText: ({ value }: { value: string }) => <>{value}</>,
}));
vi.mock("../../components/AnimatedWidth", () => ({
  AnimatedWidth: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/LibraryTile", () => ({
  LibraryTile: () => <div />,
}));
vi.mock("../../components/MotionReveal", () => ({
  MotionReveal: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../../components/animations/ConfettiAnimation", () => ({
  ConfettiAnimation: () => <div data-testid="home-confetti" />,
}));

describe("DesktopHomePage confetti", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserViews).mockResolvedValue([]);
    vi.mocked(getContinueWatchingItems).mockResolvedValue([]);
    vi.mocked(getLatestMediaItems).mockResolvedValue([]);
    vi.mocked(consumeLoginConfettiPending).mockReturnValue(false);
    vi.mocked(shouldShowDailyHomeConfetti).mockReturnValue(false);
  });

  it("waits until the hero is ready before showing daily confetti", async () => {
    vi.mocked(shouldShowDailyHomeConfetti).mockReturnValue(true);

    render(<DesktopHomePage />);

    const heroReadyButton = await screen.findByRole("button", {
      name: "hero-ready",
    });
    expect(screen.queryByTestId("home-confetti")).not.toBeInTheDocument();
    expect(shouldShowDailyHomeConfetti).not.toHaveBeenCalled();

    fireEvent.click(heroReadyButton);

    await waitFor(() => {
      expect(screen.getByTestId("home-confetti")).toBeInTheDocument();
    });
    expect(markDailyHomeConfettiShown).toHaveBeenCalledOnce();
  });

  it("shows login confetti even when daily confetti is already spent", async () => {
    vi.mocked(consumeLoginConfettiPending).mockReturnValue(true);

    render(<DesktopHomePage />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "hero-ready",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("home-confetti")).toBeInTheDocument();
    });
    expect(shouldShowDailyHomeConfetti).not.toHaveBeenCalled();
    expect(markDailyHomeConfettiShown).toHaveBeenCalledOnce();
  });
});
