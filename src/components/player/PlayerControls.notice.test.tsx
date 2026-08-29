import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlayerControls } from "./PlayerControls";

/**
 * A refusal has to reach the panel the viewer is looking at.
 *
 * The notice was raised correctly and passed to these controls, which quietly
 * dropped it on the way to the settings panel — so asking for an audio track
 * the server cannot deliver looked exactly like a dead button.
 */

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

vi.mock("./PlayerSettingsPanel", () => ({
  PlayerSettingsPanel: ({ audioNoticeText }: { audioNoticeText?: string }) => (
    <div data-testid="panel">{audioNoticeText ?? "(no notice)"}</div>
  ),
}));

function renderControls(audioNoticeText?: string) {
  const noop = () => {};
  return render(
    <PlayerControls
      visible
      isPlaying
      playWaiting={false}
      currentTime={10}
      duration={100}
      bufferedEnd={20}
      volume={1}
      muted={false}
      source={{ id: "s", itemId: "i", url: "/x", mode: "DirectPlay" } as never}
      qualityOptions={[]}
      selectedQualityId="auto"
      selectedAudioStreamIndex={1}
      selectedSubtitleStreamIndex={-1}
      subtitleDelaySeconds={0}
      canSwitchAudio
      canSwitchSubtitles={false}
      settingsOpen
      itemId="item-1"
      onTogglePlay={noop}
      onSeek={noop}
      onSeekBy={noop}
      onToggleMute={noop}
      onVolumeChange={noop}
      onToggleFullscreen={noop}
      onOpenSettings={noop}
      onSelectAutoQuality={noop}
      onSelectQuality={noop}
      onSelectAudioStream={noop}
      onSelectSubtitleStream={noop}
      onSubtitleDelayChange={noop}
      {...(audioNoticeText ? { audioNoticeText } : {})}
    />,
  );
}

describe("the settings notice", () => {
  it("reaches the settings panel", () => {
    renderControls("Bu ses parçası başlatılamadı.");

    expect(screen.getByTestId("panel").textContent).toBe(
      "Bu ses parçası başlatılamadı.",
    );
  });

  it("is absent when nothing failed", () => {
    renderControls();

    expect(screen.getByTestId("panel").textContent).toBe("(no notice)");
  });
});
