import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAdminAuth } from "./RequireAdminAuth";

vi.mock("../../api/ownApi/client", () => ({
  ownApiClient: { getCurrentUser: vi.fn() },
}));

vi.mock("../../lib/authStorage", () => ({
  setAuthSession: vi.fn(),
}));

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

import { ownApiClient } from "../../api/ownApi/client";
import { setAuthSession } from "../../lib/authStorage";

function renderGate() {
  return render(
    <MemoryRouter initialEntries={["/dev/tools"]}>
      <Routes>
        <Route element={<RequireAdminAuth />}>
          <Route path="/dev/tools" element={<div>admin content</div>} />
        </Route>
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireAdminAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows administrator content to an administrator", async () => {
    vi.mocked(ownApiClient.getCurrentUser).mockResolvedValue({
      id: "user-1",
      username: "sonat",
      displayName: "Sonat",
      isAdministrator: true,
    });

    renderGate();

    expect(await screen.findByText("admin content")).toBeInTheDocument();
  });

  it("refuses a signed-in account that is not an administrator", async () => {
    vi.mocked(ownApiClient.getCurrentUser).mockResolvedValue({
      id: "user-2",
      username: "viewer",
      displayName: "Viewer",
      isAdministrator: false,
    });

    renderGate();

    expect(await screen.findByText("adminAuth.denied")).toBeInTheDocument();
    expect(screen.queryByText("admin content")).not.toBeInTheDocument();
  });

  it("sends an unauthenticated visitor to the login page", async () => {
    vi.mocked(ownApiClient.getCurrentUser).mockRejectedValue(
      new Error("AUTH_REQUIRED"),
    );

    renderGate();

    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(screen.queryByText("admin content")).not.toBeInTheDocument();
  });

  it("hides content while the check is still in flight", () => {
    vi.mocked(ownApiClient.getCurrentUser).mockReturnValue(
      new Promise(() => undefined),
    );

    renderGate();

    expect(screen.getByText("adminAuth.checking")).toBeInTheDocument();
    expect(screen.queryByText("admin content")).not.toBeInTheDocument();
  });

  it("refreshes the cached session from what the server reported", async () => {
    vi.mocked(ownApiClient.getCurrentUser).mockResolvedValue({
      id: "user-1",
      username: "sonat",
      displayName: "Sonat",
      isAdministrator: true,
    });

    renderGate();

    await waitFor(() =>
      expect(setAuthSession).toHaveBeenCalledWith({
        userId: "user-1",
        username: "sonat",
        displayName: "Sonat",
        isAdministrator: true,
      }),
    );
  });
});
