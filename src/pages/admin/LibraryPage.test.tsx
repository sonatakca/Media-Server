import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { LibraryPage } from "./LibraryPage";

vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("../../components/admin/LibraryBoard", () => ({
  LibraryBoard: () => <p>the library list</p>,
}));
vi.mock("../../components/admin/WantedCatalogue", () => ({
  WantedCatalogue: ({ kind }: { kind: string }) => <p>searching {kind}</p>,
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <LibraryPage />
    </MemoryRouter>,
  );

it("opens on the library, with the TMDB search closed", () => {
  renderPage();
  expect(screen.getByText("the library list")).toBeTruthy();
  expect(screen.queryByText(/^searching/)).toBeNull();
});

it("opens the search for the kind asked for above the library, and closes it", () => {
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: /wanted\.addShow/ }));
  const search = screen.getByText("searching tv");
  const list = screen.getByText("the library list");
  // Above the list, not in its place.
  expect(
    search.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /wanted\.addMovie/ }));
  expect(screen.getByText("searching movie")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "library.closeSearch" }));
  expect(screen.queryByText(/^searching/)).toBeNull();
});
