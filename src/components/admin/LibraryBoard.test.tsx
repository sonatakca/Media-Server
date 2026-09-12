import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryTitle } from "../../lib/libraryAdminApi";
import { LibraryBoard } from "./LibraryBoard";

const api = vi.hoisted(() => ({
  listLibraryTitles: vi.fn(),
  getLibraryTitle: vi.fn(),
  removeLibraryTitle: vi.fn(),
  requestTitleSubtitles: vi.fn(),
  generateTrickplay: vi.fn(),
}));
vi.mock("../../lib/libraryAdminApi", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/libraryAdminApi")>()),
  ...api,
}));
vi.mock("../../lib/inventoryExport", () => ({ downloadInventory: vi.fn() }));
vi.mock("../../lib/wantedApi", () => ({
  setWanted: vi.fn(),
  releaseSearchUrl: () => "/admin/decisions",
}));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

const facts = {
  status: "downloaded",
  hasMedia: false,
  downloading: 0,
  importing: 0,
  processing: 0,
  sizeBytes: 0,
  resolution: null,
  audioLanguages: [],
  subtitleLanguages: [],
  pendingSubtitles: [],
  files: 0,
  trickplayFiles: 0,
};
const title = (over: Partial<LibraryTitle>): LibraryTitle => ({
  ...facts,
  id: "id",
  kind: "movie",
  title: "Title",
  year: 2000,
  desired: false,
  tmdbId: null,
  imdbId: null,
  episodeCount: 0,
  availableEpisodeCount: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listLibraryTitles.mockImplementation(async (kind: string) =>
    kind === "book"
      ? []
      : kind === "movie"
        ? [
            title({
              id: "held",
              title: "Held",
              hasMedia: true,
              sizeBytes: 5 * 1024 ** 3,
              resolution: 1080,
              audioLanguages: ["tur", "eng"],
              subtitleLanguages: ["tur"],
              files: 1,
            }),
            title({
              id: "coming",
              title: "Coming",
              downloading: 1,
              status: "downloading",
            }),
            title({
              id: "wanted",
              title: "Wanted",
              desired: true,
              status: "wanted",
            }),
          ]
        : [
            title({
              id: "show",
              kind: "series",
              title: "Show",
              hasMedia: true,
              episodeCount: 2,
              availableEpisodeCount: 1,
            }),
          ],
  );
});

function renderBoard() {
  return render(
    <MemoryRouter>
      <LibraryBoard />
    </MemoryRouter>,
  );
}

it("colours each title by what it holds and says what is on disk", async () => {
  renderBoard();
  const held = (await screen.findByText("Held")).closest("li")!;
  expect(held.className).toContain("border-emerald-400/30");
  expect(
    within(held).getByText(/1080p · 5\.0 GB · library\.audio TUR, ENG/),
  ).toBeTruthy();
  expect(screen.getByText("Coming").closest("li")!.className).toContain(
    "border-violet-400/30",
  );
  expect(screen.getByText("Wanted").closest("li")!.className).toContain(
    "border-red-400/30",
  );
});

it("switches to shows and lists a show's seasons and episodes", async () => {
  api.getLibraryTitle.mockResolvedValue({
    ...title({ id: "show", kind: "series", title: "Show", hasMedia: true }),
    mediaFileId: null,
    fileName: null,
    catalogueComplete: true,
    seasons: [
      {
        id: "s1",
        seasonNumber: 1,
        episodes: [
          {
            ...facts,
            hasMedia: true,
            files: 1,
            id: "e1",
            seasonNumber: 1,
            episodeNumber: 1,
            title: "Pilot",
            airDate: null,
            mediaFileId: "f1",
            fileName: "Show.S01E01.mkv",
            monitored: true,
          },
          {
            ...facts,
            status: "wanted",
            id: null,
            seasonNumber: 1,
            episodeNumber: 2,
            title: "Second",
            airDate: "2020-01-01",
            mediaFileId: null,
            fileName: null,
            monitored: true,
          },
        ],
      },
    ],
  });
  renderBoard();
  fireEvent.click(await screen.findByRole("tab", { name: /library\.shows/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: /library\.seasons/ }),
  );
  expect(await screen.findByText("Pilot")).toBeTruthy();
  expect(screen.getByText("Second")).toBeTruthy();
  // Only the episode with a file can be searched for.
  expect(
    screen.getAllByRole("button", { name: /library\.findTurkish · E0/ }),
  ).toHaveLength(1);
});

it("filters by colour", async () => {
  renderBoard();
  await screen.findByText("Held");
  fireEvent.click(
    screen.getByRole("button", { name: /library\.tone\.wanted/ }),
  );
  expect(screen.queryByText("Held")).toBeNull();
  expect(screen.getByText("Wanted")).toBeTruthy();
});

it("removes a title only once its name is typed", async () => {
  api.removeLibraryTitle.mockResolvedValue({
    itemId: "held",
    title: "Held",
    folder: "Movies/Held (2000)",
    filesRemoved: 1,
    downloadsCancelled: 0,
    leftovers: [],
  });
  renderBoard();
  const row = (await screen.findByText("Held")).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: /library\.remove/ }));
  const dialog = screen.getByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", {
    name: "library.removeConfirm",
  });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "Held" },
  });
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(api.removeLibraryTitle).toHaveBeenCalledWith("held", "Held"),
  );
  expect(await screen.findByText("library.removed Held")).toBeTruthy();
});

it("starts a subtitle search for a whole title", async () => {
  api.requestTitleSubtitles.mockResolvedValue({ files: 1, queued: 1 });
  renderBoard();
  const row = (await screen.findByText("Held")).closest("li")!;
  fireEvent.click(
    within(row).getByRole("button", { name: /library\.findTurkish/ }),
  );
  await waitFor(() =>
    expect(api.requestTitleSubtitles).toHaveBeenCalledWith("held", "tur"),
  );
  expect(await screen.findByText("library.subtitlesQueued 1/1")).toBeTruthy();
});

it("generates trickplay for one film from its row", async () => {
  api.generateTrickplay.mockResolvedValue({
    queued: 1,
    alreadyGenerated: 0,
    notReady: 0,
  });
  renderBoard();
  const row = (await screen.findByText("Held")).closest("li")!;
  fireEvent.click(
    within(row).getByRole("button", { name: /library\.generateTrickplay/ }),
  );
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith("held", false),
  );
  expect(await screen.findByText("library.trickplayQueued 1")).toBeTruthy();
});

it("offers trickplay per season and per episode of a show", async () => {
  api.getLibraryTitle.mockResolvedValue({
    ...title({ id: "show", kind: "series", title: "Show", hasMedia: true }),
    mediaFileId: null,
    fileName: null,
    catalogueComplete: true,
    seasons: [
      {
        id: "season-1",
        seasonNumber: 1,
        episodes: [
          {
            ...facts,
            hasMedia: true,
            files: 1,
            id: "e1",
            seasonNumber: 1,
            episodeNumber: 1,
            title: "Pilot",
            airDate: null,
            mediaFileId: "f1",
            fileName: null,
            monitored: true,
          },
        ],
      },
    ],
  });
  api.generateTrickplay.mockResolvedValue({
    queued: 1,
    alreadyGenerated: 0,
    notReady: 0,
  });
  renderBoard();
  fireEvent.click(await screen.findByRole("tab", { name: /library\.shows/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: /library\.seasons/ }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "library.generateTrickplay · library.season 1",
    }),
  );
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith("season-1", false),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "library.generateTrickplay · E01",
    }),
  );
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith("e1", false),
  );
});
