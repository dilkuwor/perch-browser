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
```

- `APP_PASSWORD` is required. The process **refuses to start** if it is missing or shorter than 12 characters.
- Leave `CHROME_PATH` empty to auto-detect Chrome/Chromium. Set it if the binary lives somewhere unusual.
- If Chromium fails with a sandbox error (common on some VPS / LXC hosts), set `CHROME_NO_SANDBOX=1`. Prefer a real user namespace sandbox when you can.

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

Node.js launches system Chromium with `puppeteer-core`, talks to it over Chrome DevTools Protocol (pipe / loopback only — debug port is never published on `0.0.0.0:9222`), JPEG-screencasts the page into the big viewport, and forwards mouse, wheel, keyboard, and paste.

Until the first real navigation, the viewport shows the new-tab start page (Google, YouTube, Find my IP, Wikipedia). After that it becomes the live stream.

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
