import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { WantedCatalogue } from "./WantedCatalogue";
const api = vi.hoisted(() => ({
  listWanted: vi.fn(),
  searchWanted: vi.fn(),
  addWanted: vi.fn(),
  setWanted: vi.fn(),
  releaseSearchUrl: (title: { kind: string; title: string }) =>
    `/admin/decisions?kind=${title.kind}&title=${title.title}`,
}));
vi.mock("../../lib/wantedApi", () => api);
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  api.listWanted.mockResolvedValue({
    items: [],
    libraries: [
      { id: "movies", name: "Movies", kind: "movies" },
      { id: "shows", name: "Shows", kind: "series" },
    ],
  });
  api.searchWanted.mockImplementation(async (kind) => ({
    items: [
      {
        providerId: "94605",
        kind: kind === "tv" ? "series" : "movie",
        title: "Arcane",
        year: 2021,
        posterUrl: "https://image.tmdb.org/t/p/w185/arcane.jpg",
        overview: "Two sisters in Piltover.",
      },
    ],
    totalPages: 3,
  }));
  api.addWanted.mockResolvedValue({ item: { id: "saved" } });
});
it("has separate movie/show discovery, artwork, and a real wanted action", async () => {
  render(
    <MemoryRouter>
      <WantedCatalogue />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("wanted.addShow"));
  expect(await screen.findByText("Two sisters in Piltover.")).toBeTruthy();
  await waitFor(() =>
    expect(api.searchWanted).toHaveBeenCalledWith("tv", "", 1),
  );
  expect(
    screen.getByRole("link", { name: "wanted.releases" }).getAttribute("href"),
  ).toContain("kind=series");
  fireEvent.click(screen.getByText("wanted.add"));
  await waitFor(() =>
    expect(api.addWanted).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "series", providerId: "94605" }),
      "shows",
    ),
  );
  fireEvent.click(screen.getByText("wanted.next"));
  await waitFor(() =>
    expect(api.searchWanted).toHaveBeenCalledWith("tv", "", 2),
  );
});
