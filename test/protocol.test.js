"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  encodeFrame,
  decodeFrameHeader,
  keyEvents,
  virtualKey,
  buildUaOverride,
  adaptLevel,
  levelParams,
  useDevShm,
  ADAPT_LEVELS,
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

describe("adaptive streaming ladder", () => {
  const top = ADAPT_LEVELS.length - 1;

  it("steps down one level at a time while a viewer keeps holding frames, and stops at the top", () => {
    let q = { level: 0, calm: 0 };
    for (let i = 1; i <= top + 2; i += 1) {
      q = adaptLevel({ level: q.level, offered: 20, ratio: 0.5, calm: q.calm });
      assert.equal(q.level, Math.min(i, top));
    }
  });

  it("ignores a handful of frames and a few held ones", () => {
    assert.equal(adaptLevel({ level: 0, offered: 3, ratio: 1, calm: 0 }).level, 0);
    assert.equal(adaptLevel({ level: 0, offered: 40, ratio: 0.2, calm: 0 }).level, 0);
  });

  it("climbs back only after the link has been calm for a few seconds", () => {
    let q = { level: 2, calm: 0 };
    for (let i = 0; i < 3; i += 1) {
      q = adaptLevel({ level: q.level, offered: 30, ratio: 0, calm: q.calm });
      assert.equal(q.level, 2, `tick ${i} stays put`);
    }
    q = adaptLevel({ level: q.level, offered: 30, ratio: 0, calm: q.calm });
    assert.equal(q.level, 1);
    assert.equal(q.calm, 0);
    // A busy second resets the count.
    q = adaptLevel({ level: 1, offered: 30, ratio: 0.1, calm: 3 });
    assert.deepEqual(q, { level: 1, calm: 0 });
    // An idle page (no frames) still counts as calm.
    q = adaptLevel({ level: 1, offered: 0, ratio: 0, calm: 3 });
    assert.equal(q.level, 0);
  });

  it("prefers fewer frames and a smaller picture over a lower quality", () => {
    const vp = { width: 1200, height: 800 };
    const l0 = levelParams(0, 60, vp);
    assert.deepEqual([l0.quality, l0.everyNthFrame, l0.maxWidth, l0.maxHeight], [60, 1, 1200, 800]);
    const l1 = levelParams(1, 60, vp);
    assert.equal(l1.quality, 60, "the first step keeps the quality");
    assert.equal(l1.everyNthFrame, 2);
    const l2 = levelParams(2, 60, vp);
    assert.equal(l2.quality, 60);
    assert.equal(l2.maxWidth, 900);
    const last = levelParams(top, 60, vp);
    assert.ok(last.quality < 60 && last.quality >= 20);
    assert.equal(levelParams(top, 25, vp).quality, 20, "never below 20");
    assert.equal(levelParams(99, 60, vp).level, top, "clamped");
  });
});

describe("adaptive streaming in the browser", () => {
  const { HomeBrowser } = require("../src/browser");

  function socket() {
    return { readyState: 1, bufferedAmount: 0, sent: [], send(p) { this.sent.push(p); } };
  }

  it("tells a new client the stream parameters straight away", () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    browser.launch = async () => {};
    const ws = socket();
    browser.addClient(ws);
    const info = ws.sent.map((p) => JSON.parse(p)).find((m) => m.type === "stream");
    assert.ok(info, "a stream message is sent");
    assert.equal(info.quality, info.target);
    assert.equal(info.level, 0);
    assert.equal(info.everyNthFrame, 1);
    browser.removeClient(ws);
    browser.adblock.stop();
  });

  it("follows the worst watching viewer, not a sum, and ignores hidden ones", () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    const sent = [];
    browser.broadcast = (m) => sent.push(m);
    const phone = socket();
    const laptop = socket();
    browser.clients.add(phone);
    browser.clients.add(laptop);
    phone._stat = { offered: 20, held: 12 };
    laptop._stat = { offered: 20, held: 0 };
    browser._adaptTick();
    assert.equal(browser._adapt.level, 1, "one struggling viewer steps the shared stream down");
    assert.equal(sent.at(-1).type, "stream");
    assert.equal(sent.at(-1).everyNthFrame, 2);

    phone._hidden = true;
    phone._stat = { offered: 20, held: 20 };
    laptop._stat = { offered: 20, held: 0 };
    browser._adapt.changedAt = 0;
    for (let i = 0; i < 4; i += 1) browser._adaptTick();
    assert.equal(browser._adapt.level, 0, "a hidden viewer's backlog does not count");
    browser.adblock.stop();
  });

  it("never restarts the screencast twice in quick succession", () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    browser.broadcast = () => {};
    const ws = socket();
    browser.clients.add(ws);
    for (let i = 0; i < 3; i += 1) {
      ws._stat = { offered: 20, held: 20 };
      browser._adaptTick();
    }
    assert.equal(browser._adapt.level, 1, "further steps wait for the restart interval");
    browser._adapt.changedAt = Date.now() - 4000;
    ws._stat = { offered: 20, held: 20 };
    browser._adaptTick();
    assert.equal(browser._adapt.level, 2);
    browser.adblock.stop();
  });
});

describe("viewers", () => {
  const { HomeBrowser } = require("../src/browser");

  function socket() {
    return { readyState: 1, bufferedAmount: 0, sent: [], send(p) { this.sent.push(p); } };
  }

  it("sends no frames to a client that is not on screen, and resumes when it returns", async () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    const phone = socket();
    const laptop = socket();
    browser.clients.add(phone);
    browser.clients.add(laptop);
    await browser.setClientHidden(phone, true);
    assert.equal(browser._viewers(), 1);
    browser._sendFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 1, 100, 100);
    assert.equal(phone.sent.length, 0);
    assert.equal(laptop.sent.length, 1);
    await browser.setClientHidden(phone, false);
    browser._sendFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 1, 100, 100);
    assert.equal(phone.sent.length, 1);
    browser.adblock.stop();
  });

  it("stops encoding altogether when nobody is watching", async () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    let stopped = 0;
    browser._stopScreencast = async () => { stopped += 1; };
    const only = socket();
    browser.clients.add(only);
    await browser.setClientHidden(only, true);
    assert.equal(stopped, 1);
    assert.equal(browser._viewers(), 0);
    browser._sendFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 1, 100, 100);
    assert.equal(only.sent.length, 0);
    browser.adblock.stop();
  });

  it("treats any input from a hidden device as proof that it is watching again", async () => {
    const browser = new HomeBrowser({ homeUrl: "https://example.com/" });
    const phone = socket();
    browser.clients.add(phone);
    await browser.setClientHidden(phone, true);
    // Not ready (no Chromium in tests): the un-hide must still be recorded.
    let shown = 0;
    browser.setClientHidden = async (ws, hidden) => { ws._hidden = hidden; if (!hidden) shown += 1; };
    browser.handleInput({ type: "hittest", x: 1, y: 1, seq: 1 }, phone);
    assert.equal(shown, 1);
    assert.equal(phone._hidden, false);
    browser.adblock.stop();
  });
});

describe("shared memory flag", () => {
  const GB = 1024 * 1024 * 1024;
  const fsOf = (bytes) => () => ({ bsize: 4096, blocks: bytes / 4096 });

  it("honours an explicit override", () => {
    assert.equal(useDevShm({ CHROME_DEV_SHM: "1" }, fsOf(0)), true);
    assert.equal(useDevShm({ CHROME_DEV_SHM: "0" }, fsOf(8 * GB)), false);
  });

  it("uses /dev/shm only when the container was given room (Linux)", { skip: process.platform !== "linux" }, () => {
    assert.equal(useDevShm({}, fsOf(GB)), true);
    assert.equal(useDevShm({}, fsOf(64 * 1024 * 1024)), false, "Docker's 64 MB default keeps the safe flag");
    assert.equal(useDevShm({}, () => { throw new Error("no /dev/shm"); }), false);
  });
});
