import type { SeekFeedbackState } from "./types";

export const AUTO_QUALITY_ID = "auto";
export const DEFAULT_SUBTITLE_SCALE = 1;
export const MIN_SUBTITLE_SCALE = 0.7;
export const MAX_SUBTITLE_SCALE = 2.4;

export const TRICKPLAY_RESOLUTION = 320;
export const TRICKPLAY_INTERVAL_SECONDS = 10;
export const TRICKPLAY_COLUMNS = 10;
export const TRICKPLAY_ROWS = 10;
export const TRICKPLAY_IMAGES_PER_SHEET = TRICKPLAY_COLUMNS * TRICKPLAY_ROWS;
export const DEFAULT_VIDEO_ASPECT_RATIO = 16 / 9;

export const SEEK_FEEDBACK_OPPOSITE_HIDE_MS = 100;
export const SEEK_FEEDBACK_HIDE_MS = 950;
export const SEEK_FEEDBACK_FADE_RESET_MS = 260;
export const SEEK_FEEDBACK_SPIN_MS = 1000;

export const DIRECT_PLAY_STARTUP_WATCHDOG_MS = 12_000;
export const HLS_REMUX_STARTUP_WATCHDOG_MS = 20_000;
export const HLS_TRANSCODE_STARTUP_WATCHDOG_MS = 40_000;

export const VIEW_MODE_CURSOR_HIDE_MS = 1600;
export const PLAYBACK_PROGRESS_REPORT_INTERVAL_MS = 15_000;

export const TOUCH_DOUBLE_TAP_THRESHOLD_MS = 320;
export const TOUCH_SINGLE_TAP_DELAY_MS = 180;
export const TOUCH_SEEK_SESSION_TIMEOUT_MS = 850;

export const DEFAULT_NEXT_EPISODE_COUNTDOWN_SECONDS = 10;

export const SKIPPABLE_SEGMENT_TYPES = new Set(["intro", "recap", "outro"]);

export const PARTY_WATCH_DOT_POSITIONS = [
  "right-[0.5rem] top-[0.42rem]",
  "right-[0.15rem] top-[1.25rem]",
  "right-[0.5rem] top-[2.08rem]",
  "left-[0.5rem] top-[0.42rem]",
  "left-[0.5rem] top-[2.08rem]",
  "left-[0.15rem] top-[1.25rem]",
] as const;

export const initialSeekFeedback: SeekFeedbackState = {
  backward: {
    amount: 0,
    visible: false,
    pulse: 0,
    spinPulse: 0,
  },
  forward: {
    amount: 0,
    visible: false,
    pulse: 0,
    spinPulse: 0,
  },
};
