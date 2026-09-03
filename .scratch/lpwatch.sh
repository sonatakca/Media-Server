#!/bin/bash
# Records the live-progress fields that matter for the acceptance test.
F=/var/folders/xg/n4ctjty96yn8lrbx8tg0wm500000gn/T/seyirlik-live-progress/c00e1a1f-c9b2-4f4b-940d-53fec686cf9e.json
LAST=""
while true; do
  NOW=$(python3 -c 'import datetime;print(datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])')
  CUR=$(python3 - "$F" <<'PY' 2>/dev/null
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
io=d.get("sourceIo") or {}
print(json.dumps({
 "phase":d.get("phase"),"epoch":d.get("epochIndex"),"frac":round(d.get("epochFraction") or 0,4),
 "enc":round(d.get("encodedSeconds") or 0,2),"speed":d.get("speed"),"fps":d.get("fps"),
 "eta":d.get("etaSeconds"),"completed":d.get("completedEpochs"),
 "io":io.get("state"),"ioAttempt":io.get("attempt"),"ioLastMedia":io.get("lastMediaSeconds"),
 "ioResume":io.get("resumeSeconds"),"damage":len(d.get("sourceDamage") or [])}, sort_keys=True))
PY
)
  KEY=$(echo "$CUR" | python3 -c 'import sys,json;
try:
 d=json.load(sys.stdin); d.pop("frac",None); d.pop("enc",None); d.pop("speed",None); d.pop("fps",None); d.pop("eta",None); print(json.dumps(d,sort_keys=True))
except Exception: print("")')
  if [ "$KEY" != "$LAST" ]; then
    echo "[$NOW] $CUR"
    LAST="$KEY"
  fi
  sleep 0.5
done
