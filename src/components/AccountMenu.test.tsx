import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock("../lib/authStorage", () => ({
  getCachedSession: () => ({ username: "sonat", isAdministrator: true }),
  clearAuthSession: vi.fn(),
}));

function GoBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      back
    </button>
  );
}

describe("account menu", () => {
  it("stays closed on returning to the page it was left open on", () => {
    render(
      <MemoryRouter initialEntries={["/dev/tmdb-artwork"]}>
        <AccountMenu />
        <Routes>
          <Route path="/admin" element={<GoBack />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /nav\.account/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "admin.entry" }));
    expect(
      screen.getByRole("button", { name: /nav\.account/ }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "back" }));

    expect(
      screen.getByRole("button", { name: /nav\.account/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});
