/**
 * The acquisition endpoints, as the operations pages use them.
 *
 * The server decides what these carry; nothing here reconstructs a field it
 * chose not to send. In particular there is no download URL, no SABnzbd job
 * identifier and no filesystem path, and none of them should be added: the
 * first is credential-bearing and the others exist to be kept server-side.
 */
import { ownApiClient } from "../api/ownApi/client";
import type {
  AcquisitionFailureClass,
  AcquisitionState,
} from "./acquisitionPresentation";

export interface Acquisition {
  readonly id: string;
  readonly state: AcquisitionState;
  readonly origin: string;
  readonly target: { kind: string; title: string };
  readonly indexerId: string;
  readonly releaseTitle: string;
  readonly attempt: number;
  readonly failureClass?: AcquisitionFailureClass;
  readonly failureDetail?: string;
  readonly sizeBytes?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AcquisitionReason {
  readonly code?: string;
  readonly detail?: string;
}

export interface RejectedRelease {
  readonly title?: string;
  readonly reason?: string;
}

export interface AcquisitionDecision {
  readonly profileName: string;
  readonly score: number;
  readonly reasons: AcquisitionReason[];
  readonly rejected: RejectedRelease[];
  readonly decidedAt: string;
}

export interface AcquisitionEvent {
  readonly fromState: string | null;
  readonly toState: string;
  readonly failureClass?: string;
  readonly detail?: string;
  readonly at: string;
}

export interface AcquisitionDetail {
  readonly acquisition: Acquisition;
  readonly decision: AcquisitionDecision | null;
  readonly events: AcquisitionEvent[];
}

/** The two shapes the decision's JSON columns can legitimately arrive in. */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function listAcquisitions(limit = 100): Promise<Acquisition[]> {
  const { acquisitions } = await ownApiClient.request<{
    acquisitions: Acquisition[];
  }>(`/acquisitions?limit=${limit}`);
  return acquisitions;
}

export async function getAcquisition(id: string): Promise<AcquisitionDetail> {
  const data = await ownApiClient.request<{
    acquisition: Acquisition;
    decision:
      | (Omit<AcquisitionDecision, "reasons" | "rejected"> & {
          reasons: unknown;
          rejected: unknown;
        })
      | null;
    events: AcquisitionEvent[];
  }>(`/acquisitions/${encodeURIComponent(id)}`);

  return {
    acquisition: data.acquisition,
    decision: data.decision
      ? {
          profileName: data.decision.profileName,
          score: data.decision.score,
          // The columns are `jsonb`, so their contents are whatever was
          // recorded; anything that is not a list is treated as none.
          reasons: asArray<AcquisitionReason>(data.decision.reasons),
          rejected: asArray<RejectedRelease>(data.decision.rejected),
          decidedAt: data.decision.decidedAt,
        }
      : null,
    events: data.events,
  };
}

export function retryAcquisition(id: string): Promise<unknown> {
  return ownApiClient.request(`/acquisitions/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    body: {},
  });
}

export function cancelAcquisition(id: string): Promise<unknown> {
  return ownApiClient.request(
    `/acquisitions/${encodeURIComponent(id)}/cancel`,
    { method: "POST", body: {} },
  );
}
