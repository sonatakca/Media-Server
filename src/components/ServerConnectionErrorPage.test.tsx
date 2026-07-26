import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n/LanguageContext";
import { LANGUAGE_STORAGE_KEY } from "../i18n/translations";
import { ServerConnectionErrorPage } from "./ServerConnectionErrorPage";

describe("ServerConnectionErrorPage provider mode", () => {
  it("shows native server status and keeps retry on injected native callbacks", async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    const diagnoseConnection = vi.fn(async () => {
      throw new Error("native health unavailable");
    });
    const testConnection = vi.fn(async () => {
      throw new Error("native health unavailable");
    });

    render(
      <LanguageProvider>
        <MemoryRouter>
          <ServerConnectionErrorPage
            mode="own-api"
            serverUrl="https://fallback.example"
            failure={{
              serverUrl: "https://fallback.example",
              requestUrl: "/ownAPI/v1/health",
              reason: "network",
              message: "native health unavailable",
            }}
            diagnoseConnection={diagnoseConnection}
            testConnection={testConnection}
            onRetrySuccess={vi.fn()}
          />
        </MemoryRouter>
      </LanguageProvider>,
    );

    expect(await screen.findByText("Seyirlik Server")).toBeInTheDocument();
    expect(screen.queryByText("Jellyfin Server")).not.toBeInTheDocument();
    expect(screen.queryByText("Tunnel Connection")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(testConnection).toHaveBeenCalledWith("https://fallback.example");
    expect(diagnoseConnection).toHaveBeenCalledTimes(2);
  });
});
