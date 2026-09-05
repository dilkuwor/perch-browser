#!/bin/sh
set -e

if [ "${CHROME_HEADLESS:-0}" = "0" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac +extension RENDER -noreset >/tmp/xvfb.log 2>&1 &
  sleep 0.4
fi

exec node src/server.js
