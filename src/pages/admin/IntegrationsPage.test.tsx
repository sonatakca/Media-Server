import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationsPage } from "./IntegrationsPage";

const api = vi.hoisted(() => ({
  fetchIntegrations: vi.fn(),
  fetchSchemaStatus: vi.fn(),
}));

vi.mock("../../lib/configurationApi", () => api);
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <IntegrationsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchIntegrations.mockResolvedValue([
    { id: "indexers", configured: true, detail: "NZBgeek" },
    { id: "subtitles", configured: false },
  ]);
  api.fetchSchemaStatus.mockResolvedValue({
    applied: 24,
    latest: "024_subtitle_execution",
    current: true,
    pending: [],
  });
});

describe("the integrations page", () => {
  it("says configured or not for each service", async () => {
    renderPage();
    await screen.findByText("admin.integrations.name.indexers");
    expect(screen.getByText("admin.integrations.configured")).toBeTruthy();
    expect(screen.getByText("admin.integrations.notConfigured")).toBeTruthy();
  });

  it("shows something recognisable without showing a secret", async () => {
    /*
     * A key that has been stored is never read back out. An operator replaces
     * one; they never need to see it.
     */
    api.fetchIntegrations.mockResolvedValue([
      {
        id: "downloadClient",
        configured: true,
        detail: "127.0.0.1:8080 · seyirlik",
      },
    ]);
    renderPage();

    expect(await screen.findByText(/127\.0\.0\.1:8080/)).toBeTruthy();
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/apikey/i);
    expect(html).not.toMatch(/password/i);
  });

  it("says plainly that configuration is not editable here, and why", async () => {
    renderPage();
    expect(await screen.findByText("admin.integrations.readOnly")).toBeTruthy();
    // No form, no save: the page reports and does not write.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reports a database that is up to date", async () => {
    renderPage();
    expect(
      await screen.findByText("admin.integrations.schemaCurrent"),
    ).toBeTruthy();
    expect(screen.getByText(/024_subtitle_execution/)).toBeTruthy();
  });

  it("names the migrations a database is missing", async () => {
    /*
     * Code shipped ahead of its schema is what stops the services starting —
     * the Phase 7 outage exactly — so the missing versions are named rather
     * than counted.
     */
    api.fetchSchemaStatus.mockResolvedValue({
      applied: 23,
      latest: "023_something",
      current: false,
      pending: ["024_subtitle_execution"],
    });
    renderPage();

    expect(
      await screen.findByText("admin.integrations.schemaBehind"),
    ).toBeTruthy();
    expect(screen.getByText("024_subtitle_execution")).toBeTruthy();
  });

  it("reports a failure without repeating what was thrown", async () => {
    api.fetchIntegrations.mockRejectedValue(
      new Error("fetch http://127.0.0.1:43111 failed"),
    );
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("admin.integrations.loadFailed");
  });
});
