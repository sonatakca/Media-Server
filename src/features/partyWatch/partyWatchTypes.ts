import type { TranslationKey } from "../../i18n/translations";

export type SyncPlayGroupState =
  | "Idle"
  | "Waiting"
  | "Paused"
  | "Playing"
  | string;

export type SyncPlayCommandType =
  | "Unpause"
  | "Pause"
  | "Stop"
  | "Seek"
  | string;

export type SyncPlayGroupUpdateType =
  | "UserJoined"
  | "UserLeft"
  | "GroupJoined"
  | "GroupLeft"
  | "StateUpdate"
  | "PlayQueue"
  | "NotInGroup"
  | "GroupDoesNotExist"
  | "LibraryAccessDenied"
  | string;

export type SyncPlaySocketStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type PartyWatchRole = "host" | "member";

export interface SyncPlayParticipant {
  UserId?: string;
  UserName?: string;
  Username?: string;
  Name?: string;
  DeviceName?: string;
}

export interface SyncPlayGroupInfo {
  GroupId?: string;
  GroupName?: string;
  State?: SyncPlayGroupState;
  Participants?: Array<SyncPlayParticipant | string>;
  LastUpdatedAt?: string;
}

export interface SyncPlayQueueItem {
  ItemId?: string;
  PlaylistItemId?: string;
}

export interface SyncPlayPlayQueueUpdate {
  Reason?: string;
  LastUpdate?: string;
  Playlist?: SyncPlayQueueItem[];
  PlayingItemIndex?: number;
  StartPositionTicks?: number;
  IsPlaying?: boolean;
}

export interface SyncPlayGroupStateUpdate {
  State?: SyncPlayGroupState;
  Reason?: string;
}

export interface SyncPlayGroupUpdate {
  Type?: SyncPlayGroupUpdateType;
  GroupId?: string;
  Data?: unknown;
}

export interface SyncPlaySendCommand {
  GroupId?: string;
  PlaylistItemId?: string;
  When?: string;
  PositionTicks?: number | null;
  Command?: SyncPlayCommandType;
  EmittedAt?: string;
}

export interface SyncPlaySocketMessage {
  MessageId?: string;
  MessageType?: string;
  Data?: unknown;
}

export interface SyncPlayPlayerStatus {
  when?: string;
  positionTicks: number;
  isPlaying: boolean;
  playlistItemId?: string;
}

export interface PartyWatchController {
  isAvailable: boolean;
  isLoading: boolean;
  isInGroup: boolean;
  isApplyingRemoteCommand: boolean;
  isResumePending: boolean;
  isPlayPausePending: boolean;
  shouldDeferAutoplay: boolean;
  groupId: string | null;
  groupName: string | null;
  groupState: SyncPlayGroupState | null;
  joinInput: string;
  inviteUrl: string | null;
  participantCount: number | null;
  participantNames: string[];
  partyEventMessage: string | null;
  role: PartyWatchRole | null;
  canControl: boolean;
  socketStatus: SyncPlaySocketStatus;
  statusKey: TranslationKey | null;
  errorKey: TranslationKey | null;
  copyStatusKey: TranslationKey | null;
  setJoinInput: (value: string) => void;
  createGroup: () => Promise<void>;
  joinGroup: (groupId?: string) => Promise<void>;
  leaveGroup: () => Promise<void>;
  copyInvite: () => Promise<void>;
  togglePlay: () => void;
  seekTo: (seconds: number) => void;
  seekBy: (seconds: number) => void;
}
