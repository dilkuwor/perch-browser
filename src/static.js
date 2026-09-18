"use strict";

// Static front-end, served for speed without ever going stale.
//
// Every asset is addressed by a hash of its content (`/app.js?v=3f9c…`). A versioned URL
// can never change meaning, so it is cached "forever" (immutable); the HTML that names
// those URLs is never cached. A new deploy therefore shows up on the very next load, and
// an unchanged asset is never downloaded twice. Text is pre-compressed once (brotli and
// gzip) and kept in memory. Files are re-read when they change on disk, so editing
// anything under public/ still only needs a page reload.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest"]);
const IMMUTABLE = "public, max-age=31536000, immutable";
// The service worker pre-fetches these so a second visit paints without the network.
const SHELL = ["styles.css", "app.js", "icons/icon-192.png"];
// The page itself is cached too (see serviceWorker()); this is its key in the cache.
const PAGE = "/";

const THEME_COLOR = "#07080b";

function sha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

function compress(buf) {
  return {
    br: zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    }),
    gzip: zlib.gzipSync(buf, { level: 9 }),
  };
}

class StaticAssets {
  constructor(publicDir) {
    this.dir = path.resolve(publicDir);
    this.files = new Map(); // rel path -> { stamp, raw }
    this.built = new Map(); // key -> { stamp, entry }
  }

  // ——— disk ———

  _resolve(rel) {
    const file = path.resolve(this.dir, rel);
    return file === this.dir || file.startsWith(this.dir + path.sep) ? file : null;
  }

  _list(dir = this.dir, prefix = "") {
    const out = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith(".")) continue;
      const rel = prefix + item.name;
      if (item.isDirectory()) out.push(...this._list(path.join(dir, item.name), `${rel}/`));
      else if (TYPES[path.extname(item.name).toLowerCase()]) out.push(rel);
    }
    return out;
  }

  // Raw bytes + a cheap change stamp; the read is skipped while the file is untouched.
  _raw(rel) {
    const file = this._resolve(rel);
    if (!file) return null;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      this.files.delete(rel);
      return null;
    }
    if (!stat.isFile()) return null;
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = this.files.get(rel);
    if (cached && cached.stamp === stamp) return cached;
    const entry = { stamp, raw: fs.readFileSync(file) };
    this.files.set(rel, entry);
    return entry;
  }

  // Memoises a derived asset until any file it depends on changes.
  _memo(key, deps, build) {
    const stamp = deps.map((rel) => (this._raw(rel) || { stamp: "-" }).stamp).join("|");
    const cached = this.built.get(key);
    if (cached && cached.stamp === stamp) return cached.entry;
    const entry = build();
    this.built.set(key, { stamp, entry });
    return entry;
  }

  _entry(rel, body) {
    const ext = path.extname(rel).toLowerCase();
    return {
      type: TYPES[ext] || "application/octet-stream",
      body,
      hash: sha(body),
      ...(COMPRESSIBLE.has(ext) && body.length > 512 ? compress(body) : {}),
    };
  }

  // ——— assets ———

  // styles.css names its images by bare path; hand out versioned ones so they can be
  // cached forever too. That makes the stylesheet's own hash depend on the images.
  _css(rel) {
    const images = this._list().filter((f) => f.startsWith("img/"));
    return this._memo(`css:${rel}`, [rel, ...images], () => {
      const text = this._raw(rel).raw.toString("utf8").replace(/url\((["']?)(img\/[^"')?]+)\1\)/g, (m, q, img) => {
        const file = this._raw(img);
        return file ? `url(${q}${img}?v=${sha(file.raw)}${q})` : m;
      });
      return this._entry(rel, Buffer.from(text));
    });
  }

  asset(rel) {
    if (rel === "index.html" || rel === "sw.js" || rel === "manifest.webmanifest") return null;
    // Allow-list: known front-end types only, and never dotfiles, whatever ends up in public/.
    if (!TYPES[path.extname(rel).toLowerCase()] || rel.split("/").some((part) => part.startsWith("."))) return null;
    if (!this._raw(rel)) return null;
    if (rel.endsWith(".css")) return this._css(rel);
    return this._memo(`file:${rel}`, [rel], () => this._entry(rel, this._raw(rel).raw));
  }

  url(rel) {
    const entry = this.asset(rel);
    return entry ? `/${rel}?v=${entry.hash}` : `/${rel}`;
  }

  // One string that changes whenever anything the client runs or shows changes.
  version() {
    const all = this._list().filter((f) => f !== "index.html");
    return this._memo("version", ["index.html", ...all], () => {
      const parts = all.map((rel) => `${rel}:${(this.asset(rel) || {}).hash}`);
      return sha(Buffer.from(`${sha(this._raw("index.html").raw)}|${parts.join("|")}`));
    });
  }

  html() {
    const all = this._list();
    return this._memo("html", all, () => {
      const images = Object.fromEntries(
        all.filter((f) => f.startsWith("img/")).map((rel) => [rel, this.asset(rel).hash])
      );
      const head = [
        `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />`,
        `<link rel="apple-touch-icon" href="${this.url("icons/apple-touch-icon.png")}" />`,
        `<meta name="mobile-web-app-capable" content="yes" />`,
        `<meta name="apple-mobile-web-app-capable" content="yes" />`,
        `<meta name="apple-mobile-web-app-title" content="Perch" />`,
        `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`,
        `<script>window.__PERCH=${JSON.stringify({ v: this.version(), assets: images })};</script>`,
      ].join("\n  ");
      const text = this._raw("index.html")
        .raw.toString("utf8")
        .replace('href="/styles.css"', `href="${this.url("styles.css")}"`)
        .replace('src="/app.js"', `src="${this.url("app.js")}"`)
        .replace("</head>", `  ${head}\n</head>`);
      return this._entry("index.html", Buffer.from(text));
    });
  }

  manifest() {
    return this._memo("manifest", this._list().filter((f) => f.startsWith("icons/")), () => {
      const icon = (rel, sizes, purpose) => ({ src: this.url(rel), sizes, type: "image/png", purpose });
      const json = {
        name: "Perch",
        short_name: "Perch",
        description: "Your private window to the web — a browser that runs on your home server.",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: THEME_COLOR,
        theme_color: THEME_COLOR,
        categories: ["utilities", "productivity"],
        icons: [
          icon("icons/icon-192.png", "192x192", "any"),
          icon("icons/icon-512.png", "512x512", "any"),
          icon("icons/maskable-512.png", "512x512", "maskable"),
        ],
      };
      return this._entry("manifest.webmanifest", Buffer.from(JSON.stringify(json)));
    });
  }

  // Repeat visits open from the cache: versioned assets (which cannot go stale) and the
  // page itself. Nobody can be pinned to an old version, because the page is always
  // re-fetched in the background: when the server's copy differs, the cache is replaced
  // and the open page is told, and it reloads itself (at once while it is still starting,
  // otherwise it asks). A new worker does the same on activation. Live traffic (/api,
  // /ws) never touches the worker.
  serviceWorker() {
    return this._memo("sw", this._list(), () => {
      const source = `"use strict";
const VERSION = ${JSON.stringify(this.version())};
const CACHE = "perch-" + VERSION;
const SHELL = ${JSON.stringify(SHELL.map((rel) => this.url(rel)))};
const PAGE = ${JSON.stringify(PAGE)};
const OFFLINE = ${JSON.stringify(OFFLINE_PAGE)};

function isPage(res) {
  return res && res.ok && /text\\/html/.test(res.headers.get("content-type") || "");
}

async function pageVersion(res) {
  try {
    const m = /__PERCH=\\{"v":"([0-9a-f]+)"/.exec(await res.clone().text());
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

async function tellClients(version) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of all) c.postMessage({ type: "perch-update", version });
}

// Fetch the page from the server; when it differs from the cached copy, replace it and
// tell open pages. Returns the network response (or throws) so a caller can also use it.
async function refreshPage(req, cache, cached) {
  const res = await fetch(req);
  if (!isPage(res)) return res;
  const prev = cached && cached.headers.get("etag");
  if (prev && prev === res.headers.get("etag")) return res;
  await cache.put(PAGE, res.clone());
  if (cached) tellClients(await pageVersion(res));
  return res;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled([...SHELL, new Request(PAGE, { cache: "reload" })].map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("perch-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => tellClients(VERSION))
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname === "/health") return;

  if (req.mode === "navigate") {
    const offline = () => new Response(OFFLINE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname !== PAGE && url.pathname !== "/index.html") {
      event.respondWith(fetch(req).catch(offline));
      return;
    }
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(PAGE);
        const refresh = refreshPage(req, cache, cached);
        if (cached) {
          event.waitUntil(refresh.catch(() => {}));
          return cached;
        }
        return refresh.catch(offline);
      })
    );
    return;
  }
  if (!url.searchParams.has("v")) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
  );
});
`;
      return this._entry("sw.js", Buffer.from(source));
    });
  }

  // ——— http ———

  send(req, res, entry, cacheControl) {
    res.setHeader("Content-Type", entry.type);
    res.setHeader("Cache-Control", cacheControl);
    res.setHeader("ETag", `"${entry.hash}"`);
    res.setHeader("Vary", "Accept-Encoding");
    if (cacheControl !== "no-store" && req.headers["if-none-match"] === `"${entry.hash}"`) {
      res.status(304).end();
      return;
    }
    const accepts = String(req.headers["accept-encoding"] || "");
    let body = entry.body;
    if (entry.br && /\bbr\b/.test(accepts)) {
      body = entry.br;
      res.setHeader("Content-Encoding", "br");
    } else if (entry.gzip && /\bgzip\b/.test(accepts)) {
      body = entry.gzip;
      res.setHeader("Content-Encoding", "gzip");
    }
    res.setHeader("Content-Length", body.length);
    res.status(200).end(req.method === "HEAD" ? undefined : body);
  }

  sendHtml(req, res) {
    // no-store, not no-cache: some phones and reverse proxies keep serving a cached page
    // under no-cache. It is ~6 KB compressed, and everything heavy it names is cached.
    this.send(req, res, this.html(), "no-store");
  }

  middleware() {
    return (req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      let rel;
      try {
        rel = decodeURIComponent(req.path).replace(/^\/+/, "");
      } catch {
        return next();
      }
      if (rel === "" || rel === "index.html") return this.sendHtml(req, res);
      if (rel === "manifest.webmanifest") return this.send(req, res, this.manifest(), "no-cache");
      if (rel === "sw.js") {
        res.setHeader("Service-Worker-Allowed", "/");
        return this.send(req, res, this.serviceWorker(), "no-cache");
      }
      const entry = this.asset(rel);
      if (!entry) return next();
      // Only the exact current hash earns "immutable"; anything else must revalidate.
      return this.send(req, res, entry, req.query.v === entry.hash ? IMMUTABLE : "no-cache");
    };
  }
}

const OFFLINE_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perch — offline</title><meta name="theme-color" content="${THEME_COLOR}">
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:${THEME_COLOR};color:#f3f5f8;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;padding:24px;box-sizing:border-box}
h1{font-size:22px;margin:0 0 8px;letter-spacing:-.02em}p{margin:0 0 22px;color:#9aa3b2;max-width:320px}
button{height:44px;padding:0 22px;border:0;border-radius:12px;background:#6ea8ff;color:#071018;font:600 15px system-ui,sans-serif}</style>
<div><h1>Can’t reach your Perch</h1><p>The home server isn’t answering. Check this device’s connection, or that the server is running.</p><button onclick="location.reload()">Try again</button></div></html>`;

module.exports = { StaticAssets };
