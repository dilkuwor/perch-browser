(() => {
  "use strict";

  const loginScreen = document.getElementById("login-screen");
  const appScreen = document.getElementById("app-screen");
  const loginForm = document.getElementById("login-form");
  const passwordInput = document.getElementById("password");
  const loginBtn = document.getElementById("login-btn");
  const loginError = document.getElementById("login-error");
  const shell = document.getElementById("shell");
  const viewport = document.getElementById("viewport");
  const stream = document.getElementById("stream");
  const kbd = document.getElementById("kbd");
  const address = document.getElementById("address");
  const omniboxForm = document.getElementById("omnibox-form");
  const startSearch = document.getElementById("start-search");
  const startQ = document.getElementById("start-q");
  const tabTitle = document.getElementById("tab-title");
  const statusText = document.getElementById("status-text");
  const wsDot = document.getElementById("ws-dot");
  const ipChip = document.getElementById("ip-chip");
  const btnFocus = document.getElementById("btn-focus");
  const btnMaximize = document.getElementById("btn-maximize");
  const btnFullscreen = document.getElementById("btn-fullscreen");
  const btnLogout = document.getElementById("btn-logout");
  const btnBack = document.getElementById("btn-back");
  const btnForward = document.getElementById("btn-forward");
  const btnReload = document.getElementById("btn-reload");
  const btnHome = document.getElementById("btn-home");
  const btnKbd = document.getElementById("btn-kbd");
  const loadingPage = document.getElementById("loading-page");

  const IP_PHRASES = new Set([
    "find my ip",
    "what is my ip",
    "what's my ip",
    "whats my ip",
    "what is myip",
    "ip",
    "my ip",
    "ifconfig.me",
    "ifconfig",
  ]);

  const FRAME_TYPE = 1;
  const FRAME_HEADER_BYTES = 9;
  const TAP_SLOP_PX = 8;
  const LONG_PRESS_MS = 550;

  const isTouchDevice = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  const ctx = stream.getContext("2d", { alpha: false, desynchronized: true }) || stream.getContext("2d");

  const state = {
    live: false,
    ws: null,
    wsGen: 0,
    reconnectTimer: null,
    reconnectDelay: 500,
    frameW: 1280,
    frameH: 800,
    lastClick: { t: 0, x: 0, y: 0, count: 0 },
    downCount: 1,
    resizeTimer: null,
    pointerDown: false,
    epoch: 0,
    minEpoch: 0,
    pendingFrame: null,
    painting: false,
    statusTimer: null,
    wasLive: false,
    prevAddress: "",
    touch: null,
    kbdPrev: "",
    kbdWanted: false,
  };

  function resolveUrl(input) {
    const raw = String(input || "").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    if (IP_PHRASES.has(lower)) return "https://ifconfig.me/";
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
    const looksLikeHost =
      raw.includes(".") ||
      /^localhost(?::\d+)?(?:\/|$)/i.test(raw) ||
      /^\d{1,3}(\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(raw);
    if (!looksLikeHost || /\s/.test(raw)) {
      return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    }
    return `https://${raw}`;
  }

  function showError(msg) {
    loginError.hidden = !msg;
    loginError.textContent = msg || "";
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  // Temporary notice (dialog auto-handled, navigation error) that reverts to the URL.
  function flashStatus(text, ms) {
    setStatus(text);
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(() => {
      if (state.live) setStatus(address.value || "");
    }, ms || 4000);
  }

  function renderLoading(label, url) {
    loadingPage.textContent = "";
    const spin = document.createElement("div");
    spin.className = "spinner";
    const text = document.createElement("div");
    text.textContent = label || "Loading remote page…";
    const wrap = document.createElement("div");
    wrap.appendChild(spin);
    wrap.appendChild(text);
    if (url) {
      const u = document.createElement("span");
      u.className = "loading-url";
      u.textContent = url;
      wrap.appendChild(u);
    }
    loadingPage.appendChild(wrap);
  }

  function clearCanvas() {
    try {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, stream.width, stream.height);
    } catch {
      // ignore
    }
  }

  function showLoading(label, url) {
    viewport.classList.add("is-live", "is-waiting");
    stream.classList.remove("has-frame");
    state.pendingFrame = null;
    clearCanvas();
    renderLoading(label, url);
  }

  function hideLoading() {
    viewport.classList.remove("is-waiting");
    stream.classList.add("has-frame");
  }

  function setLive(on) {
    state.live = on;
    viewport.classList.toggle("is-live", on);
    if (!on) {
      viewport.classList.remove("is-waiting");
      stream.classList.remove("has-frame");
      state.pendingFrame = null;
      clearCanvas();
      tabTitle.textContent = "New Tab";
      address.value = "";
      setStatus("Start page");
      document.title = "Home Browser — bytetech.cloud";
      blurKbd();
    }
  }

  function beginNav(url, label) {
    state.wasLive = state.live;
    state.prevAddress = address.value;
    state.live = true;
    state.minEpoch = state.epoch + 1;
    address.value = url || address.value;
    tabTitle.textContent = "Loading…";
    setStatus(label || "Loading…");
    showLoading(label || "Loading remote page…", url);
  }

  // ——— frames ———

  function decodeHeader(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < FRAME_HEADER_BYTES) return null;
    const dv = new DataView(buf);
    if (dv.getUint8(0) !== FRAME_TYPE) return null;
    return {
      epoch: dv.getUint32(1),
      width: dv.getUint16(5),
      height: dv.getUint16(7),
    };
  }

  function drawBitmap(img, w, h) {
    const iw = img.width || img.naturalWidth || w || state.frameW;
    const ih = img.height || img.naturalHeight || h || state.frameH;
    if (stream.width !== iw || stream.height !== ih) {
      stream.width = iw;
      stream.height = ih;
    }
    ctx.drawImage(img, 0, 0);
    hideLoading();
  }

  function decodeJpeg(bytes) {
    const blob = new Blob([bytes], { type: "image/jpeg" });
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(blob);
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode"));
      };
      img.src = url;
    });
  }

  // Keep only the newest frame while one is decoding, so a slow link never builds a queue.
  async function paintLoop() {
    if (state.painting) return;
    state.painting = true;
    try {
      while (state.pendingFrame) {
        const frame = state.pendingFrame;
        state.pendingFrame = null;
        if (!state.live || frame.epoch < state.minEpoch) continue;
        try {
          const img = await decodeJpeg(frame.bytes);
          if (state.live && frame.epoch >= state.minEpoch) {
            drawBitmap(img, frame.width, frame.height);
          }
          if (img && typeof img.close === "function") img.close();
        } catch {
          // skip a bad frame
        }
      }
    } finally {
      state.painting = false;
    }
  }

  function onBinaryFrame(buf) {
    const header = decodeHeader(buf);
    if (!header) return;
    if (header.epoch < state.minEpoch) return;
    if (header.epoch > state.epoch) state.epoch = header.epoch;
    state.frameW = header.width || state.frameW;
    state.frameH = header.height || state.frameH;
    if (!state.live) return;
    state.pendingFrame = {
      epoch: header.epoch,
      width: header.width,
      height: header.height,
      bytes: new Uint8Array(buf, FRAME_HEADER_BYTES),
    };
    paintLoop();
  }

  // ——— api ———

  async function api(path, opts) {
    const res = await fetch(path, {
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(opts && opts.headers) },
      ...opts,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = new Error((body && body.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function checkSession() {
    try {
      const data = await api("/api/ip");
      enterApp(data.egress_ip);
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    loginScreen.hidden = false;
    appScreen.hidden = true;
    closeSocket();
    setTimeout(() => passwordInput.focus(), 50);
  }

  function enterApp(egressIp) {
    loginScreen.hidden = true;
    appScreen.hidden = false;
    if (egressIp) ipChip.textContent = `IP · ${egressIp}`;
    setLive(false);
    connectSocket();
    refreshIp();
    sendResize();
    viewport.focus();
  }

  async function refreshIp() {
    try {
      const data = await api("/api/ip");
      if (data && data.egress_ip) ipChip.textContent = `IP · ${data.egress_ip}`;
    } catch {
      // ignore
    }
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    loginBtn.disabled = true;
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ password: passwordInput.value }),
      });
      passwordInput.value = "";
      const data = await api("/api/ip");
      enterApp(data.egress_ip);
    } catch (err) {
      showError(err.status === 429
        ? "Too many attempts. Wait a few minutes."
        : (err.message || "Invalid credentials"));
    } finally {
      loginBtn.disabled = false;
    }
  });

  btnLogout.addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
    } catch {
      // ignore
    }
    showLogin();
  });

  function applyMeta(meta) {
    if (!meta) return;
    if (typeof meta.epoch === "number" && meta.epoch > state.epoch) {
      state.epoch = meta.epoch;
    }
    if (meta.url) {
      if (meta.url === "about:blank") {
        setLive(false);
        return;
      }
      if (document.activeElement !== address) address.value = meta.url;
      if (!viewport.classList.contains("is-waiting")) setStatus(meta.url);
      document.title = `${meta.title || "Home Browser"} — bytetech.cloud`;
    }
    if (meta.title && !(viewport.classList.contains("is-waiting") && meta.title === meta.url)) {
      tabTitle.textContent = meta.title;
    }
  }

  // The server never started a navigation: go back to what was on screen.
  function cancelNav(message) {
    state.minEpoch = state.epoch;
    if (state.wasLive) {
      address.value = state.prevAddress || "";
      sendWs({ type: "snapshot" });
    } else {
      setLive(false);
    }
    if (message) flashStatus(message);
  }

  async function go(raw) {
    const url = resolveUrl(raw);
    if (!url) return;
    beginNav(url, "Loading remote page…");
    try {
      const meta = await api("/api/navigate", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      if (meta && meta.error) flashStatus(meta.error);
      else applyMeta(meta);
    } catch (err) {
      cancelNav(err.message || "Navigation failed");
    }
    viewport.focus();
  }

  async function doAction(type) {
    const labels = {
      reload: "Reloading…",
      back: "Going back…",
      forward: "Going forward…",
      home: "Loading home…",
    };
    if (type === "home" || (type === "reload" && state.live)) {
      beginNav(type === "home" ? "" : address.value, labels[type]);
    }
    try {
      const meta = await api("/api/action", {
        method: "POST",
        body: JSON.stringify({ type }),
      });
      applyMeta(meta);
    } catch (err) {
      cancelNav(err.message || "Action failed");
    }
    viewport.focus();
  }

  omniboxForm.addEventListener("submit", (e) => {
    e.preventDefault();
    go(address.value);
  });

  // Select the whole URL when the address bar gains focus, and keep that selection
  // through the mouseup of the click that focused it (mouseup would otherwise collapse it).
  let selectOnUp = false;
  address.addEventListener("focus", () => {
    address.select();
    selectOnUp = true;
  });
  address.addEventListener("mouseup", (e) => {
    if (selectOnUp) e.preventDefault();
    selectOnUp = false;
  });
  address.addEventListener("blur", () => {
    selectOnUp = false;
  });

  startSearch.addEventListener("submit", (e) => {
    e.preventDefault();
    go(startQ.value);
  });

  document.querySelectorAll(".dial").forEach((btn) => {
    btn.addEventListener("click", () => go(btn.getAttribute("data-url")));
  });

  btnBack.addEventListener("click", () => doAction("back"));
  btnForward.addEventListener("click", () => doAction("forward"));
  btnReload.addEventListener("click", () => doAction("reload"));
  btnHome.addEventListener("click", () => doAction("home"));

  btnMaximize.addEventListener("click", () => {
    document.body.classList.toggle("is-maximized");
    btnMaximize.classList.toggle("is-on", document.body.classList.contains("is-maximized"));
    sendResize();
  });

  btnFocus.addEventListener("click", () => {
    document.body.classList.toggle("is-focus");
    btnFocus.classList.toggle("is-on", document.body.classList.contains("is-focus"));
    sendResize();
  });

  function isFullscreen() {
    return Boolean(document.fullscreenElement);
  }

  async function toggleFullscreen() {
    try {
      if (isFullscreen()) await document.exitFullscreen();
      else await shell.requestFullscreen();
    } catch {
      // ignore
    }
  }

  btnFullscreen.addEventListener("click", () => toggleFullscreen());

  document.addEventListener("fullscreenchange", () => {
    const on = isFullscreen();
    document.body.classList.toggle("is-fullscreen", on);
    btnFullscreen.classList.toggle("is-on", on);
    sendResize();
  });

  // ——— socket ———

  function closeSocket() {
    state.wsGen += 1;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.ws) {
      const ws = state.ws;
      state.ws = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    wsDot.classList.remove("on");
  }

  function connectSocket() {
    closeSocket();
    const gen = state.wsGen;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    ws.addEventListener("open", () => {
      if (gen !== state.wsGen) return;
      wsDot.classList.add("on");
      state.reconnectDelay = 500;
      sendResize(true);
    });
    ws.addEventListener("close", () => {
      if (gen !== state.wsGen) return;
      wsDot.classList.remove("on");
      if (appScreen.hidden) return;
      const wait = state.reconnectDelay;
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 8000);
      state.reconnectTimer = setTimeout(() => {
        if (gen !== state.wsGen) return;
        connectSocket();
      }, wait);
    });
    ws.addEventListener("error", () => {
      if (gen !== state.wsGen) return;
      wsDot.classList.remove("on");
    });
    ws.addEventListener("message", (ev) => {
      if (gen !== state.wsGen) return;
      if (ev.data instanceof ArrayBuffer) {
        onBinaryFrame(ev.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "navigating") {
        if (typeof msg.epoch === "number") {
          state.epoch = msg.epoch;
          state.minEpoch = msg.epoch;
        }
        state.live = true;
        showLoading("Loading remote page…", msg.url || "");
        if (msg.url && document.activeElement !== address) address.value = msg.url;
        tabTitle.textContent = "Loading…";
        setStatus("Loading…");
        blurKbd();
        return;
      }
      if (msg.type === "meta") {
        const remote = msg.url && msg.url !== "about:blank";
        if (remote && !state.live) setLive(true);
        if (state.live) applyMeta(msg);
        return;
      }
      if (msg.type === "status" && msg.text) {
        flashStatus(String(msg.text).slice(0, 160), 5000);
        return;
      }
      if (msg.type === "focus") {
        if (msg.editable) focusKbd();
      }
    });
  }

  function sendWs(obj) {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (obj && obj.type === "mouse" && obj.action === "move" && ws.bufferedAmount > 256000) return;
    ws.send(JSON.stringify(obj));
  }

  function viewportSize() {
    const r = viewport.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    };
  }

  function sendResize(now) {
    clearTimeout(state.resizeTimer);
    const fire = () => {
      const { width, height } = viewportSize();
      sendWs({ type: "resize", width, height });
    };
    if (now) fire();
    else state.resizeTimer = setTimeout(fire, 300);
  }

  new ResizeObserver(() => sendResize()).observe(viewport);

  // ——— pointer ———

  function localPoint(clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    return {
      x: clientX - r.left,
      y: clientY - r.top,
      vw: r.width,
      vh: r.height,
    };
  }

  function mods(e) {
    return {
      alt: Boolean(e.altKey),
      ctrl: Boolean(e.ctrlKey),
      meta: Boolean(e.metaKey),
      shift: Boolean(e.shiftKey),
    };
  }

  function clickCount(x, y) {
    const now = Date.now();
    const prev = state.lastClick;
    if (now - prev.t < 400 && Math.hypot(x - prev.x, y - prev.y) < 8) {
      prev.count = Math.min(prev.count + 1, 3);
    } else {
      prev.count = 1;
    }
    prev.t = now;
    prev.x = x;
    prev.y = y;
    return prev.count;
  }

  let moveRaf = 0;
  let moveQueued = null;

  function sendMouse(action, e, extra) {
    if (!state.live) return;
    const p = localPoint(e.clientX, e.clientY);
    sendWs({
      type: "mouse",
      action,
      x: p.x,
      y: p.y,
      vw: p.vw,
      vh: p.vh,
      button: e.button || 0,
      buttons: typeof e.buttons === "number" ? e.buttons : 0,
      clickCount: extra && extra.clickCount ? extra.clickCount : 1,
      ...mods(e),
    });
  }

  viewport.addEventListener("mousedown", (e) => {
    if (!state.live) return;
    e.preventDefault();
    if (document.activeElement !== kbd) viewport.focus();
    state.pointerDown = true;
    const p = localPoint(e.clientX, e.clientY);
    state.downCount = clickCount(p.x, p.y);
    sendMouse("down", e, { clickCount: state.downCount });
  });

  window.addEventListener("mousemove", (e) => {
    if (!state.live) return;
    if (!state.pointerDown && e.target !== viewport && e.target !== stream && e.target !== kbd) return;
    moveQueued = e;
    if (!moveRaf) {
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (moveQueued) sendMouse("move", moveQueued, { clickCount: 1 });
        moveQueued = null;
      });
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (!state.live) return;
    if (!state.pointerDown && e.target !== viewport && e.target !== stream && e.target !== kbd) return;
    state.pointerDown = false;
    sendMouse("up", e, { clickCount: state.downCount });
  });

  viewport.addEventListener("contextmenu", (e) => {
    if (!state.live) return;
    e.preventDefault();
  });

  viewport.addEventListener("wheel", (e) => {
    if (!state.live) return;
    e.preventDefault();
    const p = localPoint(e.clientX, e.clientY);
    let scale = 1;
    if (e.deltaMode === 1) scale = 32;
    else if (e.deltaMode === 2) scale = p.vh;
    sendWs({
      type: "wheel",
      x: p.x,
      y: p.y,
      vw: p.vw,
      vh: p.vh,
      deltaX: e.deltaX * scale,
      deltaY: e.deltaY * scale,
      ...mods(e),
    });
  }, { passive: false });

  // ——— touch: one finger drags scroll, a still finger taps, a long press right-clicks ———

  function touchPoint(t) {
    return { clientX: t.clientX, clientY: t.clientY, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  }

  function sendTap(t, button) {
    const base = touchPoint(t);
    const buttons = button === 2 ? 2 : 1;
    const p = localPoint(t.clientX, t.clientY);
    const count = button === 2 ? 1 : clickCount(p.x, p.y);
    sendMouse("down", { ...base, button, buttons }, { clickCount: count });
    sendMouse("up", { ...base, button, buttons: 0 }, { clickCount: count });
  }

  viewport.addEventListener("touchstart", (e) => {
    if (!state.live) return;
    e.preventDefault();
    if (e.touches.length !== 1) {
      state.touch = null;
      return;
    }
    const t = e.changedTouches[0];
    state.touch = {
      id: t.identifier,
      x: t.clientX,
      y: t.clientY,
      lastX: t.clientX,
      lastY: t.clientY,
      t: Date.now(),
      moved: false,
      done: false,
      timer: setTimeout(() => {
        const cur = state.touch;
        if (!cur || cur.moved || cur.done) return;
        cur.done = true;
        sendTap({ clientX: cur.x, clientY: cur.y }, 2);
      }, LONG_PRESS_MS),
    };
  }, { passive: false });

  viewport.addEventListener("touchmove", (e) => {
    if (!state.live) return;
    e.preventDefault();
    const cur = state.touch;
    if (!cur) return;
    const t = Array.from(e.changedTouches).find((x) => x.identifier === cur.id);
    if (!t) return;
    if (!cur.moved && Math.hypot(t.clientX - cur.x, t.clientY - cur.y) > TAP_SLOP_PX) {
      cur.moved = true;
      clearTimeout(cur.timer);
    }
    if (!cur.moved || cur.done) return;
    const dx = t.clientX - cur.lastX;
    const dy = t.clientY - cur.lastY;
    cur.lastX = t.clientX;
    cur.lastY = t.clientY;
    const p = localPoint(cur.x, cur.y);
    const k = state.frameW / Math.max(1, p.vw);
    sendWs({
      type: "wheel",
      x: p.x,
      y: p.y,
      vw: p.vw,
      vh: p.vh,
      deltaX: -dx * k,
      deltaY: -dy * k,
    });
  }, { passive: false });

  function endTouch(e, cancelled) {
    if (!state.live) return;
    e.preventDefault();
    const cur = state.touch;
    if (!cur) return;
    const t = Array.from(e.changedTouches).find((x) => x.identifier === cur.id);
    if (!t) return;
    clearTimeout(cur.timer);
    state.touch = null;
    if (cancelled || cur.moved || cur.done) return;
    sendTap({ clientX: cur.x, clientY: cur.y }, 0);
    // Ask the server whether the tap landed in a text field, to raise the keyboard.
    sendWs({ type: "probe" });
  }

  viewport.addEventListener("touchend", (e) => endTouch(e, false), { passive: false });
  viewport.addEventListener("touchcancel", (e) => endTouch(e, true), { passive: false });

  // ——— keyboard ———

  function isTypingTarget(el) {
    if (!el) return false;
    if (el === address || el === passwordInput || el === startQ) return true;
    if (el === kbd) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  function keyPayload(action, e) {
    return {
      type: "key",
      action,
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      repeat: Boolean(e.repeat),
      ...mods(e),
    };
  }

  function handleShortcut(e) {
    const meta = e.metaKey || e.ctrlKey;
    if (e.key === "F11") {
      e.preventDefault();
      toggleFullscreen();
      return true;
    }
    if (meta && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      address.focus();
      address.select();
      return true;
    }
    return false;
  }

  window.addEventListener("keydown", (e) => {
    if (handleShortcut(e)) return;
    if (e.key === "Escape" && isFullscreen()) return;
    if (!state.live) return;
    if (isTypingTarget(e.target)) return;
    if (e.target === kbd) {
      onKbdKeydown(e);
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (meta && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then((text) => {
          if (text) sendWs({ type: "paste", text });
        }).catch(() => {});
      }
      return;
    }
    e.preventDefault();
    sendWs(keyPayload("down", e));
  });

  window.addEventListener("keyup", (e) => {
    if (!state.live) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === "F11") return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === "l" || e.key === "L")) return;
    if (e.target === kbd && e.key.length === 1) return;
    if (e.key === "Unidentified" || e.key === "Process") return;
    sendWs(keyPayload("up", e));
  });

  viewport.addEventListener("paste", (e) => {
    if (!state.live) return;
    const text = e.clipboardData && e.clipboardData.getData("text");
    if (text) {
      e.preventDefault();
      sendWs({ type: "paste", text });
    }
  });

  // Phone / virtual keyboards: text lands in the hidden textarea, and the difference
  // against its previous value is forwarded as insertText / Backspace / Enter. This works
  // with autocorrect and composition, which never produce usable keydown events.
  function resetKbd() {
    kbd.value = "";
    state.kbdPrev = "";
  }

  function focusKbd() {
    if (!state.live) return;
    state.kbdWanted = true;
    resetKbd();
    try {
      kbd.focus({ preventScroll: true });
    } catch {
      kbd.focus();
    }
  }

  function blurKbd() {
    state.kbdWanted = false;
    if (document.activeElement === kbd) {
      kbd.blur();
      viewport.focus();
    }
    resetKbd();
  }

  function sendKeyPress(key, keyCode) {
    sendWs({ type: "key", action: "press", key, code: key, keyCode });
  }

  function onKbdKeydown(e) {
    if (e.key === "Unidentified" || e.key === "Process" || e.key === "Dead") return;
    if (e.key === "Backspace") {
      if (kbd.value.length === 0) {
        e.preventDefault();
        sendKeyPress("Backspace", 8);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      resetKbd();
      sendKeyPress("Enter", 13);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      blurKbd();
      return;
    }
    if (e.key.length > 1) {
      e.preventDefault();
      sendWs(keyPayload("down", e));
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      sendWs(keyPayload("down", e));
    }
  }

  kbd.addEventListener("input", () => {
    const now = kbd.value;
    const prev = state.kbdPrev;
    let common = 0;
    const max = Math.min(now.length, prev.length);
    while (common < max && now[common] === prev[common]) common += 1;
    const removed = prev.length - common;
    const added = now.slice(common);
    for (let i = 0; i < removed; i += 1) sendKeyPress("Backspace", 8);
    if (added) {
      const parts = added.split("\n");
      parts.forEach((part, idx) => {
        if (part) sendWs({ type: "paste", text: part });
        if (idx < parts.length - 1) sendKeyPress("Enter", 13);
      });
    }
    state.kbdPrev = now;
    if (now.length > 400 || now.includes("\n")) resetKbd();
  });

  kbd.addEventListener("blur", () => {
    state.kbdWanted = false;
    resetKbd();
    btnKbd.classList.remove("is-on");
  });

  kbd.addEventListener("focus", () => {
    btnKbd.classList.add("is-on");
  });

  btnKbd.addEventListener("click", () => {
    if (!state.live) {
      startQ.focus();
      return;
    }
    if (document.activeElement === kbd) blurKbd();
    else focusKbd();
  });

  if (!isTouchDevice) btnKbd.title = "Keyboard (for touch devices)";

  checkSession();
})();
