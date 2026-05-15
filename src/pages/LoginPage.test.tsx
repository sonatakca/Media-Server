import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { LoginPage } from "./LoginPage";
import * as authStorage from "../lib/authStorage";
import * as jellyfinApi from "../lib/jellyfinApi";

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
vi.mock("../lib/jellyfinApi");

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
    // Assume the user has a server selected but is not logged in
    vi.mocked(authStorage.getServerUrl).mockReturnValue(
      "http://mock-server.local",
    );
    vi.mocked(authStorage.isAuthenticated).mockReturnValue(false);
  });

  it("redirects to /server if no server URL is set", () => {
    vi.mocked(authStorage.getServerUrl).mockReturnValue(null);
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("navigate-/server")).toBeInTheDocument();
  });

  it("shows an error message when authentication fails", async () => {
    vi.mocked(jellyfinApi.authenticateByName).mockRejectedValue(
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
});
