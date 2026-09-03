#!/bin/bash
# Waits for the epoch-10 encoder, then records its lifecycle at 0.25s.
now(){ python3 -c 'import datetime;print(datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])'; }
PID=""
while [ -z "$PID" ]; do
  PID=$(ps -Ao pid,command | grep "[-]ss 3000.018" | grep -v grep | awk '{print $1}' | head -1)
  [ -z "$PID" ] && sleep 1
done
echo "[$(now)] EPOCH-10 FFMPEG pid=$PID pgid=$(ps -o pgid= -p "$PID" | tr -d ' ')"
LAST=""
while true; do
  LINE=$(ps -o stat=,etime= -p "$PID" 2>/dev/null | tr -s ' ' | sed 's/^ //')
  CUR="${LINE:-GONE}"
  STATE="${CUR%% *}"
  if [ "$STATE" != "$LAST" ]; then echo "[$(now)] pid=$PID state=$CUR"; LAST="$STATE"; fi
  [ "$CUR" = "GONE" ] && break
  sleep 0.25
done
echo "[$(now)] other ffmpeg now: $(ps -Ao pid,command | grep '[f]fmpeg' | grep -v grep | cut -c1-90 | tr '\n' ';')"
