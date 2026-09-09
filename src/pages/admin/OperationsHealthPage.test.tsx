import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperationsHealthPage } from "./OperationsHealthPage";
import type { OperationsSnapshot } from "../../lib/operationsApi";

const fetchOperationsSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../../lib/operationsApi", () => ({ fetchOperationsSnapshot }));
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
/*
 * `t` returns the key, as the other page tests do. The assertions are then
 * about which message the page chose, not about how it happens to be worded in
 * whichever locale the provider defaulted to.
 */
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

const healthy = {
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

function snapshot(over: Partial<OperationsSnapshot> = {}): OperationsSnapshot {
  return {
    input: { health: healthy },
    importsNeedingAttention: [],
    unreachable: [],
    ...over,
  } as OperationsSnapshot;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <OperationsHealthPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchOperationsSnapshot.mockReset();
});

describe("the operations dashboard", () => {
  it("says the server is serving when it is", async () => {
    fetchOperationsSnapshot.mockResolvedValue(snapshot());
    renderPage();
    expect(
      await screen.findByRole("heading", {
        name: "admin.health.verdict.serving",
        level: 1,
      }),
    ).toBeTruthy();
  });

  it("does not call the server dead because a download client is off", async () => {
    /*
     * The behaviour the tiers exist for. An operator who reads "Not serving"
     * goes looking for a fault in Seyirlik; the fault is in another program,
     * and playback is unaffected.
     */
    fetchOperationsSnapshot.mockResolvedValue(
      snapshot({
        input: {
          health: healthy,
          downloadClient: {
            configured: true,
            reachable: false,
            reason: "connect ECONNREFUSED",
          },
        },
      }),
    );
    renderPage();

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("admin.health.verdict.degraded");
    expect(screen.queryByText("admin.health.needsOperator")).toBeNull();
  });

  it("says plainly when something really has stopped it serving", async () => {
    fetchOperationsSnapshot.mockResolvedValue(
      snapshot({
        input: {
          health: {
            ...healthy,
            checks: { ...healthy.checks, database: "unavailable" },
          },
        },
      }),
    );
    renderPage();

    expect(
      await screen.findByRole("heading", {
        name: "admin.health.verdict.not-serving",
        level: 1,
      }),
    ).toBeTruthy();
    expect(screen.getByText("admin.health.needsOperator")).toBeTruthy();
  });

  it("separates starting up from broken", async () => {
    fetchOperationsSnapshot.mockResolvedValue(
      snapshot({ input: { health: { ...healthy, ready: false } } }),
    );
    renderPage();
    expect(
      await screen.findByRole("heading", {
        name: "admin.health.verdict.starting",
        level: 1,
      }),
    ).toBeTruthy();
  });

  it("lists what is waiting for a person, with counts", async () => {
    fetchOperationsSnapshot.mockResolvedValue(
      snapshot({ input: { health: healthy, attention: { imports: 2 } } }),
    );
    renderPage();

    expect(await screen.findByText("admin.health.waiting")).toBeTruthy();
    expect(
      screen.getByText("admin.health.signal.importsNeedingAttention"),
    ).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("says nothing about waiting work when there is none", async () => {
    fetchOperationsSnapshot.mockResolvedValue(
      snapshot({ input: { health: healthy, attention: { imports: 0 } } }),
    );
    renderPage();

    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("admin.health.waiting")).toBeNull();
  });

  it("names a subsystem that did not answer rather than hiding it", async () => {
    // A blank panel where a subsystem should be is indistinguishable from a
    // healthy one with nothing to report.
    fetchOperationsSnapshot.mockResolvedValue(
      snapshot({ unreachable: ["downloadClient"] }),
    );
    renderPage();

    expect(await screen.findByText("admin.health.notAnswered")).toBeTruthy();
    expect(screen.getByText("downloadClient")).toBeTruthy();
  });

  it("groups the server's own parts apart from the programs it talks to", async () => {
    fetchOperationsSnapshot.mockResolvedValue(
      snapshot({
        input: {
          health: healthy,
          downloadClient: { configured: true, reachable: true },
        },
      }),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("admin.health.tier.core")).toBeTruthy();
      expect(screen.getByText("admin.health.tier.dependency")).toBeTruthy();
    });
  });
});
