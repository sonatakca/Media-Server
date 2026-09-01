import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServerControlPage } from "./ServerControlPage";
import * as serverControl from "../lib/serverControl";

vi.mock("../lib/serverControl");
vi.mock("../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ServerControlPage />
    </MemoryRouter>,
  );
}

describe("ServerControlPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(serverControl.waitForServerRestart).mockResolvedValue("ready");
  });

  it("offers the restart once the server says it is available", async () => {
    vi.mocked(serverControl.getServerRestartStatus).mockResolvedValue({
      mode: "respawn",
      available: true,
      inProgress: false,
    });

    renderPage();

    expect(
      await screen.findByText("serverControl.restart.action"),
    ).toBeInTheDocument();
    expect(screen.getByText("serverControl.mode.respawn")).toBeInTheDocument();
    expect(
      screen.queryByText("serverControl.unavailable"),
    ).not.toBeInTheDocument();
  });

  describe("when the status cannot be read", () => {
    /*
     * The case a stale server produced: the status request 404s, and the page
     * used to render the restart section with no button, no explanation and no
     * way forward. An unreadable status says nothing about whether the feature
     * exists — a server that is mid-restart fails this call too.
     */
    beforeEach(() => {
      vi.mocked(serverControl.getServerRestartStatus).mockRejectedValue(
        new Error("Route not found."),
      );
    });

    it("still offers the restart rather than rendering an empty section", async () => {
      renderPage();

      expect(
        await screen.findByText("serverControl.restart.action"),
      ).toBeInTheDocument();
    });

    it("says the status could not be read, and offers a retry", async () => {
      renderPage();

      expect(
        await screen.findByText("serverControl.statusUnavailable"),
      ).toBeInTheDocument();
      expect(screen.getByText("Route not found.")).toBeInTheDocument();
      expect(screen.getByText("common.retry")).toBeInTheDocument();
    });

    it("re-reads the status when the retry is pressed", async () => {
      renderPage();

      await screen.findByText("common.retry");
      vi.mocked(serverControl.getServerRestartStatus).mockResolvedValue({
        mode: "respawn",
        available: true,
        inProgress: false,
      });
      fireEvent.click(screen.getByText("common.retry"));

      expect(
        await screen.findByText("serverControl.mode.respawn"),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("serverControl.statusUnavailable"),
      ).not.toBeInTheDocument();
    });

    it("shows no mode badge, because the mode is genuinely unknown", async () => {
      renderPage();

      await screen.findByText("serverControl.restart.action");
      expect(
        screen.queryByText("serverControl.mode.respawn"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("serverControl.mode.disabled"),
      ).not.toBeInTheDocument();
    });
  });

  it("explains an unavailable restart instead of offering a dead button", async () => {
    vi.mocked(serverControl.getServerRestartStatus).mockResolvedValue({
      mode: "disabled",
      available: false,
      inProgress: false,
    });

    renderPage();

    expect(
      await screen.findByText("serverControl.unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("serverControl.restart.action"),
    ).not.toBeInTheDocument();
  });

  describe("restarting", () => {
    beforeEach(() => {
      vi.mocked(serverControl.getServerRestartStatus).mockResolvedValue({
        mode: "respawn",
        available: true,
        inProgress: false,
      });
      vi.mocked(serverControl.requestServerRestart).mockResolvedValue({
        status: "restarting",
        mode: "respawn",
      });
    });

    it("confirms before doing anything", async () => {
      renderPage();

      fireEvent.click(await screen.findByText("serverControl.restart.action"));

      expect(
        screen.getByText("serverControl.confirm.question"),
      ).toBeInTheDocument();
      expect(serverControl.requestServerRestart).not.toHaveBeenCalled();
    });

    it("does nothing when the confirmation is cancelled", async () => {
      renderPage();

      fireEvent.click(await screen.findByText("serverControl.restart.action"));
      fireEvent.click(screen.getByText("serverControl.confirm.cancel"));

      expect(serverControl.requestServerRestart).not.toHaveBeenCalled();
      expect(
        screen.getByText("serverControl.restart.action"),
      ).toBeInTheDocument();
    });

    it("requests the restart and then waits for the server", async () => {
      renderPage();

      fireEvent.click(await screen.findByText("serverControl.restart.action"));
      fireEvent.click(screen.getByText("serverControl.confirm.accept"));

      await waitFor(() =>
        expect(serverControl.requestServerRestart).toHaveBeenCalledTimes(1),
      );
      await waitFor(() =>
        expect(serverControl.waitForServerRestart).toHaveBeenCalledTimes(1),
      );
    });

    it("reports a restart that was refused", async () => {
      vi.mocked(serverControl.requestServerRestart).mockRejectedValue(
        new Error("This server is not configured to restart itself."),
      );

      renderPage();

      fireEvent.click(await screen.findByText("serverControl.restart.action"));
      fireEvent.click(screen.getByText("serverControl.confirm.accept"));

      expect(
        await screen.findByText(
          "This server is not configured to restart itself.",
        ),
      ).toBeInTheDocument();
      expect(serverControl.waitForServerRestart).not.toHaveBeenCalled();
    });

    it("reports a server that never came back", async () => {
      vi.mocked(serverControl.waitForServerRestart).mockResolvedValue(
        "timeout",
      );

      renderPage();

      fireEvent.click(await screen.findByText("serverControl.restart.action"));
      fireEvent.click(screen.getByText("serverControl.confirm.accept"));

      expect(
        await screen.findByText("serverControl.timedOut"),
      ).toBeInTheDocument();
    });
  });
});
