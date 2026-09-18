"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Auth, clientIp } = require("./auth");
const { HomeBrowser, resolveUrl } = require("./browser");
const { Settings, SEARCH_ENGINES, BACKGROUND_MAX_BYTES } = require("./settings");
const { StaticAssets } = require("./static");

const APP_PASSWORD = process.env.APP_PASSWORD || "";
const APP_USER = process.env.APP_USER || "admin";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 8080;
const HOME_URL = process.env.HOME_URL || "https://www.google.com/";
// Bumped whenever the server protocol changes; lets a client confirm it is not talking
// to an older process. Adaptive quality + settings over the socket landed in build 4,
// audio in build 3, tabs + binary screencast in build 2.
const BUILD = 4;

if (!APP_PASSWORD) {
  console.error("Refusing to start: APP_PASSWORD is missing.");
  console.error("Copy .env.example to .env and set APP_PASSWORD.");
  process.exit(1);
}

const browser = new HomeBrowser({ homeUrl: HOME_URL });
const auth = new Auth({
  password: APP_PASSWORD,
  user: APP_USER,
  dataDir: path.join(HomeBrowser.userDataDir(), "perch-auth"),
});
if (auth.passwordChanged) {
  console.log("[home-browser] using the password set in Settings (APP_PASSWORD is ignored)");
}
// Next to the ad blocker's data, inside the Chrome profile, so one volume persists it all.
const settings = new Settings({ dataDir: path.join(HomeBrowser.userDataDir(), "perch-settings") });

function applySettings() {
  const s = settings.get();
  browser.applySettings({
    homeUrl: s.browsing.homeUrl || HOME_URL,
    searchUrl: settings.searchUrl(),
    quality: s.stream.quality,
  });
}
applySettings();

function settingsPayload() {
  return {
    settings: settings.get(),
    searchUrl: settings.searchUrl(),
    searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, label: e.label })),
    defaultHomeUrl: HOME_URL,
    hasCustomBackground: Boolean(settings.backgroundFile()),
  };
}

// Every connected device follows along, so a phone and a laptop never disagree.
function settingsChanged(res) {
  applySettings();
  const payload = settingsPayload();
  browser.broadcast({ type: "settings", ...payload });
  res.json({ ok: true, ...payload });
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: "ok",
    build: BUILD,
    features: ["tabs", "binary-frames", "latency", "adblock", "settings", "password", "pwa", "adaptive-quality", ...(browser.audioEnabled ? ["audio"] : [])],
    chromium: browser.ready,
    audio: browser.audioEnabled ? (browser.audioActive ? "streaming" : "idle") : "disabled",
    user: APP_USER,
  });
});

app.post("/api/login", (req, res) => {
  const ip = clientIp(req);
  if (!auth.allowLoginAttempt(ip)) {
    const retry = auth.retryAfterSec(ip);
    res.setHeader("Retry-After", String(retry));
    res.status(429).json({ error: "Too many login attempts. Try again later." });
    return;
  }

  const password = req.body && req.body.password;
  const username = req.body && req.body.username;
  if (username != null && String(username) !== "" && String(username) !== APP_USER) {
    console.log(`[home-browser] login failed for ${ip}`);
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  if (!auth.verifyPassword(password)) {
    console.log(`[home-browser] login failed for ${ip}`);
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = auth.createSession(ip);
  auth.setSessionCookie(req, res, token);
  console.log(`[home-browser] login ok for ${ip} (user=${APP_USER})`);
  res.json({ ok: true, user: APP_USER });
});

// Shares the login limiter: a stolen session must not become a way to guess the password.
app.post("/api/password", auth.requireAuth.bind(auth), (req, res) => {
  const ip = clientIp(req);
  if (!auth.allowLoginAttempt(ip)) {
    res.setHeader("Retry-After", String(auth.retryAfterSec(ip)));
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  const body = req.body || {};
  const keep = auth.tokenFromRequest(req);
  let dropped;
  try {
    dropped = auth.changePassword(body.current, body.next, keep);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  // Devices signed in with the old password lose their live connection too, not just
  // their cookie.
  for (const ws of wss.clients) {
    if (dropped.includes(ws.sessionToken)) ws.close(4001, "Password changed");
  }
  console.log(`[home-browser] password changed by ${ip}; ${dropped.length} other session(s) signed out`);
  res.json({ ok: true, signedOut: dropped.length });
});

app.post("/api/logout", (req, res) => {
  const token = auth.tokenFromRequest(req);
  auth.destroySession(token);
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Cheap "am I signed in?" for start-up. /api/ip answers the same question but waits on
// an outside IP lookup first, which can take seconds.
app.get("/api/session", auth.requireAuth.bind(auth), (req, res) => {
  res.json({ ok: true, user: req.session.user });
});

app.get("/api/ip", auth.requireAuth.bind(auth), async (_req, res) => {
  try {
    const egress = await fetchEgressIp();
    res.json({ egress_ip: egress });
  } catch (err) {
    res.status(502).json({ error: "Could not fetch egress IP", detail: err.message });
  }
});

app.post("/api/navigate", auth.requireAuth.bind(auth), async (req, res) => {
  const url = req.body && req.body.url;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }
  try {
    const meta = await browser.navigate(url);
    res.json({ ok: true, ...meta, resolved: resolveUrl(url, browser.homeUrl, browser.searchUrl) });
  } catch (err) {
    res.status(503).json({ error: err.message || "Navigation failed" });
  }
});

app.post("/api/action", auth.requireAuth.bind(auth), async (req, res) => {
  const type = req.body && req.body.type;
  if (!["back", "forward", "reload", "home"].includes(type)) {
    res.status(400).json({ error: "type must be back, forward, reload, or home" });
    return;
  }
  try {
    const meta = await browser.action(type);
    res.json({ ok: true, ...meta });
  } catch (err) {
    res.status(503).json({ error: err.message || "Action failed" });
  }
});

app.get("/api/settings", auth.requireAuth.bind(auth), (_req, res) => {
  res.json({ ok: true, ...settingsPayload() });
});

app.put("/api/settings", auth.requireAuth.bind(auth), (req, res) => {
  settings.update(req.body);
  settingsChanged(res);
});

app.post("/api/settings/reset", auth.requireAuth.bind(auth), (_req, res) => {
  settings.reset();
  settingsChanged(res);
});

app.put(
  "/api/settings/background",
  auth.requireAuth.bind(auth),
  express.raw({ type: ["image/webp", "image/jpeg", "image/png"], limit: BACKGROUND_MAX_BYTES }),
  (req, res) => {
    try {
      settings.setBackground(req.body);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    settingsChanged(res);
  }
);

app.delete("/api/settings/background", auth.requireAuth.bind(auth), (_req, res) => {
  settings.removeBackground();
  settingsChanged(res);
});

app.get("/api/background", auth.requireAuth.bind(auth), (_req, res) => {
  const bg = settings.backgroundFile();
  if (!bg) {
    res.status(404).json({ error: "No custom background" });
    return;
  }
  res.setHeader("Content-Type", bg.mime);
  // The client adds ?v=<backgroundVersion>, so a given URL never changes content.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(bg.file);
});

app.get("/api/tabs", auth.requireAuth.bind(auth), async (_req, res) => {
  try {
    res.json({ ok: true, ...(await browser.listTabs()) });
  } catch (err) {
    res.status(503).json({ error: err.message || "Tabs unavailable" });
  }
});

app.post("/api/tab", auth.requireAuth.bind(auth), async (req, res) => {
  const body = req.body || {};
  const action = body.action;
  const id = typeof body.id === "string" ? body.id : "";
  try {
    let meta;
    if (action === "new") meta = await browser.newTab(typeof body.url === "string" ? body.url : "");
    else if (action === "switch" && id) meta = await browser.switchTab(id);
    else if (action === "close" && id) meta = await browser.closeTab(id);
    else {
      res.status(400).json({ error: "action must be new, switch or close (with id)" });
      return;
    }
    res.json({ ok: true, ...meta });
  } catch (err) {
    res.status(503).json({ error: err.message || "Tab action failed" });
  }
});

const assets = new StaticAssets(path.join(__dirname, "..", "public"));
app.use(assets.middleware());

app.use((req, res) => {
  if (req.path.startsWith("/api/") || req.path === "/ws") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // A missing file must not come back as HTML under a script or image URL.
  if (/\.[a-z0-9]{2,5}$/i.test(req.path)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  assets.sendHtml(req, res);
});

// Body-parser failures (oversized upload, malformed JSON) as JSON, like every other error.
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 413 ? "Upload is too large" : err.message || "Request failed" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  clientTracking: true,
  // JPEG frames do not compress; skipping deflate saves CPU and latency.
  perMessageDeflate: false,
  maxPayload: 256 * 1024,
});

server.on("upgrade", (req, socket, head) => {
  const url = (req.url || "").split("?")[0];
  if (url !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const session = auth.sessionFromRequest(req);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, session);
  });
});

wss.on("connection", (ws, req, session) => {
  ws.isAlive = true;
  ws.sessionUser = session.user;
  ws.sessionToken = auth.tokenFromRequest(req);
  console.log(`[home-browser] ws connected (${clientIp(req)}, user=${session.user})`);
  // Settings ride along on the socket, so a (re)connecting device is current at once
  // without a separate round trip.
  try {
    ws.send(JSON.stringify({ type: "settings", ...settingsPayload() }));
  } catch {
    // ignore
  }
  browser.addClient(ws);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    if (msg.type === "ping") {
      // Latency probe: echo the client's timestamp straight back.
      try {
        ws.send(JSON.stringify({ type: "pong", t: msg.t }));
      } catch {
        // ignore
      }
      return;
    }
    const run = browser.handleInput(msg, ws);
    if (run && typeof run.then === "function") {
      run.catch((err) => {
        console.error(`[home-browser] input error: ${err.message}`);
      });
    }
  });

  ws.on("close", () => {
    browser.removeClient(ws);
  });

  ws.on("error", () => {
    browser.removeClient(ws);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      browser.removeClient(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }
}, 25000);
heartbeat.unref();

let egressCache = { ip: null, at: 0 };

async function fetchEgressIp() {
  const now = Date.now();
  if (egressCache.ip && now - egressCache.at < 60_000) return egressCache.ip;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: ac.signal });
    if (!res.ok) throw new Error(`ipify HTTP ${res.status}`);
    const data = await res.json();
    const ip = data && data.ip;
    if (!ip) throw new Error("ipify returned no ip");
    egressCache = { ip, at: now };
    return ip;
  } finally {
    clearTimeout(t);
  }
}

async function shutdown(signal) {
  console.log(`[home-browser] ${signal}, shutting down`);
  clearInterval(heartbeat);
  try {
    wss.clients.forEach((ws) => ws.close());
  } catch {
    // ignore
  }
  await browser.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  console.log(`[home-browser] http://${HOST}:${PORT}  user=${APP_USER}`);
  console.log("[home-browser] single Chromium session — a second login shares / takes it over");
  browser.launch().catch(() => {
    console.error("[home-browser] will keep retrying Chromium in the background");
  });
});
