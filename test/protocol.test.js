"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  encodeFrame,
  decodeFrameHeader,
  keyEvents,
  virtualKey,
  buildUaOverride,
  adaptQuality,
  FRAME_HEADER_BYTES,
} = require("../src/browser");

describe("binary frame protocol", () => {
  it("round-trips epoch, size and payload", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const buf = encodeFrame(jpeg, 42, 1280, 800);
    assert.equal(buf.length, FRAME_HEADER_BYTES + jpeg.length);
    const header = decodeFrameHeader(buf);
    assert.deepEqual(header, { epoch: 42, width: 1280, height: 800, offset: FRAME_HEADER_BYTES });
    assert.deepEqual(buf.subarray(header.offset), jpeg);
  });

  it("rejects buffers that are not frames", () => {
    assert.equal(decodeFrameHeader(Buffer.from("{}")), null);
    assert.equal(decodeFrameHeader(Buffer.alloc(3)), null);
  });
});

describe("keyEvents", () => {
  it("sends printable characters as real keyDown events with text", () => {
    const ev = keyEvents({ key: "a", code: "KeyA", keyCode: 65 });
    assert.equal(ev.down.type, "keyDown");
    assert.equal(ev.down.text, "a");
    assert.equal(ev.down.windowsVirtualKeyCode, 65);
    assert.equal(ev.up.type, "keyUp");
    assert.equal(ev.printable, true);
  });

  it("gives Enter a carriage return so forms submit", () => {
    const ev = keyEvents({ key: "Enter", code: "Enter", keyCode: 13 });
    assert.equal(ev.down.type, "keyDown");
    assert.equal(ev.down.text, "\r");
  });

  it("uses rawKeyDown for shortcuts and never inserts text", () => {
    const ev = keyEvents({ key: "a", code: "KeyA", keyCode: 65, ctrl: true }, { metaAsCtrl: true });
    assert.equal(ev.down.type, "rawKeyDown");
    assert.equal(ev.down.text, undefined);
    assert.equal(ev.down.modifiers & 2, 2);
  });

  it("maps a Mac client's Cmd to Ctrl for a Linux Chromium", () => {
    const ev = keyEvents({ key: "c", code: "KeyC", keyCode: 67, meta: true }, { metaAsCtrl: true });
    assert.equal(ev.down.modifiers, 2);
    const keep = keyEvents({ key: "c", code: "KeyC", keyCode: 67, meta: true }, { metaAsCtrl: false });
    assert.equal(keep.down.modifiers, 4);
  });

  it("ignores keys that cannot be represented", () => {
    assert.equal(keyEvents({ key: "Unidentified", code: "", keyCode: 229 }), null);
    assert.equal(keyEvents({ key: "Process", code: "" }), null);
  });

  it("derives virtual key codes from code names when keyCode is missing", () => {
    assert.equal(virtualKey({ key: ".", code: "Period" }), 190);
    assert.equal(virtualKey({ key: "5", code: "Numpad5" }), 101);
    assert.equal(virtualKey({ key: "ArrowLeft", code: "ArrowLeft" }), 37);
    assert.equal(virtualKey({ key: "a", code: "KeyA", keyCode: 229 }), 65);
  });
});

describe("buildUaOverride", () => {
  it("strips the headless marker and keeps the Chrome version", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.85 Safari/537.36";
    const out = buildUaOverride(ua);
    assert.equal(/HeadlessChrome/.test(out.ua), false);
    assert.match(out.ua, /Chrome\/131\.0\.6778\.85/);
    assert.equal(out.metadata.fullVersion, "131.0.6778.85");
    assert.ok(out.metadata.brands.some((b) => b.brand === "Chromium" && b.version === "131"));
    assert.equal(out.metadata.mobile, false);
  });
});

describe("key events and fullscreen", () => {
  it("never marks a key event as native (Chromium re-injects those when a handler goes fullscreen)", () => {
    const ev = keyEvents({ type: "key", action: "down", key: "f", code: "KeyF", keyCode: 70 });
    assert.equal("nativeVirtualKeyCode" in ev.down, false);
    assert.equal("nativeVirtualKeyCode" in ev.up, false);
    assert.equal(ev.down.windowsVirtualKeyCode, 70);
  });
});

describe("frame backpressure", () => {
  const { HomeBrowser } = require("../src/browser");

  function fakeSocket() {
    return {
      readyState: 1,
      bufferedAmount: 0,
      sent: [],
      send(payload) {
        this.sent.push(payload);
      },
    };
  }

  it("sends straight through while the socket keeps up", () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    const ws = fakeSocket();
    browser._offerFrame(ws, Buffer.alloc(80_000, 1));
    browser._offerFrame(ws, Buffer.alloc(80_000, 2));
    assert.equal(ws.sent.length, 2);
    browser.adblock.stop();
  });

  it("keeps only the newest frame behind a slow socket and sends it once it drains", async () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    const ws = fakeSocket();
    ws.bufferedAmount = 900_000; // a phone on a bad link: earlier frames still queued
    for (let i = 1; i <= 5; i += 1) browser._offerFrame(ws, Buffer.alloc(80_000, i));
    assert.equal(ws.sent.length, 0, "nothing is piled onto a busy socket");

    ws.bufferedAmount = 0;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ws.sent.length, 1, "the stale frames were dropped, not delivered late");
    assert.equal(ws.sent[0][0], 5, "and the one delivered is the newest");

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ws._frameDrain, null, "the drain timer stops once there is nothing held");
    browser.adblock.stop();
  });

  it("stops watching a socket that went away", async () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    const ws = fakeSocket();
    ws.bufferedAmount = 900_000;
    browser._offerFrame(ws, Buffer.alloc(80_000, 1));
    browser.removeClient(ws);
    ws.bufferedAmount = 0;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ws.sent.length, 0);
    browser.adblock.stop();
  });
});

describe("adaptive quality", () => {
  it("steps down while a link keeps holding frames, but never below the floor", () => {
    let q = { quality: 60, calm: 0 };
    q = adaptQuality({ target: 60, current: q.quality, offered: 20, held: 10, calm: q.calm });
    assert.equal(q.quality, 50);
    q = adaptQuality({ target: 60, current: q.quality, offered: 20, held: 10, calm: q.calm });
    assert.equal(q.quality, 40);
    q = adaptQuality({ target: 60, current: q.quality, offered: 20, held: 10, calm: q.calm });
    assert.equal(q.quality, 30);
    q = adaptQuality({ target: 60, current: q.quality, offered: 20, held: 20, calm: q.calm });
    assert.equal(q.quality, 30, "at most 30 points below the setting");
    q = adaptQuality({ target: 30, current: 30, offered: 20, held: 20, calm: 0 });
    assert.equal(q.quality, 20, "and never below 20");
  });

  it("ignores a handful of frames and a few held ones", () => {
    assert.equal(adaptQuality({ target: 60, current: 60, offered: 3, held: 3, calm: 0 }).quality, 60);
    assert.equal(adaptQuality({ target: 60, current: 60, offered: 40, held: 8, calm: 0 }).quality, 60);
  });

  it("climbs back only after the link has been calm for a few seconds", () => {
    let q = { quality: 40, calm: 0 };
    for (let i = 0; i < 3; i += 1) {
      q = adaptQuality({ target: 60, current: q.quality, offered: 30, held: 0, calm: q.calm });
      assert.equal(q.quality, 40, `tick ${i} stays put`);
    }
    q = adaptQuality({ target: 60, current: q.quality, offered: 30, held: 0, calm: q.calm });
    assert.equal(q.quality, 50);
    assert.equal(q.calm, 0);
    // A busy second resets the count.
    q = adaptQuality({ target: 60, current: 50, offered: 30, held: 3, calm: 3 });
    assert.equal(q.quality, 50);
    assert.equal(q.calm, 0);
    // An idle page (no frames) still counts as calm.
    q = adaptQuality({ target: 60, current: 50, offered: 0, held: 0, calm: 3 });
    assert.equal(q.quality, 60);
  });

  it("snaps to a new setting", () => {
    assert.equal(adaptQuality({ target: 45, current: 60, offered: 0, held: 0, calm: 0 }).quality, 45);
    assert.equal(adaptQuality({ target: 45, current: 60, offered: 20, held: 10, calm: 0 }).quality, 35);
  });
});

describe("client start-up", () => {
  const { HomeBrowser } = require("../src/browser");

  it("tells a new client the stream quality straight away", () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    browser.launch = async () => {};
    const sent = [];
    const ws = { readyState: 1, bufferedAmount: 0, send: (p) => sent.push(JSON.parse(p)) };
    browser.addClient(ws);
    const info = sent.find((m) => m.type === "stream");
    assert.ok(info, "a stream message is sent");
    assert.equal(info.quality, info.target);
    browser.removeClient(ws);
    browser.adblock.stop();
  });

  it("lowers and restores the quality from frame statistics", () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    const sent = [];
    browser.broadcast = (m) => sent.push(m);
    browser._adapt.offered = 20;
    browser._adapt.held = 12;
    browser._adaptTick();
    assert.equal(browser._adapt.quality, browser.jpegQuality - 10);
    assert.equal(sent.at(-1).type, "stream");
    assert.equal(sent.at(-1).quality, browser.jpegQuality - 10);
    for (let i = 0; i < 4; i += 1) {
      browser._adapt.offered = 20;
      browser._adapt.held = 0;
      browser._adaptTick();
    }
    assert.equal(browser._adapt.quality, browser.jpegQuality);
    browser.adblock.stop();
  });
});
