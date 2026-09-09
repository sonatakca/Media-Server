import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcquisitionsPage } from "./AcquisitionsPage";
import type { Acquisition, AcquisitionDetail } from "../../lib/acquisitionsApi";

const api = vi.hoisted(() => ({
  listAcquisitions: vi.fn(),
  getAcquisition: vi.fn(),
  retryAcquisition: vi.fn(),
  cancelAcquisition: vi.fn(),
}));

vi.mock("../../lib/acquisitionsApi", () => api);
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

function acquisition(over: Partial<Acquisition> = {}): Acquisition {
  return {
    id: "a1",
    state: "downloading",
    origin: "manual",
    target: { kind: "movie", title: "Dune" },
    indexerId: "nzbgeek",
    releaseTitle: "Dune.2021.2160p.WEB-DL.HEVC-GROUP",
    attempt: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function detail(over: Partial<AcquisitionDetail> = {}): AcquisitionDetail {
  return {
    acquisition: acquisition(),
    decision: {
      profileName: "HD-2160p",
      score: 140,
      reasons: [{ code: "codec", detail: "Preferred codec HEVC" }],
      rejected: [{ title: "Dune.2021.720p", reason: "quality not allowed" }],
      decidedAt: "2026-01-01T00:00:00.000Z",
    },
    events: [
      { fromState: null, toState: "planned", at: "2026-01-01T00:00:00.000Z" },
    ],
    ...over,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AcquisitionsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.listAcquisitions.mockResolvedValue([acquisition()]);
  api.getAcquisition.mockResolvedValue(detail());
});

describe("the acquisitions page", () => {
  it("groups what needs a person above what is merely running", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ id: "a1", state: "downloading" }),
      acquisition({ id: "a2", state: "failed", failureClass: "sab-auth" }),
      acquisition({ id: "a3", state: "downloaded" }),
    ]);
    renderPage();

    await screen.findByText("admin.acquisitions.bucket.needsAttention");
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((node) => node.textContent);
    expect(headings).toEqual([
      "admin.acquisitions.bucket.needsAttention",
      "admin.acquisitions.bucket.active",
      "admin.acquisitions.bucket.finished",
    ]);
  });

  it("says what a failure asks of the reader, not just its code", async () => {
    /*
     * A class on its own tells an operator nothing about whether to wait, pick
     * another release, or go and fix something.
     */
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "failed", failureClass: "missing-articles" }),
    ]);
    renderPage();

    const banner = await screen.findByText(
      /admin\.acquisitions\.failure\.missing-articles/,
    );
    expect(banner.textContent).toContain(
      "admin.acquisitions.remedy.another-release",
    );
  });

  it("offers a retry only where the server would accept one", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ id: "a1", state: "downloading" }),
    ]);
    renderPage();

    await screen.findByText("Dune");
    expect(screen.queryByText("admin.acquisitions.retry")).toBeNull();
    expect(screen.getByText("admin.acquisitions.cancel")).toBeTruthy();
  });

  it("never offers to cancel a download that already finished", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "downloaded" }),
    ]);
    renderPage();

    await screen.findByText("Dune");
    expect(screen.queryByText("admin.acquisitions.cancel")).toBeNull();
  });

  it("explains why the release was chosen, and what was passed over", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Dune"));

    await screen.findByText("admin.acquisitions.why");
    expect(screen.getByText(/HD-2160p/)).toBeTruthy();
    expect(screen.getByText("Preferred codec HEVC")).toBeTruthy();
    expect(
      screen.getByText(/Dune\.2021\.720p — quality not allowed/),
    ).toBeTruthy();
  });

  it("says so plainly when no decision was recorded", async () => {
    api.getAcquisition.mockResolvedValue(detail({ decision: null }));
    renderPage();
    fireEvent.click(await screen.findByText("Dune"));

    expect(
      await screen.findByText("admin.acquisitions.noDecision"),
    ).toBeTruthy();
  });

  it("retries through the server and reloads what it says afterwards", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "failed", failureClass: "disk-full" }),
    ]);
    renderPage();

    fireEvent.click(await screen.findByText("admin.acquisitions.retry"));
    await waitFor(() => {
      expect(api.retryAcquisition).toHaveBeenCalledWith("a1");
      // The row is re-read rather than assumed: the server decides the state.
      expect(api.listAcquisitions).toHaveBeenCalledTimes(2);
    });
  });

  it("reports a failed load without repeating what the client threw", async () => {
    // A request failure message can carry a URL, and this is a browser.
    api.listAcquisitions.mockRejectedValue(
      new Error("fetch failed http://127.0.0.1:43111/ownAPI/v1/acquisitions"),
    );
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("admin.acquisitions.loadFailed");
    expect(alert.textContent).not.toContain("127.0.0.1");
  });

  it("says the list is empty rather than showing nothing at all", async () => {
    api.listAcquisitions.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("admin.acquisitions.empty")).toBeTruthy();
  });

  it("carries no download URL or job identifier into the page", async () => {
    // The server does not send them; nothing here should invent a place for
    // them either.
    renderPage();
    fireEvent.click(await screen.findByText("Dune"));
    await screen.findByText("admin.acquisitions.why");

    const html = document.body.innerHTML;
    expect(html).not.toMatch(/apikey/i);
    expect(html).not.toMatch(/nzo_/i);
  });
});
