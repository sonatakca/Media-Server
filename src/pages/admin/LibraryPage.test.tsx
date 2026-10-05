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
const { uploadBook } = vi.hoisted(() => ({
  uploadBook: vi.fn<(file: File) => Promise<unknown>>(),
}));
vi.mock("../../lib/libraryAdminApi", () => ({ uploadBook }));
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

it("uploads each chosen EPUB and says what became of it", async () => {
  uploadBook
    .mockResolvedValueOnce({
      outcome: "added",
      relativePath: "Books/Ray Bradbury/Fahrenheit 451 (1953).epub",
      title: "Fahrenheit 451",
      author: "Ray Bradbury",
    })
    .mockRejectedValueOnce(new Error("This EPUB is copy-protected (DRM)."));
  renderPage();

  const input = screen.getByTestId("book-upload-input");
  fireEvent.change(input, {
    target: {
      files: [
        new File(["a"], "f451.epub", { type: "application/epub+zip" }),
        new File(["b"], "locked.epub", { type: "application/epub+zip" }),
      ],
    },
  });

  expect(await screen.findByText("Fahrenheit 451 · Ray Bradbury")).toBeTruthy();
  expect(
    await screen.findByText("This EPUB is copy-protected (DRM)."),
  ).toBeTruthy();
  expect(screen.getByText("library.bookAdded")).toBeTruthy();
  expect(screen.getByText("library.bookFailed")).toBeTruthy();
  expect(screen.getByText("library.bookScanNote")).toBeTruthy();
  // One at a time, in the order chosen.
  expect(uploadBook.mock.calls.map(([file]) => file.name)).toEqual([
    "f451.epub",
    "locked.epub",
  ]);
});
