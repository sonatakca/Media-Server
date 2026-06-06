import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaybackQueue } from "../../lib/playbackQueue";
import type { JellyfinItem } from "../../lib/types";
import { PlayerQueuePanel } from "./PlayerQueuePanel";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        "details.watched": "İzlendi",
        "media.episodeNumber": "Episode {number}",
        "media.seasonEpisodeNumber":
          "Season {seasonNumber} · Episode {episodeNumber}",
        "media.seasonNumber": "Season {number}",
        "player.playbackQueue": "Liste",
        "player.queueCollection": "Koleksiyon",
        "player.queueEpisodes": "Bölümler",
        "player.seasonSelect": "Season",
      })[key] ?? key,
  }),
}));

function episode(
  id: string,
  name: string,
  episodeNumber: number,
  played = false,
): JellyfinItem {
  return {
    Id: id,
    Name: name,
    Type: "Episode",
    IndexNumber: episodeNumber,
    ParentIndexNumber: 1,
    SeasonId: "season-1",
    UserData: played ? { Played: true } : undefined,
  };
}

function renderPanel(queue: PlaybackQueue, onPlayItem = vi.fn()) {
  render(<PlayerQueuePanel queue={queue} onPlayItem={onPlayItem} />);

  return onPlayItem;
}

function movie(
  id: string,
  name: string,
  productionYear: number,
  played = false,
): JellyfinItem {
  return {
    Id: id,
    Name: name,
    Type: "Movie",
    ProductionYear: productionYear,
    UserData: played ? { Played: true } : undefined,
  };
}

describe("PlayerQueuePanel", () => {
  it("marks watched items and prevents replaying the current item", () => {
    const watchedEpisode = episode("episode-1", "Watched episode", 1, true);
    const currentEpisode = episode("episode-2", "Current episode", 2);
    const nextEpisode = episode("episode-3", "Next episode", 3);
    const queue: PlaybackQueue = {
      kind: "series",
      currentItemId: currentEpisode.Id,
      items: [watchedEpisode, currentEpisode, nextEpisode],
      seasons: [
        {
          id: "season-1",
          seasonNumber: 1,
          episodes: [watchedEpisode, currentEpisode, nextEpisode],
        },
      ],
      currentSeasonId: "season-1",
      nextItem: nextEpisode,
    };
    const onPlayItem = renderPanel(queue);

    expect(screen.getByText("Bölümler")).toBeInTheDocument();
    expect(screen.getByText("İzlendi")).toBeInTheDocument();

    const currentButton = screen.getByRole("button", {
      name: /Current episode/i,
    });
    expect(currentButton).toHaveAttribute("aria-disabled", "true");
    expect(currentButton).not.toBeDisabled();

    fireEvent.click(currentButton);
    expect(onPlayItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Next episode/i }));
    expect(onPlayItem).toHaveBeenCalledWith(nextEpisode);
  });

  it("uses the collection title for movie queues", () => {
    const currentMovie = movie("movie-1", "Current movie", 2022);
    const sequelMovie = movie("movie-2", "Sequel movie", 2025);
    const queue: PlaybackQueue = {
      kind: "collection",
      currentItemId: currentMovie.Id,
      items: [currentMovie, sequelMovie],
      nextItem: sequelMovie,
    };
    const onPlayItem = renderPanel(queue);

    expect(screen.getByText("Koleksiyon")).toBeInTheDocument();
    expect(screen.queryByText("Liste")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Current movie/i }));
    expect(onPlayItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Sequel movie/i }));
    expect(onPlayItem).toHaveBeenCalledWith(sequelMovie);
  });
});
