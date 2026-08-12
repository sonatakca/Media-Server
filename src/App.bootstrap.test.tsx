import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "./i18n/LanguageContext";

/**
 * Startup behaviour of the server gate.
 *
 * There is no server to choose and no provider to select, so what these cover
 * is narrower and more important: the gate checks liveness, then the session,
 * and it must fail closed — never falling through to protected content when
 * either step fails. It also reconciles the cached session against the
 * server's answer, because the cookie is the credential and the cache is only
 * a hint.
 */

const mocks = vi.hoisted(() => ({
  bootstrapIdentity: vi.fn(),
  checkServerAvailability: vi.fn(),
  setAuthSession: vi.fn(),
  clearAuthSession: vi.fn(),
  errorPageProps: null as Record<string, unknown> | null,
}));

vi.mock("./lib/identityBootstrap", () => ({
  bootstrapIdentity: mocks.bootstrapIdentity,
}));

vi.mock("./lib/authStorage", () => ({
  isAuthenticated: () => false,
  setAuthSession: mocks.setAuthSession,
  clearAuthSession: mocks.clearAuthSession,
}));

vi.mock("./lib/serverAvailability", () => ({
  checkServerAvailability: mocks.checkServerAvailability,
}));

vi.mock("./components/ServerConnectionErrorPage", () => ({
  ServerConnectionErrorPage: (props: Record<string, unknown>) => {
    mocks.errorPageProps = props;
    return <div data-testid="connection-error" />;
  },
}));

import { DefaultServerGate } from "./App";

const signedInUser = {
  id: "user-1",
  username: "person",
  displayName: "Person",
  isAdministrator: true,
};

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

describe("DefaultServerGate startup", () => {
  beforeEach(() => {
    mocks.bootstrapIdentity.mockReset();
    mocks.bootstrapIdentity.mockResolvedValue({
      status: "anonymous",
      user: null,
    });
    mocks.checkServerAvailability.mockReset();
    mocks.checkServerAvailability.mockResolvedValue(undefined);
    mocks.setAuthSession.mockReset();
    mocks.clearAuthSession.mockReset();
    mocks.errorPageProps = null;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("checks liveness and the session, then renders the app", async () => {
    renderGate();

    await waitFor(() =>
      expect(mocks.checkServerAvailability).toHaveBeenCalled(),
    );
    expect(mocks.bootstrapIdentity).toHaveBeenCalled();
    expect(await screen.findByText("protected content")).toBeInTheDocument();
  });

  it("refreshes the cached session from the server's answer", async () => {
    mocks.bootstrapIdentity.mockResolvedValue({
      status: "authenticated",
      user: signedInUser,
    });

    renderGate();

    await waitFor(() =>
      expect(mocks.setAuthSession).toHaveBeenCalledWith({
        userId: "user-1",
        username: "person",
        displayName: "Person",
        isAdministrator: true,
      }),
    );
    expect(mocks.clearAuthSession).not.toHaveBeenCalled();
  });

  it("clears a cached session the server no longer recognises", async () => {
    renderGate();

    await waitFor(() => expect(mocks.clearAuthSession).toHaveBeenCalled());
    expect(mocks.setAuthSession).not.toHaveBeenCalled();
  });

  it("fails closed when the session cannot be established", async () => {
    mocks.bootstrapIdentity.mockRejectedValue(new Error("session unavailable"));

    renderGate();

    expect(await screen.findByTestId("connection-error")).toBeInTheDocument();
    expect(mocks.errorPageProps?.failure).toMatchObject({
      requestUrl: "/ownAPI/v1/auth/me",
      message: "session unavailable",
    });
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("reports which endpoint failed when the server is unreachable", async () => {
    mocks.checkServerAvailability.mockRejectedValue(
      new Error("health unavailable"),
    );

    renderGate();

    expect(await screen.findByTestId("connection-error")).toBeInTheDocument();
    expect(mocks.errorPageProps?.failure).toMatchObject({
      requestUrl: "/ownAPI/v1/health",
      message: "health unavailable",
    });
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("does not touch the cached session when startup fails", async () => {
    // A failed health check says nothing about whether the user is signed in,
    // and signing them out over an outage would be its own bug.
    mocks.checkServerAvailability.mockRejectedValue(
      new Error("health unavailable"),
    );

    renderGate();
    await screen.findByTestId("connection-error");

    expect(mocks.setAuthSession).not.toHaveBeenCalled();
    expect(mocks.clearAuthSession).not.toHaveBeenCalled();
  });

  it("retries against the same origin, with no server URL to pass", async () => {
    mocks.checkServerAvailability.mockRejectedValue(
      new Error("health unavailable"),
    );

    renderGate();
    await screen.findByTestId("connection-error");

    const testConnection = mocks.errorPageProps
      ?.testConnection as () => Promise<unknown>;

    await expect(testConnection()).rejects.toThrow("health unavailable");
  });
});
