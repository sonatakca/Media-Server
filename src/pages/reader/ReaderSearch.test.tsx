import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "../../i18n/LanguageContext";
import { LANGUAGE_STORAGE_KEY } from "../../i18n/translations";
import type { BookSearchHit, BookSearchOutcome } from "../../lib/bookSearchApi";
import { ReaderSearch } from "./ReaderSearch";

const searchBook =
  vi.fn<(itemId: string, query: string) => Promise<BookSearchOutcome>>();

vi.mock("../../lib/bookSearchApi", () => ({
  searchBook: (itemId: string, query: string) => searchBook(itemId, query),
}));

const HIT: BookSearchHit = {
  section: 18,
  block: 42,
  anchor: "Vahşi kırbacı kaldırdı",
  text: "Vahşi kırbacı kaldırdı ve kendine vurdu.",
  score: 0.61,
};

function renderSearch(active = true) {
  const onShow = vi.fn();
  const view = render(
    <LanguageProvider>
      <ReaderSearch
        itemId="book-1"
        active={active}
        chapterOf={(section) => (section === 18 ? "On Sekizinci Bölüm" : null)}
        onShow={onShow}
      />
    </LanguageProvider>,
  );
  return { onShow, view };
}

beforeEach(() => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
  searchBook.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("searching inside the reader", () => {
  it("asks nothing while the tab is off screen", () => {
    renderSearch(false);
    expect(searchBook).not.toHaveBeenCalled();
  });

  it("prepares the book when the tab opens, and asks again until it is ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    searchBook
      .mockResolvedValueOnce({ state: "preparing", progress: null })
      .mockResolvedValueOnce({ state: "preparing", progress: 0.4 })
      .mockResolvedValueOnce({ state: "ready", hits: [] });

    renderSearch();
    await act(async () => undefined);
    expect(searchBook).toHaveBeenLastCalledWith("book-1", "");
    expect(
      screen.getByText("Getting this book ready to search"),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "40",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(searchBook).toHaveBeenCalledTimes(3);
    expect(
      screen.getByText(/Describe what happens in your own words/),
    ).toBeInTheDocument();
  });

  it("searches on Enter and opens the book at the passage chosen", async () => {
    searchBook.mockImplementation(async (_id, query) =>
      query ? { state: "ready", hits: [HIT] } : { state: "ready", hits: [] },
    );
    const { onShow } = renderSearch();
    const user = userEvent.setup();

    await user.type(
      screen.getByRole("searchbox", { name: "Search this book" }),
      "  the savage whips himself {Enter}",
    );
    expect(searchBook).toHaveBeenLastCalledWith(
      "book-1",
      "the savage whips himself",
    );

    const result = await screen.findByRole("button", {
      name: /Vahşi kırbacı kaldırdı/,
    });
    expect(result).toHaveTextContent("On Sekizinci Bölüm");
    await user.click(result);
    expect(onShow).toHaveBeenCalledWith(HIT);
  });

  it("says it is searching until the answer comes, never that nothing matched", async () => {
    let answer: (outcome: BookSearchOutcome) => void = () => undefined;
    searchBook.mockImplementation((_id, query) =>
      query
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve({ state: "ready", hits: [] }),
    );
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole("searchbox"), "the savage{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");
    expect(
      screen.queryByText("Nothing in this book matches that."),
    ).not.toBeInTheDocument();

    expect(
      await screen.findByText(
        /first search can take a few seconds/,
        undefined,
        {
          timeout: 3000,
        },
      ),
    ).toBeInTheDocument();

    await act(async () => answer({ state: "ready", hits: [HIT] }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Vahşi kırbacı kaldırdı/ }),
    ).toBeInTheDocument();
  });

  it("says so when nothing matches, when the book cannot be searched, and when the server is away", async () => {
    searchBook.mockResolvedValue({ state: "ready", hits: [] });
    const user = userEvent.setup();
    const first = renderSearch();
    await user.type(screen.getByRole("searchbox"), "nothing{Enter}");
    expect(
      await screen.findByText("Nothing in this book matches that."),
    ).toBeInTheDocument();
    first.view.unmount();

    searchBook.mockResolvedValue({ state: "unavailable", reason: "DRM" });
    const second = renderSearch();
    expect(
      await screen.findByText("This book can't be searched."),
    ).toBeInTheDocument();
    second.view.unmount();

    searchBook.mockRejectedValue(new Error("offline"));
    renderSearch();
    expect(
      await screen.findByText(
        "Search isn't answering right now. Try again in a moment.",
      ),
    ).toBeInTheDocument();
  });
});
