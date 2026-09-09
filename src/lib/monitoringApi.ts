/**
 * Monitoring, addressed by catalogue id.
 *
 * Each level carries its own choice, the effective answer, and which level
 * produced it. The page shows all three rather than a single toggle, because
 * a season that is monitored because its series is, and one that was set
 * monitored deliberately, behave differently the moment the series changes.
 */
import { ownApiClient } from "../api/ownApi/client";

export type MonitoringChoice = "inherit" | "monitored" | "unmonitored";
export type DecidedBy = "series" | "season" | "episode";

export interface MonitoredTitle {
  readonly itemId: string;
  readonly monitored: boolean;
  readonly profileId?: string;
}

export interface MonitoredSeasonView {
  readonly seasonNumber: number;
  readonly choice: MonitoringChoice;
  readonly monitored: boolean;
  readonly decidedBy: DecidedBy;
  readonly reason: string;
}

export interface MonitoredEpisodeView extends Omit<
  MonitoredSeasonView,
  "seasonNumber"
> {
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  readonly airedAt?: string;
}

export interface MonitoringView {
  readonly title: MonitoredTitle;
  readonly seasons: MonitoredSeasonView[];
  readonly episodes: MonitoredEpisodeView[];
}

export function getMonitoring(itemId: string): Promise<MonitoringView> {
  return ownApiClient.request<MonitoringView>(
    `/monitoring/${encodeURIComponent(itemId)}`,
  );
}

export function setTitleMonitoring(
  itemId: string,
  monitored: boolean,
): Promise<unknown> {
  return ownApiClient.request(`/monitoring/${encodeURIComponent(itemId)}`, {
    method: "PUT",
    body: { monitored },
  });
}

export function setSeasonMonitoring(
  itemId: string,
  seasonNumber: number,
  choice: MonitoringChoice,
): Promise<unknown> {
  return ownApiClient.request(
    `/monitoring/${encodeURIComponent(itemId)}/seasons/${seasonNumber}`,
    { method: "PUT", body: { choice } },
  );
}

export function setEpisodeMonitoring(
  itemId: string,
  seasonNumber: number,
  episodeNumber: number,
  choice: MonitoringChoice,
): Promise<unknown> {
  return ownApiClient.request(
    `/monitoring/${encodeURIComponent(itemId)}/seasons/${seasonNumber}/episodes/${episodeNumber}`,
    { method: "PUT", body: { choice } },
  );
}

export interface SeriesSummary {
  readonly Id: string;
  readonly Name: string;
  readonly ProductionYear?: number;
}

export async function listSeries(): Promise<SeriesSummary[]> {
  const data = await ownApiClient.request<
    { Items?: SeriesSummary[] } | SeriesSummary[]
  >("/series?limit=200");
  return Array.isArray(data) ? data : (data.Items ?? []);
}
