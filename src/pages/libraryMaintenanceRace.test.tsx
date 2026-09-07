import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { LibraryMaintenancePage } from "./LibraryMaintenancePage";
import { translations } from "../i18n/translations";
import type { MaintenanceTaskDto } from "../lib/maintenance/maintenanceTasks";
const request = vi.fn();
vi.mock("../api/ownApi/client", () => ({
  ownApiClient: { request: (...args: unknown[]) => request(...args) },
}));
const t = (key: string) =>
  (translations.en as Record<string, string>)[key] ?? key;
vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t, language: "en" }),
}));
vi.mock("./admin/MetadataEditPanel", () => ({ MetadataEditPanel: () => null }));
const id = "00000000-0000-4000-8000-000000000001";
const finished: MaintenanceTaskDto = {
  id,
  operation: "library.rename",
  status: "succeeded",
  reorderable: false,
  attempts: 1,
  maxAttempts: 3,
  progress: null,
  result: { counters: {}, failures: [], outcome: "organize-disabled" },
  errorCode: null,
  queuedAt: "2026-09-06T10:00:00.000Z",
  runAfter: "2026-09-06T10:00:00.000Z",
  startedAt: "2026-09-06T10:00:00.001Z",
  finishedAt: "2026-09-06T10:00:00.005Z",
  progressAt: null,
};
beforeEach(() => {
  request.mockReset();
});
it("connects sibling actions to the canonical reader and reveals ultra-fast work outside history", async () => {
  let accepted = false;
  request.mockImplementation(async (path: string) => {
    if (path === "/admin/maintenance/rename") {
      accepted = true;
      return { action: "rename", taskIds: [id], libraries: 1 };
    }
    const url = new URL(path, "http://test");
    if (url.pathname === "/admin/maintenance/tasks") {
      // Even the newest history is already displaced by other work; only the
      // exact accepted-ID read can recover this canonical concluded row.
      return {
        tasks:
          accepted && url.searchParams.get("include") === id ? [finished] : [],
        queue: [],
      };
    }
    throw new Error(`unexpected read: ${path}`);
  });
  render(
    <MemoryRouter>
      <LibraryMaintenancePage />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/admin/maintenance/tasks"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: t("maintenance.renameFiles") }),
  );
  // No poll timer advances: acceptance itself causes the canonical read.
  await waitFor(() =>
    expect(
      request.mock.calls.some(([path]) =>
        String(path).includes(`include=${id}`),
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: /Concluded.*1/ })).toBeTruthy(),
  );
  expect(screen.getByRole("tab", { name: /In progress.*0/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await userEvent.click(screen.getByRole("tab", { name: /Concluded.*1/ }));
  expect(
    screen.getByText(t("maintenance.outcome.organize-disabled")),
  ).toBeTruthy();
});

it("does not invalidate or request exact rows for an empty category", async () => {
  request.mockImplementation(async (path: string) =>
    path === "/admin/maintenance/scan-books"
      ? { action: "scan-books", taskIds: [], libraries: 0 }
      : { tasks: [], queue: [] },
  );
  render(
    <MemoryRouter>
      <LibraryMaintenancePage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  await userEvent.click(
    screen.getByRole("button", { name: t("maintenance.scanBooks") }),
  );
  expect(
    request.mock.calls.filter(([path]) =>
      String(path).startsWith("/admin/maintenance/tasks"),
    ),
  ).toHaveLength(1);
});
