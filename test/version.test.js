"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describeBuild } = require("../src/version");

const pkg = { version: "1.2.3" };

describe("build description", () => {
  it("takes the build number, commit and date from a built image", () => {
    const r = describeBuild({
      env: { PERCH_BUILD: "57", PERCH_COMMIT: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", PERCH_BUILD_DATE: "2026-09-20T10:11:12Z" },
      pkg,
    });
    assert.deepEqual(r, { version: "1.2.3", build: "57", commit: "a1b2c3d", date: "2026-09-20", label: "v1.2.3 · build 57 · a1b2c3d" });
  });

  it("describes a plain checkout as a dev build", () => {
    const r = describeBuild({ env: {}, pkg });
    assert.equal(r.version, "1.2.3");
    assert.equal(r.build, "dev");
    assert.match(r.label, /^v1\.2\.3 · dev/);
  });

  it("copes with no git and no package.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-version-test-"));
    try {
      const r = describeBuild({ env: { GIT_DIR: path.join(dir, "none"), GIT_CEILING_DIRECTORIES: dir }, rootDir: dir, pkg });
      assert.equal(r.commit, "");
      assert.equal(r.date, "");
      assert.equal(r.label, "v1.2.3 · dev");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never lets an env value inject markup into the label", () => {
    const r = describeBuild({ env: { PERCH_BUILD: "<script>1", PERCH_COMMIT: "abc<b>def" }, pkg });
    assert.equal(r.label, "v1.2.3 · build script1 · abcbdef");
  });
});
