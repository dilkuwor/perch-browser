FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    pulseaudio \
    ffmpeg \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-color-emoji \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh \
  && mkdir -p /data/chrome \
  && chown node:node /data/chrome /app/docker-entrypoint.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1 \
    CHROME_HEADLESS=0 \
    CHROME_USER_DATA=/data/chrome \
    DISPLAY=:99 \
    AUDIO=1 \
    XDG_RUNTIME_DIR=/tmp/perch-runtime \
    PULSE_SERVER=unix:/tmp/perch-runtime/pulse.sock

EXPOSE 8080

USER node

ENTRYPOINT ["/app/docker-entrypoint.sh"]
