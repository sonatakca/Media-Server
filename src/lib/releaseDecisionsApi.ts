/**
 * Searching and judging releases, and asking for one.
 *
 * A release is named to the server by indexer and guid, never by URL. The
 * server resolves it and fetches the NZB with its own credentials — the whole
 * reason Phase 2 kept the download URL out of every DTO — so nothing here
 * accepts or forwards one.
 */
import { ownApiClient } from "../api/ownApi/client";
import type { JudgedRelease } from "./releaseDecisionPresentation";

export interface QualityProfile {
  readonly id: string;
  readonly name: string;
}

export interface EvaluateQuery {
  readonly kind: "movie" | "tv";
  readonly title: string;
  readonly year?: number;
  readonly profileId?: string;
}

export interface EvaluateResult {
  readonly candidates: JudgedRelease[];
  readonly winner: JudgedRelease | null;
  readonly profile: { id: string; name: string };
}

export async function listProfiles(): Promise<QualityProfile[]> {
  const { profiles } = await ownApiClient.request<{
    profiles: QualityProfile[];
  }>("/releases/profiles");
  return profiles;
}

export function evaluateReleases(
  query: EvaluateQuery,
): Promise<EvaluateResult> {
  return ownApiClient.request<EvaluateResult>("/releases/evaluate", {
    method: "POST",
    body: { ...query },
  });
}

export interface AcquireRequest {
  readonly kind: "movie" | "season" | "episode";
  readonly title: string;
  readonly year?: number;
  readonly indexerId: string;
  readonly releaseGuid: string;
  readonly releaseTitle: string;
  readonly profileId?: string;
  readonly score?: number;
  readonly reasons?: unknown;
}

export function acquireRelease(request: AcquireRequest): Promise<unknown> {
  return ownApiClient.request("/acquisitions", {
    method: "POST",
    body: { ...request },
  });
}
