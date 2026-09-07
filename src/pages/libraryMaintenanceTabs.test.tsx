/**
 * The split itself: two top-level modes, one page.
 *
 * The claims are that the operational controls and the metadata editor are no
 * longer on screen together, that the mode is in the URL so back and forward
 * work, and that neither half is duplicated into the other.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { translations } from "../i18n/translations";
import { LibraryMaintenancePage } from "./LibraryMaintenancePage";

/*
 * One `t`, defined once. The real provider memoises it, and the editor's data
 * load lists `t` among its dependencies — a mock that returned a fresh
 * function on every render would re-run that load after every state change and
 * spin, which says nothing about the code under test.
 */
const t = (key: string) =>
  (translations.en as Record<string, string>)[key] ?? key;
const language = { t, language: "en" } as const;

vi.mock("../i18n/LanguageContext", () => ({ useLanguage: () => language }));

vi.mock("../lib/notifications/notificationStore", () => ({
  notify: vi.fn(),
}));

vi.mock("../lib/maintenanceApi", () => ({
  getMaintenanceTasks: async () => ({
    tasks: [],
    queue: [],
    pages: {
      active: { total: 0, offset: 0, limit: 200 },
      concluded: { total: 0, offset: 0, limit: 50 },
    },
  }),
  reorderMaintenanceQueue: async () => ({ moved: [], queue: [] }),
  cancelMaintenanceTask: async () => undefined,
  MAINTENANCE_ACTIVE_PAGE_SIZE: 200,
  MAINTENANCE_HISTORY_PAGE_SIZE: 50,
}));

/*
 * The metadata half loads the catalogue on mount. Stubbed to nothing so this
 * suite is about the split rather than about the editor, which has its own.
 */
vi.mock("../lib/mediaApi", () => ({
  getUserViews: async () => [],
  getVideoItemsForLibrary: async () => [],
  getAllSeriesEpisodes: async () => [],
  getItem: async () => null,
  refreshItemMetadata: async () => undefined,
  refreshLibraryMetadata: async () => undefined,
  scanAllLibraries: async () => undefined,
  updateItemMetadata: async () => undefined,
  runLibraryMaintenance: async () => ({
    action: "all",
    taskIds: [],
    libraries: 0,
  }),
  getBackdropImageUrl: () => "",
  getLogoImageUrl: () => "",
  getPrimaryImageUrl: () => "",
  getItemTrickplayImageUrl: () => "",
}));

const en = translations.en as Record<string, string>;

/**
 * The router's own view of where the page is, and a way back.
 *
 * `window.history` is not the router's history under `MemoryRouter`, so a test
 * that called `window.history.back()` would be asserting against a history
 * nothing in the tree is reading. This reads and drives the real one.
 */
function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="search">{location.search}</span>
      <button type="button" onClick={() => navigate(-1)}>
        go back
      </button>
    </>
  );
}

function mount(initial = "/dev/library-maintenance") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <LibraryMaintenancePage />
      <Probe />
    </MemoryRouter>,
  );
}

describe("the two modes of Library Maintenance", () => {
  it("offers both as proper tabs, with the operational one selected first", async () => {
    mount();

    const scan = screen.getByRole("tab", { name: en["maintenance.tab.scan"] });
    const metadata = screen.getByRole("tab", {
      name: en["maintenance.tab.metadata"],
    });
    expect(scan).toHaveAttribute("aria-selected", "true");
    expect(metadata).toHaveAttribute("aria-selected", "false");
    expect(
      screen.getByRole("tabpanel", { name: en["maintenance.tab.scan"] }),
    ).toBeInTheDocument();
  });

  it("shows the maintenance controls and the task viewer in the scan tab", async () => {
    mount();

    expect(
      screen.getByRole("group", { name: en["maintenance.actionsLabel"] }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tablist", { name: en["maintenance.tasks.label"] }),
    ).toBeInTheDocument();
    // The editor is not merely hidden: it is not rendered.
    expect(screen.queryByText(en["maintenance.metadataEditor"]!)).toBeNull();
  });

  it("shows the editor, and only the editor, in the metadata tab", async () => {
    mount();

    await userEvent.click(
      screen.getByRole("tab", { name: en["maintenance.tab.metadata"] }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(en["maintenance.libraryItems"]!),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("group", { name: en["maintenance.actionsLabel"] }),
    ).toBeNull();
    expect(
      screen.queryByRole("tablist", { name: en["maintenance.tasks.label"] }),
    ).toBeNull();
  });

  it("opens straight into the mode the URL names", async () => {
    mount("/dev/library-maintenance?tab=metadata");

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: en["maintenance.tab.metadata"] }),
      ).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("falls back to the operational mode for a tab it does not have", async () => {
    mount("/dev/library-maintenance?tab=nonsense");

    expect(
      screen.getByRole("tab", { name: en["maintenance.tab.scan"] }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("puts the mode in the URL, and leaves the operational one plain", async () => {
    mount();

    expect(screen.getByTestId("search")).toHaveTextContent("");

    await userEvent.click(
      screen.getByRole("tab", { name: en["maintenance.tab.metadata"] }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("search")).toHaveTextContent("?tab=metadata"),
    );
  });

  it("keeps the mode in history, so back returns to the previous one", async () => {
    mount();

    await userEvent.click(
      screen.getByRole("tab", { name: en["maintenance.tab.metadata"] }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: en["maintenance.tab.metadata"] }),
      ).toHaveAttribute("aria-selected", "true"),
    );

    await userEvent.click(screen.getByRole("button", { name: "go back" }));

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: en["maintenance.tab.scan"] }),
      ).toHaveAttribute("aria-selected", "true"),
    );
  });
});
