import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "./i18n/LanguageContext";

const mocks = vi.hoisted(() => ({
  bootstrapIdentity: vi.fn(),
  checkServerAvailability: vi.fn(),
  errorPageProps: null as Record<string, unknown> | null,
  serverUrl: null as string | null,
  setServerUrl: vi.fn((value: string) => {
    mocks.serverUrl = value;
  }),
}));

vi.mock("./lib/identityBootstrap", () => ({
  bootstrapIdentity: mocks.bootstrapIdentity,
  parseIdentityProvider: () => "native",
}));

vi.mock("./lib/authStorage", () => ({
  getServerUrl: () => mocks.serverUrl,
  isAuthenticated: () => false,
  setServerUrl: mocks.setServerUrl,
}));

vi.mock("./lib/serverAvailability", () => ({
  checkServerAvailability: mocks.checkServerAvailability,
  parseServerBootstrapProvider: () => "jellyfin",
}));

vi.mock("./components/ServerConnectionErrorPage", () => ({
  ServerConnectionErrorPage: (props: Record<string, unknown>) => {
    mocks.errorPageProps = props;
    return <div data-testid="connection-error" />;
  },
}));

import { DefaultServerGate } from "./App";

function renderGate() {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={["/home"]}>
        <DefaultServerGate>
          <div>protected content</div>
        </DefaultServerGate>
      </MemoryRouter>
    </LanguageProvider>,
  );
}

describe("DefaultServerGate native bootstrap", () => {
  beforeEach(() => {
    mocks.bootstrapIdentity.mockReset();
    mocks.bootstrapIdentity.mockResolvedValue({
      provider: "native",
      status: "anonymous",
      user: null,
    });
    mocks.checkServerAvailability.mockReset();
    mocks.errorPageProps = null;
    mocks.serverUrl = null;
    mocks.setServerUrl.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("continues after native liveness succeeds even when readiness is false", async () => {
    mocks.checkServerAvailability.mockResolvedValue({ provider: "own-api" });

    renderGate();

    await waitFor(() =>
      expect(mocks.checkServerAvailability).toHaveBeenCalledWith({
        provider: "own-api",
        serverUrl: "https://izle.sonatakca.com",
      }),
    );
    expect(mocks.setServerUrl).not.toHaveBeenCalled();
    expect(mocks.bootstrapIdentity).toHaveBeenCalledWith({
      provider: "native",
    });
    expect(
      await screen.findByTestId("native-identity-foundation"),
    ).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("checks native reachability even when a Jellyfin fallback URL is saved", async () => {
    mocks.serverUrl = "https://saved.example";
    mocks.checkServerAvailability.mockResolvedValue({ provider: "own-api" });

    renderGate();

    await waitFor(() =>
      expect(mocks.checkServerAvailability).toHaveBeenCalledWith({
        provider: "own-api",
        serverUrl: "https://saved.example",
      }),
    );
    expect(mocks.setServerUrl).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("native-identity-foundation"),
    ).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("fails closed on native session bootstrap errors despite a saved Jellyfin URL", async () => {
    mocks.serverUrl = "https://saved.example";
    mocks.checkServerAvailability.mockResolvedValue({ provider: "own-api" });
    mocks.bootstrapIdentity.mockRejectedValue(
      new Error("native session unavailable"),
    );

    renderGate();

    expect(await screen.findByTestId("connection-error")).toBeInTheDocument();
    expect(mocks.errorPageProps?.failure).toMatchObject({
      requestUrl: "/ownAPI/v1/auth/me",
      message: "native session unavailable",
    });
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("keeps native failure diagnostics and retry on the native provider", async () => {
    mocks.checkServerAvailability.mockRejectedValue(
      new Error("native health unavailable"),
    );

    renderGate();

    expect(await screen.findByTestId("connection-error")).toBeInTheDocument();
    expect(mocks.errorPageProps?.failure).toMatchObject({
      requestUrl: "/ownAPI/v1/health",
      message: "native health unavailable",
    });
    expect(mocks.errorPageProps?.mode).toBe("own-api");

    const diagnoseConnection = mocks.errorPageProps?.diagnoseConnection as (
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    const testConnection = mocks.errorPageProps?.testConnection as (
      serverUrl: string,
    ) => Promise<unknown>;

    await expect(
      diagnoseConnection({ failure: mocks.errorPageProps?.failure }),
    ).rejects.toThrow("native health unavailable");
    await expect(testConnection("https://ignored.example")).rejects.toThrow(
      "native health unavailable",
    );
    expect(mocks.checkServerAvailability).toHaveBeenLastCalledWith({
      provider: "own-api",
      serverUrl: "https://ignored.example",
    });
  });
});
