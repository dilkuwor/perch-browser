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

# Stamped by CI (run number, commit, date) so every published image reports its own build
# on /health and the login page. A local `docker build` without these is a "dev" build.
ARG PERCH_BUILD=dev
ARG PERCH_COMMIT=
ARG PERCH_BUILD_DATE=
ENV PERCH_BUILD=$PERCH_BUILD \
    PERCH_COMMIT=$PERCH_COMMIT \
    PERCH_BUILD_DATE=$PERCH_BUILD_DATE
LABEL org.opencontainers.image.title="Perch" \
      org.opencontainers.image.source="https://github.com/dpksamir/perch-browser" \
      org.opencontainers.image.revision=$PERCH_COMMIT \
      org.opencontainers.image.created=$PERCH_BUILD_DATE \
      org.opencontainers.image.version=$PERCH_BUILD
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
