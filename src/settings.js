"use strict";

const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = "settings.json";
const BACKGROUND_BASENAME = "background";
const BACKGROUND_MAX_BYTES = 8 * 1024 * 1024;

const SEARCH_ENGINES = {
  google: { label: "Google", url: "https://www.google.com/search?q=%s" },
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q=%s" },
  brave: { label: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  startpage: { label: "Startpage", url: "https://www.startpage.com/do/search?q=%s" },
};

// Title-bar and toolbar buttons the user may hide. Settings, Fullscreen and Sign out are
// deliberately absent: hiding them could lock someone out of the way back.
const TOOLBAR_ITEMS = ["latency", "adblock", "audio", "focus", "maximize", "home", "keyboard", "statusbar"];

const THEMES = ["dark", "light", "system"];

const IMAGE_TYPES = [
  { ext: "webp", mime: "image/webp", test: (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
  { ext: "jpg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", mime: "image/png", test: (b) => b.toString("latin1", 1, 4) === "PNG" && b[0] === 0x89 },
];

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  return IMAGE_TYPES.find((t) => t.test(buf)) || null;
}

function defaults(env = process.env) {
  return {
    appearance: { theme: "dark" },
    toolbar: Object.fromEntries(TOOLBAR_ITEMS.map((k) => [k, true])),
    newTab: { background: "default", dim: 35, search: true, shortcuts: true },
    browsing: { homeUrl: "", searchEngine: "google" },
    stream: { quality: clampInt(env.JPEG_QUALITY, 20, 95, 60) },
    backgroundVersion: 0,
  };
}

// Unknown keys are dropped and bad values fall back to `base`, so neither a hand-edited
// file nor a hostile request can put anything unexpected into the stored settings.
function sanitize(input, base) {
  const src = input && typeof input === "object" ? input : {};
  const out = JSON.parse(JSON.stringify(base));
  const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);

  const appearance = src.appearance && typeof src.appearance === "object" ? src.appearance : {};
  if (THEMES.includes(appearance.theme)) out.appearance.theme = appearance.theme;

  const toolbar = src.toolbar && typeof src.toolbar === "object" ? src.toolbar : {};
  for (const key of TOOLBAR_ITEMS) out.toolbar[key] = bool(toolbar[key], base.toolbar[key]);

  const newTab = src.newTab && typeof src.newTab === "object" ? src.newTab : {};
  if (["default", "custom", "none"].includes(newTab.background)) out.newTab.background = newTab.background;
  out.newTab.dim = clampInt(newTab.dim, 0, 80, base.newTab.dim);
  out.newTab.search = bool(newTab.search, base.newTab.search);
  out.newTab.shortcuts = bool(newTab.shortcuts, base.newTab.shortcuts);

  const browsing = src.browsing && typeof src.browsing === "object" ? src.browsing : {};
  if (typeof browsing.homeUrl === "string") out.browsing.homeUrl = normalizeHomeUrl(browsing.homeUrl, base.browsing.homeUrl);
  if (Object.hasOwn(SEARCH_ENGINES, browsing.searchEngine)) out.browsing.searchEngine = browsing.searchEngine;

  const stream = src.stream && typeof src.stream === "object" ? src.stream : {};
  out.stream.quality = clampInt(stream.quality, 20, 95, base.stream.quality);

  out.backgroundVersion = clampInt(src.backgroundVersion, 0, Number.MAX_SAFE_INTEGER, base.backgroundVersion);
  return out;
}

function normalizeHomeUrl(value, fallback) {
  const raw = value.trim().slice(0, 2048);
  if (!raw) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : fallback;
  } catch {
    return fallback;
  }
}

class Settings {
  constructor({ dataDir, env } = {}) {
    this.dataDir = dataDir || null;
    this.defaults = defaults(env);
    this.values = this._load();
  }

  _file(name) {
    return this.dataDir ? path.join(this.dataDir, name) : null;
  }

  _load() {
    const file = this._file(SETTINGS_FILE);
    let stored = null;
    if (file) {
      try {
        stored = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        // first run, or unreadable: start from defaults
      }
    }
    const values = sanitize(stored, this.defaults);
    if (values.newTab.background === "custom" && !this.backgroundFile()) values.newTab.background = "default";
    return values;
  }

  _save() {
    const file = this._file(SETTINGS_FILE);
    if (!file) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`[settings] could not save: ${err.message}`);
    }
  }

  get() {
    return JSON.parse(JSON.stringify(this.values));
  }

  // Merges a partial object section by section; returns the full, sanitized result.
  update(patch) {
    const merged = this.get();
    if (patch && typeof patch === "object") {
      for (const section of ["appearance", "toolbar", "newTab", "browsing", "stream"]) {
        if (patch[section] && typeof patch[section] === "object") Object.assign(merged[section], patch[section]);
      }
    }
    merged.backgroundVersion = this.values.backgroundVersion;
    const next = sanitize(merged, this.values);
    if (next.newTab.background === "custom" && !this.backgroundFile()) next.newTab.background = this.values.newTab.background;
    this.values = next;
    this._save();
    return this.get();
  }

  reset() {
    this.removeBackground();
    this.values = sanitize(null, this.defaults);
    this._save();
    return this.get();
  }

  searchUrl() {
    return SEARCH_ENGINES[this.values.browsing.searchEngine].url;
  }

  // ——— new-tab background ———

  backgroundFile() {
    if (!this.dataDir) return null;
    for (const type of IMAGE_TYPES) {
      const file = this._file(`${BACKGROUND_BASENAME}.${type.ext}`);
      if (fs.existsSync(file)) return { file, mime: type.mime };
    }
    return null;
  }

  setBackground(buf) {
    if (!this.dataDir) throw new Error("No data directory");
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error("Empty upload");
    if (buf.length > BACKGROUND_MAX_BYTES) throw new Error("Image is too large");
    const type = sniffImage(buf);
    if (!type) throw new Error("Unsupported image (use WebP, JPEG or PNG)");
    fs.mkdirSync(this.dataDir, { recursive: true });
    this._deleteBackgroundFiles();
    fs.writeFileSync(this._file(`${BACKGROUND_BASENAME}.${type.ext}`), buf);
    this.values.newTab.background = "custom";
    this.values.backgroundVersion += 1;
    this._save();
    return this.get();
  }

  removeBackground() {
    this._deleteBackgroundFiles();
    if (this.values.newTab.background === "custom") this.values.newTab.background = "default";
    this.values.backgroundVersion += 1;
    this._save();
    return this.get();
  }

  _deleteBackgroundFiles() {
    if (!this.dataDir) return;
    for (const type of IMAGE_TYPES) {
      fs.rmSync(this._file(`${BACKGROUND_BASENAME}.${type.ext}`), { force: true });
    }
  }
}

module.exports = { Settings, SEARCH_ENGINES, TOOLBAR_ITEMS, BACKGROUND_MAX_BYTES, sanitize, sniffImage, defaults };
