"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { FiltersEngine, Request, fullLists, fetchResources } = require("@ghostery/adblocker");

const { agent } = require("./adblock-agent");

const ENGINE_FILE = "engine.bin";
const ENGINE_RECIPE_FILE = "engine.recipe";
const STATE_FILE = "state.json";
const CUSTOM_FILTERS_FILE = "custom-filters.txt";
const FETCH_TIMEOUT_MS = 30_000;
const UPDATE_CHECK_MS = 60 * 60 * 1000;
const DRAIN_MS = 700;
const EVAL_TIMEOUT_MS = 2_000;
const SUBFRAME_DRAIN_EVERY = 3;
const SUBFRAME_DRAIN_MAX = 12;
const DOCUMENT_BODY_MAX = 12 * 1024 * 1024;
const POPUP_URL_WAIT_MS = 400;
const CHANGE_THROTTLE_MS = 1_000;

const UPDATE_HOURS = Math.max(1, Number(process.env.ADBLOCK_UPDATE_HOURS) || 24);

const ENGINE_CONFIG = {
  loadExtendedSelectors: true,
  guessRequestTypeFromUrl: true,
  // Response headers and bodies cannot be rewritten through Puppeteer's interception.
  loadCSPFilters: false,
  enableHtmlFiltering: false,
};

// The extended-selector evaluator ships as a UMD bundle; giving it a local `module`
// keeps it from leaking a global into the page.
const EXTENDED_LIB_SOURCE = (() => {
  try {
    const file = require.resolve("@ghostery/adblocker-extended-selectors/dist/adblocker.umd.min.js");
    const umd = fs.readFileSync(file, "utf8").replace(/\/\/# sourceMappingURL=.*$/m, "");
    return `function(){var exports={},module={exports:exports};${umd}\n;return module.exports;}`;
  } catch {
    return "function(){throw new Error('extended selectors unavailable')}";
  }
})();

// uBlock Origin publishes its site-specific fixes — anti-adblock walls, YouTube, video
// players — in one file per year (filters-2025.txt, filters-2026.txt …). The engine's
// built-in list set is frozen at the year that library version shipped, so without this
// every fix written since then is simply missing: that is how Dailymotion's detector got
// through. Years the mirror does not have (yet) just 404 and are skipped quietly.
const UBO_MIRROR = "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin";
const UBO_UPSTREAM = "https://ublockorigin.github.io/uAssets/filters";
const UBO_YEARLY_SINCE = 2020;

function yearlyUboLists(now = new Date()) {
  const known = new Set(fullLists);
  const out = [];
  for (let year = UBO_YEARLY_SINCE; year <= now.getUTCFullYear(); year += 1) {
    const url = `${UBO_MIRROR}/filters-${year}.txt`;
    if (!known.has(url)) out.push({ url, fallback: `${UBO_UPSTREAM}/filters-${year}.txt`, optional: true });
  }
  return out;
}

// The day-to-day arms race (YouTube above all) is fought in quick-fixes.txt, where a fix
// can be hours old. The mirror trails upstream, so this one is also read from the source;
// rules present in both are de-duplicated by the engine.
const FRESH_LISTS = [{ url: `${UBO_UPSTREAM}/quick-fixes.txt`, optional: true }];

async function fetchList(list) {
  try {
    return await fetchText(list.url);
  } catch (err) {
    if (list.fallback) return fetchText(list.fallback);
    throw err;
  }
}

function extraListUrls() {
  return String(process.env.ADBLOCK_EXTRA_LISTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

const engineFetch = (url) => fetchText(url).then((text) => ({ text: async () => text }));

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isHttp(url) {
  return /^https?:\/\//i.test(url || "");
}

// URL of the document a request belongs to; blank frames inherit their parent's.
function frameUrl(frame) {
  for (let f = frame; f; f = f.parentFrame()) {
    const url = f.url();
    if (isHttp(url)) return url;
  }
  return "";
}

function requestType(resourceType, isMainFrame) {
  if (resourceType === "document") return isMainFrame ? "main_frame" : "sub_frame";
  return resourceType;
}

function validScriptlet(source) {
  try {
    new vm.Script(source);
    return true;
  } catch {
    return false;
  }
}

// The page's encoding is unknown at this level, so the script is kept pure ASCII and is
// spliced in bytewise. `hash` lets it through a strict Content-Security-Policy.
function toInlineScript(source) {
  const text = source
    .replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");
  const hash = crypto.createHash("sha256").update(text).digest("base64");
  return { html: `<script>${text}</script>`, hash: `'sha256-${hash}'` };
}

// Right after <head …> (or <html …>, or the doctype): early enough to run first,
// late enough not to push the document into quirks mode.
function injectIntoHtml(body, html) {
  const probe = body.subarray(0, 64 * 1024).toString("latin1");
  let at = -1;
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(probe);
    if (m) {
      at = m.index + m[0].length;
      break;
    }
  }
  if (at < 0) {
    if (!/<[a-z!]/i.test(probe)) return null;
    at = 0;
  }
  return Buffer.concat([body.subarray(0, at), Buffer.from(html, "latin1"), body.subarray(at)]);
}

// Allow exactly our inline script. A policy that already relies on 'unsafe-inline' must
// be left alone: adding a hash would make browsers ignore that keyword and break the site.
function patchCsp(policy, hash) {
  const directives = policy.split(";").map((d) => d.trim()).filter(Boolean);
  const names = directives.map((d) => d.split(/\s+/)[0].toLowerCase());
  let idx = names.indexOf("script-src-elem");
  if (idx < 0) idx = names.indexOf("script-src");
  if (idx < 0) idx = names.indexOf("default-src");
  if (idx < 0) return policy;
  const value = directives[idx];
  const pinned = /'(nonce|sha256|sha384|sha512)-/i.test(value);
  if (/'unsafe-inline'/i.test(value) && !pinned) return policy;
  if (/'none'/i.test(value)) directives[idx] = value.replace(/'none'/gi, "").trim();
  directives[idx] += ` ${hash}`;
  return directives.join("; ");
}

function patchHeaders(headers, hash) {
  const out = [];
  for (const h of headers) {
    const name = h.name.toLowerCase();
    // The body handed back is decoded and longer than the original.
    if (name === "content-length" || name === "content-encoding" || name === "transfer-encoding") continue;
    if (name === "content-security-policy") out.push({ name: h.name, value: patchCsp(h.value, hash) });
    else out.push(h);
  }
  return out;
}

class AdBlocker {
  constructor({ dataDir, getActivePage, getPages, onChange, engine } = {}) {
    this.dataDir = dataDir || null;
    this.getActivePage = getActivePage || (() => null);
    this.getPages = getPages || (async () => []);
    this.onChange = onChange || (() => {});
    this.engine = engine || null;
    this.status = "off"; // off | loading | on | error
    this.error = null;
    this.builtAt = engine ? Date.now() : 0;
    this.total = 0;
    this.enabled = this._loadEnabled();

    // Unguessable per process, so pages cannot probe for the agent by name.
    this._key = `__p${crypto.randomBytes(9).toString("hex")}`;
    this._agentSource = "";
    this._contexts = new Map(); // page -> ctx
    this._enginePromise = null;
    this._drainTimer = null;
    this._drainBusy = false;
    this._drainTick = 0;
    this._updateTimer = null;
    this._changeTimer = null;
    if (this.engine) this._buildAgentSource();
  }

  // ——— state ———

  _file(name) {
    return this.dataDir ? path.join(this.dataDir, name) : null;
  }

  _loadEnabled() {
    const fallback = String(process.env.ADBLOCK || "0") === "1";
    const file = this._file(STATE_FILE);
    if (!file) return fallback;
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      return typeof state.enabled === "boolean" ? state.enabled : fallback;
    } catch {
      return fallback;
    }
  }

  _saveEnabled() {
    const file = this._file(STATE_FILE);
    if (!file) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ enabled: this.enabled }));
    } catch (err) {
      console.error(`[adblock] could not save state: ${err.message}`);
    }
  }

  state(page) {
    const ctx = page && this._contexts.get(page);
    return {
      enabled: this.enabled,
      status: this.enabled ? this.status : "off",
      blocked: ctx ? ctx.blocked : 0,
      total: this.total,
      error: this.error,
    };
  }

  _changed(now) {
    if (now) {
      clearTimeout(this._changeTimer);
      this._changeTimer = null;
      this.onChange();
      return;
    }
    if (this._changeTimer) return;
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      this.onChange();
    }, CHANGE_THROTTLE_MS);
  }

  // ——— engine ———

  async _buildEngine() {
    const sources = [
      ...fullLists.map((url) => ({ url })),
      ...yearlyUboLists(),
      ...FRESH_LISTS,
      ...extraListUrls().map((url) => ({ url })),
    ];
    const urls = sources.map((s) => s.url);
    const results = await Promise.allSettled(sources.map(fetchList));
    const lists = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") lists.push(r.value);
      else if (!sources[i].optional) console.error(`[adblock] list failed: ${urls[i]} (${r.reason && r.reason.message})`);
    });
    if (lists.length === 0) throw new Error("no filter list could be downloaded");
    const custom = this._file(CUSTOM_FILTERS_FILE);
    if (custom && fs.existsSync(custom)) lists.push(fs.readFileSync(custom, "utf8"));

    const engine = FiltersEngine.parse(lists.join("\n"), ENGINE_CONFIG);
    // Scriptlets and redirect stubs (noop scripts, a fake IMA SDK, …) come from uBlock
    // Origin's resources; without them YouTube/video-ad filters are inert.
    try {
      const resources = await fetchResources(engineFetch);
      engine.updateResources(resources, String(resources.length));
    } catch (err) {
      console.error(`[adblock] resources failed: ${err.message}`);
    }
    console.log(`[adblock] engine built from ${lists.length}/${urls.length} lists`);
    return engine;
  }

  // Which lists (and engine options) a cached engine was built from. When a Perch update
  // changes the recipe, the cache is stale by definition — rebuild now, not in a day.
  _recipe() {
    const urls = [...fullLists, ...yearlyUboLists().map((l) => l.url), ...FRESH_LISTS.map((l) => l.url), ...extraListUrls()];
    return crypto.createHash("sha256").update(JSON.stringify([urls, ENGINE_CONFIG])).digest("hex");
  }

  _readCachedEngine() {
    const file = this._file(ENGINE_FILE);
    if (!file) return null;
    try {
      if (fs.readFileSync(this._file(ENGINE_RECIPE_FILE), "utf8").trim() !== this._recipe()) return null;
      const engine = FiltersEngine.deserialize(fs.readFileSync(file));
      this.builtAt = fs.statSync(file).mtimeMs;
      return engine;
    } catch {
      // missing, corrupt, or written by another engine version
      return null;
    }
  }

  _writeCachedEngine(engine) {
    const file = this._file(ENGINE_FILE);
    if (!file) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, engine.serialize());
      fs.renameSync(tmp, file);
      fs.writeFileSync(this._file(ENGINE_RECIPE_FILE), this._recipe());
    } catch (err) {
      console.error(`[adblock] could not cache engine: ${err.message}`);
    }
  }

  _buildAgentSource() {
    // Generic rules that are not keyed by class/id/href; identical for every site, so
    // they travel once with the agent instead of with each hostname's bootstrap.
    const base = this.engine.getCosmeticsFilters({
      url: "https://generic.invalid/",
      hostname: "generic.invalid",
      domain: "generic.invalid",
      getBaseRules: true,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromDOM: false,
      getRulesFromHostname: false,
    });
    this._agentSource = `(${agent.toString()})(${JSON.stringify(this._key)},${JSON.stringify(
      base.styles || ""
    )},${EXTENDED_LIB_SOURCE});`;
  }

  ensureEngine() {
    if (this.engine) return Promise.resolve(this.engine);
    if (this._enginePromise) return this._enginePromise;
    this.status = "loading";
    this.error = null;
    this._changed(true);
    this._enginePromise = (async () => {
      try {
        let engine = this._readCachedEngine();
        if (!engine) {
          engine = await this._buildEngine();
          this.builtAt = Date.now();
          this._writeCachedEngine(engine);
        }
        this.engine = engine;
        this._buildAgentSource();
        return engine;
      } catch (err) {
        this.status = "error";
        this.error = err.message;
        console.error(`[adblock] engine unavailable: ${err.message}`);
        this._changed(true);
        throw err;
      } finally {
        this._enginePromise = null;
      }
    })();
    return this._enginePromise;
  }

  async _refreshEngine() {
    if (!this.enabled || !this.engine || !this.dataDir) return;
    if (Date.now() - this.builtAt < UPDATE_HOURS * 3600_000) return;
    try {
      const engine = await this._buildEngine();
      this.builtAt = Date.now();
      this._writeCachedEngine(engine);
      this.engine = engine;
      this._buildAgentSource();
      // Re-register the agent so new documents get the new generic rules.
      const pages = [...this._contexts.keys()];
      for (const page of pages) await this.detach(page);
      for (const page of pages) await this.attach(page);
      console.log("[adblock] filter lists refreshed");
    } catch (err) {
      // keep serving the previous engine
      console.error(`[adblock] refresh failed: ${err.message}`);
    }
  }

  // ——— lifecycle ———

  async start() {
    if (!this.enabled) return;
    try {
      await this.ensureEngine();
    } catch {
      return;
    }
    if (!this.enabled) return;
    this.status = "on";
    // Listed only now: tabs may have opened while the lists were downloading.
    for (const page of await this.getPages()) await this.attach(page);
    this._startTimers();
    this._changed(true);
  }

  async setEnabled(enabled) {
    enabled = Boolean(enabled);
    if (enabled === this.enabled && (!enabled || this.status === "on")) return this.enabled;
    this.enabled = enabled;
    this._saveEnabled();
    if (enabled) {
      await this.start();
    } else {
      this.status = "off";
      this._stopTimers();
      for (const page of [...this._contexts.keys()]) await this.detach(page);
      this._changed(true);
    }
    return this.enabled;
  }

  _startTimers() {
    if (!this._drainTimer) {
      this._drainTimer = setInterval(() => this._drain(), DRAIN_MS);
      this._drainTimer.unref();
    }
    if (!this._updateTimer) {
      this._updateTimer = setInterval(() => this._refreshEngine(), UPDATE_CHECK_MS);
      this._updateTimer.unref();
      this._refreshEngine();
    }
  }

  _stopTimers() {
    clearInterval(this._drainTimer);
    clearInterval(this._updateTimer);
    this._drainTimer = null;
    this._updateTimer = null;
  }

  // Chromium restarted: the old pages are gone, their contexts with them.
  reset() {
    this._contexts.clear();
  }

  stop() {
    this._stopTimers();
    clearTimeout(this._changeTimer);
    this._changeTimer = null;
    this._contexts.clear();
  }

  // ——— per-page wiring ———

  // Idempotent; safe to call every time a page becomes the active view.
  async attach(page, { popup = false } = {}) {
    if (!this.enabled || !this.engine || !page || page.isClosed()) return;
    let ctx = this._contexts.get(page);
    if (ctx) return ctx.ready;
    ctx = {
      page,
      blocked: 0,
      popup,
      committed: false,
      agentId: null,
      cdp: null,
      onRequest: (req) => this._onRequest(ctx, req),
      onNavigated: (frame) => {
        if (frame === page.mainFrame() && isHttp(frame.url())) ctx.committed = true;
        this._lateActivate(frame).catch(() => {});
      },
      onClose: () => this._contexts.delete(page),
      ready: null,
    };
    this._contexts.set(page, ctx);
    ctx.ready = (async () => {
      try {
        const { identifier } = await page.evaluateOnNewDocument(this._agentSource);
        ctx.agentId = identifier;
        page.on("request", ctx.onRequest);
        page.on("framenavigated", ctx.onNavigated);
        page.once("close", ctx.onClose);
        await page.setRequestInterception(true);
        // Puppeteer only intercepts at the request stage. Documents are also paused at
        // the response stage, on a session of our own, to splice the bootstrap in.
        ctx.cdp = await page.createCDPSession();
        ctx.cdp.on("Fetch.requestPaused", (ev) => this._onDocumentResponse(ctx, ev));
        await ctx.cdp.send("Fetch.enable", {
          patterns: [{ urlPattern: "http*", resourceType: "Document", requestStage: "Response" }],
        });
      } catch (err) {
        this._contexts.delete(page);
        if (!page.isClosed()) console.error(`[adblock] attach failed: ${err.message}`);
      }
    })();
    return ctx.ready;
  }

  async detach(page) {
    const ctx = this._contexts.get(page);
    if (!ctx) return;
    this._contexts.delete(page);
    await ctx.ready;
    page.off("request", ctx.onRequest);
    page.off("framenavigated", ctx.onNavigated);
    page.off("close", ctx.onClose);
    if (page.isClosed()) return;
    await page.setRequestInterception(false).catch(() => {});
    if (ctx.cdp) await ctx.cdp.detach().catch(() => {});
    if (ctx.agentId) await page.removeScriptToEvaluateOnNewDocument(ctx.agentId).catch(() => {});
  }

  // ——— network ———

  match(url, sourceUrl, type) {
    const request = Request.fromRawDetails({ url, sourceUrl, type });
    if (request.type === "other") request.guessTypeOfRequest();
    return this.engine.match(request);
  }

  async _onRequest(ctx, req) {
    if (req.isInterceptResolutionHandled()) return;
    try {
      if (!this.enabled || !this.engine) return await req.continue();
      const url = req.url();
      if (!isHttp(url)) return await req.continue();

      const frame = req.frame();
      const resourceType = req.resourceType();
      const isDocument = resourceType === "document" && req.isNavigationRequest();
      const isMainFrame = isDocument && Boolean(frame) && frame.parentFrame() === null;

      if (isMainFrame) {
        // Never block what the user navigates to — except a script-opened window whose
        // very first destination is an ad server.
        if (ctx.popup && !ctx.committed && this._isAdPopup(url, ctx.openerUrl)) {
          this._countBlocked(ctx);
          await req.abort("blockedbyclient");
          ctx.page.close().catch(() => {});
          return;
        }
        if (req.redirectChain().length === 0) ctx.blocked = 0;
        return await req.continue();
      }

      const sourceUrl = frameUrl(isDocument && frame ? frame.parentFrame() : frame) || ctx.page.url();
      const { match, redirect } = this.match(url, sourceUrl, requestType(resourceType, false));

      if (redirect !== undefined) {
        this._countBlocked(ctx);
        const base64 = redirect.contentType.endsWith(";base64");
        return await req.respond({
          status: 200,
          headers: { "access-control-allow-origin": "*" },
          contentType: base64 ? redirect.contentType.slice(0, -7) : redirect.contentType,
          body: base64 ? Buffer.from(redirect.body, "base64") : redirect.body,
        });
      }
      if (match) {
        this._countBlocked(ctx);
        await req.abort("blockedbyclient");
        if (resourceType === "document" || resourceType === "image") {
          this._collapse(resourceType === "document" && frame ? frame.parentFrame() : frame, url);
        }
        return;
      }
      await req.continue();
    } catch {
      // The request may already be gone (tab closed, navigation cancelled). Never leave
      // one paused: that would hang the page.
      if (!req.isInterceptResolutionHandled()) req.continue().catch(() => {});
    }
  }

  _countBlocked(ctx) {
    ctx.blocked += 1;
    this.total += 1;
    if (ctx.page === this.getActivePage()) this._changed(false);
  }

  _collapse(frame, url) {
    if (!frame || frame.detached) return;
    withTimeout(
      frame.evaluate(
        (key, u) => {
          const a = window[key];
          if (a) a.collapse(u);
        },
        this._key,
        url
      ),
      EVAL_TIMEOUT_MS
    ).catch(() => {});
  }

  // ——— cosmetics and scriptlets ———

  // Hostname-specific styles, procedural filters and scriptlets for one document.
  cosmetics(url) {
    let hostname;
    let domain;
    try {
      ({ hostname, domain } = Request.fromRawDetails({ url, type: "main_frame" }));
    } catch {
      return null;
    }
    if (!hostname) return null;
    const common = { url, hostname, domain, getRulesFromDOM: false };
    const specific = this.engine.getCosmeticsFilters({
      ...common,
      getBaseRules: false,
      getInjectionRules: true,
      getExtendedRules: true,
      getRulesFromHostname: true,
    });
    if (!specific.active) return null;
    // Empty when the site is exempt from generic hiding ($generichide).
    const generic = this.engine.getCosmeticsFilters({
      ...common,
      getBaseRules: true,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: false,
    });
    return {
      opts: {
        generic: Boolean(generic.styles),
        css: specific.styles || "",
        extended: specific.extended || [],
      },
      scriptlets: (specific.scripts || []).filter(validScriptlet),
    };
  }

  // Inline script placed first in <head>, so scriptlets (YouTube's ad-payload pruning
  // etc.) are in place before the page's first own script runs.
  bootstrapSource(url) {
    const cosmetics = this.cosmetics(url);
    if (!cosmetics) return null;
    const scriptlets = cosmetics.scriptlets.map((s) => `try{${s}\n}catch(e){}`).join("\n");
    const source = `(()=>{try{document.currentScript.remove()}catch(e){}
try{window[${JSON.stringify(this._key)}].activate(${JSON.stringify(cosmetics.opts)})}catch(e){}
${scriptlets}
})();`;
    return toInlineScript(source);
  }

  async _onDocumentResponse(ctx, ev) {
    const cdp = ctx.cdp;
    const passThrough = () => cdp.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => {});
    try {
      const headers = ev.responseHeaders || [];
      const header = (name) => (headers.find((h) => h.name.toLowerCase() === name) || {}).value || "";
      const status = ev.responseStatusCode;
      if (
        !this.enabled ||
        !this.engine ||
        ev.responseErrorReason ||
        status < 200 ||
        (status >= 300 && status < 400) ||
        !/^\s*(text\/html|application\/xhtml\+xml)/i.test(header("content-type")) ||
        Number(header("content-length")) > DOCUMENT_BODY_MAX
      ) {
        return await passThrough();
      }
      const script = this.bootstrapSource(ev.request.url);
      if (!script) return await passThrough();

      const res = await cdp.send("Fetch.getResponseBody", { requestId: ev.requestId });
      const body = Buffer.from(res.body, res.base64Encoded ? "base64" : "utf8");
      if (body.length > DOCUMENT_BODY_MAX) return await passThrough();
      const patched = injectIntoHtml(body, script.html);
      if (!patched) return await passThrough();

      await cdp.send("Fetch.fulfillRequest", {
        requestId: ev.requestId,
        responseCode: status,
        responseHeaders: patchHeaders(headers, script.hash),
        body: patched.toString("base64"),
      });
    } catch {
      await passThrough();
    }
  }

  // Safety net for documents the response hook never saw (served by a service worker,
  // restored from the back/forward cache, navigations inside an out-of-process iframe).
  // Scriptlets run late here, which is weaker, but styles and procedural rules still work.
  async _lateActivate(frame) {
    const url = frame.url();
    if (!this.enabled || !this.engine || !isHttp(url) || frame.detached) return;
    const active = await withTimeout(
      frame.evaluate((key) => {
        const a = window[key];
        return a ? a.isActive() : true;
      }, this._key),
      EVAL_TIMEOUT_MS
    );
    if (active) return;
    const cosmetics = this.cosmetics(url);
    if (!cosmetics) return;
    await withTimeout(
      frame.evaluate(
        (key, opts) => {
          const a = window[key];
          if (a && !a.isActive()) a.activate(opts);
        },
        this._key,
        cosmetics.opts
      ),
      EVAL_TIMEOUT_MS
    );
    for (const scriptlet of cosmetics.scriptlets) {
      await withTimeout(frame.evaluate(`try{${scriptlet}\n}catch(e){}`), EVAL_TIMEOUT_MS).catch(() => {});
    }
  }

  // Generic cosmetic rules are keyed by the classes/ids/hrefs present in the DOM. The
  // agent collects new ones as the page mutates; we look them up and push styles back.
  async _drain() {
    if (this._drainBusy || !this.enabled || !this.engine) return;
    const page = this.getActivePage();
    if (!page || page.isClosed() || !this._contexts.has(page)) return;
    this._drainBusy = true;
    this._drainTick += 1;
    try {
      const main = page.mainFrame();
      let frames = [main];
      if (this._drainTick % SUBFRAME_DRAIN_EVERY === 0) {
        frames = frames.concat(
          page
            .frames()
            .filter((f) => f !== main && !f.detached && isHttp(f.url()))
            .slice(0, SUBFRAME_DRAIN_MAX)
        );
      }
      await Promise.all(frames.map((frame) => this._drainFrame(frame).catch(() => {})));
    } finally {
      this._drainBusy = false;
    }
  }

  async _drainFrame(frame) {
    const url = frame.url();
    if (!isHttp(url)) return;
    const features = await withTimeout(
      frame.evaluate((key) => {
        const a = window[key];
        return a ? a.drain() : null;
      }, this._key),
      EVAL_TIMEOUT_MS
    );
    if (!features) return;
    const { hostname, domain } = Request.fromRawDetails({ url, type: "main_frame" });
    const { active, styles } = this.engine.getCosmeticsFilters({
      url,
      hostname,
      domain,
      classes: features.classes,
      ids: features.ids,
      hrefs: features.hrefs,
      getBaseRules: false,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: false,
      getRulesFromDOM: true,
    });
    if (!active || !styles) return;
    await withTimeout(
      frame.evaluate(
        (key, css) => {
          const a = window[key];
          if (a) a.addCss(css);
        },
        this._key,
        styles
      ),
      EVAL_TIMEOUT_MS
    );
  }

  // ——— popups ———

  _isAdPopup(url, openerUrl) {
    if (!isHttp(url)) return false;
    // Anything that would be blocked as an embedded frame is an ad when it arrives as a
    // pop-up/pop-under instead.
    return this.match(url, openerUrl || url, "sub_frame").match === true;
  }

  // For a script-opened window: true once it has been identified as an ad and closed.
  // Otherwise the page is attached (with popup tracking) and the caller may adopt it.
  async screenPopup(target, page) {
    if (!this.enabled || !this.engine) return false;
    const opener = target.opener();
    if (!opener) {
      await this.attach(page);
      return false;
    }
    let openerUrl = "";
    try {
      const openerPage = await opener.page();
      openerUrl = openerPage ? openerPage.url() : "";
    } catch {
      // ignore
    }
    // window.open(url) targets start at about:blank and get their URL a beat later.
    const deadline = Date.now() + POPUP_URL_WAIT_MS;
    while (!isHttp(target.url()) && Date.now() < deadline && !page.isClosed()) {
      await new Promise((r) => setTimeout(r, 40));
    }
    if (this._isAdPopup(target.url(), openerUrl)) {
      this.total += 1;
      const openerCtx = [...this._contexts.values()].find((c) => c.page.target() === opener);
      if (openerCtx) openerCtx.blocked += 1;
      this._changed(false);
      await page.close().catch(() => {});
      return true;
    }
    await this.attach(page, { popup: true });
    const ctx = this._contexts.get(page);
    if (ctx) ctx.openerUrl = openerUrl;
    return false;
  }
}

module.exports = { AdBlocker, yearlyUboLists, requestType, frameUrl, patchCsp, injectIntoHtml, toInlineScript };
