import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaybackSourceCandidate } from "../../lib/types";
import { PlayerSettingsPanel } from "./PlayerSettingsPanel";
import type { CompleteFileQualityControls } from "./types";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        "settings.settings": "Settings",
        "settings.playbackOptions": "Playback options",
        "settings.quality": "Quality",
        "settings.audio": "Audio",
        "settings.subtitles": "Subtitles",
        "settings.currentSource": "Current source",
        "settings.auto": "Auto",
        "settings.currentQuality": "Current quality",
        "settings.hlsUpTo": "HLS · up to {mbps} Mbps",
        "settings.manualQuality": "Manual quality",
        "settings.noAlternateQualities": "No alternate qualities",
        "player.qualityLowData": "Low Data",
        "player.qualityLowDataDescription": "Uses less data",
        "player.qualityHigherResolution": "Higher Resolution",
        "player.qualityHigherResolutionDescription": "Uses more data",
        "player.qualityAdvanced": "Advanced",
        "player.qualityBackToModes": "Quality modes",
        "player.qualityLockedTo": "Locked to {quality}",
        "player.qualityAutoEffective": "Auto ({quality})",
        "player.qualityFileAutoDescription":
          "Automatically chooses an existing file",
        "player.qualityCompleteFileLimitations":
          "Generated files carry the default audio track only.",
      })[key] ?? key,
  }),
}));

const source = {
  id: "quality-file-generated-720",
  mode: "DirectPlay",
  url: "https://media.example/720.mp4",
  mimeType: "video/mp4",
  isHls: false,
  label: "720p",
  mediaSource: {
    Id: "media-1",
    Container: "mp4",
    MediaStreams: [],
  },
} as unknown as PlaybackSourceCandidate;

function renderPanel(overrides: Partial<CompleteFileQualityControls> = {}) {
  const onSelectMode = vi.fn();
  const onSelectAdvancedQuality = vi.fn();

  render(
    <PlayerSettingsPanel
      source={source}
      qualityOptions={[]}
      selectedQualityId="auto"
      selectedSubtitleStreamIndex={-1}
      subtitleDelaySeconds={0}
      canSwitchAudio={false}
      canSwitchSubtitles={false}
      completeFileQuality={{
        activeMode: "auto",
        effectiveQualityLabel: "720p",
        modeQualityLabels: {
          "low-data": "480p",
          auto: "720p",
          "higher-resolution": "1080p",
        },
        advancedOptions: [
          {
            id: "original",
            label: "Original (2160p)",
            subtitle: "",
            maxHeight: 2160,
            maxWidth: 3840,
            maxStreamingBitrate: 80_000_000,
          },
          {
            id: "generated-720",
            label: "720p",
            subtitle: "",
            maxHeight: 720,
            maxWidth: 1280,
            maxStreamingBitrate: 4_000_000,
          },
        ],
        limitationsText: "Generated files carry the default audio track only.",
        onSelectMode,
        onSelectAdvancedQuality,
        ...overrides,
      }}
      onSelectAutoQuality={vi.fn()}
      onSelectQuality={vi.fn()}
      onSelectAudioStream={vi.fn()}
      onSelectSubtitleStream={vi.fn()}
      onSubtitleDelayChange={vi.fn()}
      compact
    />,
  );

  return { onSelectMode, onSelectAdvancedQuality };
}

describe("PlayerSettingsPanel complete-file qualities", () => {
  it("offers exactly the four top-level modes with their effective qualities", () => {
    renderPanel();

    expect(
      screen.getByRole("button", { name: /Low Data.*480p/s }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Auto \(720p\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Higher Resolution.*1080p/s }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Advanced/ }),
    ).toBeInTheDocument();

    // Nothing repeats the current source or the effective quality twice.
    expect(
      screen.queryByText(/Current source|Now playing/),
    ).not.toBeInTheDocument();
    // The individual quality files stay behind the Advanced submenu.
    expect(screen.queryByText("Original (2160p)")).not.toBeInTheDocument();
    expect(screen.queryByText(/HLS/)).not.toBeInTheDocument();
  });

  it("reports the selected mode back to the player", () => {
    const { onSelectMode } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Low Data/ }));

    expect(onSelectMode).toHaveBeenCalledWith("low-data");
  });

  it("lists only the supplied files in Advanced and locks onto one", () => {
    const { onSelectAdvancedQuality } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));

    expect(screen.getByText("Original (2160p)")).toBeInTheDocument();
    expect(screen.getByText("720p")).toBeInTheDocument();
    expect(screen.queryByText("480p")).not.toBeInTheDocument();
    // Entries carry no repeated boilerplate; the check mark marks the active one.
    expect(screen.queryByText("Complete file")).not.toBeInTheDocument();
    expect(screen.queryByText("Current quality")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Original \(2160p\)/ }));

    expect(onSelectAdvancedQuality).toHaveBeenCalledWith("original");
  });

  it("closes the Advanced submenu with Escape and restores focus", () => {
    renderPanel();

    const advancedButton = screen.getByRole("button", { name: /Advanced/ });
    fireEvent.click(advancedButton);
    expect(screen.getByText("Original (2160p)")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByText("Quality modes"), { key: "Escape" });

    expect(screen.queryByText("Original (2160p)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Advanced/ })).toHaveFocus();
  });

  it("marks the locked Advanced quality when playback is locked", () => {
    renderPanel({ activeMode: "advanced", lockedQualityId: "generated-720" });

    expect(
      screen.getByRole("button", { name: /Advanced.*Locked to 720p/s }),
    ).toBeInTheDocument();
  });
});
