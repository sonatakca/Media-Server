import { X } from "lucide-react";
import type { PlaybackSourceCandidate } from "../../lib/types";
import {
  formatBitrate,
  formatBytes,
  getDirectPlayRecommendation,
  getPlaybackModeLabel,
  getPlaybackReasons,
  getSanitizedDebugPayload,
  getStreamOfType,
  getSubtitleStreams,
} from "../../lib/playbackDiagnostics";

interface PlaybackInfoPanelProps {
  source: PlaybackSourceCandidate;
  videoError?: string | null;
  onClose: () => void;
}

function InfoRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex justify-between gap-4 border-b border-white/[0.07] py-2 text-sm">
      <dt className="text-white/45">{label}</dt>
      <dd className="text-right font-semibold text-white/80">{value || "Unknown"}</dd>
    </div>
  );
}

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/[0.08] px-2.5 py-1 text-xs font-semibold text-white/75">
      {children}
    </span>
  );
}

export function PlaybackInfoPanel({ source, videoError, onClose }: PlaybackInfoPanelProps) {
  const mediaSource = source.mediaSource;
  const video = getStreamOfType(mediaSource, "Video");
  const audio = getStreamOfType(mediaSource, "Audio");
  const subtitles = getSubtitleStreams(mediaSource);
  const reasons = getPlaybackReasons(source);
  const recommendations = getDirectPlayRecommendation(source);
  const debugPayload = getSanitizedDebugPayload(source, videoError);

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/62 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="max-h-[88svh] w-full overflow-hidden rounded-t-3xl border border-white/10 bg-[linear-gradient(145deg,rgba(24,24,27,0.96),rgba(5,5,5,0.96))] shadow-[0_30px_140px_rgba(0,0,0,0.78)] sm:max-w-3xl sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--accent)]">Playback details</p>
            <h2 className="mt-1 text-xl font-black text-white">{getPlaybackModeLabel(source.mode)}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            aria-label="Close playback details"
          >
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[calc(88svh-5rem)] overflow-y-auto px-5 py-5">
          <section>
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">Playback</h3>
            <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
              <InfoRow label="Mode" value={getPlaybackModeLabel(source.mode)} />
              <InfoRow label="Media source" value={mediaSource.Name || mediaSource.Id} />
              <InfoRow label="Protocol" value={mediaSource.Protocol} />
              <InfoRow label="Container" value={mediaSource.Container} />
              <InfoRow label="HLS" value={source.isHls ? "Yes" : "No"} />
              <InfoRow label="HLS engine" value={source.isHls ? (source.usingHlsJs ? "hls.js" : "Native browser HLS") : "Not used"} />
            </dl>
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">Why this mode?</h3>
            <ul className="mt-3 space-y-2">
              {reasons.map((reason) => (
                <li key={reason} className="rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3 text-sm leading-6 text-white/76">
                  {reason}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">Source media</h3>
            <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
              <InfoRow label="Size" value={formatBytes(mediaSource.Size)} />
              <InfoRow label="Bitrate" value={formatBitrate(mediaSource.Bitrate)} />
              <InfoRow label="Video codec" value={video?.Codec} />
              <InfoRow label="Video profile" value={video?.Profile} />
              <InfoRow label="Video level" value={video?.Level} />
              <InfoRow label="Resolution" value={video?.Width && video?.Height ? `${video.Width}x${video.Height}` : undefined} />
              <InfoRow label="Frame rate" value={video?.AverageFrameRate || video?.RealFrameRate} />
              <InfoRow label="Range" value={video?.VideoRange || video?.VideoRangeType} />
              <InfoRow label="Audio codec" value={audio?.Codec} />
              <InfoRow label="Audio channels" value={audio?.Channels ? `${audio.Channels} ch` : undefined} />
              <InfoRow label="Audio language" value={audio?.Language || audio?.DisplayTitle} />
            </dl>

            {subtitles.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {subtitles.map((subtitle, index) => (
                  <Chip key={`${subtitle.Index ?? index}-${subtitle.Codec}`}>
                    {[subtitle.Codec, subtitle.Language, subtitle.IsExternal ? "External" : undefined].filter(Boolean).join(" · ")}
                  </Chip>
                ))}
              </div>
            ) : null}
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">Transcoding output</h3>
            <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
              <InfoRow label="Transcoding container" value={mediaSource.TranscodingContainer} />
              <InfoRow label="Sub-protocol" value={mediaSource.TranscodingSubProtocol} />
              <InfoRow label="Output video" value={source.mode === "Transcoding" ? "H.264 if using current Seyirlik HLS profile" : "Not transcoding"} />
              <InfoRow label="Output audio" value={source.mode === "Transcoding" ? "AAC if using current Seyirlik HLS profile" : "Not transcoding"} />
              <InfoRow label="Speed" value="Speed not available from the current frontend API response." />
            </dl>
            <p className="mt-2 text-xs leading-5 text-white/42">
              TODO: accurate transcode speed may require querying Jellyfin active sessions or dashboard endpoints with proper permissions.
            </p>
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">How to avoid transcoding</h3>
            <ul className="mt-3 space-y-2">
              {recommendations.map((recommendation) => (
                <li key={recommendation} className="rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3 text-sm leading-6 text-white/76">
                  {recommendation}
                </li>
              ))}
            </ul>
          </section>

          <details className="mt-6 rounded-2xl border border-white/10 bg-black/40 p-4">
            <summary className="cursor-pointer text-sm font-bold text-white/82">Raw playback debug</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-white/58">
              {JSON.stringify(debugPayload, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}