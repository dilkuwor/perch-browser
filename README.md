# Perch

**Perch is a personal remote browser.** A real Chromium runs on your home server and streams to any phone or laptop; the pages actually load **at home**, not on the device in your hand. Open a desktop-style browser UI anywhere, and frames stream into the viewport over WebSocket. Mouse, wheel, keyboard, and paste are forwarded with the Chrome DevTools Protocol.

This is **not** a VPN, **not** an HTML-rewriting proxy, and **not** an `<iframe>` of google.com (that is blocked by almost every site). It is a real remote Chromium — your own vantage on the web, kept at home.

> The npm package is named `home-browser` and the Docker image is `perch-browser`; **Perch** is the product name.

## Screenshots

**Sign in** — password-only, single session. The host name shown reflects wherever you open it.

![Perch login screen](docs/screenshot-login.png)

**The browser** — real tabs, an address bar with speed dials, and the home server's live egress IP in the status bar.

![Perch browser UI](docs/screenshot-app.png)

## Features

- **Real Chromium, streamed.** Pages render on the home server and stream as binary JPEG frames over WebSocket; input is forwarded with the Chrome DevTools Protocol.
- **Egress from home.** Every site sees your home network's public IP, not the device in your hand.
- **Sound.** What Chromium plays at home — video, music, calls — streams to the device as Opus (or raw PCM on browsers without WebCodecs), with a mute button in the title bar.
- **Tabs.** A real tab strip to open, switch, and close tabs. Popups and SSO windows take over the view and hand it back when closed.
- **Non-blocking navigation.** Keep full mouse and keyboard control while a page loads, with no stale frames after a URL change.
- **Sign-in friendly.** Real key events, hover-before-click, and no automation banner, so Google's "are you human?" checks and corporate SSO behave like a local browser.
- **Phone-ready.** Touch scrolling, tap-to-click, long-press right-click, an on-screen keyboard, and a viewport sized to your screen.
- **Single session.** One shared browser; a second login joins — and can take over — the same tabs and cookies.

## Table of contents

- [Requirements](#requirements)
- [Run with Docker (recommended)](#run-with-docker-recommended)
- [Run natively (Ubuntu / Debian)](#run-natively-ubuntu--debian)
- [Configuration](#configuration)
- [Verify it works](#verify-it-works)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Reverse proxy (TLS)](#reverse-proxy-tls)
- [Health](#health)
- [Security notes](#security-notes)
- [License](#license)

## Requirements

- Docker and Docker Compose (recommended), **or** Node.js 20+ with Google Chrome / Chromium installed
- A long password (12+ characters) for `APP_PASSWORD`

Single Chromium session: there is one browser process. A second login uses — and can take over — that same session, sharing its cookies, tabs, and page.

## Run with Docker (recommended)

### Docker Compose

1. Create your configuration from the template and set a password:

   ```bash
   cp .env.example .env
   nano .env                     # set APP_PASSWORD to 12+ characters
   ```

2. Start the container:

   ```bash
   docker compose up -d
   ```

3. Follow the logs:

   ```bash
   docker compose logs -f
   ```

Stop it with:

```bash
docker compose down
```

### `docker run`

```bash
docker volume create perch-chrome-profile

docker run -d \
  --name perch-browser \
  --restart unless-stopped \
  -p 8080:8080 \
  -e APP_PASSWORD="choose-a-long-password" \
  -e APP_USER="admin" \
  -v perch-chrome-profile:/data/chrome \
  --shm-size="1gb" \
  dpksamir/perch-browser:latest
```

### Build from source

```bash
docker build -t perch-browser .
docker run -d \
  --name perch-browser \
  -p 8080:8080 \
  -e APP_PASSWORD="choose-a-long-password" \
  --shm-size="1gb" \
  perch-browser
```

## Run natively (Ubuntu / Debian)

### 1. Install dependencies

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Chromium (Debian package name is chromium; Ubuntu may use chromium-browser)
sudo apt-get update
sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser

# Sound (optional): PulseAudio and ffmpeg. Skip these and set AUDIO=0 to run silent.
sudo apt-get install -y pulseaudio ffmpeg
```

For sound, Chromium needs a PulseAudio (or PipeWire-Pulse) server to play into and ffmpeg captures it. On a headless server with no sound card, start one with a null sink for the user that runs Perch:

```bash
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=perch
pactl set-default-sink perch
```

On a desktop that already runs PulseAudio or PipeWire, the same `pactl` commands add the sink; or set `AUDIO_SOURCE=@DEFAULT_MONITOR@` to stream whatever the machine's speakers play.

Confirm the binaries:

```bash
node -v          # v20 or newer
which chromium || which chromium-browser || which google-chrome-stable
```

### 2. Configure and run

From this repo on the **home server**:

```bash
cd /opt/perch                 # or wherever you cloned this repo
cp .env.example .env
nano .env                     # set APP_PASSWORD to 12+ characters
npm install
npm start
```

Then open `http://<home-lan-ip>:8080` (for example, `http://192.168.1.50:8080`) and log in with the password from `.env`. The login is real; any other password is rejected.

## Configuration

All settings are read from environment variables (via `.env` when running natively, or `-e` / Compose `environment` in Docker).

| Variable            | Default                    | Description                                                                                                 |
| ------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `APP_PASSWORD`      | _(required)_               | Login password. The process **refuses to start** if it is missing or shorter than 12 characters.            |
| `APP_USER`          | `admin`                    | Display name for the signed-in user.                                                                        |
| `HOST`              | `0.0.0.0`                  | Address the server binds to.                                                                                 |
| `PORT`              | `8080`                     | Port the server listens on.                                                                                  |
| `HOME_URL`          | `https://www.google.com/`  | Page the **Home** button loads.                                                                             |
| `CHROME_PATH`       | _(auto-detect)_            | Path to the Chrome / Chromium binary. Leave empty to auto-detect; set it if the binary lives somewhere unusual. |
| `CHROME_NO_SANDBOX` | `0`                        | Set to `1` if Chromium fails with a sandbox error (common on some VPS / LXC hosts). Prefer a real user-namespace sandbox where possible. |
| `CHROME_HEADLESS`   | `1`                        | `0` runs a real (headed) Chromium under Xvfb — the Docker default, and the mode you want for Google, CAPTCHAs, and corporate sign-in, since headless Chromium is easier to detect and gets challenged more often. |
| `CHROME_USER_DATA`  | _(temporary)_              | Directory for the Chrome profile. Set it to keep cookies and site trust between restarts; otherwise every site treats each restart as a brand-new visitor. |
| `JPEG_QUALITY`      | `60`                       | Frame quality, 20–95. Lower trades sharpness for bandwidth; try `45` on a slow mobile link.                  |
| `AUDIO`             | `1`                        | `0` disables sound capture entirely (no PulseAudio or ffmpeg needed).                                        |
| `AUDIO_SOURCE`      | `perch.monitor`            | PulseAudio source ffmpeg records. The Docker image creates the `perch` null sink; natively, create it with `pactl` (see above) or use `@DEFAULT_MONITOR@`. |
| `AUDIO_BITRATE`     | `96`                       | Opus bitrate in kbit/s (24–256). Raw PCM, used by browsers without WebCodecs Opus, is a fixed 24 kHz stereo. |
| `FFMPEG_PATH`       | _(auto-detect)_            | Path to the ffmpeg binary, if it is not on `PATH`.                                                           |

## Verify it works

1. **Egress is the home server.** Click the **Find my IP** speed dial, or type `ifconfig.me` / `find my ip` in the address bar. The page must show the **home server's public IP**, not the laptop or phone. The same value is returned by the API, fetched on the server:

   ```bash
   # after login, from a machine that has the session cookie — or from the server:
   curl -s http://127.0.0.1:8080/api/ip
   # 401 without a session cookie, as expected
   ```

2. **Input reaches real Chromium.** Type `google.com` and press **Go**, then click the Google search box **inside the viewport** and type. Characters must appear — proof that input reaches a live Chromium, not a screenshot.

## Usage

### Address bar

- `example.com` → `https://example.com`
- Text with no dot (and no scheme) → Google search
- `find my ip` / `what is my ip` / `ifconfig.me` → `https://ifconfig.me/`

### Tabs

The title bar is a real tab strip. **+** opens a new tab (showing the start page), clicking a tab switches to it, and **×** (or a middle-click) closes it. Closing the last tab opens a fresh blank one, so the browser is never left without a page. Because there is a single shared Chromium, everyone signed in sees and controls the same set of tabs. Links that open a new tab or window (SSO sign-in, `target=_blank`) appear in the strip and take over the view; closing such a tab returns you to the one that opened it.

### Window and keyboard controls

- **Maximize** — the window fills the page.
- **Fullscreen** — uses the Fullscreen API; the address bar stays visible, and `Esc` exits.
- **Focus** — hides the title bar and status bar.
- **Ctrl/Cmd + L** — focus the address bar.
- **F11** — toggle fullscreen.

### Sound

Whatever the remote Chromium plays streams to your device. Browsers only allow sound after you interact with the page, so the first click or tap in the viewport switches it on; the speaker button in the title bar mutes and unmutes, and the choice is remembered on that device. The **Latency** panel shows which encoding is in use: **Opus** (about 100 kbit/s, on Chrome, Edge, Firefox, and recent Safari) or **PCM** (about 770 kbit/s) as a fallback. When nothing is playing, the stream costs almost nothing.

### Latency

The chart icon next to **Focus** opens a panel with live connection stats: round-trip time to the home server, frames per second, bandwidth, and the remote viewport size. The dot on the icon is green under ~80 ms, amber under ~200 ms, and red above — handy for telling an unresponsive site apart from a slow link.

### Phones and tablets

- One finger drags to scroll, a still tap clicks, and a long press right-clicks.
- Tapping a text field raises the on-screen keyboard automatically. The keyboard button in the toolbar raises it manually — useful for fields inside cross-origin iframes, where the server cannot tell what has focus.
- The remote viewport is sized to your screen (down to 360 px wide), so responsive sites render their mobile layout instead of a shrunken desktop page.

### Google "are you a human?" and corporate sign-in

Run headed (`CHROME_HEADLESS=0`, the Docker default) with a persistent profile (`CHROME_USER_DATA`, the Docker volume). Headless Chromium plus a fresh profile is the combination that trips reCAPTCHA. In this mode, clicks reach the CAPTCHA iframe with a preceding hover, key events are real, and nothing is dropped during navigation, so the checkbox and image challenges can be completed as in a local browser.

## How it works

Node.js launches system Chromium with `puppeteer-core` and talks to it over the Chrome DevTools Protocol (pipe / loopback only — the debug port is never published on `0.0.0.0:9222`), forwarding mouse, wheel, keyboard, and paste.

Frames come from Chromium's own `Page.startScreencast`: Chromium pushes a JPEG only when pixels change, so an idle page costs nothing and a scrolling page streams at the compositor rate. Frames travel as **binary** WebSocket messages (a 9-byte header plus the JPEG — no base64, no JSON), and the client decodes them off the main thread with `createImageBitmap`, always painting only the newest one.

Navigation is non-blocking. Changing the URL sends `Page.navigate` and returns; you keep full mouse and keyboard control while the site loads, and the viewport is cleared the moment you press **Go**. Every navigation bumps an _epoch_, and frames from the old document are dropped, so you never see stale content after a URL change. JavaScript dialogs (`alert`, `confirm`, `beforeunload`) are auto-answered so they can never wedge the stream, and downloads are refused.

Sound follows the same path. Chromium plays into a PulseAudio null sink on the server; ffmpeg records that sink's monitor, encodes it as Opus in 20 ms packets, and the server forwards each packet as a binary WebSocket message (a 6-byte header plus the packet) to every client that asked for sound. The client decodes with WebCodecs `AudioDecoder` and schedules the samples with the Web Audio API a few tens of milliseconds ahead of the clock, dropping the queue and resyncing if a stall leaves it behind live. Browsers without an Opus decoder ask for raw PCM instead. ffmpeg only runs while someone is listening.

Popups and new tabs (SSO sign-in windows, `target=_blank` links) take over the view automatically. When such a window closes, the view returns to the page that opened it — what an OAuth / SSO round-trip expects.

Keyboard input is delivered as real `keyDown` / `keyUp` events (with `text` for printable keys), not text insertion, so sites that listen to key events behave as they do locally. A Mac client's Cmd is translated to Ctrl when Chromium runs on Linux, so Cmd+A / Cmd+C / Cmd+V work. Chromium is launched without the automation banner or the `navigator.webdriver` flag, and in headless mode the `HeadlessChrome` user agent (including client hints) is rewritten.

Until the first real navigation, the viewport shows the new-tab start page (Google, YouTube, Find my IP, Wikipedia). After that it becomes the live stream.

## Reverse proxy (TLS)

To serve Perch over HTTPS, put it behind Caddy or Nginx. The proxy **must** forward WebSocket `Upgrade` headers; otherwise the UI loads but the viewport never becomes a live stream.

**Caddy**

```caddy
vpn.bytetech.cloud {
    reverse_proxy 127.0.0.1:8080
}
```

**Nginx**

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}
```

The session cookie is `HttpOnly` and `SameSite=Lax`, and is marked `Secure` when `X-Forwarded-Proto` is `https`.

## Health

```bash
curl -s http://127.0.0.1:8080/health
```

## Security notes

- Do not expose port 8080 on the public internet without TLS and the reverse proxy.
- Login is rate-limited, and passwords are never logged.
- Chromium's DevTools port is bound to loopback / a pipe only. Do not publish `9222`.
- This app can reach whatever the home server can reach. Treat the password like a house key.

## License

Released under the [MIT License](LICENSE).
