import type {
  JellyfinMediaStream,
  PlaybackSourceCandidate,
} from "../../lib/types";
import type {
  NativeAudioSyncResult,
  NativeAudioTrack,
  NativeAudioTrackList,
  VideoElementWithAudioTracks,
} from "./types";
import { getStreamsOfType } from "./streamUtils";

export function getAudioTracks(
  video: HTMLVideoElement,
): NativeAudioTrackList | undefined {
  return (video as VideoElementWithAudioTracks).audioTracks;
}

export function getNativeAudioTrackSnapshot(video: HTMLVideoElement) {
  const audioTracks = getAudioTracks(video);

  return {
    length: audioTracks?.length ?? 0,
    tracks: Array.from({ length: audioTracks?.length ?? 0 }, (_, index) => {
      const track = audioTracks?.[index];

      return {
        index,
        id: track?.id,
        kind: track?.kind,
        label: track?.label,
        language: track?.language,
        enabled: track?.enabled,
      };
    }),
  };
}

function normalizeMatchText(value?: string): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeLanguage(value?: string): string {
  const normalized = normalizeMatchText(value).split(" ")[0] ?? "";
  const languageAliases: Record<string, string> = {
    en: "en",
    eng: "en",
    english: "en",
    es: "es",
    spa: "es",
    esp: "es",
    spanish: "es",
    castellano: "es",
    castilian: "es",
    fr: "fr",
    fra: "fr",
    fre: "fr",
    french: "fr",
    de: "de",
    deu: "de",
    ger: "de",
    german: "de",
    it: "it",
    ita: "it",
    italian: "it",
    pt: "pt",
    por: "pt",
    portuguese: "pt",
    ja: "ja",
    jpn: "ja",
    japanese: "ja",
  };

  return languageAliases[normalized] ?? normalized;
}

function getStreamMatchText(stream: JellyfinMediaStream): string {
  return [stream.Language, stream.DisplayTitle, stream.Title, stream.Codec]
    .map(normalizeMatchText)
    .filter(Boolean)
    .join(" ");
}

function getTrackMatchText(track: NativeAudioTrack): string {
  return [track.language, track.label, track.id, track.kind]
    .map(normalizeMatchText)
    .filter(Boolean)
    .join(" ");
}

function getNativeAudioTrackMatch(
  source: PlaybackSourceCandidate,
  streamIndex: number,
  audioTracks: NativeAudioTrackList,
): { nativeTrackIndex: number; reason: string } | null {
  const audioStreams = getStreamsOfType(source, "Audio");
  const jellyfinStream = audioStreams.find(
    (stream) => stream.Index === streamIndex,
  );

  if (!jellyfinStream) {
    return null;
  }

  const streamLanguage = normalizeLanguage(jellyfinStream.Language);

  if (streamLanguage) {
    for (let index = 0; index < audioTracks.length; index += 1) {
      const track = audioTracks[index];
      const trackLanguage = normalizeLanguage(track?.language);

      if (track && trackLanguage && trackLanguage === streamLanguage) {
        return { nativeTrackIndex: index, reason: "language" };
      }
    }
  }

  const streamText = getStreamMatchText(jellyfinStream);

  if (streamText.length > 1) {
    for (let index = 0; index < audioTracks.length; index += 1) {
      const track = audioTracks[index];

      if (!track) {
        continue;
      }

      const trackText = getTrackMatchText(track);

      if (
        trackText.length > 1 &&
        (trackText.includes(streamText) || streamText.includes(trackText))
      ) {
        return { nativeTrackIndex: index, reason: "label" };
      }
    }
  }

  const jellyfinOrdinal = audioStreams.findIndex(
    (stream) => stream.Index === streamIndex,
  );

  if (
    audioStreams.length === 2 &&
    audioTracks.length === 2 &&
    jellyfinOrdinal >= 0
  ) {
    return { nativeTrackIndex: jellyfinOrdinal, reason: "two-track-order" };
  }

  return null;
}

export function getNativeActiveAudioStreamIndex(
  video: HTMLVideoElement,
  source: PlaybackSourceCandidate,
): number | undefined {
  const audioTracks = getAudioTracks(video);

  if (!audioTracks || audioTracks.length === 0) {
    return undefined;
  }

  for (let index = 0; index < audioTracks.length; index += 1) {
    const track = audioTracks[index];

    if (!track?.enabled) {
      continue;
    }

    const audioStreams = getStreamsOfType(source, "Audio");

    for (const stream of audioStreams) {
      if (stream.Index === undefined) {
        continue;
      }

      const match = getNativeAudioTrackMatch(source, stream.Index, audioTracks);

      if (match?.nativeTrackIndex === index) {
        return stream.Index;
      }
    }

    return undefined;
  }

  return undefined;
}

export function tryApplyNativeAudioTrack(
  video: HTMLVideoElement,
  source: PlaybackSourceCandidate,
  streamIndex: number | undefined,
): NativeAudioSyncResult {
  const audioTracks = getAudioTracks(video);

  if (!audioTracks || audioTracks.length === 0) {
    return { succeeded: false, reason: "native-audio-tracks-unavailable" };
  }

  if (streamIndex === undefined) {
    return { succeeded: false, reason: "stream-index-missing" };
  }

  const match = getNativeAudioTrackMatch(source, streamIndex, audioTracks);

  if (!match) {
    return {
      succeeded: false,
      streamIndex,
      reason: "native-track-match-not-found",
    };
  }

  for (let index = 0; index < audioTracks.length; index += 1) {
    const track = audioTracks[index];

    if (track) {
      track.enabled = index === match.nativeTrackIndex;
    }
  }

  const enabledTrack = audioTracks[match.nativeTrackIndex];

  if (!enabledTrack?.enabled) {
    return {
      succeeded: false,
      streamIndex,
      nativeTrackIndex: match.nativeTrackIndex,
      reason: "native-track-enable-failed",
    };
  }

  return {
    succeeded: true,
    streamIndex,
    nativeTrackIndex: match.nativeTrackIndex,
    reason: match.reason,
  };
}
