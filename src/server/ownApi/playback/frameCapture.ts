import { collectFfmpegOutput } from "./ffmpegOutput";

/** An 8-bit 4K PNG is ~25 MB; this leaves headroom for noisy grain. */
const MAX_FRAME_BYTES = 96 * 1024 * 1024;
const FRAME_CAPTURE_TIMEOUT_MS = 60_000;

/**
 * Square pixels at full height. Anamorphic sources store a narrower picture
 * than they show, and a still saved at storage width looks squeezed.
 */
const SQUARE_PIXEL_SCALE = "scale=w=trunc(iw*sar/2)*2:h=ih";

/**
 * PQ and HLG pixels written straight into an 8-bit PNG come out grey and flat.
 * Linearise, move to BT.709 and tone-map, as a player does when it shows HDR
 * on an SDR display. Mobius, not Hable: it leaves everything under the knee
 * where the grade put it and rolls off only the highlights. On a PQ master of
 * a known SDR frame it scored 16.9 dB PSNR against the original to Hable's
 * 11.1, which dimmed the whole picture by a third.
 */
const HDR_TO_SDR = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=tonemap=mobius:param=0.3:desat=0",
  "zscale=t=bt709:m=bt709:r=pc",
  SQUARE_PIXEL_SCALE,
  "setsar=1",
  "format=rgb24",
].join(",");

const SDR = [
  // The colour options belong to `scale`, which does the YUV-to-RGB step.
  `${SQUARE_PIXEL_SCALE}:in_color_matrix=auto:in_range=auto:out_range=pc`,
  "setsar=1",
  "format=rgb24",
].join(",");

const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

export function isHdrTransfer(colorTransfer: string | null): boolean {
  return colorTransfer !== null && HDR_TRANSFERS.has(colorTransfer);
}

export function buildFrameCaptureArgs(
  inputPath: string,
  atSeconds: number,
  options: { toneMap: boolean },
): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    // An input seek, so FFmpeg jumps to the keyframe before `at` and decodes
    // forward to the exact frame rather than reading the film from the start.
    "-ss",
    atSeconds.toFixed(3),
    "-i",
    inputPath,
    // `V`, not `v`: skips cover art and thumbnails muxed in as video streams.
    "-map",
    "0:V:0",
    "-frames:v",
    "1",
    "-vf",
    options.toneMap ? HDR_TO_SDR : SDR,
    "-c:v",
    "png",
    "-f",
    "image2pipe",
    "pipe:1",
  ];
}

/**
 * One frame of the original file as PNG, at the source's full resolution.
 * Empty when `at` lies past the last frame: FFmpeg exits cleanly having
 * written nothing, and the caller decides what that means.
 */
export function captureFrameAsPng(
  inputPath: string,
  atSeconds: number,
  options: { toneMap: boolean },
  ffmpegPath = "ffmpeg",
): Promise<Buffer> {
  return collectFfmpegOutput(
    ffmpegPath,
    buildFrameCaptureArgs(inputPath, atSeconds, options),
    {
      label: "Frame capture",
      maxBytes: MAX_FRAME_BYTES,
      timeoutMs: FRAME_CAPTURE_TIMEOUT_MS,
    },
  );
}
