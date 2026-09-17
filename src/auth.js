"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE_NAME = "hb_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const PASSWORD_MAX = 256;
const PASSWORD_FILE = "password.json";
// scrypt cost: ~50 ms per check, which login rate-limiting keeps from being a DoS lever.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function safeEqualString(a, b) {
  const ha = sha256(String(a ?? ""));
  const hb = sha256(String(b ?? ""));
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) {
    return xf.split(",")[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function isSecureRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https" || req.secure === true;
}

function cookieHeader(token, { secure, maxAge }) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join("; ");
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), ...SCRYPT };
}

function matchesHash(candidate, stored) {
  try {
    const expected = Buffer.from(stored.hash, "base64");
    const actual = crypto.scryptSync(candidate, Buffer.from(stored.salt, "base64"), expected.length, {
      N: stored.N,
      r: stored.r,
      p: stored.p,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

class Auth {
  // `password` (APP_PASSWORD) is the initial password. Once it has been changed from the
  // settings page, the salted scrypt hash in `dataDir` takes over and the environment
  // value is ignored; deleting that file is the recovery path back to APP_PASSWORD.
  constructor({ password, user, dataDir }) {
    this.password = password;
    this.dataDir = dataDir || null;
    this.stored = this.#loadStored();
    this.user = user || "admin";
    this.sessions = new Map();
    this.loginHits = new Map();
    setInterval(() => this.#gc(), 60 * 1000).unref();
  }

  #gc() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
    for (const [ip, hits] of this.loginHits) {
      const fresh = hits.filter((t) => now - t < LOGIN_WINDOW_MS);
      if (fresh.length === 0) this.loginHits.delete(ip);
      else this.loginHits.set(ip, fresh);
    }
  }

  allowLoginAttempt(ip) {
    const now = Date.now();
    const hits = (this.loginHits.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (hits.length >= LOGIN_MAX_ATTEMPTS) {
      this.loginHits.set(ip, hits);
      return false;
    }
    hits.push(now);
    this.loginHits.set(ip, hits);
    return true;
  }

  retryAfterSec(ip) {
    const hits = this.loginHits.get(ip) || [];
    if (hits.length === 0) return 0;
    const oldest = Math.min(...hits);
    return Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - Date.now()) / 1000));
  }

  #loadStored() {
    if (!this.dataDir) return null;
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(this.dataDir, PASSWORD_FILE), "utf8"));
      return stored && typeof stored.hash === "string" && typeof stored.salt === "string" ? stored : null;
    } catch {
      return null;
    }
  }

  get passwordChanged() {
    return Boolean(this.stored);
  }

  verifyPassword(candidate) {
    if (typeof candidate !== "string" || candidate.length > PASSWORD_MAX) return false;
    if (this.stored) return matchesHash(candidate, this.stored);
    return safeEqualString(candidate, this.password);
  }

  // Throws an Error whose message is safe to show the user. On success every session
  // except `keepToken` is dropped, so a device that knew the old password is signed out.
  changePassword(current, next, keepToken) {
    if (!this.dataDir) throw new Error("Password changes are not available on this server");
    if (!this.verifyPassword(current)) throw new Error("Current password is incorrect");
    if (typeof next !== "string" || next.trim() === "") throw new Error("New password cannot be blank");
    if (next.length > PASSWORD_MAX) throw new Error(`New password must be at most ${PASSWORD_MAX} characters`);
    if (next === current) throw new Error("New password must be different from the current one");

    const stored = hashPassword(next);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dataDir, PASSWORD_FILE);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.stored = stored;

    const dropped = [];
    for (const token of this.sessions.keys()) {
      if (token !== keepToken) dropped.push(token);
    }
    for (const token of dropped) this.sessions.delete(token);
    return dropped;
  }

  createSession(ip) {
    const token = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    this.sessions.set(token, {
      user: this.user,
      ip,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    return token;
  }

  destroySession(token) {
    if (token) this.sessions.delete(token);
  }

  getSession(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  tokenFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[COOKIE_NAME] || null;
  }

  sessionFromRequest(req) {
    return this.getSession(this.tokenFromRequest(req));
  }

  setSessionCookie(req, res, token) {
    res.setHeader("Set-Cookie", cookieHeader(token, {
      secure: isSecureRequest(req),
      maxAge: SESSION_TTL_MS / 1000,
    }));
  }

  clearSessionCookie(req, res) {
    res.setHeader("Set-Cookie", cookieHeader("", {
      secure: isSecureRequest(req),
      maxAge: 0,
    }));
  }

  requireAuth(req, res, next) {
    const session = this.sessionFromRequest(req);
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.session = session;
    next();
  }
}

Auth.clientIp = clientIp;
Auth.isSecureRequest = isSecureRequest;
Auth.COOKIE_NAME = COOKIE_NAME;

module.exports = { Auth, clientIp, isSecureRequest, COOKIE_NAME };
