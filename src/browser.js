"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_VIEW_W = 360;
const MIN_VIEW_H = 300;
const MAX_VIEW_W = 1920;
const MAX_VIEW_H = 1080;
const RESTART_DELAY_MS = 1500;
const WS_BACKPRESSURE = 1_500_000;
// A frame is only handed to a socket that has (nearly) finished sending the last one.
const FRAME_BACKLOG_MIN = 48 * 1024;
const FRAME_DRAIN_MS = 8;
const COMMIT_FALLBACK_MS = 20_000;
const NAVIGATE_REPLY_MS = 3_000;
const META_POLL_MS = 1_000;
const INPUT_QUEUE_MAX = 128;

const crypto = require("crypto");
const { AudioStreamer, AUDIO_FORMATS } = require("./audio");
const { AdBlocker } = require("./adblock");

const FRAME_TYPE = 1;
const FRAME_HEADER_BYTES = 9;

const JPEG_QUALITY = clamp(Number(process.env.JPEG_QUALITY) || 60, 20, 100);
const META_AS_CTRL = process.platform !== "darwin";

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

// Runs in the remote page. Reports fullscreen changes through a CDP binding, which it
// removes from `window` straight away so pages cannot see it. Re-runnable: a fresh CDP
// session (tab switch) brings a fresh binding, and the old listener is swapped out.
function hookFullscreen(name) {
  const report = window[name];
  if (typeof report !== "function") return Boolean(document.fullscreenElement);
  delete window[name];
  const key = Symbol.for(name);
  if (document[key]) document.removeEventListener("fullscreenchange", document[key], true);
  const handler = () => {
    try {
      report(document.fullscreenElement ? "1" : "0");
    } catch {
      // the session that owned this binding is gone
    }
  };
  Object.defineProperty(document, key, { value: handler, configurable: true });
  document.addEventListener("fullscreenchange", handler, true);
  return Boolean(document.fullscreenElement);
}

function userDataDir() {
  return (
    (process.env.CHROME_USER_DATA && process.env.CHROME_USER_DATA.trim()) ||
    path.join(os.tmpdir(), "home-browser-chrome")
  );
}

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

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

const DEFAULT_SEARCH_URL = "https://www.google.com/search?q=%s";

function resolveUrl(input, homeUrl, searchUrl) {
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
    return (searchUrl || DEFAULT_SEARCH_URL).replace("%s", encodeURIComponent(raw));
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

// Binary frame: [type u8][epoch u32][width u16][height u16][jpeg bytes]
function encodeFrame(jpeg, epoch, width, height) {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt8(FRAME_TYPE, 0);
  header.writeUInt32BE(Math.max(0, epoch) >>> 0, 1);
  header.writeUInt16BE(clamp(Math.round(width) || 0, 0, 0xffff), 5);
  header.writeUInt16BE(clamp(Math.round(height) || 0, 0, 0xffff), 7);
  return Buffer.concat([header, jpeg]);
}

function decodeFrameHeader(buf) {
  if (!buf || buf.length < FRAME_HEADER_BYTES || buf.readUInt8(0) !== FRAME_TYPE) return null;
  return {
    epoch: buf.readUInt32BE(1),
    width: buf.readUInt16BE(5),
    height: buf.readUInt16BE(7),
    offset: FRAME_HEADER_BYTES,
  };
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

const NAMED_VK = {
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

const CODE_VK = {
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumpadEnter: 13,
};

function virtualKey(msg) {
  if (Number.isFinite(msg.keyCode) && msg.keyCode > 0 && msg.keyCode !== 229) return msg.keyCode;
  const key = msg.key || "";
  const code = msg.code || "";
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(6));
  if (CODE_VK[code] != null) return CODE_VK[code];
  if (NAMED_VK[key] != null) return NAMED_VK[key];
  if (/^[a-zA-Z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  return 0;
}

function editingCommand(key, shift) {
  const k = String(key || "").toLowerCase();
  if (k === "a") return "selectAll";
  if (k === "c") return "copy";
  if (k === "x") return "cut";
  if (k === "v") return "paste";
  if (k === "z") return shift ? "redo" : "undo";
  if (k === "y") return "redo";
  return null;
}

// Build real keyDown/keyUp CDP events (like a physical keyboard) for a client key message.
// Returns null for keys that cannot be represented (IME "Process", "Unidentified", ...).
function keyEvents(msg, opts = {}) {
  const metaAsCtrl = opts.metaAsCtrl == null ? META_AS_CTRL : opts.metaAsCtrl;
  const key = String(msg.key ?? "");
  const code = String(msg.code ?? "");
  if (!key || key === "Unidentified" || key === "Process" || key === "Dead") return null;

  let ctrl = Boolean(msg.ctrl);
  let meta = Boolean(msg.meta);
  if (meta && metaAsCtrl) {
    ctrl = true;
    meta = false;
  }
  const alt = Boolean(msg.alt);
  const shift = Boolean(msg.shift);
  const modifiers = modifiersFrom({ alt, ctrl, meta, shift });
  const plain = !ctrl && !alt && !meta;
  const printable =
    plain && (key.length === 1 || (key.length === 2 && /[\uD800-\uDBFF]/.test(key[0])));

  let text = "";
  if (printable) text = key;
  else if (key === "Enter" && !alt && !meta && !ctrl) text = "\r";

  const vk = virtualKey({ ...msg, key, code });
  if (!printable && vk === 0 && key.length > 1) return null;

  const base = {
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    // No nativeVirtualKeyCode. With it, Chromium treats the event as a native one and,
    // when the page's handler changes the window state — YouTube's "f" for fullscreen —
    // re-injects it in a loop: hundreds of keydowns from a single press. Puppeteer
    // leaves it out for the same reason.
  };
  const down = {
    ...base,
    type: text ? "keyDown" : "rawKeyDown",
    autoRepeat: Boolean(msg.repeat),
  };
  if (text) {
    down.text = text;
    down.unmodifiedText = text;
  }
  if ((ctrl || meta) && !alt && process.platform === "darwin") {
    const cmd = editingCommand(key, shift);
    if (cmd) down.commands = [cmd];
  }
  const up = { ...base, type: "keyUp" };
  return { down, up, printable };
}

function buildUaOverride(ua) {
  const full = (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || "120.0.0.0";
  const major = full.split(".")[0];
  const platform =
    process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  const platformVersion = platform === "Linux" ? "6.1.0" : platform === "macOS" ? "14.0.0" : "10.0.0";
  const brands = [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not?A_Brand", version: "8" },
  ];
  return {
    ua: ua.replace(/HeadlessChrome/g, "Chrome"),
    metadata: {
      brands,
      fullVersionList: brands.map((b) => ({
        brand: b.brand,
        version: b.brand.startsWith("Not") ? "8.0.0.0" : full,
      })),
      fullVersion: full,
      platform,
      platformVersion,
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
  };
}

function isSessionGone(err) {
  return /closed|detached|disconnected/i.test((err && err.message) || "");
}

class HomeBrowser {
  constructor({ homeUrl }) {
    this.homeUrl = homeUrl || "https://www.google.com/";
    this.searchUrl = DEFAULT_SEARCH_URL;
    this.jpegQuality = JPEG_QUALITY;
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
    this.headed = String(process.env.CHROME_HEADLESS || "1") === "0";
    this._restartTimer = null;
    this._restartDelay = RESTART_DELAY_MS;
    this._targetsBound = false;
    this._screencastOn = false;
    this._frameLogged = false;
    this._pendingMove = null;
    this._pendingExtras = [];
    this._draining = false;
    this._commitPending = false;
    this._commitTimer = null;
    this._prevEpoch = 0;
    this._metaTimer = null;
    this._metaPoll = null;
    this._uaOverride = null;
    this._pendingUrl = "";
    this._lastMouse = { x: -1, y: -1 };
    this._tabIds = new WeakMap();
    this._tabSeq = 0;
    this._tabsTimer = null;
    this._adoptChain = Promise.resolve();
    this._lastActive = null;
    this.audioEnabled = String(process.env.AUDIO || "1") !== "0";
    this._audio = {};
    this.remoteFullscreen = false;
    this._fsBinding = `__f${crypto.randomBytes(9).toString("hex")}`;
    this._fsHooked = new WeakSet();
    this.adblock = new AdBlocker({
      // Lives inside the Chrome profile so it shares its volume/persistence.
      dataDir: path.join(userDataDir(), "perch-adblock"),
      getActivePage: () => this.page,
      getPages: () => this._openPages(),
      onChange: () => this._broadcastAdblock(),
    });
  }

  get ready() {
    return Boolean(this.page && this.browser && this.inputCdp);
  }

  get cdp() {
    return this.inputCdp;
  }

  async ensure() {
    if (this.ready) return;
    if (this.launching) {
      for (let i = 0; i < 300 && this.launching; i += 1) await delay(100);
      if (this.ready) return;
    }
    await this.launch();
  }

  async launch() {
    if (this.closed || this.launching) return;
    this.launching = true;
    try {
      await this._killBrowser();
      const executablePath = findChrome();
      // Headed (Xvfb) mode: make the real window as large as the biggest viewport we
      // allow so the emulated viewport always fits inside it.
      const winW = this.headed ? MAX_VIEW_W : this.viewport.width;
      const winH = this.headed ? MAX_VIEW_H : this.viewport.height;
      const args = [
        "--disable-dev-shm-usage",
        `--window-size=${winW},${winH}`,
        "--window-position=0,0",
        "--no-first-run",
        "--no-default-browser-check",
        "--force-device-scale-factor=1",
        "--hide-crash-restore-bubble",
        "--disable-session-crashed-bubble",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=BackForwardCache",
        "--disable-popup-blocking",
        "--disable-infobars",
        "--noerrdialogs",
        "--lang=en-US,en",
      ];
      if (String(process.env.CHROME_NO_SANDBOX) === "1") {
        args.push("--no-sandbox", "--disable-setuid-sandbox");
      }

      console.log(
        `[home-browser] launching Chromium: ${executablePath} headless=${!this.headed}`
      );
      const launchOpts = {
        executablePath,
        headless: this.headed ? false : true,
        dumpio: false,
        protocolTimeout: 30_000,
        userDataDir: userDataDir(),
        // --enable-automation is the flag that makes navigator.webdriver true and
        // shows the "controlled by automated software" bar; hidden scrollbars are a
        // headless fingerprint and hide where you are on the page.
        ignoreDefaultArgs: ["--enable-automation", "--hide-scrollbars"],
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
        this._resetHandles();
        this._scheduleRestart();
      });

      this._uaOverride = null;
      if (!this.headed) {
        const ua = await this.browser.userAgent().catch(() => "");
        if (/HeadlessChrome/.test(ua)) this._uaOverride = buildUaOverride(ua);
      }

      this._listenTargets();
      const pages = await this.browser.pages();
      const page = pages[0] || (await this.browser.newPage());
      this.adblock.reset();
      // Filter lists may need downloading on first use; never hold the launch for that.
      this.adblock.start().catch(() => {});
      await this._bindPage(page);
      await this._sendMeta(true);
      if (this.clients.size > 0) {
        await this._startScreencast();
        this._snapshot();
      }
      this._startMetaPoll();
      this._restartDelay = RESTART_DELAY_MS;
      console.log("[home-browser] Chromium ready");
    } catch (err) {
      console.error(`[home-browser] Chromium launch failed: ${err.message}`);
      this._resetHandles();
      this._scheduleRestart();
      throw err;
    } finally {
      this.launching = false;
    }
  }

  _resetHandles() {
    this.page = null;
    this.inputCdp = null;
    this.paintCdp = null;
    this.browser = null;
    this._screencastOn = false;
    this._targetsBound = false;
  }

  _scheduleRestart() {
    if (this.closed || this._restartTimer) return;
    const wait = this._restartDelay;
    this._restartDelay = Math.min(Math.round(this._restartDelay * 1.6), 15000);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.launch().catch(() => {});
    }, wait);
  }

  async _detach(session) {
    if (!session) return;
    try {
      session.removeAllListeners();
      await withTimeout(session.detach(), 2000, null);
    } catch {
      // ignore
    }
  }

  async _killBrowser() {
    this._stopMetaPoll();
    const browser = this.browser;
    const input = this.inputCdp;
    const paint = this.paintCdp;
    this._resetHandles();
    await this._detach(input);
    await this._detach(paint);
    if (!browser) return;
    try {
      await withTimeout(browser.close(), 5000, null);
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
      if (!page || page === this.page || page.isClosed()) return;
      // Ad pop-ups/pop-unders are closed here, before they can steal the view.
      if (await this.adblock.screenPopup(target, page).catch(() => false)) return;
      if (page.isClosed()) return;
      console.log("[home-browser] new window/tab; switching view");
      await this._adoptPage(page).catch((err) => {
        console.error(`[home-browser] adopt page failed: ${err.message}`);
      });
    });
    this.browser.on("targetdestroyed", () => this._scheduleTabs());
    this.browser.on("targetchanged", () => this._scheduleTabs());
  }

  // ——— tabs ———

  _tabId(page) {
    let id = this._tabIds.get(page);
    if (!id) {
      this._tabSeq += 1;
      id = `t${this._tabSeq}`;
      this._tabIds.set(page, id);
    }
    return id;
  }

  async _openPages() {
    if (!this.browser) return [];
    try {
      return (await this.browser.pages()).filter((p) => !p.isClosed());
    } catch {
      return [];
    }
  }

  async _pageById(id) {
    const pages = await this._openPages();
    return pages.find((p) => this._tabId(p) === id) || null;
  }

  async listTabs() {
    const pages = await this._openPages();
    const tabs = await Promise.all(
      pages.map(async (p) => {
        let url = "about:blank";
        try {
          url = p.url() || url;
        } catch {
          // ignore
        }
        let title = "";
        if (p === this.page) {
          // The active page already has fresh meta; do not evaluate against it mid-load.
          url = this.lastMeta.url;
          title = this.lastMeta.title;
        } else {
          // Chrome's cached target title is unreliable for background pages, so read the
          // document title directly (short timeout so a hung tab never stalls the list).
          try {
            title = (await withTimeout(p.title(), 700, "")) || "";
          } catch {
            // ignore
          }
        }
        if (!title || title === url) {
          if (url === "about:blank") title = "New Tab";
          else {
            try {
              title = new URL(url).hostname || url;
            } catch {
              title = url;
            }
          }
        }
        return { id: this._tabId(p), url, title, active: p === this.page };
      })
    );
    return { tabs, active: this.page ? this._tabId(this.page) : null };
  }

  _scheduleTabs() {
    if (this._tabsTimer || this.closed) return;
    this._tabsTimer = setTimeout(() => {
      this._tabsTimer = null;
      this._broadcastTabs().catch(() => {});
    }, 150);
  }

  async _broadcastTabs(only) {
    if (!this.browser) return;
    const payload = JSON.stringify({ type: "tabs", ...(await this.listTabs()) });
    for (const ws of only ? [only] : this.clients) {
      if (ws.readyState === 1) {
        try {
          ws.send(payload);
        } catch {
          // ignore
        }
      }
    }
  }

  async newTab(rawUrl) {
    await this.ensure();
    const href = rawUrl ? assertAllowedUrl(resolveUrl(rawUrl, this.homeUrl, this.searchUrl)) : "";
    const page = await this.browser.newPage();
    await this._adoptPage(page);
    if (href) return this._navigateTo(href);
    return this._sendMeta(true);
  }

  async switchTab(id) {
    await this.ensure();
    const page = await this._pageById(id);
    if (!page) throw new Error("No such tab");
    if (page !== this.page) await this._adoptPage(page);
    return this._sendMeta(true);
  }

  async closeTab(id) {
    await this.ensure();
    const page = await this._pageById(id);
    if (!page) throw new Error("No such tab");
    const pages = await this._openPages();
    if (pages.length === 1) {
      // Never leave the browser without a tab: open a fresh one first, it becomes the view.
      await this.browser.newPage();
    }
    await page.close().catch(() => {});
    this._scheduleTabs();
    return this._sendMeta(true);
  }

  _unbindPage(page) {
    if (!page) return;
    for (const ev of ["close", "error", "dialog", "framenavigated", "load", "domcontentloaded"]) {
      page.removeAllListeners(ev);
    }
  }

  // View switches are serialized: newTab() and the targetcreated listener may both ask
  // to adopt the same page, and the second request must become a no-op.
  _adoptPage(page) {
    const run = () => this._doAdopt(page);
    this._adoptChain = this._adoptChain.then(run, run);
    return this._adoptChain;
  }

  async _doAdopt(page) {
    if (this.closed || !page || page.isClosed() || page === this.page) return;
    const previous = this.page;
    if (previous && previous !== page) {
      this._unbindPage(previous);
      this._lastActive = previous;
    }
    this._beginNav(page.url());
    await this._bindPage(page);
    this._commitDone();
    await this._sendMeta(true);
    this._scheduleTabs();
  }

  async _bindPage(page) {
    this._unbindPage(page);
    this.page = page;
    await page
      .setViewport({
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: 1,
      })
      .catch(() => {});
    if (this._uaOverride) {
      await page.setUserAgent(this._uaOverride.ua, this._uaOverride.metadata).catch(() => {});
    }

    page.on("close", () => {
      if (this.closed || this.page !== page) return;
      console.log("[home-browser] page closed; switching to another tab");
      this._switchAway(page).catch((err) => {
        console.error(`[home-browser] switch tab failed: ${err.message}`);
      });
    });
    page.on("error", (err) => {
      console.error(`[home-browser] page error: ${err.message}`);
    });
    page.on("dialog", (dialog) => {
      this._handleDialog(dialog).catch(() => {});
    });
    page.on("framenavigated", (frame) => {
      if (this.page !== page) return;
      if (frame === page.mainFrame()) {
        this._commitDone();
        this._scheduleMeta();
        // A new document is never fullscreen, and no fullscreenchange fires for it.
        this._setRemoteFullscreen(false);
      }
    });
    page.on("load", () => {
      if (this.page === page) this._scheduleMeta();
    });
    page.on("domcontentloaded", () => {
      if (this.page === page) this._scheduleMeta();
    });

    await page.bringToFront().catch(() => {});
    await this.adblock.attach(page);
    await this._attachSessions(page);
    this._broadcastAdblock();
  }

  async _attachSessions(page) {
    await this._stopScreencast();
    const oldInput = this.inputCdp;
    const oldPaint = this.paintCdp;
    this.inputCdp = null;
    this.paintCdp = null;
    await this._detach(oldInput);
    await this._detach(oldPaint);
    if (this.page !== page || page.isClosed()) return;

    const input = await page.createCDPSession();
    const paint = await page.createCDPSession();
    this.inputCdp = input;
    this.paintCdp = paint;
    await input.send("Page.enable").catch(() => {});
    await paint.send("Page.enable").catch(() => {});
    // Downloads are useless on a remote box and can leave a navigation hanging.
    await input.send("Page.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    // Pages should believe they are the focused window even in headless mode.
    await input.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    paint.on("Page.screencastFrame", (ev) => this._onScreencastFrame(paint, ev));
    await this._watchFullscreen(page, input).catch(() => {});
    if (this.clients.size > 0) await this._startScreencast();
  }

  // ——— fullscreen ———
  //
  // A video's fullscreen button only makes it fill the *remote* view; the device in the
  // user's hand knows nothing about it. So the remote page reports the change here and
  // every client mirrors it (real fullscreen where the browser allows, chrome hidden
  // everywhere else).
  async _watchFullscreen(page, session) {
    await session.send("Runtime.enable");
    await session.send("Runtime.addBinding", { name: this._fsBinding });
    session.on("Runtime.bindingCalled", (ev) => {
      if (ev.name !== this._fsBinding || this.inputCdp !== session) return;
      this._setRemoteFullscreen(ev.payload === "1");
    });
    if (!this._fsHooked.has(page)) {
      this._fsHooked.add(page);
      await page.evaluateOnNewDocument(hookFullscreen, this._fsBinding);
    }
    const on = await page.evaluate(hookFullscreen, this._fsBinding).catch(() => false);
    this._setRemoteFullscreen(Boolean(on));
  }

  _setRemoteFullscreen(on) {
    if (this.remoteFullscreen === on) return;
    this.remoteFullscreen = on;
    this.broadcast({ type: "fullscreen", on });
  }

  // The user left fullscreen locally (Esc, the system gesture, the back button): the
  // remote page has to follow, or its player stays in fullscreen layout.
  async exitRemoteFullscreen() {
    if (!this.page || !this.remoteFullscreen) return;
    await this.page
      .evaluate(() => (document.fullscreenElement ? document.exitFullscreen() : undefined))
      .catch(() => {});
  }

  async _switchAway(closedPage) {
    if (this.closed || !this.browser) return;
    let next = null;
    try {
      const pages = await this.browser.pages();
      const open = pages.filter((p) => p !== closedPage && !p.isClosed());
      // Prefer the tab that was active before this one (the opener of a popup).
      if (this._lastActive && open.includes(this._lastActive)) next = this._lastActive;
      else next = open[open.length - 1] || null;
    } catch {
      // ignore
    }
    if (!next) {
      try {
        next = await this.browser.newPage();
      } catch (err) {
        console.error(`[home-browser] new page failed: ${err.message}`);
        return;
      }
    }
    await this._adoptPage(next);
  }

  async _handleDialog(dialog) {
    const type = dialog.type();
    const message = String(dialog.message() || "").slice(0, 200);
    console.log(`[home-browser] dialog (${type}) auto-handled: ${message}`);
    this.broadcast({ type: "status", text: `${type}: ${message || "(no message)"}` });
    try {
      if (type === "prompt") await dialog.dismiss();
      else await dialog.accept();
    } catch {
      // ignore
    }
  }

  // ——— frames ———

  async _startScreencast() {
    if (!this.paintCdp || this._screencastOn || this.clients.size === 0) return;
    this._screencastOn = true;
    try {
      await this.paintCdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.jpegQuality,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1,
      });
    } catch (err) {
      this._screencastOn = false;
      console.error(`[home-browser] startScreencast: ${err.message}`);
    }
  }

  async _stopScreencast() {
    if (!this._screencastOn) return;
    this._screencastOn = false;
    if (!this.paintCdp) return;
    await withTimeout(this.paintCdp.send("Page.stopScreencast"), 2000, null).catch(() => {});
  }

  async _restartScreencast() {
    await this._stopScreencast();
    await this._startScreencast();
  }

  _frameEpoch() {
    return this._commitPending ? this._prevEpoch : this.epoch;
  }

  _onScreencastFrame(session, ev) {
    session.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
    if (session !== this.paintCdp || this.clients.size === 0 || !ev.data) return;
    const meta = ev.metadata || {};
    this._sendFrame(
      Buffer.from(ev.data, "base64"),
      this._frameEpoch(),
      meta.deviceWidth || this.viewport.width,
      meta.deviceHeight || this.viewport.height
    );
  }

  // One-off full frame, for a client that just connected or right after a navigation
  // commit (the screencast only emits when pixels change).
  async _snapshot(target) {
    if (!this.paintCdp) return;
    const epoch = this._frameEpoch();
    try {
      const result = await withTimeout(
        this.paintCdp.send("Page.captureScreenshot", { format: "jpeg", quality: this.jpegQuality }),
        5000,
        null
      );
      if (!result || !result.data) return;
      this._sendFrame(
        Buffer.from(result.data, "base64"),
        epoch,
        this.viewport.width,
        this.viewport.height,
        target
      );
    } catch {
      // ignore
    }
  }

  _sendFrame(jpeg, epoch, width, height, only) {
    if (!jpeg || this.clients.size === 0) return;
    if (!this._frameLogged) {
      this._frameLogged = true;
      console.log("[home-browser] streaming frames");
    }
    const payload = encodeFrame(jpeg, epoch, width, height);
    const targets = only ? [only] : this.clients;
    for (const ws of targets) this._offerFrame(ws, payload);
  }

  // Latest frame wins, per client. Queuing frames behind a slow link (phone on mobile
  // data) is what turns a slow connection into a laggy one: every queued frame is an
  // old picture that still has to be delivered before the current one. So while a
  // socket is still busy, only the newest frame is kept, and it goes out the moment the
  // socket drains. Fast links never hit this path.
  _offerFrame(ws, payload) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > Math.max(FRAME_BACKLOG_MIN, payload.length)) {
      ws._heldFrame = payload;
      this._armFrameDrain(ws);
      return;
    }
    ws._heldFrame = null;
    try {
      ws.send(payload, { binary: true });
    } catch {
      // ignore
    }
  }

  _armFrameDrain(ws) {
    if (ws._frameDrain) return;
    ws._frameDrain = setInterval(() => {
      const held = ws._heldFrame;
      if (ws.readyState !== 1 || !held) {
        clearInterval(ws._frameDrain);
        ws._frameDrain = null;
        ws._heldFrame = null;
        return;
      }
      if (ws.bufferedAmount > FRAME_BACKLOG_MIN) return;
      ws._heldFrame = null;
      try {
        ws.send(held, { binary: true });
      } catch {
        // ignore
      }
    }, FRAME_DRAIN_MS);
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

  // ——— meta (url/title) ———

  _scheduleMeta() {
    if (this._metaTimer) return;
    this._metaTimer = setTimeout(() => {
      this._metaTimer = null;
      this._sendMeta(false).catch(() => {});
    }, 120);
  }

  _startMetaPoll() {
    this._stopMetaPoll();
    this._metaPoll = setInterval(() => {
      if (this.clients.size === 0 || !this.page) return;
      this._sendMeta(false).catch(() => {});
    }, META_POLL_MS);
    this._metaPoll.unref();
  }

  _stopMetaPoll() {
    if (this._metaPoll) clearInterval(this._metaPoll);
    this._metaPoll = null;
  }

  async _sendMeta(force = true) {
    const page = this.page;
    if (!page) return this.lastMeta;
    let url = "about:blank";
    let title = "";
    try {
      url = page.url() || url;
    } catch {
      // ignore
    }
    if (this._commitPending && this._pendingUrl && this._pendingUrl !== "about:blank") {
      // The new document has not committed yet: report where we are going, not where we were.
      url = this._pendingUrl;
      title = "Loading…";
    } else {
      try {
        // During a load the execution context is not there yet; do not wait on it,
        // the meta poll will pick the title up as soon as it exists.
        title = (await withTimeout(page.title(), 400, "")) || "";
      } catch {
        // ignore
      }
    }
    if (!title) {
      title = url === this.lastMeta.url && this.lastMeta.title
        ? this.lastMeta.title
        : url !== "about:blank" ? url : "New Tab";
    }
    const changed =
      url !== this.lastMeta.url || title !== this.lastMeta.title || this.epoch !== this.lastMeta.epoch;
    this.lastMeta = { url, title, epoch: this.epoch };
    if (force || changed) this.broadcast({ type: "meta", ...this.lastMeta });
    if (changed) this._scheduleTabs();
    return this.lastMeta;
  }

  // ——— clients ———

  addClient(ws) {
    this.clients.add(ws);
    try {
      ws.send(JSON.stringify({ type: "meta", ...this.lastMeta }));
      ws.send(JSON.stringify({ type: "adblock", ...this.adblock.state(this.page) }));
      if (this.remoteFullscreen) ws.send(JSON.stringify({ type: "fullscreen", on: true }));
    } catch {
      // ignore
    }
    this.ensure()
      .then(async () => {
        await this._broadcastTabs(ws);
        await this._startScreencast();
        await this._snapshot(ws);
      })
      .catch(() => {});
  }

  removeClient(ws) {
    this.clients.delete(ws);
    clearInterval(ws._frameDrain);
    ws._frameDrain = null;
    ws._heldFrame = null;
    if (this.clients.size === 0) this._stopScreencast().catch(() => {});
    this._syncAudio();
  }

  // ——— settings ———

  // Applies the parts of the user's settings that live in this process.
  applySettings({ homeUrl, searchUrl, quality }) {
    if (homeUrl) this.homeUrl = homeUrl;
    if (searchUrl) this.searchUrl = searchUrl;
    const q = clamp(Number(quality) || this.jpegQuality, 20, 100);
    if (q !== this.jpegQuality) {
      this.jpegQuality = q;
      if (this._screencastOn) this._restartScreencast().catch(() => {});
    }
  }

  // ——— ad blocker ———

  _broadcastAdblock() {
    this.broadcast({ type: "adblock", ...this.adblock.state(this.page) });
  }

  // The switch is global (one Chromium, shared by every client). The active tab is
  // reloaded so the change is visible at once; other tabs pick it up as they navigate.
  async setAdblock(enabled) {
    const wasOn = this.adblock.state().status === "on";
    await this.adblock.setEnabled(enabled);
    this._broadcastAdblock();
    const isOn = this.adblock.state().status === "on";
    if (isOn === wasOn || !this.ready) return;
    if (/^https?:/i.test(this.lastMeta.url || "")) await this.action("reload").catch(() => {});
  }

  // ——— audio ———

  // A client opts in with { type: "audio", format: "opus" | "pcm" } and out with
  // format null. ffmpeg runs only while somebody is listening.
  _setClientAudio(ws, format) {
    const want = this.audioEnabled && AUDIO_FORMATS.includes(format) ? format : null;
    if (ws.audioFormat === want) return;
    ws.audioFormat = want;
    this._syncAudio();
  }

  _syncAudio() {
    for (const format of AUDIO_FORMATS) {
      let wanted = false;
      for (const ws of this.clients) {
        if (ws.audioFormat === format && ws.readyState === 1) {
          wanted = true;
          break;
        }
      }
      let streamer = this._audio[format];
      if (wanted && !streamer) {
        streamer = new AudioStreamer({ format });
        streamer.on("packet", (payload) => this._sendAudio(format, payload));
        this._audio[format] = streamer;
      }
      if (!streamer) continue;
      if (wanted) streamer.start();
      else streamer.stop();
    }
  }

  _sendAudio(format, payload) {
    for (const ws of this.clients) {
      if (ws.audioFormat !== format || ws.readyState !== 1) continue;
      // Under backpressure drop audio rather than queue it: stale sound is worse than a gap.
      if (ws.bufferedAmount >= WS_BACKPRESSURE) continue;
      try {
        ws.send(payload, { binary: true });
      } catch {
        // ignore
      }
    }
  }

  get audioActive() {
    return Object.values(this._audio).some((a) => a.running);
  }

  // ——— navigation ———

  // Bump the epoch: frames of the old document are tagged with the old epoch until the
  // main frame commits, so clients never paint stale content after a URL change.
  _beginNav(url) {
    this._prevEpoch = this.epoch;
    this._pendingUrl = url || "";
    this.epoch += 1;
    this._commitPending = true;
    if (this._commitTimer) clearTimeout(this._commitTimer);
    this._commitTimer = setTimeout(() => this._commitDone(), COMMIT_FALLBACK_MS);
    this.broadcast({ type: "navigating", epoch: this.epoch, url: url || "" });
  }

  _commitDone() {
    if (!this._commitPending) return;
    this._commitPending = false;
    this._pendingUrl = "";
    if (this._commitTimer) clearTimeout(this._commitTimer);
    this._commitTimer = null;
    this._snapshot();
  }

  async _navigateTo(href) {
    const cdp = this.inputCdp;
    this._beginNav(href);
    const nav = cdp
      .send("Page.navigate", { url: href })
      .then((r) => {
        if (r && r.errorText) {
          this._commitDone();
          if (!/ERR_ABORTED/i.test(r.errorText)) {
            this.broadcast({ type: "status", text: `Navigation failed: ${r.errorText}` });
          }
        }
        return this._sendMeta(true);
      })
      .catch((err) => {
        this._commitDone();
        this.broadcast({ type: "status", text: `Navigation failed: ${err.message}` });
        return { ...this.lastMeta, error: err.message };
      });
    // Reply quickly even when the site is slow to answer; frames and meta keep flowing
    // over the WebSocket.
    return withTimeout(nav, NAVIGATE_REPLY_MS, { ...this.lastMeta, epoch: this.epoch, pending: true });
  }

  async navigate(rawUrl) {
    const href = assertAllowedUrl(resolveUrl(rawUrl, this.homeUrl, this.searchUrl));
    await this.ensure();
    return this._navigateTo(href);
  }

  async action(type) {
    await this.ensure();
    const cdp = this.inputCdp;
    switch (type) {
      case "home":
        return this._navigateTo(this.homeUrl);
      case "reload": {
        this._beginNav(this.lastMeta.url);
        await cdp.send("Page.reload", { ignoreCache: false }).catch((err) => {
          this._commitDone();
          this.broadcast({ type: "status", text: `Reload failed: ${err.message}` });
        });
        return this._sendMeta(true);
      }
      case "back":
      case "forward": {
        const hist = await cdp.send("Page.getNavigationHistory");
        const idx = hist.currentIndex + (type === "back" ? -1 : 1);
        const entry = hist.entries && hist.entries[idx];
        if (!entry) {
          this.broadcast({ type: "status", text: type === "back" ? "Nothing to go back to" : "Nothing to go forward to" });
          return this.lastMeta;
        }
        this._beginNav(entry.url);
        await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }).catch((err) => {
          this._commitDone();
          this.broadcast({ type: "status", text: `Navigation failed: ${err.message}` });
        });
        return this._sendMeta(true);
      }
      default:
        throw new Error("Unknown action");
    }
  }

  async resize(width, height) {
    const w = clamp(Math.round(Number(width) || DEFAULT_WIDTH), MIN_VIEW_W, MAX_VIEW_W);
    const h = clamp(Math.round(Number(height) || DEFAULT_HEIGHT), MIN_VIEW_H, MAX_VIEW_H);
    if (Math.abs(w - this.viewport.width) < 4 && Math.abs(h - this.viewport.height) < 4) return;
    this.viewport = { width: w, height: h };
    if (!this.page) return;
    try {
      await this.page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    } catch {
      // ignore
    }
    await this._restartScreencast();
    this._snapshot();
  }

  scalePoint(msg) {
    const vw = Number(msg.vw) || this.viewport.width;
    const vh = Number(msg.vh) || this.viewport.height;
    const x = (Number(msg.x) || 0) * (this.viewport.width / vw);
    const y = (Number(msg.y) || 0) * (this.viewport.height / vh);
    return {
      x: clamp(Math.round(x * 100) / 100, 0, this.viewport.width),
      y: clamp(Math.round(y * 100) / 100, 0, this.viewport.height),
    };
  }

  // ——— input ———

  handleInput(msg, ws) {
    if (!msg || !msg.type) return Promise.resolve();
    if (msg.type === "audio") {
      this._setClientAudio(ws, msg.format);
      return Promise.resolve();
    }
    if (msg.type === "adblock") {
      return this.setAdblock(msg.enabled === true);
    }
    if (msg.type === "exitFullscreen") {
      return this.exitRemoteFullscreen();
    }
    if (msg.type === "resize") {
      if (!this.ready) return Promise.resolve();
      return this.resize(msg.width, msg.height);
    }
    if (!this.ready) return Promise.resolve();
    if (msg.type === "probe") {
      return this._probeFocus(ws);
    }
    if (msg.type === "snapshot") {
      return this._snapshot(ws);
    }
    if (msg.type === "mouse" && msg.action === "move") {
      this._pendingMove = msg;
    } else if (["mouse", "wheel", "key", "paste"].includes(msg.type)) {
      if (this._pendingMove) {
        this._pendingExtras.push(this._pendingMove);
        this._pendingMove = null;
      }
      const last = this._pendingExtras[this._pendingExtras.length - 1];
      if (
        msg.type === "wheel" &&
        last &&
        last.type === "wheel" &&
        Math.abs(Number(last.x) - Number(msg.x)) < 2 &&
        Math.abs(Number(last.y) - Number(msg.y)) < 2 &&
        modifiersFrom(last) === modifiersFrom(msg)
      ) {
        last.deltaX = (Number(last.deltaX) || 0) + (Number(msg.deltaX) || 0);
        last.deltaY = (Number(last.deltaY) || 0) + (Number(msg.deltaY) || 0);
      } else {
        this._pendingExtras.push(msg);
        if (this._pendingExtras.length > INPUT_QUEUE_MAX) this._pendingExtras.shift();
      }
    } else {
      return Promise.resolve();
    }
    this._drainInput();
    return Promise.resolve();
  }

  async _drainInput() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._pendingExtras.length || this._pendingMove) {
        if (!this.inputCdp) break;
        const extra = this._pendingExtras.shift();
        const next = extra || this._pendingMove;
        if (!extra) this._pendingMove = null;
        if (!next) break;
        try {
          await this._dispatch(next);
        } catch (err) {
          if (isSessionGone(err)) {
            this._pendingMove = null;
            this._pendingExtras.length = 0;
            if (this.page && !this.page.isClosed()) {
              await this._attachSessions(this.page).catch(() => {});
            }
            break;
          }
          console.error(`[home-browser] input ${next.type}: ${err.message}`);
        }
      }
    } finally {
      this._draining = false;
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
    const action = msg.action;
    const buttons = typeof msg.buttons === "number" ? msg.buttons : action === "up" ? 0 : 1;
    const button = action === "move" && buttons === 0 ? "none" : MOUSE_BUTTONS[msg.button] || "left";
    const clickCount = clamp(Math.round(Number(msg.clickCount) || 1), 1, 3);
    const modifiers = modifiersFrom(msg);

    // Sites (and CAPTCHA widgets) expect hover before a press: guarantee a move at the
    // press position, which also covers touch clients that never send moves.
    if (action === "down" && (this._lastMouse.x !== x || this._lastMouse.y !== y)) {
      await this.inputCdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        modifiers,
        button: "none",
        buttons: 0,
        clickCount: 0,
        pointerType: "mouse",
      });
    }
    this._lastMouse = { x, y };

    let type = "mouseMoved";
    if (action === "down") type = "mousePressed";
    else if (action === "up") type = "mouseReleased";
    const params = {
      type,
      x,
      y,
      modifiers,
      button,
      buttons,
      clickCount: type === "mouseMoved" ? 0 : clickCount,
      pointerType: "mouse",
    };
    const sent = this.inputCdp.send("Input.dispatchMouseEvent", params);
    if (action === "move") {
      sent.catch(() => {});
      return;
    }
    await sent;
  }

  async _wheel(msg) {
    const { x, y } = this.scalePoint(msg);
    this._lastMouse = { x, y };
    await this.inputCdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      modifiers: modifiersFrom(msg),
      deltaX: clamp(Number(msg.deltaX) || 0, -4000, 4000),
      deltaY: clamp(Number(msg.deltaY) || 0, -4000, 4000),
      pointerType: "mouse",
    });
  }

  async _key(msg) {
    const events = keyEvents(msg);
    if (!events) {
      // Not representable as a key: for printable text fall back to insertion.
      const key = String(msg.key ?? "");
      if (msg.action !== "up" && key.length <= 2 && key.length > 0 && !msg.ctrl && !msg.alt && !msg.meta) {
        await this.inputCdp.send("Input.insertText", { text: key });
      }
      return;
    }
    if (msg.action === "up") {
      await this.inputCdp.send("Input.dispatchKeyEvent", events.up);
      return;
    }
    await this.inputCdp.send("Input.dispatchKeyEvent", events.down);
    if (msg.action === "press") {
      await this.inputCdp.send("Input.dispatchKeyEvent", events.up);
    }
  }

  async _paste(msg) {
    const text = String(msg.text ?? "");
    if (!text) return;
    await this.inputCdp.send("Input.insertText", { text: text.slice(0, 20000) });
  }

  async _probeFocus(ws) {
    if (!this.page || !ws) return;
    let editable = false;
    try {
      editable = await withTimeout(
        this.page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return false;
          const tag = el.tagName;
          if (tag === "INPUT") {
            const t = String(el.type || "text").toLowerCase();
            return !["button", "submit", "checkbox", "radio", "file", "range", "color", "image", "reset"].includes(t);
          }
          return tag === "TEXTAREA" || Boolean(el.isContentEditable);
        }),
        1000,
        false
      );
    } catch {
      editable = false;
    }
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "focus", editable: Boolean(editable) }));
    } catch {
      // ignore
    }
  }

  async close() {
    this.closed = true;
    this._stopMetaPoll();
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._commitTimer) {
      clearTimeout(this._commitTimer);
      this._commitTimer = null;
    }
    if (this._metaTimer) {
      clearTimeout(this._metaTimer);
      this._metaTimer = null;
    }
    if (this._tabsTimer) {
      clearTimeout(this._tabsTimer);
      this._tabsTimer = null;
    }
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    for (const streamer of Object.values(this._audio)) streamer.stop();
    this.adblock.stop();
    await this._stopScreencast();
    await this._killBrowser();
  }
}

HomeBrowser.resolveUrl = resolveUrl;
HomeBrowser.findChrome = findChrome;
HomeBrowser.userDataDir = userDataDir;

module.exports = {
  HomeBrowser,
  resolveUrl,
  findChrome,
  encodeFrame,
  decodeFrameHeader,
  keyEvents,
  virtualKey,
  buildUaOverride,
  FRAME_HEADER_BYTES,
  FRAME_TYPE,
};
