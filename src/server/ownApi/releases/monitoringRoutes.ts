/**
 * Monitoring over HTTP.
 *
 * Everything is addressed by catalogue id. No path appears in a request or a
 * response: monitoring is a statement about a title, not about a file, and an
 * endpoint that accepted a path would be a second way to name media.
 *
 * Each level reports three things — what it was explicitly set to, what it
 * effectively is, and which level decided — because "monitored" on its own
 * leaves an operator unable to tell a season they set from one that is merely
 * following its series.
 */
import { OwnApiError } from "../ownApiHandler";
import { sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyString,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { MonitoringRepository } from "./monitoringRepository";
import type { MonitoringChoice } from "./monitoring";

const CHOICES: readonly MonitoringChoice[] = [
  "inherit",
  "monitored",
  "unmonitored",
];

function requireChoice(value: unknown): MonitoringChoice {
  const choice = String(value);
  if (!CHOICES.includes(choice as MonitoringChoice)) {
    throw validationError(
      "The monitoring choice must be inherit, monitored or unmonitored.",
    );
  }
  return choice as MonitoringChoice;
}

function requireNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw validationError(`${name} must be a whole season or episode number.`);
  }
  return parsed;
}

export function createMonitoringRoutes(
  repository: MonitoringRepository,
): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/monitoring/:itemId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const series = await repository.readSeries(itemId);
        if (!series) {
          throw new OwnApiError("NOT_FOUND", "No such catalogue item.", 404);
        }
        sendData(context.response, context.requestId, {
          title: {
            itemId: series.title.itemId,
            monitored: series.title.monitored,
            ...(series.title.profileId
              ? { profileId: series.title.profileId }
              : {}),
          },
          seasons: series.seasons.map((season) => ({
            seasonNumber: season.seasonNumber,
            // What was set here, and what it works out to, kept apart.
            choice: season.monitoring,
            monitored: season.effective.monitored,
            decidedBy: season.effective.decidedBy,
            reason: season.effective.reason.detail,
          })),
          episodes: series.episodes.map((episode) => ({
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            choice: episode.monitoring,
            monitored: episode.effective.monitored,
            decidedBy: episode.effective.decidedBy,
            reason: episode.effective.reason.detail,
            ...(episode.airedAtMs === undefined
              ? {}
              : { airedAt: new Date(episode.airedAtMs).toISOString() }),
          })),
        });
      },
    },
    {
      method: "PUT",
      path: "/monitoring/:itemId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody(await context.readJson(), [
          "monitored",
          "profileId",
        ]);
        if (typeof body.monitored !== "boolean") {
          throw validationError("monitored must be true or false.");
        }
        const profileId = optionalBodyString(body, "profileId", {
          maxLength: 64,
        });
        const saved = await repository.setTitle(itemId, {
          monitored: body.monitored,
          ...(profileId ? { profileId } : {}),
        });
        sendData(context.response, context.requestId, {
          title: { itemId: saved.itemId, monitored: saved.monitored },
        });
      },
    },
    {
      /** Sets or clears a season's own opinion. `inherit` is the clear. */
      method: "PUT",
      path: "/monitoring/:itemId/seasons/:seasonNumber",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const seasonNumber = requireNumber(
          context.params.seasonNumber,
          "seasonNumber",
        );
        const body = asObjectBody(await context.readJson(), ["choice"]);
        await repository.setSeason(
          itemId,
          seasonNumber,
          requireChoice(requireBodyString(body, "choice", { maxLength: 16 })),
        );
        sendNoContent(context.response);
      },
    },
    {
      method: "PUT",
      path: "/monitoring/:itemId/seasons/:seasonNumber/episodes/:episodeNumber",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody(await context.readJson(), ["choice"]);
        await repository.setEpisode(
          itemId,
          requireNumber(context.params.seasonNumber, "seasonNumber"),
          requireNumber(context.params.episodeNumber, "episodeNumber"),
          requireChoice(requireBodyString(body, "choice", { maxLength: 16 })),
        );
        sendNoContent(context.response);
      },
    },
    {
      /** What Seyirlik is watching, for an operator and for the acquisition side. */
      method: "GET",
      path: "/monitoring",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const titles = await repository.listMonitoredTitles();
        sendData(context.response, context.requestId, {
          monitored: titles.map((title) => ({
            itemId: title.itemId,
            ...(title.profileId ? { profileId: title.profileId } : {}),
            ...(title.currentQualityId
              ? { currentQualityId: title.currentQualityId }
              : {}),
          })),
        });
      },
    },
  ];
}
