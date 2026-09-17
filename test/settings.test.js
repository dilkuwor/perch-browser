"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Settings, TOOLBAR_ITEMS, sniffImage } = require("../src/settings");
const { resolveUrl } = require("../src/browser");

const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-settings-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("defaults", () => {
  it("shows every tool and uses the bundled wallpaper", () => {
    const s = new Settings({ dataDir: dir, env: {} }).get();
    for (const key of TOOLBAR_ITEMS) assert.equal(s.toolbar[key], true);
    assert.equal(s.newTab.background, "default");
    assert.equal(s.browsing.searchEngine, "google");
    assert.equal(s.stream.quality, 60);
  });

  it("never offers Settings, Fullscreen or Sign out for hiding", () => {
    for (const key of ["settings", "fullscreen", "logout"]) assert.ok(!TOOLBAR_ITEMS.includes(key));
  });

  it("takes the initial stream quality from JPEG_QUALITY", () => {
    assert.equal(new Settings({ dataDir: dir, env: { JPEG_QUALITY: "45" } }).get().stream.quality, 45);
  });
});

describe("theme", () => {
  it("defaults to dark and accepts only known themes", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    assert.equal(settings.get().appearance.theme, "dark");
    assert.equal(settings.update({ appearance: { theme: "light" } }).appearance.theme, "light");
    assert.equal(settings.update({ appearance: { theme: "system" } }).appearance.theme, "system");
    assert.equal(settings.update({ appearance: { theme: "hotdog" } }).appearance.theme, "system");
    assert.equal(new Settings({ dataDir: dir, env: {} }).get().appearance.theme, "system");
  });

  it("upgrades a settings file written before themes existed", () => {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ toolbar: { audio: false } }));
    const s = new Settings({ dataDir: dir, env: {} }).get();
    assert.equal(s.appearance.theme, "dark");
    assert.equal(s.toolbar.audio, false);
  });
});

describe("update", () => {
  it("merges partial patches and persists them", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    settings.update({ toolbar: { latency: false }, browsing: { searchEngine: "duckduckgo" } });
    const reloaded = new Settings({ dataDir: dir, env: {} });
    assert.equal(reloaded.get().toolbar.latency, false);
    assert.equal(reloaded.get().toolbar.audio, true);
    assert.equal(reloaded.searchUrl(), "https://duckduckgo.com/?q=%s");
  });

  it("accepts the dark and light bundled wallpapers", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    assert.equal(settings.update({ newTab: { background: "dark" } }).newTab.background, "dark");
    assert.equal(settings.update({ newTab: { background: "light" } }).newTab.background, "light");
  });

  it("rejects bad values and unknown keys", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    const s = settings.update({
      toolbar: { latency: "no", logout: false, __proto__: { polluted: true } },
      newTab: { dim: 999, background: "javascript:alert(1)" },
      browsing: { searchEngine: "constructor", homeUrl: "javascript:alert(1)" },
      stream: { quality: 1 },
      backgroundVersion: 42,
    });
    assert.equal(s.toolbar.latency, true);
    assert.equal("logout" in s.toolbar, false);
    assert.equal(s.newTab.dim, 80);
    assert.equal(s.newTab.background, "default");
    assert.equal(s.browsing.searchEngine, "google");
    assert.equal(s.browsing.homeUrl, "");
    assert.equal(s.stream.quality, 20);
    assert.equal(s.backgroundVersion, 0);
    assert.equal({}.polluted, undefined);
  });

  it("allows picture quality up to 100 and no further", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    assert.equal(settings.update({ stream: { quality: 100 } }).stream.quality, 100);
    assert.equal(settings.update({ stream: { quality: 150 } }).stream.quality, 100);
    assert.equal(new Settings({ dataDir: dir, env: { JPEG_QUALITY: "100" } }).get().stream.quality, 100);
  });

  it("normalises the home page and lets it be cleared", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    assert.equal(settings.update({ browsing: { homeUrl: "example.com" } }).browsing.homeUrl, "https://example.com/");
    assert.equal(settings.update({ browsing: { homeUrl: "  " } }).browsing.homeUrl, "");
  });

  it("refuses the custom wallpaper when none was uploaded", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    assert.equal(settings.update({ newTab: { background: "custom" } }).newTab.background, "default");
  });

  it("survives a corrupt settings file", () => {
    fs.writeFileSync(path.join(dir, "settings.json"), "{not json");
    assert.equal(new Settings({ dataDir: dir, env: {} }).get().newTab.background, "default");
  });
});

describe("wallpaper", () => {
  it("identifies images by content, not by claimed type", () => {
    assert.equal(sniffImage(WEBP).mime, "image/webp");
    assert.equal(sniffImage(JPEG).mime, "image/jpeg");
    assert.equal(sniffImage(PNG).mime, "image/png");
    assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>      ")), null);
    assert.equal(sniffImage(Buffer.alloc(2)), null);
  });

  it("stores an upload, selects it and bumps the version", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    const s = settings.setBackground(WEBP);
    assert.equal(s.newTab.background, "custom");
    assert.equal(s.backgroundVersion, 1);
    assert.equal(settings.backgroundFile().mime, "image/webp");
  });

  it("keeps a single file when the format changes", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    settings.setBackground(WEBP);
    settings.setBackground(JPEG);
    assert.equal(settings.backgroundFile().mime, "image/jpeg");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("background")), ["background.jpg"]);
  });

  it("rejects non-images and oversized uploads", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    assert.throws(() => settings.setBackground(Buffer.from("<html>not an image</html>")), /Unsupported/);
    assert.throws(() => settings.setBackground(Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)])), /too large/);
    assert.throws(() => settings.setBackground({}), /Empty/);
  });

  it("falls back to the default when the image is removed or reset", () => {
    const settings = new Settings({ dataDir: dir, env: {} });
    settings.setBackground(PNG);
    assert.equal(settings.removeBackground().newTab.background, "default");
    assert.equal(settings.backgroundFile(), null);
    settings.setBackground(PNG);
    settings.update({ toolbar: { audio: false } });
    const s = settings.reset();
    assert.equal(s.toolbar.audio, true);
    assert.equal(settings.backgroundFile(), null);
  });
});

describe("search engine", () => {
  it("routes typed words to the chosen engine and leaves addresses alone", () => {
    const ddg = "https://duckduckgo.com/?q=%s";
    assert.equal(resolveUrl("cute owls", "", ddg), "https://duckduckgo.com/?q=cute%20owls");
    assert.equal(resolveUrl("example.com", "", ddg), "https://example.com");
    assert.equal(resolveUrl("cute owls", ""), "https://www.google.com/search?q=cute%20owls");
  });
});
