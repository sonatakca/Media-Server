/**
 * Library Maintenance is library-wide work and nothing else.
 *
 * The per-title editor that used to be its second tab moved into each title's
 * workspace under Library; what stays is the work across every title and the
 * queue that shows it running.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
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

vi.mock("../lib/mediaApi", () => ({
  runLibraryMaintenance: async () => ({
    action: "all",
    taskIds: [],
    libraries: 0,
  }),
}));

const en = translations.en as Record<string, string>;

function mount() {
  return render(
    <MemoryRouter initialEntries={["/dev/library-maintenance"]}>
      <LibraryMaintenancePage />
    </MemoryRouter>,
  );
}

describe("Library Maintenance", () => {
  it("runs library-wide work and shows its queue", () => {
    mount();
    expect(
      screen.getByRole("group", { name: en["maintenance.actionsLabel"] }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tablist", { name: en["maintenance.tasks.label"] }),
    ).toBeInTheDocument();
  });

  it("has no per-title editor, and points to where one title is worked on", () => {
    mount();
    expect(screen.queryByRole("tab", { name: /metadata/i })).toBeNull();
    expect(
      screen.getByRole("link", { name: en["library.title"] }),
    ).toHaveAttribute("href", "/admin/library");
  });
});
