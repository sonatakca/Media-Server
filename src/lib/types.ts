export interface AuthSession {
  serverUrl: string;
  accessToken: string;
  userId: string;
  username: string;
  deviceId: string;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
  ServerId?: string;
  HasPassword?: boolean;
  HasConfiguredPassword?: boolean;
  HasConfiguredEasyPassword?: boolean;
  EnableAutoLogin?: boolean;
  LastLoginDate?: string;
  LastActivityDate?: string;
}

export interface JellyfinAuthResponse {
  User: JellyfinUser;
  SessionInfo?: {
    Id?: string;
    DeviceId?: string;
    DeviceName?: string;
    Client?: string;
  };
  AccessToken: string;
  ServerId?: string;
}

export interface JellyfinImageTags {
  Primary?: string;
  Logo?: string;
  Thumb?: string;
  Banner?: string;
  [key: string]: string | undefined;
}

export interface JellyfinUserData {
  PlaybackPositionTicks?: number;
  PlayCount?: number;
  IsFavorite?: boolean;
  Played?: boolean;
  PlayedPercentage?: number;
  UnplayedItemCount?: number;
}

export interface JellyfinMediaStream {
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
  DeliveryMethod?: string;
  Channels?: number;
  BitRate?: number;
  Width?: number;
  Height?: number;
  AverageFrameRate?: number;
  RealFrameRate?: number;
  VideoRange?: string;
  VideoRangeType?: string;
  ColorTransfer?: string;
  ColorPrimaries?: string;
  ColorSpace?: string;
}

export interface JellyfinMediaSource {
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
  MediaStreams?: JellyfinMediaStream[];
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type?: string;
  MediaType?: string;
  CollectionType?: string;
  ProductionYear?: number;
  PremiereDate?: string;
  DateCreated?: string;
  Overview?: string;
  Taglines?: string[];
  Genres?: string[];
  OfficialRating?: string;
  CommunityRating?: number;
  RunTimeTicks?: number;
  ImageTags?: JellyfinImageTags;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  SeriesName?: string;
  SeasonName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  UserData?: JellyfinUserData;
  MediaSources?: JellyfinMediaSource[];
}

export interface JellyfinLibrary extends JellyfinItem {
  CollectionType?: string;
}

export interface JellyfinItemsResponse<TItem = JellyfinItem> {
  Items?: TItem[];
  TotalRecordCount?: number;
  StartIndex?: number;
}

export interface JellyfinPublicSystemInfo {
  LocalAddress?: string;
  ServerName?: string;
  Version?: string;
  ProductName?: string;
  OperatingSystem?: string;
  Id?: string;
}

export interface JellyfinPlaybackInfoResponse {
  MediaSources?: JellyfinMediaSource[];
  PlaySessionId?: string;
  ErrorCode?: string;
}

export type PlaybackMode = "DirectPlay" | "DirectStream" | "Transcoding" | "Unknown";

export interface PlaybackSourceCandidate {
  id: string;
  itemId: string;
  mediaSourceId?: string;
  playSessionId?: string;
  mode: PlaybackMode;
  url: string;
  mimeType?: string;
  isHls: boolean;
  usingHlsJs?: boolean;
  label: string;
  mediaSource: JellyfinMediaSource;
  playbackInfo?: JellyfinPlaybackInfoResponse;
  reason: string;
  transcodeReasons?: string[];
  directPlayError?: string;
  priority: number;
}
