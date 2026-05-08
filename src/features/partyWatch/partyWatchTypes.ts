import type { TranslationKey } from "../../i18n/translations";

export type JellyfinSyncPlayGroupState = "Idle" | "Waiting" | "Paused" | "Playing" | string;

export type JellyfinSyncPlayCommandType = "Unpause" | "Pause" | "Stop" | "Seek" | string;

export type JellyfinSyncPlayGroupUpdateType =
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

export type JellyfinSyncPlaySocketStatus = "connecting" | "connected" | "disconnected" | "error";

export type PartyWatchRole = "host" | "member";

export interface JellyfinSyncPlayGroupInfo {
  GroupId?: string;
  GroupName?: string;
  State?: JellyfinSyncPlayGroupState;
  Participants?: unknown[];
  LastUpdatedAt?: string;
}

export interface JellyfinSyncPlayQueueItem {
  ItemId?: string;
  PlaylistItemId?: string;
}

export interface JellyfinSyncPlayPlayQueueUpdate {
  Reason?: string;
  LastUpdate?: string;
  Playlist?: JellyfinSyncPlayQueueItem[];
  PlayingItemIndex?: number;
  StartPositionTicks?: number;
  IsPlaying?: boolean;
}

export interface JellyfinSyncPlayGroupStateUpdate {
  State?: JellyfinSyncPlayGroupState;
  Reason?: string;
}

export interface JellyfinSyncPlayGroupUpdate {
  Type?: JellyfinSyncPlayGroupUpdateType;
  GroupId?: string;
  Data?: unknown;
}

export interface JellyfinSyncPlaySendCommand {
  GroupId?: string;
  PlaylistItemId?: string;
  When?: string;
  PositionTicks?: number | null;
  Command?: JellyfinSyncPlayCommandType;
  EmittedAt?: string;
}

export interface JellyfinSyncPlaySocketMessage {
  MessageId?: string;
  MessageType?: string;
  Data?: unknown;
}

export interface JellyfinSyncPlayPlayerStatus {
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
  shouldDeferAutoplay: boolean;
  groupId: string | null;
  groupName: string | null;
  groupState: JellyfinSyncPlayGroupState | null;
  joinInput: string;
  inviteUrl: string | null;
  participantCount: number | null;
  role: PartyWatchRole | null;
  canControl: boolean;
  socketStatus: JellyfinSyncPlaySocketStatus;
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
