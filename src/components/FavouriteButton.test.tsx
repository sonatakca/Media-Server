import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setItemFavourite } from "../lib/mediaApi";
import type { MediaItem } from "../lib/types";
import { FavouriteButton } from "./FavouriteButton";

vi.mock("../lib/mediaApi", () => ({
  setItemFavourite: vi.fn(),
}));

vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        "myList.addToMyList": "Add to My List",
        "myList.removeFromMyList": "Remove from My List",
        "myList.couldNotSave": "Could not save. Try again.",
      })[key] ?? key,
  }),
}));

const mockedSetItemFavourite = vi.mocked(setItemFavourite);

function movie(isFavourite: boolean): MediaItem {
  return {
    Id: "movie-1",
    Name: "Movie",
    Type: "Movie",
    UserData: { IsFavorite: isFavourite },
  };
}

describe("FavouriteButton", () => {
  beforeEach(() => {
    mockedSetItemFavourite.mockReset();
    mockedSetItemFavourite.mockResolvedValue(undefined);
  });

  it("reflects the stored favourite state", () => {
    render(<FavouriteButton item={movie(true)} className="" />);

    const button = screen.getByRole("button", { name: "Remove from My List" });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("adds an item to the list and reports the new state", async () => {
    render(<FavouriteButton item={movie(false)} className="" />);

    fireEvent.click(screen.getByRole("button", { name: "Add to My List" }));

    await waitFor(() => {
      expect(mockedSetItemFavourite).toHaveBeenCalledWith("movie-1", true);
    });

    expect(
      screen.getByRole("button", { name: "Remove from My List" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("rolls the optimistic toggle back when the write fails", async () => {
    mockedSetItemFavourite.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    render(<FavouriteButton item={movie(false)} className="" />);

    fireEvent.click(screen.getByRole("button", { name: "Add to My List" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Add to My List" }),
      ).toHaveAttribute("aria-pressed", "false");
    });

    warn.mockRestore();
  });

  it("keeps every surface showing the same item in sync", async () => {
    render(
      <>
        <FavouriteButton item={movie(false)} className="" />
        <FavouriteButton item={movie(false)} className="" />
      </>,
    );

    const [firstButton] = screen.getAllByRole("button", {
      name: "Add to My List",
    });

    fireEvent.click(firstButton);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: "Remove from My List" }),
      ).toHaveLength(2);
    });
  });
});
