"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Auth, clientIp, isSecureRequest, COOKIE_NAME } = require("../src/auth");

function mockReq({ cookie, headers, socket } = {}) {
  return {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(headers || {}),
    },
    socket: socket || { remoteAddress: "127.0.0.1" },
  };
}

function mockRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("Auth", () => {
  it("accepts the configured password and rejects others", () => {
    const auth = new Auth({ password: "twelvechars!!", user: "admin" });
    assert.equal(auth.verifyPassword("twelvechars!!"), true);
    assert.equal(auth.verifyPassword("wrong-password"), false);
    assert.equal(auth.verifyPassword(""), false);
    assert.equal(auth.verifyPassword(null), false);
  });

  it("creates a session that requireAuth accepts", () => {
    const auth = new Auth({ password: "twelvechars!!", user: "admin" });
    const token = auth.createSession("1.2.3.4");
    const req = mockReq({ cookie: `${COOKIE_NAME}=${token}` });
    const res = mockRes();
    let nextCalled = false;
    auth.requireAuth(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(req.session.user, "admin");
    assert.equal(req.session.ip, "1.2.3.4");
  });

  it("rejects requests without a session cookie", () => {
    const auth = new Auth({ password: "twelvechars!!" });
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    auth.requireAuth(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Unauthorized" });
  });

  it("destroys a session on logout", () => {
    const auth = new Auth({ password: "twelvechars!!" });
    const token = auth.createSession("127.0.0.1");
    auth.destroySession(token);
    assert.equal(auth.getSession(token), null);
  });

  it("rate-limits login attempts per IP", () => {
    const auth = new Auth({ password: "twelvechars!!" });
    const ip = "10.0.0.9";
    for (let i = 0; i < 8; i += 1) {
      assert.equal(auth.allowLoginAttempt(ip), true);
    }
    assert.equal(auth.allowLoginAttempt(ip), false);
    assert.ok(auth.retryAfterSec(ip) > 0);
  });

  it("sets HttpOnly SameSite cookie and Secure when forwarded proto is https", () => {
    const auth = new Auth({ password: "twelvechars!!" });
    const token = auth.createSession("127.0.0.1");
    const req = mockReq({ headers: { "x-forwarded-proto": "https" } });
    const res = mockRes();
    auth.setSessionCookie(req, res, token);
    const cookie = res.headers["Set-Cookie"];
    assert.match(cookie, new RegExp(`^${COOKIE_NAME}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
  });
});

describe("clientIp / isSecureRequest", () => {
  it("reads the first X-Forwarded-For hop", () => {
    const req = mockReq({
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
    });
    assert.equal(clientIp(req), "203.0.113.10");
  });

  it("falls back to the socket address", () => {
    const req = mockReq({ socket: { remoteAddress: "::1" } });
    assert.equal(clientIp(req), "::1");
  });

  it("treats X-Forwarded-Proto https as secure", () => {
    assert.equal(isSecureRequest(mockReq({ headers: { "x-forwarded-proto": "https" } })), true);
    assert.equal(isSecureRequest(mockReq({ headers: { "x-forwarded-proto": "http" } })), false);
  });
});

describe("changing the password", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const OLD = "initial-password-1";
  const NEW = "correct horse battery";

  function tempAuth() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-auth-test-"));
    return { dataDir, auth: new Auth({ password: OLD, user: "admin", dataDir }) };
  }

  it("replaces the environment password and survives a restart", () => {
    const { dataDir, auth } = tempAuth();
    try {
      auth.changePassword(OLD, NEW, null);
      assert.equal(auth.verifyPassword(NEW), true);
      assert.equal(auth.verifyPassword(OLD), false);
      const restarted = new Auth({ password: OLD, user: "admin", dataDir });
      assert.equal(restarted.passwordChanged, true);
      assert.equal(restarted.verifyPassword(NEW), true);
      assert.equal(restarted.verifyPassword(OLD), false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stores a salted hash, never the password, in an owner-only file", () => {
    const { dataDir, auth } = tempAuth();
    try {
      auth.changePassword(OLD, NEW, null);
      const file = path.join(dataDir, "password.json");
      const raw = fs.readFileSync(file, "utf8");
      assert.ok(!raw.includes(NEW));
      assert.ok(JSON.parse(raw).salt.length >= 16);
      if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("requires the current password and a non-blank, different new one", () => {
    const { dataDir, auth } = tempAuth();
    try {
      assert.throws(() => auth.changePassword("wrong-password-xx", NEW, null), /Current password/);
      assert.throws(() => auth.changePassword(OLD, "", null), /blank/);
      assert.throws(() => auth.changePassword(OLD, "   ", null), /blank/);
      assert.throws(() => auth.changePassword(OLD, OLD, null), /different/);
      assert.throws(() => auth.changePassword(OLD, "x".repeat(300), null), /at most/);
      assert.throws(() => auth.changePassword(OLD, { length: 99 }, null), /blank/);
      assert.equal(auth.verifyPassword(OLD), true);
      assert.equal(auth.passwordChanged, false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts a short password", () => {
    const { dataDir, auth } = tempAuth();
    try {
      auth.changePassword(OLD, "abc", null);
      assert.equal(auth.verifyPassword("abc"), true);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("signs out every other session but keeps the one that made the change", () => {
    const { dataDir, auth } = tempAuth();
    try {
      const mine = auth.createSession("10.0.0.1");
      const phone = auth.createSession("10.0.0.2");
      const dropped = auth.changePassword(OLD, NEW, mine);
      assert.deepEqual(dropped, [phone]);
      assert.ok(auth.getSession(mine));
      assert.equal(auth.getSession(phone), null);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("falls back to the environment password when the file is deleted or corrupt", () => {
    const { dataDir, auth } = tempAuth();
    try {
      auth.changePassword(OLD, NEW, null);
      fs.writeFileSync(path.join(dataDir, "password.json"), "{broken");
      assert.equal(new Auth({ password: OLD, dataDir }).verifyPassword(OLD), true);
      fs.rmSync(path.join(dataDir, "password.json"));
      assert.equal(new Auth({ password: OLD, dataDir }).verifyPassword(OLD), true);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses when the server has nowhere to store it", () => {
    const auth = new Auth({ password: OLD });
    assert.throws(() => auth.changePassword(OLD, NEW, null), /not available/);
  });
});
