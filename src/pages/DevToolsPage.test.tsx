import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DevToolsPage } from "./DevToolsPage";
import { visibleGroups } from "../lib/adminSections";

const api = vi.hoisted(() => ({
  getHealth: vi.fn(),
  listAcquisitions: vi.fn(),
}));

vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../api/ownApi/client", () => ({
  ownApiClient: { getHealth: api.getHealth },
}));
vi.mock("../lib/acquisitionsApi", () => ({
  listAcquisitions: api.listAcquisitions,
}));

const SHIPPED = visibleGroups({ includeDevOnly: false });

function healthy() {
  return {
    status: "ok",
    alive: true,
    ready: true,
    checks: {
      database: "available",
      jobs: "available",
      ffmpeg: "available",
      ffprobe: "available",
      mediaStorage: "available",
      generatedStorage: "writable",
    },
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DevToolsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.getHealth.mockReset().mockResolvedValue(healthy());
  api.listAcquisitions.mockReset().mockResolvedValue([]);
});

describe("the administration index", () => {
  it("shows every group of work", async () => {
    renderPage();

    for (const { group } of SHIPPED) {
      expect(
        await screen.findByRole("heading", { name: group.titleKey }),
        `${group.id} is missing from the index`,
      ).toBeTruthy();
    }
  });

  it("offers a card for every tool that ships", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "admin.group.library.title" });

    for (const section of SHIPPED.flatMap((entry) => entry.sections)) {
      const links = screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("href") === section.path);
      expect(links.length, `${section.id} has no card`).toBeGreaterThan(0);
    }
  });

  it("spells out how a film reaches the library, in order", async () => {
    renderPage();
    const steps = await screen.findByRole("list", { hidden: false });
    void steps;

    const order = ["wanted", "releases", "downloads", "imports"].map((name) =>
      screen.getByRole("link", { name: `admin.workflow.${name}` }),
    );

    expect(order.map((link) => link.getAttribute("href"))).toEqual([
      "/admin/library",
      "/admin/decisions",
      "/admin/acquisitions",
      "/admin/imports",
    ]);
  });

  it("reports the server and the download queue once they answer", async () => {
    api.listAcquisitions.mockResolvedValue([
      { state: "downloading" },
      { state: "downloading" },
      { state: "downloaded" },
    ]);
    renderPage();

    expect(await screen.findByText("admin.overview.system.ready")).toBeTruthy();
    expect(
      await screen.findByText("admin.overview.downloads.active"),
    ).toBeTruthy();
  });

  it("calls a degraded dependency degraded, not ready", async () => {
    api.getHealth.mockResolvedValue({
      ...healthy(),
      checks: { ...healthy().checks, mediaStorage: "unavailable" },
    });
    renderPage();

    expect(
      await screen.findByText("admin.overview.system.degraded"),
    ).toBeTruthy();
  });

  it("says nothing rather than zero when a source does not answer", async () => {
    // A failed request is not a measurement. "0 failed downloads" because the
    // request failed is worse than admitting the number is unknown.
    api.listAcquisitions.mockRejectedValue(new Error("offline"));
    renderPage();

    expect(
      await screen.findByText("admin.overview.status.unavailable"),
    ).toBeTruthy();
  });

  it("says the server is unreachable when health does not answer", async () => {
    api.getHealth.mockRejectedValue(new Error("offline"));
    renderPage();

    expect(
      await screen.findByText("admin.overview.system.unreachable"),
    ).toBeTruthy();
  });

  it("opens the library first, beside what fetches titles into it", async () => {
    renderPage();
    const library = await screen.findByRole("heading", {
      name: "admin.group.library.title",
    });
    const downloads = screen.getByRole("heading", {
      name: "admin.group.downloads.title",
    });
    const hrefsIn = (heading: HTMLElement) =>
      Array.from(
        (heading.closest("section") as HTMLElement).querySelectorAll("a"),
      ).map((link) => link.getAttribute("href"));
    expect(hrefsIn(library)[0]).toBe("/admin/library");
    expect(hrefsIn(downloads)).toEqual([
      "/admin/decisions",
      "/admin/acquisitions",
      "/admin/imports",
    ]);
  });
});
