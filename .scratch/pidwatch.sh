#!/bin/bash
# High-resolution lifecycle record for one ffmpeg pid: state changes only.
PID=$1
LAST=""
while true; do
  NOW=$(python3 -c 'import datetime;print(datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])')
  LINE=$(ps -o stat=,etime= -p "$PID" 2>/dev/null | tr -s ' ' | sed 's/^ //')
  CUR="${LINE:-GONE}"
  STATE="${CUR%% *}"
  if [ "$STATE" != "$LAST" ]; then
    echo "[$NOW] pid=$PID state=$CUR"
    LAST="$STATE"
  fi
  [ "$CUR" = "GONE" ] && break
  sleep 0.25
done
