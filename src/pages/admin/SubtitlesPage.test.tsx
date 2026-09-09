import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitlesPage } from "./SubtitlesPage";
import type { SubtitleAttempt } from "../../lib/subtitlesApi";

const api = vi.hoisted(() => ({
  listSubtitleAttempts: vi.fn(),
  resumeSubtitleAttempt: vi.fn(),
}));

vi.mock("../../lib/subtitlesApi", () => api);
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

function attempt(over: Partial<SubtitleAttempt> = {}): SubtitleAttempt {
  return {
    attemptId: "s1",
    mediaFileId: "m1",
    language: "tr",
    forced: false,
    hearingImpaired: "indifferent",
    state: "installed",
    attempt: 1,
    providerId: "opensubtitles",
    score: 80,
    failureClass: null,
    awaitingProviderId: null,
    ...over,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <SubtitlesPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.listSubtitleAttempts.mockResolvedValue([attempt()]);
  api.resumeSubtitleAttempt.mockResolvedValue({});
});

describe("the subtitles page", () => {
  it("puts what is waiting for a sign-in first", async () => {
    /*
     * An attempt in `needs-authentication` is not progressing and not failing:
     * nothing will change until somebody signs in. Burying it under running
     * work would make a stopped queue look busy.
     */
    api.listSubtitleAttempts.mockResolvedValue([
      attempt({ attemptId: "a", state: "installed" }),
      attempt({
        attemptId: "b",
        state: "needs-authentication",
        awaitingProviderId: "opensubtitles",
      }),
    ]);
    renderPage();

    await screen.findByText("admin.subtitles.state.needs-authentication");
    const items = screen.getAllByRole("listitem").map((n) => n.textContent);
    expect(items[0]).toContain("admin.subtitles.state.needs-authentication");
  });

  it("says the work is stopped and why, rather than faking a sign-in", async () => {
    // There is no embedded browser yet; claiming otherwise would be a lie the
    // operator only discovers when nothing happens.
    api.listSubtitleAttempts.mockResolvedValue([
      attempt({ state: "needs-authentication", awaitingProviderId: "os" }),
    ]);
    renderPage();

    expect(
      await screen.findByText(/admin\.subtitles\.authExplanation/),
    ).toBeTruthy();
    expect(screen.getByText("admin.subtitles.resume")).toBeTruthy();
  });

  it("names the provider that is waiting", async () => {
    api.listSubtitleAttempts.mockResolvedValue([
      attempt({ state: "needs-authentication", awaitingProviderId: "os" }),
    ]);
    renderPage();
    expect(await screen.findByText(/\(os\)/)).toBeTruthy();
  });

  it("offers to continue only where a sign-in is actually pending", async () => {
    renderPage();
    await screen.findByText("admin.subtitles.state.installed");
    expect(screen.queryByText("admin.subtitles.resume")).toBeNull();
  });

  it("lets the server refuse a resume, and says so", async () => {
    /*
     * The server is the authority on whether the sign-in really happened.
     * Nothing here marks an attempt as authenticated on its own.
     */
    api.listSubtitleAttempts.mockResolvedValue([
      attempt({ state: "needs-authentication" }),
    ]);
    api.resumeSubtitleAttempt.mockRejectedValue(new Error("not waiting"));
    renderPage();

    fireEvent.click(await screen.findByText("admin.subtitles.resume"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("admin.subtitles.resumeRefused");
  });

  it("reloads from the server after a successful resume", async () => {
    api.listSubtitleAttempts.mockResolvedValue([
      attempt({ state: "needs-authentication" }),
    ]);
    renderPage();

    fireEvent.click(await screen.findByText("admin.subtitles.resume"));
    await waitFor(() => {
      expect(api.resumeSubtitleAttempt).toHaveBeenCalledWith("s1");
      expect(api.listSubtitleAttempts).toHaveBeenCalledTimes(2);
    });
  });

  it("counts how many are waiting, so the banner is not merely decorative", async () => {
    api.listSubtitleAttempts.mockResolvedValue([
      attempt({ attemptId: "a", state: "needs-authentication" }),
      attempt({ attemptId: "b", state: "needs-authentication" }),
    ]);
    renderPage();
    expect(
      await screen.findByText(/admin\.subtitles\.waitingBanner \(2\)/),
    ).toBeTruthy();
  });

  it("carries no provider session or cookie into the page", async () => {
    api.listSubtitleAttempts.mockResolvedValue([
      attempt({ state: "needs-authentication", awaitingProviderId: "os" }),
    ]);
    renderPage();
    await screen.findByText("admin.subtitles.resume");

    const html = document.body.innerHTML;
    expect(html).not.toMatch(/cookie/i);
    expect(html).not.toMatch(/session[_-]?id/i);
  });

  it("says the list is empty rather than showing nothing", async () => {
    api.listSubtitleAttempts.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("admin.subtitles.empty")).toBeTruthy();
  });
});
