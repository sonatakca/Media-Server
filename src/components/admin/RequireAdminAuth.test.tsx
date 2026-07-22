import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAdminAuth } from "./RequireAdminAuth";

const adminAuthMock = vi.hoisted(() => ({
  onChange: null as ((user: User | null) => void) | null,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        "adminAuth.title": "Administrator access",
        "adminAuth.description": "Sign in with the authorized Google account.",
        "adminAuth.checking": "Checking administrator access...",
        "adminAuth.denied": "This Google account is not authorized.",
        "adminAuth.signIn": "Continue with Google",
        "adminAuth.useAnotherAccount": "Use another Google account",
      })[key] ?? key,
  }),
}));

vi.mock("../../lib/firebaseAdminAuth", () => ({
  getConfiguredAdminEmail: () => "sonatakcaa@gmail.com",
  getFirebaseAdminConfigurationError: () => null,
  isAuthorizedAdminUser: (user: User | null) =>
    user?.email === "sonatakcaa@gmail.com" && user.emailVerified,
  observeAdminAuthState: (onChange: (user: User | null) => void) => {
    adminAuthMock.onChange = onChange;
    return vi.fn();
  },
  signInAdminWithGoogle: adminAuthMock.signIn,
  signOutAdmin: adminAuthMock.signOut,
}));

function renderAdminRoute() {
  return render(
    <MemoryRouter initialEntries={["/dev"]}>
      <Routes>
        <Route element={<RequireAdminAuth />}>
          <Route path="/dev" element={<p>Private administrator tools</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function publishUser(user: Partial<User> | null) {
  act(() => {
    adminAuthMock.onChange?.(user as User | null);
  });
}

describe("RequireAdminAuth", () => {
  beforeEach(() => {
    adminAuthMock.onChange = null;
    adminAuthMock.signIn.mockReset();
    adminAuthMock.signOut.mockReset();
  });

  it("keeps administrator content hidden until the authorized account signs in", () => {
    renderAdminRoute();

    expect(screen.queryByText("Private administrator tools")).toBeNull();

    publishUser({
      email: "sonatakcaa@gmail.com",
      emailVerified: true,
    });

    expect(screen.getByText("Private administrator tools")).toBeInTheDocument();
  });

  it("offers Google sign-in when no account is signed in", () => {
    renderAdminRoute();
    publishUser(null);

    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Private administrator tools")).toBeNull();
  });

  it("rejects another Google account and lets the user switch accounts", async () => {
    const user = userEvent.setup();
    renderAdminRoute();
    publishUser({ email: "someone@example.com", emailVerified: true });

    expect(
      screen.getByText("This Google account is not authorized."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use another Google account" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Private administrator tools")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Use another Google account" }),
    );

    expect(adminAuthMock.signOut).toHaveBeenCalledTimes(1);
    expect(adminAuthMock.signIn).toHaveBeenCalledTimes(1);
  });
});
