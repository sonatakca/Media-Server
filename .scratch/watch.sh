#!/bin/bash
# Diagnostic observer for the source-damage acceptance test.
EPOCHS=/Volumes/Expansion/seyirlik/work/renditions/9f18d579-268f-445f-8a99-ef76033afa62/cmaf-hls-aligned-v3-2babccc71a782fd9/epochs
while true; do
  TS=$(date "+%H:%M:%S.%3N" 2>/dev/null || date "+%H:%M:%S")
  FF=$(ps -Ao pid,ppid,stat,etime,%cpu,command | grep -i "[f]fmpeg" | head -3)
  CK=$(ls -1 "$EPOCHS" 2>/dev/null | tr '\n' ' ')
  echo "[$TS] ffmpeg: ${FF:-none}"
  echo "[$TS] epochs: $CK"
  sleep 2
done
