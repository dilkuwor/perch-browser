"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cacheDirs, dirSize } = require("../src/browser");

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-cache-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel, bytes) {
  const file = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
}

describe("cache size", () => {
  it("counts only Chromium's cache directories, never cookies or site data", async () => {
    write("Default/Cache/Cache_Data/f_000001", 100);
    write("Default/Code Cache/js/index", 50);
    write("Default/Service Worker/CacheStorage/abc/def/data", 25);
    write("GPUCache/data_0", 999);
    write("Default/Cookies", 999);
    write("Default/Local Storage/leveldb/000003.log", 999);
    write("Default/History", 999);
    assert.equal(await dirSize(cacheDirs(dir)), 175);
  });

  it("treats a missing profile as empty", async () => {
    assert.equal(await dirSize(cacheDirs(path.join(dir, "nope"))), 0);
  });

  it("resolves cache paths inside the given profile", () => {
    for (const p of cacheDirs(dir)) assert.ok(p.startsWith(dir + path.sep));
  });
});
