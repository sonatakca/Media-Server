# FFmpeg runtime

Seyirlik does not bundle FFmpeg or declare a numeric minimum version. Install
FFmpeg and ffprobe together. The server accepts explicit binary paths through
`SEYIRLIK_FFMPEG_PATH` and `SEYIRLIK_FFPROBE_PATH`; otherwise it uses `PATH`.
Offline rendition commands also accept the legacy `FFMPEG_PATH` and
`FFPROBE_PATH` overrides, which take precedence over their `SEYIRLIK_` equivalents.

Compatibility depends on the selected encoder, filters and muxers being usable,
not the version string. Hardware selection probes encoders with synthetic input.
Adaptive packaging requires fragmented MP4 HLS output, supported video/audio
encoders, and the filters selected for the source. Validation must still prove
frame timing, decodability, rendition alignment and duration before publication.
An installed encoder name alone does not establish working hardware support.

The adaptive QSV path disables B-frame reordering because independently joined
epochs require zero-based presentation time. This applies across FFmpeg versions;
it trades some compression efficiency for exact epoch timing.

To compare binaries, use explicit absolute paths and synthetic media in an
isolated directory. Do not change a host's PATH or replace its installed binary
to run a comparison. Fixture generation and probes must use the same selected
build, with a separate fixture cache for each comparison.

Replacement publications retain the previous files for existing readers. New
files live in a generation directory and one atomic pointer-file rename selects
the new generation. Old generations are retained; automatic reclamation is not
implemented. Allow storage for both generations during replacement.
