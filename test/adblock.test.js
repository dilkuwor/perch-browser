"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FiltersEngine } = require("@ghostery/adblocker");
const { AdBlocker, yearlyUboLists, requestType, frameUrl, patchCsp, injectIntoHtml, toInlineScript } = require("../src/adblock");

// A tiny inline list keeps these tests off the network.
const FILTERS = [
  "||ads.example^",
  "||tracker.example^$third-party",
  "@@||ads.example/allowed.js",
  "news.example##.sponsored",
  "##.generic-ad-banner",
].join("\n");

function blocker(opts) {
  const engine = FiltersEngine.parse(FILTERS, { loadExtendedSelectors: true });
  return new AdBlocker({ engine, ...opts });
}

function fakeFrame(url, parent) {
  return { url: () => url, parentFrame: () => parent || null };
}

describe("network matching", () => {
  it("blocks ad requests and honours exceptions", () => {
    const ab = blocker();
    assert.equal(ab.match("https://ads.example/banner.js", "https://news.example/", "script").match, true);
    assert.equal(ab.match("https://ads.example/allowed.js", "https://news.example/", "script").match, false);
    assert.equal(ab.match("https://cdn.example/app.js", "https://news.example/", "script").match, false);
  });

  it("applies third-party rules relative to the embedding document", () => {
    const ab = blocker();
    assert.equal(ab.match("https://tracker.example/p.gif", "https://news.example/", "image").match, true);
    assert.equal(ab.match("https://tracker.example/p.gif", "https://tracker.example/", "image").match, false);
  });

  it("treats a window opened towards an ad server as an ad pop-up", () => {
    const ab = blocker();
    assert.equal(ab._isAdPopup("https://ads.example/landing", "https://news.example/"), true);
    assert.equal(ab._isAdPopup("https://shop.example/", "https://news.example/"), false);
    assert.equal(ab._isAdPopup("about:blank", "https://news.example/"), false);
  });
});

describe("request helpers", () => {
  it("maps Puppeteer documents to main_frame / sub_frame", () => {
    assert.equal(requestType("document", true), "main_frame");
    assert.equal(requestType("document", false), "sub_frame");
    assert.equal(requestType("xhr", false), "xhr");
  });

  it("resolves blank frames to the nearest real document", () => {
    const top = fakeFrame("https://news.example/story");
    assert.equal(frameUrl(fakeFrame("about:blank", top)), "https://news.example/story");
    assert.equal(frameUrl(fakeFrame("https://embed.example/", top)), "https://embed.example/");
    assert.equal(frameUrl(null), "");
  });
});

describe("document bootstrap", () => {
  it("carries hostname-specific styles only for that hostname", () => {
    const ab = blocker();
    assert.match(ab.cosmetics("https://news.example/").opts.css, /\.sponsored/);
    assert.doesNotMatch(ab.cosmetics("https://other.example/").opts.css, /\.sponsored/);
  });

  it("produces an ASCII inline script whose hash matches its text", () => {
    const { html, hash } = toInlineScript('const s = "é</script><!--";');
    assert.match(html, /^<script>[\x00-\x7f]*<\/script>$/);
    assert.equal(html.indexOf("</script>"), html.length - "</script>".length);
    assert.ok(!html.includes("<!--"));
    const text = html.slice("<script>".length, -"</script>".length);
    assert.equal(hash, `'sha256-${crypto.createHash("sha256").update(text).digest("base64")}'`);
  });

  it("splices into <head> without disturbing the doctype", () => {
    const out = injectIntoHtml(Buffer.from('<!DOCTYPE html><html><head lang="en"><title>x</title>'), "<S>");
    assert.equal(out.toString(), '<!DOCTYPE html><html><head lang="en"><S><title>x</title>');
    assert.equal(injectIntoHtml(Buffer.from("<!doctype html><p>hi"), "<S>").toString(), "<!doctype html><S><p>hi");
    assert.equal(injectIntoHtml(Buffer.from("plain text"), "<S>"), null);
  });

  it("leaves non-ASCII page bytes untouched", () => {
    const body = Buffer.concat([Buffer.from("<head>"), Buffer.from([0xe9, 0xff, 0x80])]);
    const out = injectIntoHtml(body, "<S>");
    assert.deepEqual(out.subarray(out.length - 3), Buffer.from([0xe9, 0xff, 0x80]));
  });
});

describe("patchCsp", () => {
  const HASH = "'sha256-abc'";

  it("adds the hash to nonce/hash based policies", () => {
    assert.equal(
      patchCsp("default-src 'self'; script-src 'nonce-r4nd' 'strict-dynamic'", HASH),
      `default-src 'self'; script-src 'nonce-r4nd' 'strict-dynamic' ${HASH}`
    );
  });

  it("prefers script-src-elem, then script-src, then default-src", () => {
    assert.match(patchCsp("script-src 'self'; script-src-elem 'self'", HASH), /script-src-elem 'self' 'sha256-abc'$/);
    assert.equal(patchCsp("default-src 'self'", HASH), `default-src 'self' ${HASH}`);
  });

  it("does not touch policies that would lose 'unsafe-inline'", () => {
    const policy = "script-src 'self' 'unsafe-inline'";
    assert.equal(patchCsp(policy, HASH), policy);
  });

  it("replaces 'none' and ignores policies without script rules", () => {
    assert.equal(patchCsp("script-src 'none'", HASH), `script-src ${HASH}`);
    assert.equal(patchCsp("img-src *", HASH), "img-src *");
  });
});

describe("state", () => {
  it("remembers the switch across restarts and falls back to ADBLOCK", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-adblock-test-"));
    try {
      const first = blocker({ dataDir: dir });
      assert.equal(first.enabled, false);
      first.enabled = true;
      first._saveEnabled();
      assert.equal(blocker({ dataDir: dir }).enabled, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports off while disabled and counts per page", async () => {
    const changes = [];
    const ab = blocker({ onChange: () => changes.push(1) });
    assert.deepEqual(ab.state(null), { enabled: false, status: "off", blocked: 0, total: 0, error: null });
    await ab.setEnabled(true);
    assert.equal(ab.state(null).status, "on");
    await ab.setEnabled(false);
    assert.equal(ab.state(null).status, "off");
    assert.ok(changes.length >= 2);
    ab.stop();
  });
});

describe("filter list set", () => {
  it("adds every yearly uBlock file the engine library does not know about, up to this year", () => {
    const urls = yearlyUboLists(new Date("2027-03-01T00:00:00Z")).map((l) => l.url.split("/").pop());
    assert.deepEqual(urls, ["filters-2025.txt", "filters-2026.txt", "filters-2027.txt"]);
  });

  it("never requests a list twice, and marks the extra years as optional", () => {
    const { fullLists } = require("@ghostery/adblocker");
    for (const list of yearlyUboLists()) {
      assert.ok(!fullLists.includes(list.url));
      assert.equal(list.optional, true);
      assert.match(list.fallback, /^https:\/\/ublockorigin\.github\.io\//);
    }
  });

  it("rebuilds a cached engine whose recipe no longer matches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-adblock-test-"));
    try {
      const ab = blocker({ dataDir: dir });
      ab._writeCachedEngine(ab.engine);
      assert.ok(blocker({ dataDir: dir })._readCachedEngine(), "a matching recipe is reused");
      fs.writeFileSync(path.join(dir, "engine.recipe"), "built-from-an-older-list-set");
      assert.equal(blocker({ dataDir: dir })._readCachedEngine(), null);
      fs.rmSync(path.join(dir, "engine.recipe"));
      assert.equal(blocker({ dataDir: dir })._readCachedEngine(), null, "pre-recipe caches count as stale");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours a site's generic-hide exception (what un-trips bait-element detectors)", () => {
    const engine = FiltersEngine.parse(["##[data-ad-slot]", "@@||video.example^$ghide", "video.example##.real-ad"].join("\n"));
    const ab = new AdBlocker({ engine });
    assert.equal(ab.cosmetics("https://video.example/watch").opts.generic, false);
    assert.match(ab.cosmetics("https://video.example/watch").opts.css, /\.real-ad/);
    assert.equal(ab.cosmetics("https://other.example/").opts.generic, true);
  });
});
