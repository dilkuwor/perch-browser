"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Auth, clientIp } = require("./auth");
const { HomeBrowser, resolveUrl } = require("./browser");

const APP_PASSWORD = process.env.APP_PASSWORD || "";
const APP_USER = process.env.APP_USER || "admin";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 8080;
const HOME_URL = process.env.HOME_URL || "https://www.google.com/";

if (!APP_PASSWORD) {
  console.error("Refusing to start: APP_PASSWORD is missing.");
  console.error("Copy .env.example to .env and set APP_PASSWORD.");
  process.exit(1);
}

const auth = new Auth({ password: APP_PASSWORD, user: APP_USER });
const browser = new HomeBrowser({ homeUrl: HOME_URL });

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
    chromium: browser.ready,
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

app.post("/api/logout", (req, res) => {
  const token = auth.tokenFromRequest(req);
  auth.destroySession(token);
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
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
    res.json({ ok: true, ...meta, resolved: resolveUrl(url, HOME_URL) });
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

app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: true,
  maxAge: 0,
  index: "index.html",
  setHeaders(res) {
    // Always revalidate the shell so remote clients never run a stale app.js.
    res.setHeader("Cache-Control", "no-cache");
  },
}));

app.use((req, res) => {
  if (req.path.startsWith("/api/") || req.path === "/ws") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
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
  console.log(`[home-browser] ws connected (${clientIp(req)}, user=${session.user})`);
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
