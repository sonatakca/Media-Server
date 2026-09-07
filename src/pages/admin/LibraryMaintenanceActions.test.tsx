import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translations, type Language } from "../../i18n/translations";
import type {
  MaintenanceAcceptance,
  MaintenanceAction,
} from "../../lib/mediaApi";
import { LibraryMaintenanceActions } from "./LibraryMaintenanceActions";

vi.mock("../../lib/mediaApi", () => ({
  runLibraryMaintenance: async () => {
    throw new Error("the component under test is always given a runner");
  },
}));
vi.mock("../../lib/notifications/notificationStore", () => ({
  notify: () => undefined,
}));

/*
 * The real translation tables, not a stub that echoes keys: the thing worth
 * checking is that seven buttons carry seven real labels in both languages,
 * which a `t = (key) => key` mock would pass without either table existing.
 */
let language: Language = "en";
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (translations[language] as Record<string, string>)[key] ?? key,
    language,
  }),
}));

const ACTION_KEYS = [
  ["maintenance.allInOne", "all"],
  ["maintenance.scanMovies", "scan-movies"],
  ["maintenance.scanShows", "scan-shows"],
  ["maintenance.scanBooks", "scan-books"],
  ["maintenance.generateTrickplays", "trickplay"],
  ["maintenance.renameFiles", "rename"],
  ["maintenance.moveFiles", "organize"],
] as const;

function label(key: string): string {
  return (translations[language] as Record<string, string>)[key] as string;
}

function accepted(
  action: MaintenanceAction,
  libraries = 3,
): MaintenanceAcceptance {
  return { action, taskIds: ["task"], libraries };
}

describe("the Library Maintenance action group", () => {
  beforeEach(() => {
    language = "en";
  });

  it("offers all seven actions, each with an accessible name", () => {
    render(<LibraryMaintenanceActions run={async (a) => accepted(a)} />);

    expect(
      screen.getByRole("group", { name: label("maintenance.actionsLabel") }),
    ).toBeTruthy();
    for (const [key] of ACTION_KEYS) {
      expect(screen.getByRole("button", { name: label(key) })).toBeTruthy();
    }
  });

  it("renders the same seven actions in Turkish", () => {
    language = "tr";
    render(<LibraryMaintenanceActions run={async (a) => accepted(a)} />);

    for (const [key] of ACTION_KEYS) {
      const button = screen.getByRole("button", { name: label(key) });
      // A key that fell through untranslated would read as `maintenance.…`.
      expect(button.textContent).not.toContain("maintenance.");
    }
  });

  it("sends each button to its own action", async () => {
    const calls: MaintenanceAction[] = [];
    render(
      <LibraryMaintenanceActions
        run={async (action) => {
          calls.push(action);
          return accepted(action);
        }}
      />,
    );

    for (const [key, action] of ACTION_KEYS) {
      await userEvent.click(screen.getByRole("button", { name: label(key) }));
      await waitFor(() => expect(calls).toContain(action));
    }
    expect(calls).toEqual(ACTION_KEYS.map(([, action]) => action));
  });

  /*
   * Seven independent operations. One global loading flag is how a page ends
   * up unusable for the length of the slowest request on it, and none of these
   * conflicts with another: the durable queue collapses duplicates by itself.
   */
  it("disables only the action being sent, never the other six", async () => {
    let release: (value: MaintenanceAcceptance) => void = () => undefined;
    render(
      <LibraryMaintenanceActions
        run={() =>
          new Promise<MaintenanceAcceptance>((resolve) => {
            release = resolve;
          })
        }
      />,
    );

    const rename = screen.getByRole("button", {
      name: label("maintenance.renameFiles"),
    });
    await userEvent.click(rename);
    await waitFor(() => expect(rename.getAttribute("aria-busy")).toBe("true"));

    for (const [key] of ACTION_KEYS.filter(
      ([candidate]) => candidate !== "maintenance.renameFiles",
    )) {
      expect(
        screen
          .getByRole("button", { name: label(key) })
          .hasAttribute("disabled"),
      ).toBe(false);
    }

    release(accepted("rename", 1));
    await waitFor(() => expect(rename.hasAttribute("disabled")).toBe(false));
  });

  it("says the work was queued, never that it finished", async () => {
    render(<LibraryMaintenanceActions run={async (a) => accepted(a)} />);

    await userEvent.click(
      screen.getByRole("button", { name: label("maintenance.allInOne") }),
    );

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(
      translations.en["maintenance.actionQueued"],
    );
    expect(status.textContent?.toLowerCase()).not.toContain("completed");
  });

  it("counts the libraries a category action was accepted for", async () => {
    render(<LibraryMaintenanceActions run={async (a) => accepted(a, 2)} />);

    await userEvent.click(
      screen.getByRole("button", { name: label("maintenance.scanMovies") }),
    );

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("2");
  });

  it("reports an empty category honestly rather than as a failure", async () => {
    render(<LibraryMaintenanceActions run={async (a) => accepted(a, 0)} />);

    await userEvent.click(
      screen.getByRole("button", { name: label("maintenance.scanBooks") }),
    );

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(
      translations.en["maintenance.actionNoLibraries"],
    );
  });

  it("surfaces a refused action without disabling the rest of the group", async () => {
    render(
      <LibraryMaintenanceActions
        run={async () => {
          throw new Error("Not permitted.");
        }}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: label("maintenance.moveFiles") }),
    );

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Not permitted.");
    expect(
      screen
        .getByRole("button", { name: label("maintenance.allInOne") })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
