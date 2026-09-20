"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

// Which build is running, for /health, the login page and the About section.
//
// Only the version number in package.json is set by hand. Everything else comes from the
// build: the Docker image is given the CI run number, commit and date as build args, so
// every image published from `main` carries a new build number without anyone editing a
// file. A native checkout asks git for its commit instead, and anything else is "dev".
const DEV = "dev";

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
  } catch {
    return "";
  }
}

function clean(value, max) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/[^\w.:+-]/g, "")
    .slice(0, max);
}

function describeBuild({ env = process.env, rootDir = path.join(__dirname, ".."), pkg } = {}) {
  let version = "0.0.0";
  try {
    version = String((pkg || require(path.join(rootDir, "package.json"))).version || version);
  } catch {
    // no package.json: keep the placeholder
  }
  const build = clean(env.PERCH_BUILD, 32) || DEV;
  let commit = clean(env.PERCH_COMMIT, 40);
  let date = clean(env.PERCH_BUILD_DATE, 32);
  if (!commit) {
    // Not a built image: describe the checkout itself. The date then belongs to the
    // commit, never to an env value meant for a different build.
    commit = git(["rev-parse", "HEAD"], rootDir);
    date = commit ? git(["show", "-s", "--format=%cI", "HEAD"], rootDir) : "";
  }
  commit = commit.slice(0, 7);
  date = date.slice(0, 10);
  const label = [`v${version}`, build === DEV ? DEV : `build ${build}`, commit].filter(Boolean).join(" · ");
  return { version, build, commit, date, label };
}

module.exports = { describeBuild };
