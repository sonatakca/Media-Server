import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const labRoot =
  process.env.SEYIRLIK_LAB_ROOT ?? "/Volumes/Expansion/seyirlik-lab";
const root = path.join(labRoot, "outputs", "test-matrix");
const ffmpeg = process.env.SEYIRLIK_FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.SEYIRLIK_FFPROBE_PATH ?? "ffprobe";

interface Stream {
  codec_type: string;
  codec_name: string;
  profile?: string;
  pix_fmt?: string;
  tags?: { language?: string };
  disposition?: { default?: number; forced?: number };
}

interface Probe {
  streams: Stream[];
  format: { duration?: string; size?: string };
}

interface ExpectedFile {
  file: string;
  container: string;
  video: string;
  audio: string;
  audioLanguages: string[];
  subtitleLanguages: string[];
  hdr: boolean;
}

const expected: ExpectedFile[] = [
  {
    file: "h264-aac-sdr-progressive.mp4",
    container: "progressive MP4",
    video: "h264",
    audio: "aac",
    audioLanguages: ["eng", "tur"],
    subtitleLanguages: ["eng", "tur"],
    hdr: false,
  },
  {
    file: "h264-aac-sdr-fragmented.mp4",
    container: "fragmented MP4",
    video: "h264",
    audio: "aac",
    audioLanguages: ["eng", "tur"],
    subtitleLanguages: ["eng", "tur"],
    hdr: false,
  },
  {
    file: "h264-aac-sdr-multilingual.mkv",
    container: "Matroska",
    video: "h264",
    audio: "aac",
    audioLanguages: ["eng", "tur"],
    subtitleLanguages: ["eng", "tur", "eng"],
    hdr: false,
  },
  {
    file: "vp9-opus-sdr.webm",
    container: "WebM",
    video: "vp9",
    audio: "opus",
    audioLanguages: ["eng"],
    subtitleLanguages: [],
    hdr: false,
  },
  {
    file: "hevc-aac-hdr.mp4",
    container: "MP4",
    video: "hevc",
    audio: "aac",
    audioLanguages: ["eng"],
    subtitleLanguages: [],
    hdr: true,
  },
  {
    file: "av1-opus-hdr.webm",
    container: "WebM",
    video: "av1",
    audio: "opus",
    audioLanguages: ["eng"],
    subtitleLanguages: [],
    hdr: true,
  },
];

function probe(file: string): Probe {
  return JSON.parse(
    execFileSync(
      ffprobe,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      { encoding: "utf8" },
    ),
  ) as Probe;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const directResults = expected.map((fixture) => {
  const file = path.join(root, "direct", fixture.file);
  const info = probe(file);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  const audio = info.streams.filter((stream) => stream.codec_type === "audio");
  const subtitles = info.streams.filter(
    (stream) => stream.codec_type === "subtitle",
  );
  assert(
    video?.codec_name === fixture.video,
    `${fixture.file}: wrong video codec`,
  );
  assert(
    audio.length === fixture.audioLanguages.length &&
      audio.every((stream) => stream.codec_name === fixture.audio),
    `${fixture.file}: wrong audio streams`,
  );
  assert(
    JSON.stringify(audio.map((stream) => stream.tags?.language)) ===
      JSON.stringify(fixture.audioLanguages),
    `${fixture.file}: wrong audio languages`,
  );
  assert(
    JSON.stringify(subtitles.map((stream) => stream.tags?.language)) ===
      JSON.stringify(fixture.subtitleLanguages),
    `${fixture.file}: wrong subtitle languages`,
  );
  if (fixture.hdr) {
    assert(
      video.pix_fmt?.includes("10"),
      `${fixture.file}: HDR fixture is not 10-bit`,
    );
  }

  const duration = Number(info.format.duration);
  assert(
    duration >= 19 && duration <= 31,
    `${fixture.file}: unexpected duration ${duration}`,
  );
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(Math.min(10, duration / 2)),
      "-i",
      file,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    { stdio: "pipe" },
  );

  return {
    file: fixture.file,
    container: fixture.container,
    video: video.codec_name,
    audio: audio.map(
      (stream) => `${stream.codec_name}:${stream.tags?.language}`,
    ),
    subtitles: subtitles.map(
      (stream) => `${stream.codec_name}:${stream.tags?.language}`,
    ),
    durationSeconds: Number(duration.toFixed(3)),
    sizeMiB: Number((statSync(file).size / 1024 / 1024).toFixed(2)),
    middleFrameDecode: "pass",
  };
});

const hlsRoot = path.join(root, "adaptive-h264-sdr");
const master = readFileSync(path.join(hlsRoot, "master.m3u8"), "utf8");
const variants = [...master.matchAll(/^([^#\s].*\.m3u8)$/gm)].map(
  (match) => match[1]!,
);
const audioRenditions = [...master.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]+/g)];
assert(variants.length === 3, "HLS master must contain three video variants");
assert(
  audioRenditions.length === 2,
  "HLS master must contain two audio renditions",
);
assert(
  master.includes('LANGUAGE="eng"'),
  "HLS master is missing English audio",
);
assert(
  master.includes('LANGUAGE="tur"'),
  "HLS master is missing Turkish audio",
);

const segmentShapes = variants.map((playlistName) => {
  const playlist = readFileSync(path.join(hlsRoot, playlistName), "utf8");
  const durations = [...playlist.matchAll(/^#EXTINF:([0-9.]+),/gm)].map(
    (match) => Number(match[1]),
  );
  const ranges = [...playlist.matchAll(/^#EXT-X-BYTERANGE:/gm)].length;
  assert(durations.length > 1, `${playlistName}: missing segments`);
  assert(
    playlist.includes("#EXT-X-MAP:"),
    `${playlistName}: missing CMAF init range`,
  );
  assert(
    ranges === durations.length,
    `${playlistName}: expected one byte range per segment`,
  );
  assert(
    Math.max(...durations) <= 2.01,
    `${playlistName}: segment exceeds 2.01 seconds`,
  );
  return { playlistName, count: durations.length, durations };
});

const referenceDurations = JSON.stringify(segmentShapes[0]!.durations);
assert(
  segmentShapes.every(
    (shape) => JSON.stringify(shape.durations) === referenceDurations,
  ),
  "HLS video variants are not segment-aligned",
);

execFileSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    "10",
    "-i",
    path.join(hlsRoot, "master.m3u8"),
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ],
  { stdio: "pipe" },
);

for (const sidecar of [
  "sample.en.vtt",
  "sample.tr.hi.vtt",
  "sample.en.forced.vtt",
]) {
  const info = probe(path.join(root, "subtitles", sidecar));
  assert(
    info.streams.some(
      (stream) =>
        stream.codec_type === "subtitle" && stream.codec_name === "webvtt",
    ),
    `${sidecar}: invalid WebVTT`,
  );
}

console.log(
  JSON.stringify(
    {
      result: "pass",
      directFiles: directResults,
      adaptiveHls: {
        videoVariants: variants.length,
        separateAudioRenditions: audioRenditions.length,
        languages: ["eng", "tur"],
        segmentCountPerVariant: segmentShapes[0]!.count,
        maximumSegmentDurationSeconds: Math.max(
          ...segmentShapes.flatMap((shape) => shape.durations),
        ),
        aligned: true,
        middleFrameDecode: "pass",
      },
      webVttSidecars: 3,
    },
    null,
    2,
  ),
);
