/**
 * Party Watch wire types: what the server's SyncPlay routes send and accept.
 * Mirrors `src/server/ownApi/syncplay/syncplayRuntime.ts`.
 */

export type PartyIntent = "playing" | "paused";
export type PartyHoldReason = "settling" | "buffering";

/** What a client says about its own player. */
export type PartyParticipantStatus = "loading" | "ready" | "stalled" | "away";

/** How the server sees a participant's connection. */
export type PartyParticipantPresence =
  | "connected"
  | "reconnecting"
  | "unresponsive";

export interface PartyParticipant {
  /** `userId:clientId` */
  id: string;
  userId: string;
  displayName: string;
  isOwner: boolean;
  presence: PartyParticipantPresence;
  status: PartyParticipantStatus;
}

export type PartyCauseKind =
  | "play"
  | "pause"
  | "seek"
  | "setItem"
  | "joined"
  | "left"
  | "hold"
  | "resumed";

export interface PartyCause {
  kind: PartyCauseKind;
  participantId: string | null;
  displayName: string | null;
  releasedPast?: Array<{ id: string; displayName: string }>;
  holdReason?: PartyHoldReason;
}

export interface PartySnapshot {
  id: string;
  name: string;
  ownerUserId: string;
  itemId: string | null;
  epoch: string;
  version: number;
  revision: number;
  intent: PartyIntent;
  positionMs: number;
  anchorMs: number;
  serverTimeMs: number;
  hold: { reason: PartyHoldReason; waitingFor: string[] } | null;
  participants: PartyParticipant[];
  cause: PartyCause | null;
}

export type PartyCommand =
  | { type: "play" }
  | { type: "pause"; positionMs?: number }
  | { type: "seek"; positionMs: number }
  | { type: "setItem"; itemId: string; fromItemId: string | null };

export type PartyCloseReason = "ended" | "empty" | "expired";
