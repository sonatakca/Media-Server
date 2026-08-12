import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n/LanguageContext";
import { LANGUAGE_STORAGE_KEY } from "../i18n/translations";
import type { ServerConnectionDiagnosis } from "../lib/serverConnectionDiagnostics";
import { ServerConnectionErrorPage } from "./ServerConnectionErrorPage";

function diagnosis(
  overrides: Partial<ServerConnectionDiagnosis> = {},
): ServerConnectionDiagnosis {
  return {
    problem: "unreachable",
    checkedAt: new Date().toISOString(),
    probe: {
      endpoint: "/ownAPI/v1/health",
      kind: "network-error",
      reachable: false,
      alive: false,
      ready: false,
    },
    failedDependencies: [],
    ...overrides,
  };
}

function renderPage(props: {
  diagnoseConnection: () => Promise<ServerConnectionDiagnosis>;
  testConnection?: () => Promise<unknown>;
  onRetrySuccess?: () => void;
}) {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");

  render(
    <LanguageProvider>
      <ServerConnectionErrorPage
        failure={{
          requestUrl: "/ownAPI/v1/health",
          reason: "network",
          message: "server unavailable",
        }}
        onRetrySuccess={props.onRetrySuccess ?? vi.fn()}
        diagnoseConnection={props.diagnoseConnection}
        {...(props.testConnection
          ? { testConnection: props.testConnection }
          : {})}
      />
    </LanguageProvider>,
  );
}

describe("ServerConnectionErrorPage", () => {
  it("reports an API outage in native terms", async () => {
    renderPage({ diagnoseConnection: vi.fn(async () => diagnosis()) });

    expect(
      await screen.findByText("The server did not answer."),
    ).toBeInTheDocument();
    expect(screen.getByText("Seyirlik Server")).toBeInTheDocument();
  });

  it("never mentions the previous backend", async () => {
    renderPage({ diagnoseConnection: vi.fn(async () => diagnosis()) });

    await screen.findByText("Seyirlik Server");

    expect(document.body.textContent).not.toMatch(/jellyfin|emby|cloudflare/i);
    expect(document.body.textContent).not.toContain("8096");
  });

  it("distinguishes a reverse proxy failure from an unreachable server", async () => {
    renderPage({
      diagnoseConnection: vi.fn(async () =>
        diagnosis({
          problem: "proxy-error",
          probe: {
            endpoint: "/ownAPI/v1/health",
            kind: "gateway-error",
            reachable: true,
            alive: false,
            ready: false,
            status: 502,
          },
        }),
      ),
    });

    expect(
      await screen.findByText("The reverse proxy cannot reach Seyirlik."),
    ).toBeInTheDocument();
  });

  it("names only the dependencies that are actually failing", async () => {
    renderPage({
      diagnoseConnection: vi.fn(async () =>
        diagnosis({
          problem: "dependency-unavailable",
          probe: {
            endpoint: "/ownAPI/v1/health",
            kind: "healthy",
            reachable: true,
            alive: true,
            ready: false,
            checks: {
              database: "unavailable",
              jobs: "disabled",
              ffmpeg: "available",
              ffprobe: "available",
              mediaStorage: "available",
              generatedStorage: "writable",
            },
          },
          failedDependencies: ["database"],
        }),
      ),
    });

    expect(await screen.findByText("Database")).toBeInTheDocument();
    // A healthy dependency on this page is noise.
    expect(screen.queryByText("FFmpeg")).not.toBeInTheDocument();
  });

  it("shows a request id so the failure can be found in the server log", async () => {
    renderPage({
      diagnoseConnection: vi.fn(async () =>
        diagnosis({
          probe: {
            endpoint: "/ownAPI/v1/health",
            kind: "http-error",
            reachable: true,
            alive: false,
            ready: false,
            status: 500,
            requestId: "req-abc-123",
          },
        }),
      ),
    });

    expect(await screen.findByText("req-abc-123")).toBeInTheDocument();
  });

  it("announces the failure assertively, since it replaced the whole app", async () => {
    renderPage({ diagnoseConnection: vi.fn(async () => diagnosis()) });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("leaves the page when a retry succeeds", async () => {
    const onRetrySuccess = vi.fn();
    renderPage({
      diagnoseConnection: vi.fn(async () => diagnosis()),
      testConnection: vi.fn(async () => undefined),
      onRetrySuccess,
    });

    await screen.findByText("Seyirlik Server");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() => expect(onRetrySuccess).toHaveBeenCalled());
  });

  it("re-runs diagnostics when a retry fails", async () => {
    const diagnoseConnection = vi.fn(async () => diagnosis());
    renderPage({
      diagnoseConnection,
      testConnection: vi.fn(async () => {
        throw new Error("still down");
      }),
    });

    await screen.findByText("Seyirlik Server");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() => expect(diagnoseConnection).toHaveBeenCalledTimes(2));
  });
});
