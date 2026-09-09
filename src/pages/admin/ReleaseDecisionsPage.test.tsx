import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseDecisionsPage } from "./ReleaseDecisionsPage";
import type { JudgedRelease } from "../../lib/releaseDecisionPresentation";

const api = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  evaluateReleases: vi.fn(),
  acquireRelease: vi.fn(),
}));

vi.mock("../../lib/releaseDecisionsApi", () => api);
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

function release(over: Partial<JudgedRelease> = {}): JudgedRelease {
  return {
    guid: "g1",
    indexerId: "nzbgeek",
    title: "Dune.2021.2160p.WEB-DL.HEVC",
    quality: "WEB-DL 2160p",
    accepted: true,
    rank: 30,
    score: 100,
    reasons: [{ code: "codec", detail: "Preferred codec HEVC" }],
    ...over,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <ReleaseDecisionsPage />
    </MemoryRouter>,
  );

async function searchFor(title = "Dune") {
  fireEvent.change(await screen.findByLabelText("admin.decisions.titleField"), {
    target: { value: title },
  });
  fireEvent.click(screen.getByText("admin.decisions.search"));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listProfiles.mockResolvedValue([{ id: "p1", name: "HD-2160p" }]);
  api.evaluateReleases.mockResolvedValue({
    candidates: [release()],
    winner: release(),
    profile: { id: "p1", name: "HD-2160p" },
  });
  api.acquireRelease.mockResolvedValue({});
});

describe("the release decision page", () => {
  it("explains a rejection instead of only marking it red", async () => {
    /*
     * The whole reason the page exists. A coloured score tells an operator
     * which release won and nothing about why the others did not.
     */
    api.evaluateReleases.mockResolvedValue({
      candidates: [
        release({
          guid: "a",
          title: "Dune.720p",
          accepted: false,
          rank: 1,
          rejection: "quality not allowed",
          reasons: [],
        }),
      ],
      winner: null,
      profile: { id: "p1", name: "HD-2160p" },
    });
    renderPage();
    await searchFor();

    expect(await screen.findByText("quality not allowed")).toBeTruthy();
    expect(screen.getByText("admin.decisions.rejected")).toBeTruthy();
  });

  it("gives the reasons a release was liked, not just its number", async () => {
    renderPage();
    await searchFor();
    expect(await screen.findByText("Preferred codec HEVC")).toBeTruthy();
  });

  it("marks the recommended release as such", async () => {
    renderPage();
    await searchFor();
    expect(await screen.findByText("admin.decisions.recommended")).toBeTruthy();
  });

  it("puts what the profile allows above what it does not", async () => {
    api.evaluateReleases.mockResolvedValue({
      candidates: [
        release({
          guid: "a",
          title: "Rejected one",
          accepted: false,
          score: 900,
          rank: 1,
        }),
        release({
          guid: "b",
          title: "Allowed one",
          accepted: true,
          score: 1,
          rank: 5,
        }),
      ],
      winner: null,
      profile: { id: "p1", name: "HD-2160p" },
    });
    renderPage();
    await searchFor();

    await screen.findByText("Allowed one");
    const items = screen.getAllByRole("listitem").map((n) => n.textContent);
    const allowed = items.findIndex((text) => text?.includes("Allowed one"));
    const rejected = items.findIndex((text) => text?.includes("Rejected one"));
    expect(allowed).toBeLessThan(rejected);
  });

  it("offers to download only what the profile accepts", async () => {
    api.evaluateReleases.mockResolvedValue({
      candidates: [release({ accepted: false, rejection: "not allowed" })],
      winner: null,
      profile: { id: "p1", name: "HD-2160p" },
    });
    renderPage();
    await searchFor();

    await screen.findByText("not allowed");
    expect(screen.queryByText("admin.decisions.acquire")).toBeNull();
  });

  it("asks for a release by indexer and guid, never by a URL", async () => {
    /*
     * The server resolves the release and fetches the NZB with its own
     * credentials. A URL crossing this boundary would put a credential-bearing
     * link in a browser and let a client choose what the server fetches.
     */
    renderPage();
    await searchFor();
    fireEvent.click(await screen.findByText("admin.decisions.acquire"));

    await waitFor(() => expect(api.acquireRelease).toHaveBeenCalled());
    const sent = api.acquireRelease.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({
      indexerId: "nzbgeek",
      releaseGuid: "g1",
      releaseTitle: "Dune.2021.2160p.WEB-DL.HEVC",
    });
    expect(JSON.stringify(sent)).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(sent)).not.toMatch(/apikey/i);
  });

  it("does not let the same release be asked for twice by accident", async () => {
    renderPage();
    await searchFor();
    fireEvent.click(await screen.findByText("admin.decisions.acquire"));

    expect(await screen.findByText("admin.decisions.asked")).toBeTruthy();
    expect(
      screen.getByText("admin.decisions.asked").closest("button")?.disabled,
    ).toBe(true);
  });

  it("says a search failed without repeating what was thrown", async () => {
    // The message can carry the indexer request URL, and this is a browser.
    api.evaluateReleases.mockRejectedValue(
      new Error("fetch https://api.nzbgeek.info/api?apikey=secret failed"),
    );
    renderPage();
    await searchFor();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("admin.decisions.searchFailed");
    expect(alert.textContent).not.toMatch(/apikey/i);
  });

  it("says plainly when a title found nothing", async () => {
    api.evaluateReleases.mockResolvedValue({
      candidates: [],
      winner: null,
      profile: { id: "p1", name: "HD-2160p" },
    });
    renderPage();
    await searchFor();
    expect(await screen.findByText("admin.decisions.noResults")).toBeTruthy();
  });
});
