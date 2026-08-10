import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "./i18n/LanguageContext";

/**
 * Bootstrap behaviour of the native gate.
 *
 * There is no server to choose and no provider to select any more, so what these
 * cover is narrower and more important: the gate must check liveness, then the
 * session, and it must fail closed — never fall through to protected content
 * when either step fails.
 */

const mocks = vi.hoisted(() => ({
  bootstrapIdentity: vi.fn(),
  checkServerAvailability: vi.fn(),
  errorPageProps: null as Record<string, unknown> | null,
}));

vi.mock("./lib/identityBootstrap", () => ({
  bootstrapIdentity: mocks.bootstrapIdentity,
  parseIdentityProvider: () => "native",
}));

vi.mock("./lib/authStorage", () => ({
  isAuthenticated: () => false,
}));

vi.mock("./lib/serverAvailability", () => ({
  checkServerAvailability: mocks.checkServerAvailability,
  parseServerBootstrapProvider: () => "own-api",
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
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("checks liveness and then the session, without any server URL", async () => {
    mocks.checkServerAvailability.mockResolvedValue({ provider: "own-api" });

    renderGate();

    await waitFor(() => expect(mocks.checkServerAvailability).toHaveBeenCalled());
    expect(mocks.bootstrapIdentity).toHaveBeenCalled();
    expect(
      await screen.findByTestId("native-identity-foundation"),
    ).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("fails closed when the session cannot be established", async () => {
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

  it("reports which endpoint failed when the server is unreachable", async () => {
    mocks.checkServerAvailability.mockRejectedValue(
      new Error("native health unavailable"),
    );

    renderGate();

    expect(await screen.findByTestId("connection-error")).toBeInTheDocument();
    expect(mocks.errorPageProps?.failure).toMatchObject({
      requestUrl: "/ownAPI/v1/health",
      message: "native health unavailable",
    });
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("retries against the same origin, with no server URL to pass", async () => {
    mocks.checkServerAvailability.mockRejectedValue(
      new Error("native health unavailable"),
    );

    renderGate();
    await screen.findByTestId("connection-error");

    const testConnection = mocks.errorPageProps?.testConnection as (
      serverUrl: string,
    ) => Promise<unknown>;

    await expect(testConnection("")).rejects.toThrow(
      "native health unavailable",
    );
  });
});
