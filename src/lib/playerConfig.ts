import seyirlikIntroVideoSrc from "../assets/Seyirlik-by-Sonat-Intro-normal_H264.mp4";

export const ENABLE_SEYIRLIK_INTRO = false;
export const SEYIRLIK_INTRO_SRC = seyirlikIntroVideoSrc;

// TODO: when ENABLE_SEYIRLIK_INTRO becomes user-configurable, play this short
// H.264 MP4 bumper once before the selected Jellyfin source, then continue into
// the existing PlaybackInfo/direct/HLS flow. Do not use the .mov assets for web
// playback by default.
