"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
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
const FRAME_MIN_MS = 80;

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
    this.inputCdp = null;
    this.paintCdp = null;
    this.clients = new Set();
    this.viewport = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    this.closed = false;
    this.launching = false;
    this.lastMeta = { url: "about:blank", title: "New Tab", epoch: 0 };
    this.epoch = 0;
    this._restartTimer = null;
    this._restartDelay = RESTART_DELAY_MS;
    this._captureRunning = false;
    this._capturing = false;
    this._navigating = false;
    this._frameLogged = false;
    this._pendingMove = null;
    this._pendingExtras = [];
    this._draining = false;
  }

  get ready() {
    return Boolean(this.page && this.browser);
  }

  get cdp() {
    return this.inputCdp;
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
      const headed = String(process.env.CHROME_HEADLESS || "1") === "0";
      const userDataDir =
        (process.env.CHROME_USER_DATA && process.env.CHROME_USER_DATA.trim()) ||
        path.join(os.tmpdir(), "home-browser-chrome");
      const args = [
        "--disable-dev-shm-usage",
        `--window-size=${this.viewport.width},${this.viewport.height}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--force-device-scale-factor=1",
        "--hide-crash-restore-bubble",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-blink-features=AutomationControlled",
        "--disable-popup-blocking",
      ];
      if (String(process.env.CHROME_NO_SANDBOX) === "1") {
        args.push("--no-sandbox", "--disable-setuid-sandbox");
      }

      console.log(
        `[home-browser] launching Chromium: ${executablePath} headless=${!headed}`
      );
      const launchOpts = {
        executablePath,
        headless: headed ? false : true,
        dumpio: false,
        protocolTimeout: 180000,
        userDataDir,
        ignoreDefaultArgs: ["--enable-automation"],
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
        this.inputCdp = null;
        this.paintCdp = null;
        this.browser = null;
        this._scheduleRestart();
      });

      this._listenTargets();
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
      this.inputCdp = null;
      this.paintCdp = null;
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

  async _detach(session) {
    if (!session) return;
    try {
      session.removeAllListeners();
      await session.detach();
    } catch {
      // ignore
    }
  }

  async _killBrowser() {
    this._stopCaptureLoop();
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    await this._detach(this.inputCdp);
    await this._detach(this.paintCdp);
    this.inputCdp = null;
    this.paintCdp = null;
    this._targetsBound = false;
    if (!browser) return;
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }

  _listenTargets() {
    if (!this.browser || this._targetsBound) return;
    this._targetsBound = true;
    this.browser.on("targetcreated", async (target) => {
      if (this.closed || target.type() !== "page") return;
      let page;
      try {
        page = await target.page();
      } catch {
        return;
      }
      if (!page || page === this.page) return;
      console.log("[home-browser] new window; switching view");
      await this._adoptPage(page).catch((err) => {
        console.error(`[home-browser] adopt page failed: ${err.message}`);
      });
    });
  }

  async _adoptPage(page) {
    const previous = this.page;
    if (previous && previous !== page) {
      previous.removeAllListeners("close");
      previous.removeAllListeners("error");
      previous.removeAllListeners("popup");
    }
    await this._bindPage(page);
    await this._sendMeta();
    if (this.clients.size > 0) this._startCaptureLoop();
  }

  async _bindPage(page) {
    this.page = page;
    await page.setViewport({
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    }).catch(() => {});

    page.on("close", () => {
      if (this.closed || this.page !== page) return;
      console.error("[home-browser] page closed; recreating");
      this._recreatePage().catch((err) => {
        console.error(`[home-browser] recreate page failed: ${err.message}`);
      });
    });
    page.on("error", (err) => {
      console.error(`[home-browser] page error: ${err.message}`);
    });
    page.on("popup", (popup) => {
      if (!popup || this.closed) return;
      console.log("[home-browser] popup; switching view");
      this._adoptPage(popup).catch((err) => {
        console.error(`[home-browser] popup adopt failed: ${err.message}`);
      });
    });

    await this._attachSessions(page);
  }

  async _attachSessions(page) {
    await this._detach(this.inputCdp);
    await this._detach(this.paintCdp);
    this.inputCdp = await page.createCDPSession();
    this.paintCdp = await page.createCDPSession();
    await this.inputCdp.send("Page.enable").catch(() => {});
    await this.paintCdp.send("Page.enable").catch(() => {});
  }

  async _recreatePage() {
    if (this.closed || !this.browser) return;
    this.page = null;
    this.inputCdp = null;
    this.paintCdp = null;
    const page = await this.browser.newPage();
    await this._bindPage(page);
    if (this.clients.size > 0) this._startCaptureLoop();
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

  async _captureLoop() {
    while (this._captureRunning && !this.closed) {
      if (this.clients.size === 0 || !this.paintCdp || this._navigating) {
        await delay(20);
        continue;
      }
      const epoch = this.epoch;
      this._capturing = true;
      const started = Date.now();
      try {
        const result = await this.paintCdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: JPEG_QUALITY,
        });
        if (
          result &&
          result.data &&
          !this._navigating &&
          epoch === this.epoch &&
          this.clients.size > 0
        ) {
          this._sendFrame(result.data, epoch);
        }
      } catch {
        if (!this._navigating && this.page && this._captureRunning) {
          await this._attachSessions(this.page).catch(() => {});
        }
        await delay(60);
      } finally {
        this._capturing = false;
      }
      const wait = FRAME_MIN_MS - (Date.now() - started);
      if (wait > 0) await delay(wait);
    }
  }

  _sendFrame(data, epoch) {
    if (!data || this.clients.size === 0) return;
    if (!this._frameLogged) {
      this._frameLogged = true;
      console.log("[home-browser] streaming frames");
    }
    const payload = JSON.stringify({
      type: "frame",
      data,
      width: this.viewport.width,
      height: this.viewport.height,
      epoch: epoch == null ? this.epoch : epoch,
    });
    for (const ws of this.clients) {
      if (ws.readyState === 1 && ws.bufferedAmount < WS_BACKPRESSURE) {
        ws.send(payload);
      }
    }
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

  async _sendMeta() {
    if (!this.page) return this.lastMeta;
    let url = "about:blank";
    let title = "New Tab";
    try {
      url = this.page.url() || url;
      title = (await this.page.title()) || title;
    } catch {
      // ignore
    }
    if (!title) title = url && url !== "about:blank" ? url : "New Tab";
    this.lastMeta = { url, title, epoch: this.epoch };
    this.broadcast({ type: "meta", url, title, epoch: this.epoch });
    return this.lastMeta;
  }

  addClient(ws) {
    this.clients.add(ws);
    try {
      ws.send(JSON.stringify({ type: "meta", ...this.lastMeta }));
    } catch {
      // ignore
    }
    this.ensure()
      .then(() => this._startCaptureLoop())
      .catch(() => {});
  }

  removeClient(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) this._stopCaptureLoop();
  }

  async _runNavigation(fn, pendingUrl) {
    await this.ensure();
    this.epoch += 1;
    this._navigating = true;
    this.broadcast({
      type: "navigating",
      epoch: this.epoch,
      url: pendingUrl || "",
    });

    let waited = 0;
    while (this._capturing && waited < 600) {
      await delay(10);
      waited += 10;
    }
    if (this._capturing && this.page) {
      await this._attachSessions(this.page).catch(() => {});
    }

    let meta = this.lastMeta;
    try {
      await fn();
    } finally {
      meta = await this._sendMeta();
      this._navigating = false;
      this._startCaptureLoop();
    }
    return meta;
  }

  async navigate(rawUrl) {
    const href = assertAllowedUrl(resolveUrl(rawUrl, this.homeUrl));
    return this._runNavigation(async () => {
      try {
        await this.page.goto(href, { waitUntil: "domcontentloaded", timeout: 25000 });
      } catch (err) {
        if (!/timeout/i.test(err.message || "")) throw err;
      }
    }, href);
  }

  async action(type) {
    return this._runNavigation(async () => {
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
          await this.page.goto(this.homeUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
          break;
        default:
          throw new Error("Unknown action");
      }
    }, type === "home" ? this.homeUrl : this.lastMeta.url);
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
      // ignore
    }
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

  handleInput(msg) {
    if (!this.ready || this._navigating || !msg || !msg.type) return Promise.resolve();
    if (msg.type === "resize") return this.resize(msg.width, msg.height);
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
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._pendingExtras.length || this._pendingMove) {
        if (this._navigating || !this.inputCdp) break;
        const extra = this._pendingExtras.shift();
        const next = extra || this._pendingMove;
        if (!extra) this._pendingMove = null;
        if (!next) break;
        try {
          await this._dispatch(next);
        } catch {
          this._pendingMove = null;
          this._pendingExtras.length = 0;
          if (this.page) await this._attachSessions(this.page).catch(() => {});
          break;
        }
      }
    } finally {
      this._draining = false;
      if ((this._pendingExtras.length || this._pendingMove) && !this._navigating) {
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
    const action = msg.action;
    let type = "mouseMoved";
    if (action === "down") type = "mousePressed";
    else if (action === "up") type = "mouseReleased";
    const params = {
      type,
      x,
      y,
      modifiers: modifiersFrom(msg),
      button,
      clickCount: type === "mouseMoved" ? 0 : clickCount,
      pointerType: "mouse",
    };
    if (typeof msg.buttons === "number") params.buttons = msg.buttons;
    const sent = this.inputCdp.send("Input.dispatchMouseEvent", params);
    if (action === "move") {
      sent.catch(() => {});
      return;
    }
    await sent;
  }

  async _wheel(msg) {
    const { x, y } = this.scalePoint(msg);
    await this.inputCdp.send("Input.dispatchMouseEvent", {
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
    const isChar = key.length === 1 && !msg.ctrl && !msg.alt && !msg.meta;

    if (isChar) {
      if (msg.action === "up") return;
      await this.inputCdp.send("Input.insertText", { text: key });
      return;
    }

    if (msg.action === "up") {
      await this.inputCdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
      return;
    }

    await this.inputCdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      autoRepeat: Boolean(msg.repeat),
    });

    if (key === "Enter") {
      await this.inputCdp.send("Input.dispatchKeyEvent", {
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
    await this.inputCdp.send("Input.insertText", { text });
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
