"use strict";

// In-page half of the ad blocker. `agent` is never called in Node: its source is
// stringified and registered with Page.addScriptToEvaluateOnNewDocument, so it runs in
// every document before any page script. It must stay self-contained (no closures over
// module scope, no require).
//
// It stays dormant until the document's bootstrap script (see adblock.js) calls
// activate(); ad iframes we never looked up therefore cost nothing.
function agent(KEY, BASE_CSS, loadExtended) {
  if (window[KEY]) return;

  const FEATURE_BATCH_MAX = 4000;
  const EXTENDED_MIN_GAP_MS = 400;

  let active = false;
  let sheet = null;
  let cssText = "";
  let extendedRules = [];
  let extendedLib = null;
  let extendedTimer = null;
  let extendedLast = 0;

  const seen = { classes: new Set(), ids: new Set(), hrefs: new Set() };
  let pending = { classes: [], ids: [], hrefs: [] };
  let queue = [];
  let queueTimer = null;

  // Constructed stylesheets are exempt from the page's CSP (a <style> tag is not), and
  // pages cannot find them by walking the DOM.
  function applySheet() {
    try {
      if (!sheet) sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      const adopted = document.adoptedStyleSheets;
      if (!adopted.includes(sheet)) document.adoptedStyleSheets = [...adopted, sheet];
    } catch {
      // document not ready for stylesheets yet; keepAlive() retries
    }
  }

  function addCss(css) {
    if (typeof css !== "string" || !css) return;
    cssText += `\n${css}`;
    applySheet();
  }

  function note(kind, value) {
    if (!value || seen[kind].has(value)) return;
    seen[kind].add(value);
    if (pending[kind].length < FEATURE_BATCH_MAX) pending[kind].push(value);
  }

  function scanElement(el) {
    const tag = el.localName;
    if (tag === "script" || tag === "style" || tag === "link" || tag === "meta" || tag === "br") return;
    if (el.id) note("ids", el.id);
    const list = el.classList;
    for (let i = 0; i < list.length; i += 1) note("classes", list[i]);
    const href = el.getAttribute("href");
    if (href) note("hrefs", href);
  }

  function scanTree(root) {
    if (!root || root.nodeType !== 1) return;
    scanElement(root);
    const all = root.querySelectorAll("[id],[class],[href]");
    for (let i = 0; i < all.length; i += 1) scanElement(all[i]);
  }

  function flushQueue() {
    queueTimer = null;
    const nodes = queue;
    queue = [];
    for (const node of nodes) scanTree(node);
    scheduleExtended();
  }

  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.type === "attributes") queue.push(m.target);
      else for (const node of m.addedNodes) if (node.nodeType === 1) queue.push(node);
    }
    if (queue.length > 512) flushQueue();
    else if (!queueTimer) queueTimer = setTimeout(flushQueue, 40);
  }

  // Procedural filters (:has-text, :upward, :matches-path, :remove() …) cannot be
  // expressed in CSS, so they are evaluated here and re-run as the DOM changes.
  function runExtended() {
    extendedTimer = null;
    extendedLast = Date.now();
    if (!extendedRules.length) return;
    if (!extendedLib) {
      try {
        extendedLib = loadExtended();
      } catch {
        extendedRules = [];
        return;
      }
    }
    const root = document.documentElement;
    if (!root) return;
    for (const rule of extendedRules) {
      try {
        const matches = extendedLib.querySelectorAll(root, rule.ast);
        for (const el of matches) {
          if (rule.attribute) {
            if (!el.hasAttribute(rule.attribute)) el.setAttribute(rule.attribute, "");
          } else if (rule.directive) {
            extendedLib.handlePseudoDirective(el, rule.directive);
          }
        }
      } catch {
        // one bad rule must not stop the rest
      }
    }
  }

  function scheduleExtended() {
    if (!extendedRules.length || extendedTimer) return;
    const wait = Math.max(0, EXTENDED_MIN_GAP_MS - (Date.now() - extendedLast));
    extendedTimer = setTimeout(runExtended, wait);
  }

  function keepAlive() {
    // Some sites reassign document.adoptedStyleSheets and drop our sheet.
    if (sheet && !document.adoptedStyleSheets.includes(sheet)) applySheet();
  }

  function start() {
    scanTree(document.documentElement);
    try {
      new MutationObserver(onMutations).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "id", "href"],
      });
    } catch {
      // ignore
    }
    document.addEventListener("DOMContentLoaded", () => {
      keepAlive();
      scheduleExtended();
    });
    window.addEventListener("load", () => {
      keepAlive();
      scheduleExtended();
    });
    setInterval(keepAlive, 2000);
  }

  // ——— site packs: last line of defence where ads share the content's own origin ———

  function youtubePack() {
    let mutedByUs = false;
    setInterval(() => {
      const player = document.querySelector(".html5-video-player");
      if (!player) return;
      const video = player.querySelector("video");
      const inAd = player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
      if (inAd && video) {
        if (!video.muted) {
          video.muted = true;
          mutedByUs = true;
        }
        if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
          video.currentTime = video.duration;
        }
        const skip = player.querySelector(
          ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-overlay-close-button"
        );
        if (skip) skip.click();
      } else if (mutedByUs && video) {
        video.muted = false;
        mutedByUs = false;
      }
      // "Ad blockers are not allowed" wall: drop it and resume playback.
      const wall = document.querySelector("ytd-enforcement-message-view-model");
      if (wall) {
        const host = wall.closest("tp-yt-paper-dialog, ytd-popup-container > *") || wall;
        host.remove();
        for (const backdrop of document.querySelectorAll("tp-yt-iron-overlay-backdrop")) backdrop.remove();
        if (video && video.paused) video.play().catch(() => {});
      }
    }, 250);
  }

  function runSitePacks() {
    const host = location.hostname;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) youtubePack();
  }

  const api = {
    activate(opts) {
      const o = opts || {};
      if (!active) {
        active = true;
        if (o.generic !== false) addCss(BASE_CSS);
        start();
        runSitePacks();
      }
      addCss(o.css);
      if (Array.isArray(o.extended) && o.extended.length) {
        extendedRules = extendedRules.concat(o.extended);
        scheduleExtended();
      }
    },
    addCss,
    isActive: () => active,
    // A blocked iframe/image would otherwise leave an empty box behind.
    collapse(url) {
      for (const el of document.querySelectorAll("iframe[src],img[src]")) {
        if (el.src === url) el.style.setProperty("display", "none", "important");
      }
    },
    drain() {
      if (!active) return null;
      if (queue.length) flushQueue();
      const out = pending;
      if (!out.classes.length && !out.ids.length && !out.hrefs.length) return null;
      pending = { classes: [], ids: [], hrefs: [] };
      return out;
    },
  };

  Object.defineProperty(window, KEY, { value: api, enumerable: false, configurable: false, writable: false });
}

module.exports = { agent };
