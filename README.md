# Home Browser

A personal remote Chromium for your home server. Open a desktop-style browser UI in any phone or laptop, and the pages actually load in a real Chrome process running **at home**. Frames stream into the viewport over WebSocket. Mouse, wheel, keyboard, and paste are forwarded with Chrome DevTools Protocol.

This is **not** a VPN, **not** an HTML-rewriting proxy, and **not** an `<iframe>` of google.com (that is blocked by almost every site). It is a remote Chromium.

Single Chromium session: there is one browser process. A second login uses (and can take over) that same session — same cookies, same tab, same page.

Later you can expose it at `https://vpn.bytetech.cloud` or `https://rdp.bytetech.cloud` behind Caddy or Nginx. The reverse proxy **must** forward WebSocket `Upgrade` headers.

## Requirements

- Node.js 20+
- Google Chrome or Chromium installed on the home server
- A long password (12+ characters) in `.env`

No Docker, no Postgres, no compose files in this pass.

## Install (Ubuntu / Debian)

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Chromium (Debian package name is chromium; Ubuntu may use chromium-browser)
sudo apt-get update
sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
```

Confirm binaries:

```bash
node -v          # v20 or newer
which chromium || which chromium-browser || which google-chrome-stable
```

## Configure and run

From this repo on the **home server**:

```bash
cd /opt/home-browser          # or wherever you cloned/copied this repo
cp .env.example .env
nano .env                     # set APP_PASSWORD to 12+ characters
npm install
npm start
```

`.env`:

```
APP_PASSWORD=choose-a-long-password
APP_USER=admin
HOST=0.0.0.0
PORT=8080
HOME_URL=https://www.google.com/
CHROME_PATH=
CHROME_NO_SANDBOX=0
CHROME_HEADLESS=1
CHROME_USER_DATA=
JPEG_QUALITY=60
```

- `APP_PASSWORD` is required. The process **refuses to start** if it is missing or shorter than 12 characters.
- Leave `CHROME_PATH` empty to auto-detect Chrome/Chromium. Set it if the binary lives somewhere unusual.
- If Chromium fails with a sandbox error (common on some VPS / LXC hosts), set `CHROME_NO_SANDBOX=1`. Prefer a real user namespace sandbox when you can.
- `CHROME_HEADLESS=0` runs a real (headed) Chromium under Xvfb. This is what the Docker image does and it is what you want for Google, CAPTCHAs and corporate sign-in pages: headless Chromium is easy to detect and gets challenged much more often.
- `CHROME_USER_DATA` keeps cookies and site trust between restarts. Losing the profile on every restart means every site treats you as a brand-new visitor.
- `JPEG_QUALITY` (20-95) trades sharpness for bandwidth. Try 45 on a slow mobile link.

Open:

```
http://HOME_LAN_IP:8080
```

Example: `http://192.168.1.50:8080`

Log in with the password from `.env`. The login is real. Any other password is rejected.

## Pass tests

1. **Find my IP**
   - Click the **Find my IP** speed dial, or type `ifconfig.me` / `find my ip` in the in-app address bar.
   - The page in the viewport must show the **house public IP** (the home server’s egress), not the laptop or phone IP.
   - `GET /api/ip` (while logged in) returns `{ "egress_ip": "..." }` from `api.ipify.org`, fetched **on the server**. That value must match.

   ```bash
   # after login, from a machine that has the session cookie — or from the server:
   curl -s http://127.0.0.1:8080/api/ip
   # 401 without a session cookie, as expected
   ```

2. **Google typing**
   - Type `google.com` in the in-app address bar and press Go.
   - Click the Google search box **inside the viewport** and type. Characters must appear. That proves input is reaching real Chromium, not a screenshot.

## Address bar

- `example.com` → `https://example.com`
- Text with no dot (and no scheme) → Google search
- `find my ip` / `what is my ip` / `ifconfig.me` → `https://ifconfig.me/`

## Window chrome

- **Maximize** — CSS class, the window fills the page
- **Fullscreen** — Fullscreen API on the browser shell. Address bar stays visible. Esc exits.
- **Focus** — hides the title bar and status bar
- **Ctrl/Cmd+L** — focus the address bar
- **F11** — toggle fullscreen

## How it works

Node.js launches system Chromium with `puppeteer-core`, talks to it over Chrome DevTools Protocol (pipe / loopback only — debug port is never published on `0.0.0.0:9222`), and forwards mouse, wheel, keyboard, and paste.

Frames come from Chromium's own `Page.startScreencast`: Chromium pushes a JPEG only when pixels change, so an idle page costs nothing and a scrolling page streams at the compositor rate. Frames travel as **binary** WebSocket messages (a 9-byte header plus the JPEG, no base64, no JSON), and the client decodes them off the main thread with `createImageBitmap`, always painting only the newest one.

Navigation is non-blocking. Changing the URL sends `Page.navigate` and returns; you keep full mouse and keyboard control while the site loads, and the viewport is cleared the moment you hit Go. Every navigation bumps an *epoch*; frames from the old document are dropped, so you never see stale content from the previous URL after a URL change. JavaScript dialogs (`alert`, `confirm`, `beforeunload`) are auto-answered so they can never wedge the stream, and downloads are refused.

Popups and new tabs (SSO sign-in windows, `target=_blank` links) take over the view automatically. When such a window closes, the view returns to the page that opened it, which is what an OAuth / SSO round-trip expects.

Keyboard input is delivered as real `keyDown` / `keyUp` events (with `text` for printable keys), not text insertion, so sites that listen to key events behave like they do locally. A Mac client's Cmd is translated to Ctrl when Chromium runs on Linux, so Cmd+A / Cmd+C / Cmd+V work. Chromium is launched without the automation banner or the `navigator.webdriver` flag, and in headless mode the `HeadlessChrome` user agent (including client hints) is rewritten.

Until the first real navigation, the viewport shows the new-tab start page (Google, YouTube, Find my IP, Wikipedia). After that it becomes the live stream.

### Tabs

The title bar is a real tab strip. **+** opens a new tab (it shows the start page), clicking a tab switches to it, and **×** (or a middle-click) closes it. Closing the last tab opens a fresh blank one so the browser is never left without a page. Because there is a single shared Chromium, everyone signed in sees and controls the same set of tabs. Links that open a new tab or window (SSO sign-in, `target=_blank`) appear in the strip and take over the view; closing such a tab returns you to the one that opened it.

### Latency

The chart icon next to Focus mode opens a small panel with the live connection stats: round-trip time to the home server, frames per second, bandwidth, and the remote viewport size. The dot on the icon is green under ~80 ms, amber under ~200 ms, red above. Use it to tell an unresponsive site apart from a slow link.

### Phones and tablets

- One finger drag scrolls, a still tap clicks, a long press right-clicks.
- Tapping a text field raises the phone keyboard automatically. The keyboard button in the toolbar raises it manually (for fields inside cross-origin iframes, where the server cannot tell what has focus).
- The remote viewport is sized to your screen (down to 360 px wide), so responsive sites render their mobile layout instead of a shrunken desktop page.

### Google "are you a human?" and corporate sign-in pages

Run headed (`CHROME_HEADLESS=0`, the Docker default) with a persistent profile (`CHROME_USER_DATA`, the Docker volume). Headless Chromium plus a fresh profile is the combination that trips reCAPTCHA. With this pass, clicks reach the CAPTCHA iframe with a preceding hover, key events are real, and nothing is dropped during navigation, so the checkbox and the image challenges can be completed like in a local browser.

## Reverse proxy (later)

Caddy and Nginx must forward WebSocket upgrades. If they do not, the UI will load but the viewport will never become a live stream.

**Caddy**

```
vpn.bytetech.cloud {
    reverse_proxy 127.0.0.1:8080
}
```

**Nginx**

```
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

The session cookie is `httpOnly`, `SameSite=Lax`, and `Secure` when `X-Forwarded-Proto` is `https`.

## Health

```bash
curl -s http://127.0.0.1:8080/health
```

## Security notes

- Do not expose port 8080 on the public internet without TLS and the reverse proxy.
- Login is rate-limited. Passwords are never logged.
- Chromium’s DevTools port is bound to loopback / a pipe only. Do not publish `9222`.
- This app sees whatever the home server can fetch. Treat the password like a house key.
