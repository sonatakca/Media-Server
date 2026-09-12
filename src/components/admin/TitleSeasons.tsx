import { Captions, Images } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  toneOf,
  type LibraryEpisode,
  type LibraryTitleDetail,
} from "../../lib/libraryAdminApi";
import { Facts } from "./libraryPresentation";
import { actionButton, TONE_STYLE } from "./libraryStyle";

export interface SeasonActions {
  busy: boolean;
  onSubtitles: (itemId: string) => void;
  onTrickplay: (itemId: string) => void;
}

function EpisodeRow({
  episode,
  wanted,
  actions,
}: {
  episode: LibraryEpisode;
  wanted: boolean;
  actions: SeasonActions;
}) {
  const { t } = useLanguage();
  const tone = toneOf(episode, wanted && episode.monitored);
  const code = `E${String(episode.episodeNumber).padStart(2, "0")}`;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_STYLE[tone].dot}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-white/85">
          <span className="tabular-nums text-white/50">{code}</span>{" "}
          {episode.title ?? ""}
          <span className="sr-only">
            {" "}
            · {t(`library.tone.${tone}` as TranslationKey)}
          </span>
        </p>
        {episode.hasMedia ? (
          <Facts facts={episode} />
        ) : (
          <p className="mt-0.5 text-xs text-white/40">
            {t(`library.tone.${tone}` as TranslationKey)}
            {episode.airDate ? ` · ${episode.airDate}` : ""}
          </p>
        )}
      </div>
      {episode.id && episode.mediaFileId ? (
        <div className="flex gap-1.5">
          <button
            type="button"
            className={actionButton}
            disabled={actions.busy}
            onClick={() => actions.onTrickplay(episode.id!)}
            aria-label={`${t("library.generateTrickplay")} · ${code}`}
            title={t("library.generateTrickplay")}
          >
            <Images size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={actionButton}
            disabled={actions.busy}
            onClick={() => actions.onSubtitles(episode.id!)}
            aria-label={`${t("library.findTurkish")} · ${code}`}
          >
            <Captions size={13} aria-hidden="true" />
            TR
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** A show's seasons, with what each season and episode holds and can be asked for. */
export function TitleSeasons({
  detail,
  actions,
}: {
  detail: LibraryTitleDetail;
  actions: SeasonActions;
}) {
  const { t } = useLanguage();
  return (
    <div className="space-y-3">
      {!detail.catalogueComplete ? (
        <p className="text-xs text-amber-200">
          {t("library.catalogueOffline")}
        </p>
      ) : null}
      {detail.seasons.map((season) => {
        const held = season.episodes.filter((e) => e.hasMedia).length;
        const label =
          season.seasonNumber === 0
            ? t("library.specials")
            : `${t("library.season")} ${season.seasonNumber}`;
        return (
          <details
            key={season.seasonNumber}
            className="rounded-xl border border-white/10 bg-black/20"
            open={detail.seasons.length === 1}
          >
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-3 py-2 text-sm font-black text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              <span>{label}</span>
              <span className="text-xs font-bold tabular-nums text-white/50">
                {held}/{season.episodes.length}
              </span>
              {/* One segment per episode: the season at a glance. */}
              <span aria-hidden="true" className="flex min-w-16 flex-1 gap-0.5">
                {season.episodes.map((episode) => (
                  <span
                    key={episode.episodeNumber}
                    className={`h-1.5 max-w-6 flex-1 rounded-full ${
                      TONE_STYLE[
                        toneOf(episode, detail.desired && episode.monitored)
                      ].dot
                    }`}
                  />
                ))}
              </span>
              {season.id && held > 0 ? (
                <span className="flex gap-1.5">
                  <button
                    type="button"
                    className={actionButton}
                    disabled={actions.busy}
                    onClick={(event) => {
                      event.preventDefault();
                      actions.onTrickplay(season.id!);
                    }}
                    aria-label={`${t("library.generateTrickplay")} · ${label}`}
                    title={t("library.generateTrickplay")}
                  >
                    <Images size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={actionButton}
                    disabled={actions.busy}
                    onClick={(event) => {
                      event.preventDefault();
                      actions.onSubtitles(season.id!);
                    }}
                    aria-label={`${t("library.findTurkish")} · ${label}`}
                  >
                    <Captions size={13} aria-hidden="true" />
                    TR
                  </button>
                </span>
              ) : null}
            </summary>
            <ul className="divide-y divide-white/5 px-3">
              {season.episodes.map((episode) => (
                <EpisodeRow
                  key={`${episode.seasonNumber}:${episode.episodeNumber}:${episode.id ?? ""}`}
                  episode={episode}
                  wanted={detail.desired}
                  actions={actions}
                />
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
