#!/usr/bin/env bash
# Build a compact, repeatable compatibility matrix without modifying the real
# media library. Outputs are disposable lab artifacts, not production assets.
set -euo pipefail

LAB_ROOT="${SEYIRLIK_LAB_ROOT:-/Volumes/Expansion/seyirlik-lab}"
SOURCE="${SEYIRLIK_LAB_SOURCE:-${LAB_ROOT}/source/Dune (2021) - 5m HDR source.mp4}"
EN_SRT="${LAB_ROOT}/source/language-fixture.en.srt"
FORCED_SRT="${LAB_ROOT}/source/language-fixture.en.forced.srt"
TR_SRT="${LAB_ROOT}/source/Dune (2021) - 5m HDR source.tr.hi.srt"
OUTPUT="${LAB_ROOT}/outputs/test-matrix"
REPORTS="${LAB_ROOT}/reports/test-matrix"
SDR_SECONDS="${SEYIRLIK_LAB_SDR_SECONDS:-20}"
HDR_SECONDS="${SEYIRLIK_LAB_HDR_SECONDS:-30}"
FFMPEG="${SEYIRLIK_FFMPEG_PATH:-ffmpeg}"
FFPROBE="${SEYIRLIK_FFPROBE_PATH:-ffprobe}"

for required in "$SOURCE" "$EN_SRT" "$FORCED_SRT" "$TR_SRT"; do
  if [ ! -f "$required" ]; then
    echo "Missing required fixture: $required" >&2
    exit 1
  fi
done

mkdir -p \
  "$OUTPUT/direct" \
  "$OUTPUT/adaptive-h264-sdr" \
  "$OUTPUT/subtitles" \
  "$REPORTS"

echo "[1/10] H.264/AAC progressive MP4 with English and Turkish audio/subtitles"
"$FFMPEG" -hide_banner -loglevel warning -stats -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=24000/1001:duration=${SDR_SECONDS}" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${SDR_SECONDS}" \
  -f lavfi -i "sine=frequency=554:sample_rate=48000:duration=${SDR_SECONDS}" \
  -i "$EN_SRT" -i "$TR_SRT" \
  -map 0:v:0 -map 1:a:0 -map 2:a:0 -map 3:s:0 -map 4:s:0 \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -g 48 -keyint_min 48 -sc_threshold 0 \
  -c:a aac -b:a 160k -ac 2 -c:s mov_text \
  -metadata:s:a:0 language=eng -metadata:s:a:0 title=English \
  -metadata:s:a:1 language=tur -metadata:s:a:1 title=Türkçe \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title=English \
  -metadata:s:s:1 language=tur -metadata:s:s:1 title="Türkçe (İşitme Engelliler)" \
  -disposition:a:0 default -disposition:a:1 0 \
  -disposition:s:0 default -disposition:s:1 0 \
  -movflags +faststart -t "$SDR_SECONDS" \
  "$OUTPUT/direct/h264-aac-sdr-progressive.mp4"

echo "[2/10] Fragmented MP4 using identical H.264/AAC samples"
"$FFMPEG" -hide_banner -loglevel warning -stats -y \
  -i "$OUTPUT/direct/h264-aac-sdr-progressive.mp4" -map 0 -c copy \
  -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx \
  -frag_duration 2000000 \
  "$OUTPUT/direct/h264-aac-sdr-fragmented.mp4"

echo "[3/10] Multilingual MKV with text subtitles"
"$FFMPEG" -hide_banner -loglevel warning -stats -y \
  -i "$OUTPUT/direct/h264-aac-sdr-progressive.mp4" -i "$EN_SRT" -i "$TR_SRT" -i "$FORCED_SRT" \
  -map 0:v:0 -map 0:a:0 -map 0:a:1 -map 1:s:0 -map 2:s:0 -map 3:s:0 \
  -c copy -c:s srt \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title=English \
  -metadata:s:s:1 language=tur -metadata:s:s:1 title="Türkçe (İşitme Engelliler)" \
  -metadata:s:s:2 language=eng -metadata:s:s:2 title="English Forced" \
  -disposition:s:0 default -disposition:s:1 0 -disposition:s:2 forced \
  -t "$SDR_SECONDS" \
  "$OUTPUT/direct/h264-aac-sdr-multilingual.mkv"

echo "[4/10] VP9/Opus WebM compatibility sample"
"$FFMPEG" -hide_banner -loglevel warning -stats -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=24000/1001:duration=${SDR_SECONDS}" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${SDR_SECONDS}" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libvpx-vp9 -deadline good -cpu-used 4 -crf 31 -b:v 0 \
  -row-mt 1 -g 48 -pix_fmt yuv420p \
  -c:a libopus -b:a 128k -ac 2 -metadata:s:a:0 language=eng \
  "$OUTPUT/direct/vp9-opus-sdr.webm"

echo "[5/10] HEVC Main 10 HDR MP4 with shared-compatible AAC"
"$FFMPEG" -hide_banner -loglevel warning -stats -y \
  -ss 0 -t "$HDR_SECONDS" -i "$SOURCE" \
  -map 0:v:0 -map 0:a:0 \
  -vf "scale=2586:1080:flags=lanczos" \
  -c:v hevc_videotoolbox -profile:v main10 -pix_fmt p010le \
  -b:v 5M -maxrate 8M -bufsize 16M -g 48 -tag:v hvc1 \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -c:a aac -b:a 256k -ac 2 -metadata:s:a:0 language=eng \
  -movflags +faststart \
  "$OUTPUT/direct/hevc-aac-hdr.mp4"

echo "[6/10] AV1/Opus HDR WebM"
"$FFMPEG" -hide_banner -loglevel warning -stats -y \
  -ss 0 -t "$HDR_SECONDS" -i "$SOURCE" \
  -map 0:v:0 -map 0:a:0 \
  -vf "scale=2586:1080:flags=lanczos" \
  -c:v libsvtav1 -preset 8 -crf 28 -pix_fmt yuv420p10le -g 48 \
  -svtav1-params tune=0 \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -c:a libopus -b:a 192k -ac 2 -metadata:s:a:0 language=eng \
  "$OUTPUT/direct/av1-opus-hdr.webm"

echo "[7/10] Text subtitle sidecars: English, Turkish and forced English"
"$FFMPEG" -hide_banner -loglevel warning -y -i "$EN_SRT" "$OUTPUT/subtitles/sample.en.vtt"
"$FFMPEG" -hide_banner -loglevel warning -y -i "$TR_SRT" "$OUTPUT/subtitles/sample.tr.hi.vtt"
"$FFMPEG" -hide_banner -loglevel warning -y -i "$FORCED_SRT" "$OUTPUT/subtitles/sample.en.forced.vtt"

echo "[8/10] Aligned H.264 SDR CMAF/HLS with three video and two separate audio renditions"
"$FFMPEG" -hide_banner -loglevel warning -stats -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=24000/1001:duration=${SDR_SECONDS}" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${SDR_SECONDS}" \
  -f lavfi -i "sine=frequency=554:sample_rate=48000:duration=${SDR_SECONDS}" \
  -filter_complex \
    "[0:v]split=3[v1080in][v720in][v480in];[v1080in]scale=1920:1080[v1080];[v720in]scale=1280:720[v720];[v480in]scale=854:480[v480]" \
  -map "[v1080]" -map "[v720]" -map "[v480]" -map 1:a:0 -map 2:a:0 \
  -c:v libx264 -preset medium -pix_fmt yuv420p \
  -g 48 -keyint_min 48 -sc_threshold 0 \
  -b:v:0 5M -maxrate:v:0 7M -bufsize:v:0 10M \
  -b:v:1 2.8M -maxrate:v:1 4.2M -bufsize:v:1 5.6M \
  -b:v:2 1.2M -maxrate:v:2 1.8M -bufsize:v:2 2.4M \
  -c:a aac -b:a 160k -ac 2 \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=tur \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_flags independent_segments+single_file \
  -hls_fmp4_init_filename "init_%v.mp4" \
  -hls_segment_filename "$OUTPUT/adaptive-h264-sdr/media_%v.m4s" \
  -master_pl_name master.m3u8 \
  -var_stream_map \
    "a:0,agroup:audio,language:eng,default:yes,name:audio_eng a:1,agroup:audio,language:tur,default:no,name:audio_tur v:0,agroup:audio,name:1080p v:1,agroup:audio,name:720p v:2,agroup:audio,name:480p" \
  "$OUTPUT/adaptive-h264-sdr/playlist_%v.m3u8"

echo "[9/10] Publish direct-play fixtures into the isolated lab library"
declare -a published=(
  "Compatibility - H264 Progressive (2026)|h264-aac-sdr-progressive.mp4"
  "Compatibility - H264 Fragmented (2026)|h264-aac-sdr-fragmented.mp4"
  "Compatibility - H264 Multilingual MKV (2026)|h264-aac-sdr-multilingual.mkv"
  "Compatibility - VP9 Opus WebM (2026)|vp9-opus-sdr.webm"
  "Compatibility - HEVC HDR (2026)|hevc-aac-hdr.mp4"
  "Compatibility - AV1 HDR (2026)|av1-opus-hdr.webm"
)
for fixture in "${published[@]}"; do
  title="${fixture%%|*}"
  file="${fixture#*|}"
  destination="${LAB_ROOT}/media/Movies/${title}"
  mkdir -p "$destination"
  cp -f "$OUTPUT/direct/$file" "$destination/${title}.${file##*.}"
done

echo "[10/10] Inventory report"
find "$OUTPUT" -type f ! -name '._*' -print0 | sort -z | \
  while IFS= read -r -d '' media; do
    relative="${media#${OUTPUT}/}"
    size=$(stat -f '%z' "$media")
    if "$FFPROBE" -v error -show_entries format=format_name,duration:stream=index,codec_type,codec_name,profile,width,height,pix_fmt,channels:stream_tags=language,title -of compact=p=0:nk=0 "$media" >"${REPORTS}/probe.tmp" 2>/dev/null; then
      probe=$(tr '\n' ' ' <"${REPORTS}/probe.tmp")
    else
      probe="playlist-or-sidecar"
    fi
    printf '%s\t%s\t%s\n' "$relative" "$size" "$probe"
  done >"${REPORTS}/inventory.tsv"

rm -f "${REPORTS}/probe.tmp"
echo "Created test matrix at $OUTPUT"
echo "Inventory: ${REPORTS}/inventory.tsv"
