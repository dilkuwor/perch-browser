#!/bin/sh
set -e

if [ "${CHROME_HEADLESS:-0}" = "0" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac +extension RENDER -noreset >/tmp/xvfb.log 2>&1 &
  sleep 0.4
fi

# Sound: a PulseAudio daemon with a single null sink. Chromium plays into it and
# ffmpeg captures its monitor, which is what streams to the browser tab.
if [ "${AUDIO:-1}" != "0" ] && command -v pulseaudio >/dev/null 2>&1; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/perch-runtime}"
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
  PULSE_SOCK="$XDG_RUNTIME_DIR/pulse.sock"
  export PULSE_SERVER="unix:$PULSE_SOCK"
  pulseaudio -n --daemonize=no --exit-idle-time=-1 --disallow-exit \
    --disable-shm=yes --realtime=no --high-priority=no \
    --log-target=stderr --log-level=error \
    -L "module-native-protocol-unix socket=$PULSE_SOCK auth-anonymous=1" \
    -L "module-null-sink sink_name=perch rate=48000 channels=2 sink_properties=device.description=Perch" \
    >/tmp/pulse.log 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -S "$PULSE_SOCK" ] && break
    sleep 0.2
  done
  [ -S "$PULSE_SOCK" ] || echo "[home-browser] warning: PulseAudio did not start; sound will be unavailable ($(tail -n 1 /tmp/pulse.log 2>/dev/null))"
fi

exec node src/server.js
