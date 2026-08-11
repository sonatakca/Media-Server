/**
 * View models rendered by the UI.
 *
 * These are Seyirlik's own shapes. Durations are ticks (100ns) because that is
 * what the player's arithmetic uses throughout; the native API speaks
 * milliseconds and `src/api/ownApi/adapters.ts` is the only place that
 * converts between the two.
 */

import type { PlaybackDiagnostics } from "./playback-planner/types";
import type { MediaQualityManifest } from "../renditions/contracts";

export interface AuthSession {
  serverUrl: string;
  accessToken: string;
  userId: string;
  username: string;
  deviceId: string;
}

export interface MediaUser {
  Id: string;
  Name: string;
  ServerId?: string;
  ServerName?: string;
  PrimaryImageTag?: string;
  HasPassword?: boolean;
  HasConfiguredPassword?: boolean;
  HasConfiguredEasyPassword?: boolean;
  EnableAutoLogin?: boolean;
  LastLoginDate?: string;
  LastActivityDate?: string;
  Configuration?: Record<string, unknown>;
  Policy?: MediaUserPolicy;
  PrimaryImageAspectRatio?: number;
}

export interface MediaUserPolicy extends Record<string, unknown> {
  IsAdministrator?: boolean;
  IsHidden?: boolean;
  IsDisabled?: boolean;
  EnableRemoteAccess?: boolean;
  EnableMediaPlayback?: boolean;
  EnableContentDownloading?: boolean;
  EnableAllFolders?: boolean;
  AuthenticationProviderId?: string;
  PasswordResetProviderId?: string;
}

export interface AuthResponse {
  User: MediaUser;
  SessionInfo?: {
    Id?: string;
    DeviceId?: string;
    DeviceName?: string;
    Client?: string;
  };
  AccessToken: string;
  ServerId?: string;
}

export interface MediaImageTags {
  Primary?: string;
  Logo?: string;
  Thumb?: string;
  Banner?: string;
  [key: string]: string | undefined;
}

export interface MediaUserData {
  PlaybackPositionTicks?: number;
  PlayCount?: number;
  IsFavorite?: boolean;
  Likes?: boolean;
  LastPlayedDate?: string | null;
  Played?: boolean;
  PlayedPercentage?: number;
  UnplayedItemCount?: number;
  Key?: string;
  ItemId?: string;
}

export interface MediaStream {
  Index?: number;
  Type?: "Audio" | "Video" | "Subtitle" | string;
  Codec?: string;
  Profile?: string;
  Level?: number;
  Language?: string;
  DisplayTitle?: string;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
  IsTextSubtitleStream?: boolean;
  DeliveryMethod?: string;
  Title?: string;
  Channels?: number;
  BitRate?: number;
  Width?: number;
  Height?: number;
  AspectRatio?: string;
  AverageFrameRate?: number;
  RealFrameRate?: number;
  VideoRange?: string;
  VideoRangeType?: string;
  ColorTransfer?: string;
  ColorPrimaries?: string;
  ColorSpace?: string;
}

export interface MediaSource {
  Protocol?: string;
  Id?: string;
  Name?: string;
  Path?: string;
  Type?: string;
  Container?: string;
  Size?: number;
  Bitrate?: number;
  ETag?: string;
  RunTimeTicks?: number;
  LiveStreamId?: string;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  TranscodingUrl?: string;
  TranscodingSubProtocol?: string;
  TranscodingContainer?: string;
  TranscodingReasons?: string[];
  DirectStreamUrl?: string;
  DirectPlayError?: string;
  DefaultAudioStreamIndex?: number;
  DefaultSubtitleStreamIndex?: number;
  RequiredHttpHeaders?: Record<string, string>;
  MediaStreams?: MediaStream[];
}

export interface MediaChapter {
  StartPositionTicks?: number;
  Name?: string;
  ImageTag?: string;
}

export type SegmentKind =
  | "Intro"
  | "Outro"
  | "Recap"
  | "Preview"
  | "Commercial"
  | string;

export interface MediaSegment {
  Id?: string;
  ItemId?: string;
  Type?: SegmentKind;
  StartTicks?: number | string;
  EndTicks?: number | string;
  BeginTicks?: number | string;
  Start?: number | string;
  End?: number | string;
  [key: string]: unknown;
}

export interface NormalizedMediaSegment {
  id: string;
  type: SegmentKind;
  startSeconds: number;
  endSeconds: number;
}

export interface MediaItem {
  Id: string;
  Name: string;
  Path?: string;
  SortName?: string;
  OriginalTitle?: string;
  Type?: string;
  MediaType?: string;
  ExtraType?: string;
  CollectionType?: string;
  ProductionYear?: number;
  ChildCount?: number;
  RecursiveItemCount?: number;
  PremiereDate?: string;
  DateCreated?: string;
  LastPlayedDate?: string;
  DatePlayed?: string;
  Overview?: string;
  Taglines?: string[];
  Genres?: string[];
  ProviderIds?: Record<string, string>;
  /**
   * Where this title's logo is anchored over its artwork. Absent means the
   * default, which is the bottom edge every logo sat on before it was settable.
   */
  LogoPlacement?: "top" | "middle" | "bottom";
  OfficialRating?: string;
  CommunityRating?: number;
  RunTimeTicks?: number;
  Chapters?: MediaChapter[];
  ImageTags?: MediaImageTags;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  SeriesName?: string;
  SeasonName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  UserData?: MediaUserData;
  MediaSources?: MediaSource[];
  ParentLogoItemId?: string;
  ParentLogoImageTag?: string;
  SeriesId?: string;
  SeriesPrimaryImageTag?: string;
  SeasonId?: string;
  ParentId?: string;
}

export interface MediaLibrary extends MediaItem {
  CollectionType?: string;
}

export interface MediaItemsResponse<TItem = MediaItem> {
  Items?: TItem[];
  TotalRecordCount?: number;
  StartIndex?: number;
}

export interface ServerInfo {
  LocalAddress?: string;
  ServerName?: string;
  Version?: string;
  ProductName?: string;
  OperatingSystem?: string;
  Id?: string;
}

export interface PlaybackInfoResponse {
  MediaSources?: MediaSource[];
  PlaySessionId?: string;
  ErrorCode?: string;
}

export interface TranscodingInfo {
  AudioCodec?: string;
  VideoCodec?: string;
  Container?: string;
  IsVideoDirect?: boolean;
  IsAudioDirect?: boolean;
  Bitrate?: number;
  Framerate?: number;
  CompletionPercentage?: number;
  Width?: number;
  Height?: number;
  AudioChannels?: number;
  TranscodeReasons?: string[];
  TranscodingReasons?: string[];
  ReasonForTranscoding?: string;
  PlaySessionId?: string;
}

export interface PlaybackSessionInfo {
  Id?: string;
  PlayState?: {
    PlaySessionId?: string;
    PositionTicks?: number;
    IsPaused?: boolean;
  };
  NowPlayingItem?: {
    Id?: string;
    Name?: string;
  };
  TranscodingInfo?: TranscodingInfo;
}

export type MetadataRefreshMode = "Default" | "FullRefresh" | "None";

export interface MetadataRefreshOptions {
  metadataRefreshMode?: MetadataRefreshMode;
  imageRefreshMode?: MetadataRefreshMode;
  replaceAllMetadata?: boolean;
  replaceAllImages?: boolean;
}

export type PlaybackMode =
  | "DirectPlay"
  | "DirectStream"
  | "Transcoding"
  | "Unknown";

export interface PlaybackQualityOption {
  id: string;
  label: string;
  subtitle: string;
  maxHeight?: number;
  maxWidth?: number;
  maxStreamingBitrate: number;
}

export interface PlaybackSourceSettings {
  audioStreamIndex?: number;
  maxHeight?: number;
  maxWidth?: number;
  maxStreamingBitrate?: number;
}

export interface PlaybackSourceCandidate {
  id: string;
  itemId: string;
  mediaSourceId?: string;
  playSessionId?: string;
  mode: PlaybackMode;
  url: string;
  mimeType?: string;
  isHls: boolean;
  hlsKind?:
    | "stream-copy"
    | "audio-transcode"
    | "forced-transcode"
    | "server-transcoding-url"
    | "direct";
  usingHlsJs?: boolean;
  label: string;
  mediaSource: MediaSource;
  playbackInfo?: PlaybackInfoResponse;
  playbackDiagnostics?: PlaybackDiagnostics;
  qualityManifest?: MediaQualityManifest;
  reason: string;
  transcodeReasons?: string[];
  directPlayError?: string;
  priority: number;
}
