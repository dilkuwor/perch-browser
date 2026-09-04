"use strict";

const fs = require("fs");
const puppeteer = require("puppeteer-core");

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const JPEG_QUALITY = 55;
const MIN_VIEW_W = 640;
const MIN_VIEW_H = 400;
const MAX_VIEW_W = 1920;
const MAX_VIEW_H = 1080;
const RESTART_DELAY_MS = 1500;
const WS_BACKPRESSURE = 1_000_000;
const FRAME_MIN_MS = 90;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
  "/usr/local/bin/chromium",
  "/usr/local/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function findChrome() {
  const fromEnv = process.env.CHROME_PATH && process.env.CHROME_PATH.trim();
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) return fromEnv;
    throw new Error(`CHROME_PATH not found: ${fromEnv}`);
  }
  for (const p of CHROME_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  throw new Error(
    "Chromium/Chrome not found. Install chromium (or google-chrome) and/or set CHROME_PATH."
  );
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IP_LOOKUP = new Set([
  "find my ip",
  "what is my ip",
  "what's my ip",
  "whats my ip",
  "what is myip",
  "ip",
  "my ip",
  "ifconfig.me",
  "ifconfig",
]);

function resolveUrl(input, homeUrl) {
  const raw = String(input ?? "").trim();
  if (!raw) return homeUrl || "https://www.google.com/";
  const lower = raw.toLowerCase();
  if (IP_LOOKUP.has(lower) || lower === "https://ifconfig.me" || lower === "http://ifconfig.me") {
    return "https://ifconfig.me/";
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    return raw;
  }
  const looksLikeHost =
    raw.includes(".") ||
    /^localhost(?::\d+)?(?:\/|$)/i.test(raw) ||
    /^\d{1,3}(\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(raw);
  if (!looksLikeHost || /\s/.test(raw)) {
    return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  }
  return `https://${raw}`;
}

function assertAllowedUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    throw new Error("Invalid URL");
  }
  const ok = u.protocol === "http:" || u.protocol === "https:" || u.protocol === "about:";
  if (!ok) throw new Error("Blocked URL scheme");
  return u.href;
}

const MOUSE_BUTTONS = {
  0: "left",
  1: "middle",
  2: "right",
  3: "back",
  4: "forward",
};

function modifiersFrom(msg) {
  let m = 0;
  if (msg.alt) m |= 1;
  if (msg.ctrl) m |= 2;
  if (msg.meta) m |= 4;
  if (msg.shift) m |= 8;
  return m;
}

function virtualKey(msg) {
  if (Number.isFinite(msg.keyCode) && msg.keyCode > 0) return msg.keyCode;
  const key = msg.key || "";
  const code = msg.code || "";
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  const named = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Pause: 19,
    CapsLock: 20,
    Escape: 27,
    " ": 32,
    Space: 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Insert: 45,
    Delete: 46,
    Meta: 91,
    ContextMenu: 93,
    F1: 112,
    F2: 113,
    F3: 114,
    F4: 115,
    F5: 116,
    F6: 117,
    F7: 118,
    F8: 119,
    F9: 120,
    F10: 121,
    F11: 122,
    F12: 123,
  };
  if (named[key] != null) return named[key];
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

class HomeBrowser {
  constructor({ homeUrl }) {
    this.homeUrl = homeUrl || "https://www.google.com/";
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.clients = new Set();
    this.viewport = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    this.closed = false;
    this.launching = false;
    this.screencastOn = false;
    this._captureRunning = false;
    this._noOptimize = true;
    this.lastMeta = { url: "about:blank", title: "New Tab" };
    this._restartTimer = null;
    this._restartDelay = RESTART_DELAY_MS;
    this._lastFrameAt = 0;
    this._pumpTimer = null;
    this._frameLogged = false;
    this._paintBusy = false;
    this._paintAgain = false;
    this._recovering = false;
    this._inFlightInput = false;
    this._inputActive = false;
    this._captureInFlight = false;
    this._lastInputAt = 0;
    this._pendingMove = null;
    this._pendingExtras = [];
    this._timeouts = 0;
    this._lastSentAt = 0;
    this._screencastStartedAt = 0;
    this._metaTimer = null;
  }

  get ready() {
    return Boolean(this.page && this.cdp && this.browser);
  }

  async ensure() {
    if (this.ready) return;
    await this.launch();
  }

  async launch() {
    if (this.closed || this.launching) return;
    this.launching = true;
    try {
      await this._killBrowser();
      const executablePath = findChrome();
      const args = [
        "--disable-dev-shm-usage",
        `--window-size=${DEFAULT_WIDTH},${DEFAULT_HEIGHT}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-translate",
        "--disable-features=Translate,MediaRouter,PaintHolding",
        "--disable-background-networking",
        "--disable-component-update",
        "--metrics-recording-only",
        "--force-device-scale-factor=1",
        "--hide-crash-restore-bubble",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ];
      if (String(process.env.CHROME_NO_SANDBOX) === "1") {
        args.push("--no-sandbox", "--disable-setuid-sandbox");
      }

      console.log(`[home-browser] launching Chromium: ${executablePath}`);
      const launchOpts = {
        executablePath,
        headless: true,
        dumpio: false,
        protocolTimeout: 180000,
        defaultViewport: {
          width: this.viewport.width,
          height: this.viewport.height,
          deviceScaleFactor: 1,
        },
      };
      try {
        this.browser = await puppeteer.launch({ ...launchOpts, pipe: true, args });
      } catch (pipeErr) {
        console.warn(`[home-browser] pipe launch failed (${pipeErr.message}); retrying with loopback DevTools`);
        this.browser = await puppeteer.launch({
          ...launchOpts,
          pipe: false,
          args: [
            ...args,
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
          ],
        });
      }

      this.browser.on("disconnected", () => {
        if (this.closed) return;
        console.error("[home-browser] Chromium disconnected; will restart");
        this.page = null;
        this.cdp = null;
        this.screencastOn = false;
        this.browser = null;
        this._scheduleRestart();
      });

      const pages = await this.browser.pages();
      this.page = pages[0] || (await this.browser.newPage());
      await this._bindPage(this.page);
      await this.page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
      await this._sendMeta();
      if (this.clients.size > 0) this._startCaptureLoop();
      this._restartDelay = RESTART_DELAY_MS;
      console.log("[home-browser] Chromium ready");
    } catch (err) {
      console.error(`[home-browser] Chromium launch failed: ${err.message}`);
      this.page = null;
      this.cdp = null;
      this.browser = null;
      this._scheduleRestart();
      throw err;
    } finally {
      this.launching = false;
    }
  }

  _scheduleRestart() {
    if (this.closed || this._restartTimer) return;
    const delay = this._restartDelay;
    this._restartDelay = Math.min(Math.round(this._restartDelay * 1.6), 15000);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.launch().catch(() => {});
    }, delay);
  }

  async _killBrowser() {
    this._stopCaptureLoop();
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.screencastOn = false;
    if (!browser) return;
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }

  async _bindPage(page) {
    this.page = page;
    await page.setViewport({
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
    });

    page.on("close", () => {
      if (this.closed) return;
      console.error("[home-browser] page closed; recreating");
      this._recreatePage().catch((err) => {
        console.error(`[home-browser] recreate page failed: ${err.message}`);
      });
    });
    page.on("error", (err) => {
      console.error(`[home-browser] page error: ${err.message}`);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this._queueMeta();
    });
    page.on("load", () => this._queueMeta());
    page.on("domcontentloaded", () => this._queueMeta());

    await this._attachCdp(page);
  }

  async _attachCdp(page) {
    if (this.cdp) {
      try {
        this.cdp.removeAllListeners();
        await this.cdp.detach();
      } catch {
        // ignore
      }
      this.cdp = null;
      this.screencastOn = false;
    }
    const cdp = await page.createCDPSession();
    this.cdp = cdp;
    cdp.on("disconnected", () => {
      this.screencastOn = false;
    });
    await cdp.send("Page.enable").catch(() => {});
  }

  async _recreatePage() {
    if (this.closed || !this.browser) return;
    this.page = null;
    this.cdp = null;
    this.screencastOn = false;
    const page = await this.browser.newPage();
    await this._bindPage(page);
    if (this.clients.size > 0) this._startCaptureLoop();
  }

  async _recoverCdp() {
    if (this._recovering || !this.page || this.closed) return;
    this._recovering = true;
    console.warn("[home-browser] recovering CDP session");
    try {
      this.screencastOn = false;
      await this._attachCdp(this.page);
      this._timeouts = 0;
    } catch (err) {
      console.error(`[home-browser] CDP recover failed: ${err.message}`);
    } finally {
      this._recovering = false;
    }
  }

  _startCaptureLoop() {
    if (this._captureRunning) return;
    this._captureRunning = true;
    this._captureLoop().catch((err) => {
      console.error(`[home-browser] capture loop: ${err.message}`);
    });
  }

  _stopCaptureLoop() {
    this._captureRunning = false;
  }

  async _captureOnce() {
    const opts = {
      format: "jpeg",
      quality: JPEG_QUALITY,
    };
    if (!this._noOptimize) opts.optimizeForSpeed = true;
    try {
      return await this.cdp.send("Page.captureScreenshot", opts);
    } catch (err) {
      const msg = err && err.message ? err.message : "";
      if (!this._noOptimize && /optimizeForSpeed|Unknown.*parameter/i.test(msg)) {
        this._noOptimize = true;
        return this.cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: JPEG_QUALITY,
        });
      }
      throw err;
    }
  }

  async _captureLoop() {
    while (this._captureRunning && !this.closed) {
      if (this.clients.size === 0 || !this.cdp) {
        await delay(150);
        continue;
      }
      if (this._inputActive || Date.now() - this._lastInputAt < 50) {
        await delay(16);
        continue;
      }
      const started = Date.now();
      this._captureInFlight = true;
      try {
        const result = await this._captureOnce();
        if (result && result.data && !this._inputActive) {
          this._sendFrame(result.data, this.viewport.width, this.viewport.height);
        }
      } catch {
        await delay(80);
      } finally {
        this._captureInFlight = false;
      }
      const wait = FRAME_MIN_MS - (Date.now() - started);
      if (wait > 0) await delay(wait);
    }
  }

  _sendFrame(data, width, height) {
    if (!data || this.clients.size === 0) return false;
    let open = 0;
    let blocked = 0;
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        open += 1;
        if (ws.bufferedAmount >= WS_BACKPRESSURE) blocked += 1;
      }
    }
    if (!open || blocked === open) return false;
    this._lastFrameAt = Date.now();
    this._lastSentAt = this._lastFrameAt;
    this._timeouts = 0;
    if (!this._frameLogged) {
      this._frameLogged = true;
      console.log("[home-browser] streaming frames");
    }
    const payload = JSON.stringify({
      type: "frame",
      data,
      width: width || this.viewport.width,
      height: height || this.viewport.height,
    });
    for (const ws of this.clients) {
      if (ws.readyState === 1 && ws.bufferedAmount < WS_BACKPRESSURE) {
        ws.send(payload);
      }
    }
    return true;
  }

  _queueMeta() {
    if (this._metaTimer) return;
    this._metaTimer = setTimeout(() => {
      this._metaTimer = null;
      this._sendMeta().catch(() => {});
    }, 300);
  }

  async _sendMeta() {
    if (!this.page) return;
    let url = "about:blank";
    let title = "New Tab";
    try {
      url = this.page.url() || url;
      title = (await this.page.title()) || title;
    } catch {
      // ignore
    }
    if (!title) title = url && url !== "about:blank" ? url : "New Tab";
    this.lastMeta = { url, title };
    this.broadcast({ type: "meta", url, title });
  }

  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        try {
          ws.send(payload);
        } catch {
          // ignore
        }
      }
    }
  }

  addClient(ws) {
    this.clients.add(ws);
    if (this.lastMeta) {
      try {
        ws.send(JSON.stringify({ type: "meta", ...this.lastMeta }));
      } catch {
        // ignore
      }
    }
    this.ensure()
      .then(() => this._startCaptureLoop())
      .catch(() => {});
  }

  removeClient(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) this._stopCaptureLoop();
  }

  scalePoint(msg) {
    const vw = Number(msg.vw) || this.viewport.width;
    const vh = Number(msg.vh) || this.viewport.height;
    const x = (Number(msg.x) || 0) * (this.viewport.width / vw);
    const y = (Number(msg.y) || 0) * (this.viewport.height / vh);
    return {
      x: clamp(x, 0, this.viewport.width),
      y: clamp(y, 0, this.viewport.height),
    };
  }

  async navigate(rawUrl) {
    await this.ensure();
    const href = assertAllowedUrl(resolveUrl(rawUrl, this.homeUrl));
    try {
      await this.page.goto(href, { waitUntil: "domcontentloaded", timeout: 25000 });
    } catch (err) {
      if (!/timeout/i.test(err.message)) throw err;
    }
    await this._sendMeta();
    this._startCaptureLoop();
    return this.lastMeta;
  }

  async action(type) {
    await this.ensure();
    switch (type) {
      case "back":
        await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        break;
      case "forward":
        await this.page.goForward({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        break;
      case "reload":
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        break;
      case "home":
        await this.page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        break;
      default:
        throw new Error("Unknown action");
    }
    await this._sendMeta();
    this._startCaptureLoop();
    return this.lastMeta;
  }

  async resize(width, height) {
    const w = clamp(Math.round(Number(width) || DEFAULT_WIDTH), MIN_VIEW_W, MAX_VIEW_W);
    const h = clamp(Math.round(Number(height) || DEFAULT_HEIGHT), MIN_VIEW_H, MAX_VIEW_H);
    if (Math.abs(w - this.viewport.width) < 8 && Math.abs(h - this.viewport.height) < 8) return;
    this.viewport = { width: w, height: h };
    if (!this.page) return;
    try {
      await this.page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    } catch {
      return;
    }
  }

  handleInput(msg) {
    if (!this.ready || !msg || !msg.type) return Promise.resolve();
    if (msg.type === "resize") {
      return this.resize(msg.width, msg.height);
    }
    this._inputActive = true;
    this._lastInputAt = Date.now();
    if (msg.type === "mouse" && msg.action === "move") {
      this._pendingMove = msg;
    } else if (msg.type === "mouse" || msg.type === "wheel" || msg.type === "key" || msg.type === "paste") {
      this._pendingExtras.push(msg);
      if (this._pendingExtras.length > 64) this._pendingExtras.shift();
    }
    this._drainInput();
    return Promise.resolve();
  }

  async _drainInput() {
    if (this._inFlightInput) return;
    this._inFlightInput = true;
    this._inputActive = true;
    try {
      let waited = 0;
      while (this._captureInFlight && waited < 800) {
        await delay(8);
        waited += 8;
      }
      while (this._pendingExtras.length || this._pendingMove) {
        const extra = this._pendingExtras.shift();
        const next = extra || this._pendingMove;
        if (!extra) this._pendingMove = null;
        if (!next) break;
        try {
          await this._dispatch(next);
          this._timeouts = 0;
        } catch (err) {
          const timedOut = /timed out/i.test(err.message || "");
          if (timedOut) {
            this._timeouts += 1;
            this._pendingMove = null;
            this._pendingExtras.length = 0;
            if (this._timeouts >= 2) await this._recoverCdp();
            break;
          }
        }
      }
    } finally {
      this._lastInputAt = Date.now();
      this._inputActive = false;
      this._inFlightInput = false;
      if (this._pendingExtras.length || this._pendingMove) {
        setImmediate(() => this._drainInput());
      }
    }
  }

  async _dispatch(msg) {
    switch (msg.type) {
      case "mouse":
        await this._mouse(msg);
        break;
      case "wheel":
        await this._wheel(msg);
        break;
      case "key":
        await this._key(msg);
        break;
      case "paste":
        await this._paste(msg);
        break;
      default:
        break;
    }
  }

  async _mouse(msg) {
    const { x, y } = this.scalePoint(msg);
    const button = MOUSE_BUTTONS[msg.button] || "left";
    const clickCount = clamp(Math.round(Number(msg.clickCount) || 1), 1, 3);
    const modifiers = modifiersFrom(msg);
    const action = msg.action;
    let type = "mouseMoved";
    if (action === "down") type = "mousePressed";
    else if (action === "up") type = "mouseReleased";
    const params = {
      type,
      x,
      y,
      modifiers,
      button,
      clickCount: type === "mouseMoved" ? 0 : clickCount,
      pointerType: "mouse",
    };
    if (typeof msg.buttons === "number") params.buttons = msg.buttons;
    const sent = this.cdp.send("Input.dispatchMouseEvent", params);
    if (action === "move") {
      sent.catch(() => {});
      return;
    }
    await sent;
  }

  async _wheel(msg) {
    const { x, y } = this.scalePoint(msg);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      modifiers: modifiersFrom(msg),
      deltaX: Number(msg.deltaX) || 0,
      deltaY: Number(msg.deltaY) || 0,
      pointerType: "mouse",
    });
  }

  async _key(msg) {
    const key = String(msg.key ?? "");
    const code = String(msg.code ?? "");
    const vk = virtualKey(msg);
    const modifiers = modifiersFrom(msg);
    const isChar =
      key.length === 1 && !msg.ctrl && !msg.alt && !msg.meta;

    if (isChar) {
      if (msg.action === "up") return;
      await this.cdp.send("Input.insertText", { text: key });
      return;
    }

    if (msg.action === "up") {
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
      return;
    }

    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      autoRepeat: Boolean(msg.repeat),
    });

    if (key === "Enter") {
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "char",
        key,
        code,
        modifiers,
        text: "\r",
        unmodifiedText: "\r",
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
    }
  }

  async _paste(msg) {
    const text = String(msg.text ?? "");
    if (!text) return;
    await this.cdp.send("Input.insertText", { text });
  }

  async close() {
    this.closed = true;
    this._stopCaptureLoop();
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    await this._killBrowser();
  }
}

HomeBrowser.resolveUrl = resolveUrl;
HomeBrowser.findChrome = findChrome;

module.exports = { HomeBrowser, resolveUrl, findChrome };
