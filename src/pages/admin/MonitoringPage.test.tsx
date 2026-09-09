import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MonitoringPage } from "./MonitoringPage";
import type { MonitoringView } from "../../lib/monitoringApi";

const api = vi.hoisted(() => ({
  getMonitoring: vi.fn(),
  listSeries: vi.fn(),
  setTitleMonitoring: vi.fn(),
  setSeasonMonitoring: vi.fn(),
  setEpisodeMonitoring: vi.fn(),
}));

vi.mock("../../lib/monitoringApi", () => api);
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

const ITEM = "11111111-1111-4111-8111-111111111111";

function view(over: Partial<MonitoringView> = {}): MonitoringView {
  return {
    title: { itemId: ITEM, monitored: true },
    seasons: [
      {
        seasonNumber: 1,
        choice: "inherit",
        monitored: true,
        decidedBy: "series",
        reason: "Inherited from the series.",
      },
      {
        seasonNumber: 2,
        choice: "unmonitored",
        monitored: false,
        decidedBy: "season",
        reason: "Season 2 has its own setting.",
      },
    ],
    episodes: [
      {
        seasonNumber: 2,
        episodeNumber: 5,
        choice: "monitored",
        monitored: true,
        decidedBy: "episode",
        reason: "The episode has its own setting.",
      },
    ],
    ...over,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <MonitoringPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.listSeries.mockResolvedValue([
    { Id: ITEM, Name: "House of the Dragon", ProductionYear: 2022 },
  ]);
  api.getMonitoring.mockResolvedValue(view());
  api.setTitleMonitoring.mockResolvedValue({});
  api.setSeasonMonitoring.mockResolvedValue({});
  api.setEpisodeMonitoring.mockResolvedValue({});
});

async function choose() {
  const select = await screen.findByLabelText("admin.monitoring.series");
  fireEvent.change(select, { target: { value: ITEM } });
  await screen.findByText("admin.monitoring.titleLevel");
}

describe("the monitoring page", () => {
  it("says why each level is what it is, not just whether it is on", async () => {
    /*
     * A season monitored because its series is, and one set monitored
     * deliberately, behave differently the moment the series changes. A single
     * toggle would hide exactly that.
     */
    renderPage();
    await choose();

    expect(screen.getByText(/Inherited from the series\./)).toBeTruthy();
    expect(screen.getByText(/Season 2 has its own setting\./)).toBeTruthy();
    expect(screen.getByText(/The episode has its own setting\./)).toBeTruthy();
  });

  it("shows a season's own choice separately from the effective answer", async () => {
    renderPage();
    await choose();

    const season1 = screen.getByLabelText("admin.monitoring.season 1");
    expect((season1 as HTMLSelectElement).value).toBe("inherit");
    const season2 = screen.getByLabelText("admin.monitoring.season 2");
    expect((season2 as HTMLSelectElement).value).toBe("unmonitored");
  });

  it("offers the three choices the model actually has", async () => {
    renderPage();
    await choose();
    const options = Array.from(
      (screen.getByLabelText("admin.monitoring.season 1") as HTMLSelectElement)
        .options,
    ).map((option) => option.value);
    expect(options).toEqual(["inherit", "monitored", "unmonitored"]);
  });

  it("sets a season and re-reads what the server then says", async () => {
    // The server resolves inheritance; the page never computes it locally.
    renderPage();
    await choose();

    fireEvent.change(screen.getByLabelText("admin.monitoring.season 1"), {
      target: { value: "unmonitored" },
    });
    await waitFor(() => {
      expect(api.setSeasonMonitoring).toHaveBeenCalledWith(
        ITEM,
        1,
        "unmonitored",
      );
      expect(api.getMonitoring).toHaveBeenCalledTimes(2);
    });
  });

  it("sets an episode override", async () => {
    renderPage();
    await choose();
    fireEvent.change(screen.getByLabelText("S2E5"), {
      target: { value: "inherit" },
    });
    await waitFor(() =>
      expect(api.setEpisodeMonitoring).toHaveBeenCalledWith(
        ITEM,
        2,
        5,
        "inherit",
      ),
    );
  });

  it("sets the series itself", async () => {
    renderPage();
    await choose();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(api.setTitleMonitoring).toHaveBeenCalledWith(ITEM, false),
    );
  });

  it("fabricates nothing before a series is chosen", async () => {
    renderPage();
    await screen.findByLabelText("admin.monitoring.series");
    expect(screen.queryByText("admin.monitoring.titleLevel")).toBeNull();
    expect(api.getMonitoring).not.toHaveBeenCalled();
  });

  it("reports a failure without repeating what was thrown", async () => {
    api.getMonitoring.mockRejectedValue(
      new Error("fetch http://127.0.0.1:43111 failed"),
    );
    renderPage();
    const select = await screen.findByLabelText("admin.monitoring.series");
    fireEvent.change(select, { target: { value: ITEM } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("admin.monitoring.loadFailed");
  });
});
