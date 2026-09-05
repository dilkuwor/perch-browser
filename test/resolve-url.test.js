"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveUrl } = require("../src/browser");

const HOME = "https://www.google.com/";

describe("resolveUrl", () => {
  it("uses the home URL when the input is empty", () => {
    assert.equal(resolveUrl("", HOME), HOME);
    assert.equal(resolveUrl("   ", HOME), HOME);
  });

  it("maps find-my-ip phrases to ifconfig.me", () => {
    assert.equal(resolveUrl("find my ip", HOME), "https://ifconfig.me/");
    assert.equal(resolveUrl("what is my ip", HOME), "https://ifconfig.me/");
    assert.equal(resolveUrl("ifconfig.me", HOME), "https://ifconfig.me/");
  });

  it("prefixes https for host-like input", () => {
    assert.equal(resolveUrl("example.com", HOME), "https://example.com");
    assert.equal(resolveUrl("google.com", HOME), "https://google.com");
  });

  it("keeps an explicit scheme", () => {
    assert.equal(resolveUrl("http://example.com/path", HOME), "http://example.com/path");
    assert.equal(resolveUrl("https://wikipedia.org", HOME), "https://wikipedia.org");
  });

  it("treats text without a dot as a Google search", () => {
    assert.equal(
      resolveUrl("cats", HOME),
      `https://www.google.com/search?q=${encodeURIComponent("cats")}`
    );
  });

  it("accepts localhost and raw IPs as hosts", () => {
    assert.equal(resolveUrl("localhost", HOME), "https://localhost");
    assert.equal(resolveUrl("192.168.1.50", HOME), "https://192.168.1.50");
    assert.equal(resolveUrl("192.168.1.50:8080", HOME), "https://192.168.1.50:8080");
  });
});
