import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryTitleDetail } from "../../lib/libraryAdminApi";
import { TitlePage } from "./TitlePage";

const api = vi.hoisted(() => ({
  getLibraryTitle: vi.fn(),
  generateTrickplay: vi.fn(),
  requestTitleSubtitles: vi.fn(),
  removeLibraryTitle: vi.fn(),
}));
vi.mock("../../lib/libraryAdminApi", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/libraryAdminApi")>()),
  ...api,
}));
vi.mock("../../lib/wantedApi", () => ({
  setWanted: vi.fn(),
  releaseSearchUrl: () => "/admin/decisions",
}));
vi.mock("../../lib/mediaApi", () => ({
  getPrimaryImageUrl: () => "",
  getLogoImageUrl: () => "",
  refreshItemMetadata: vi.fn(async () => undefined),
}));
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("../../components/admin/SeriesMonitoringPanel", () => ({
  SeriesMonitoringPanel: () => <p>monitoring panel</p>,
}));
vi.mock("../TmdbArtworkPage", () => ({
  default: ({ itemId }: { itemId: string }) => <p>artwork for {itemId}</p>,
}));

const ID = "11111111-1111-4111-8111-111111111111";
const detail = (
  over: Partial<LibraryTitleDetail> = {},
): LibraryTitleDetail => ({
  id: ID,
  kind: "movie",
  title: "Dune",
  year: 2021,
  desired: false,
  tmdbId: null,
  imdbId: null,
  episodeCount: 0,
  availableEpisodeCount: 0,
  status: "downloaded",
  hasMedia: true,
  downloading: 0,
  importing: 0,
  processing: 0,
  sizeBytes: 1,
  resolution: 2160,
  audioLanguages: ["eng"],
  subtitleLanguages: ["tur"],
  pendingSubtitles: [],
  files: 1,
  trickplayFiles: 0,
  artwork: { coverTag: null, logoTag: null, logoLayout: null, missing: true },
  mediaFileId: "f",
  fileName: "Dune.2021.mkv",
  seasons: [],
  catalogueComplete: true,
  ...over,
});

function renderAt(path = `/admin/library/${ID}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/library/:itemId" element={<TitlePage />} />
        <Route path="/admin/library" element={<p>library list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getLibraryTitle.mockResolvedValue(detail());
  api.generateTrickplay.mockResolvedValue({
    queued: 1,
    alreadyGenerated: 0,
    notReady: 0,
  });
});

it("generates missing trickplay, or rebuilds it, for this one film", async () => {
  renderAt();
  fireEvent.click(await screen.findByText("library.generateMissing"));
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith(ID, false),
  );
  fireEvent.click(screen.getByText("library.rebuildAll"));
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith(ID, true),
  );
});

it("edits the film's artwork and metadata in place", async () => {
  renderAt(`/admin/library/${ID}?tab=artwork`);
  expect(await screen.findByText(`artwork for ${ID}`)).toBeTruthy();
});

it("gives a show its episodes and monitoring, and a film neither", async () => {
  renderAt();
  await screen.findByText("Dune");
  expect(
    screen.queryByRole("tab", { name: "library.tab.episodes" }),
  ).toBeNull();

  api.getLibraryTitle.mockResolvedValue(
    detail({ kind: "series", title: "Andor", files: 2 }),
  );
  renderAt(`/admin/library/${ID}?tab=monitoring`);
  expect(await screen.findByText("monitoring panel")).toBeTruthy();
  expect(
    screen.getByRole("tab", { name: "library.tab.episodes" }),
  ).toBeTruthy();
});

it("says so when the title is gone", async () => {
  api.getLibraryTitle.mockRejectedValue({ status: 404 });
  renderAt();
  expect(await screen.findByText("library.titleMissing")).toBeTruthy();
});
