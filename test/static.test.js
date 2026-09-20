"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { StaticAssets } = require("../src/static");

let dir;
let assets;

function write(rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  // mtime resolution can be coarse; make every rewrite visibly newer.
  const t = new Date(Date.now() + write.tick++ * 2000);
  fs.utimesSync(file, t, t);
}
write.tick = 1;

function request(urlPath, headers = {}, method = "GET") {
  const [p, q] = urlPath.split("?");
  const req = { method, path: p, query: Object.fromEntries(new URLSearchParams(q || "")), headers };
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    end(b) {
      this.body = b == null ? null : Buffer.from(b);
      this.done = true;
    },
  };
  let passed = false;
  assets.middleware()(req, res, () => (passed = true));
  return { res, passed };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-static-test-"));
  write("index.html", '<html><head><link rel="stylesheet" href="/styles.css" /></head><body><script src="/app.js"></script></body></html>');
  write("app.js", `console.log("${"x".repeat(2000)}");`);
  write("styles.css", `.a{background:url("img/bg.webp")} ${".pad{}".repeat(200)}`);
  write("img/bg.webp", "RIFFxxxxWEBP-one");
  write("icons/icon-192.png", "png192");
  write("icons/icon-512.png", "png512");
  write("icons/maskable-512.png", "pngmask");
  write("icons/apple-touch-icon.png", "pngapple");
  assets = new StaticAssets(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("versioned assets", () => {
  it("names scripts and styles by content hash in the page", () => {
    const html = assets.html().body.toString();
    assert.match(html, /href="\/styles\.css\?v=[0-9a-f]{16}"/);
    assert.match(html, /src="\/app\.js\?v=[0-9a-f]{16}"/);
    assert.match(html, /rel="manifest"/);
    assert.match(html, /window\.__PERCH=\{"v":"[0-9a-f]{16}","assets":\{"img\/bg\.webp":"[0-9a-f]{16}"\},"release":null\}/);
  });

  it("stamps the running release into the page for the login screen", () => {
    const release = { version: "1.0.0", build: "57", commit: "abc1234", date: "2026-09-20", label: "v1.0.0 · build 57 · abc1234" };
    const html = new StaticAssets(dir, { release }).html().body.toString();
    assert.ok(html.includes(`"release":${JSON.stringify(release)}`));
  });

  it("caches the current version forever and makes anything else revalidate", () => {
    const hash = assets.asset("app.js").hash;
    assert.equal(request(`/app.js?v=${hash}`).res.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(request("/app.js").res.headers["cache-control"], "no-cache");
    assert.equal(request("/app.js?v=0000000000000000").res.headers["cache-control"], "no-cache");
  });

  it("never lets the page itself be cached", () => {
    assert.equal(request("/").res.headers["cache-control"], "no-store");
    assert.equal(request("/index.html").res.headers["cache-control"], "no-store");
  });

  it("picks up an edited file without a restart, under a new URL", () => {
    const before = assets.url("app.js");
    write("app.js", `console.log("changed ${"y".repeat(2000)}");`);
    const after = assets.url("app.js");
    assert.notEqual(after, before);
    assert.ok(assets.html().body.toString().includes(after));
  });

  it("versions images inside the stylesheet, so a replaced image busts the css too", () => {
    const css1 = assets.asset("styles.css");
    assert.match(css1.body.toString(), /url\("img\/bg\.webp\?v=[0-9a-f]{16}"\)/);
    write("img/bg.webp", "RIFFxxxxWEBP-two");
    const css2 = assets.asset("styles.css");
    assert.notEqual(css2.hash, css1.hash);
    assert.notEqual(assets.version(), undefined);
  });
});

describe("transfer", () => {
  it("serves brotli, then gzip, then identity — all decoding to the same bytes", () => {
    const raw = request("/app.js").res;
    const br = request("/app.js", { "accept-encoding": "gzip, deflate, br" }).res;
    const gz = request("/app.js", { "accept-encoding": "gzip" }).res;
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.equal(raw.headers["content-encoding"], undefined);
    assert.ok(br.body.length < raw.body.length / 5);
    assert.deepEqual(zlib.brotliDecompressSync(br.body), raw.body);
    assert.deepEqual(zlib.gunzipSync(gz.body), raw.body);
    assert.equal(br.headers["vary"], "Accept-Encoding");
  });

  it("does not waste time compressing images", () => {
    assert.equal(request("/img/bg.webp", { "accept-encoding": "br" }).res.headers["content-encoding"], undefined);
  });

  it("answers 304 to a matching ETag and omits the body for HEAD", () => {
    const first = request("/app.js").res;
    const again = request("/app.js", { "if-none-match": first.headers["etag"] }).res;
    assert.equal(again.statusCode, 304);
    assert.equal(again.body, null);
    const head = request("/app.js", {}, "HEAD").res;
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, null);
    assert.equal(Number(head.headers["content-length"]), first.body.length);
  });
});

describe("safety", () => {
  it("stays inside the public directory", () => {
    fs.writeFileSync(path.join(dir, "..", "perch-secret.js"), "secret");
    try {
      for (const p of ["/../perch-secret.js", "/%2e%2e/perch-secret.js", "/img/../../perch-secret.js"]) {
        const { res, passed } = request(p);
        assert.ok(passed && !res.done, p);
      }
    } finally {
      fs.rmSync(path.join(dir, "..", "perch-secret.js"), { force: true });
    }
  });

  it("ignores dotfiles, unknown types, directories and non-GET requests", () => {
    write(".env", "APP_PASSWORD=x");
    write("notes.txt", "hello");
    assert.ok(request("/.env").passed);
    assert.ok(request("/notes.txt").passed);
    assert.ok(request("/img").passed);
    assert.ok(request("/app.js", {}, "POST").passed);
  });
});

describe("pwa", () => {
  it("publishes an installable manifest with versioned icons", () => {
    const { res } = request("/manifest.webmanifest");
    const m = JSON.parse(res.body.toString());
    assert.equal(res.headers["content-type"], "application/manifest+json; charset=utf-8");
    assert.equal(m.display, "standalone");
    assert.equal(m.start_url, "/");
    assert.ok(m.icons.some((i) => i.sizes === "192x192"));
    assert.ok(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "any"));
    assert.ok(m.icons.some((i) => i.purpose === "maskable"));
    for (const icon of m.icons) assert.match(icon.src, /\?v=[0-9a-f]{16}$/);
  });

  it("builds a worker that is valid JS, scoped to /, and re-issued when anything changes", () => {
    const first = request("/sw.js").res;
    assert.equal(first.headers["service-worker-allowed"], "/");
    assert.equal(first.headers["cache-control"], "no-cache");
    assert.doesNotThrow(() => new (require("vm").Script)(first.body.toString()));
    write("app.js", `console.log("v2 ${"z".repeat(2000)}");`);
    const second = request("/sw.js").res;
    assert.notEqual(second.headers["etag"], first.headers["etag"]);
    assert.ok(second.body.toString().includes(assets.url("app.js")));
  });

  it("keeps live traffic out of the worker and never pins a page to an old build", () => {
    const src = assets.serviceWorker().body.toString();
    assert.match(src, /startsWith\("\/api\/"\)/);
    assert.match(src, /=== "\/ws"/);
    assert.match(src, /searchParams\.has\("v"\)/);
    // The page is served from the cache for an instant open, but always re-fetched
    // behind it, replaced when the server's copy differs, and the open page is told.
    assert.match(src, /cache\.put\(PAGE, res\.clone\(\)\)/);
    assert.match(src, /"perch-update"/);
    assert.match(src, /etag/);
    assert.ok(src.includes(`"v":"${assets.version()}"`) || src.includes(JSON.stringify(assets.version())));
  });

  it("puts the manifest on the credentialed connection", () => {
    const html = request("/").res.body.toString();
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/);
  });
});
