import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { LoginPage } from "./LoginPage";
import * as authStorage from "../lib/authStorage";
import * as homeConfetti from "../lib/homeConfetti";
import { ownApiClient } from "../api/ownApi/client";

// Mock routing
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: vi.fn(),
    Navigate: ({ to }: { to: string }) => (
      <div data-testid={`navigate-${to}`} />
    ),
  };
});

// Mock API and Storage
vi.mock("../lib/authStorage");
vi.mock("../lib/homeConfetti");
vi.mock("../api/ownApi/client", () => ({
  ownApiClient: { login: vi.fn() },
}));

// Mock translations
vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}));

describe("LoginPage", () => {
  const mockNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useNavigate).mockReturnValue(mockNavigate);
    vi.mocked(authStorage.isAuthenticated).mockReturnValue(false);
  });

  it("redirects home when a session already exists", () => {
    vi.mocked(authStorage.isAuthenticated).mockReturnValue(true);
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("navigate-/home")).toBeInTheDocument();
  });

  it("shows an error message when authentication fails", async () => {
    vi.mocked(ownApiClient.login).mockRejectedValue(
      new Error("Invalid credentials"),
    );

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("auth.username"), {
      target: { value: "testuser" },
    });
    fireEvent.change(screen.getByLabelText("auth.password"), {
      target: { value: "wrongpass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.signIn" }));

    // Button should show loading state temporarily
    expect(
      screen.getByRole("button", { name: "auth.signingIn" }),
    ).toBeInTheDocument();

    // Wait for the API to reject and the error to render
    await waitFor(() => {
      expect(
        screen.getByText("auth.failedMessagePrefix Invalid credentials"),
      ).toBeInTheDocument();
    });

    // Check that we did not save auth session
    expect(authStorage.setAuthSession).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("marks login confetti pending before navigating home on success", async () => {
    vi.mocked(ownApiClient.login).mockResolvedValue({
      id: "user-id",
      username: "testuser",
      displayName: "Test User",
      isAdministrator: false,
    });

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("auth.username"), {
      target: { value: "testuser" },
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.signIn" }));

    await waitFor(() => {
      expect(homeConfetti.markLoginConfettiPending).toHaveBeenCalledOnce();
      expect(mockNavigate).toHaveBeenCalledWith("/home", { replace: true });
    });
  });
});
