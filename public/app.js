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

  const loadingPage = document.getElementById("loading-page");

  const state = {
    live: false,
    ws: null,
    wsGen: 0,
    reconnectTimer: null,
    waitTimer: null,
    frameW: 1280,
    frameH: 800,
    lastClick: { t: 0, x: 0, y: 0, count: 0 },
    resizeTimer: null,
    pointerDown: false,
    blobUrl: null,
    frameBusy: false,
    pendingFrame: null,
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

  function setLive(on) {
    state.live = on;
    viewport.classList.toggle("is-live", on);
    const waiting = on && !stream.classList.contains("has-frame");
    viewport.classList.toggle("is-waiting", waiting);
    if (waiting) {
      if (loadingPage) loadingPage.textContent = "Loading remote page…";
      armWaitWatchdog();
    } else {
      clearWaitWatchdog();
    }
    if (on) {
      state.frameBusy = false;
    }
    if (!on) {
      clearWaitWatchdog();
      stream.classList.remove("has-frame");
      state.frameBusy = false;
      state.pendingFrame = null;
      if (state.blobUrl) {
        URL.revokeObjectURL(state.blobUrl);
        state.blobUrl = null;
      }
      try {
        const ctx = stream.getContext("2d");
        ctx.clearRect(0, 0, stream.width, stream.height);
      } catch {
        // ignore
      }
      tabTitle.textContent = "New Tab";
      address.value = "";
      setStatus("Start page");
      document.title = "Home Browser — bytetech.cloud";
    }
  }

  function clearWaitWatchdog() {
    if (state.waitTimer) {
      clearTimeout(state.waitTimer);
      state.waitTimer = null;
    }
  }

  function armWaitWatchdog() {
    clearWaitWatchdog();
    state.waitTimer = setTimeout(() => {
      if (!state.live || stream.classList.contains("has-frame")) return;
      if (loadingPage) loadingPage.textContent = "Still waiting for video — reconnecting…";
      connectSocket();
    }, 2500);
  }

  function showFrame(b64) {
    if (!state.live || !b64) return;
    state.pendingFrame = b64;
    if (!state.frameBusy) paintPending();
  }

  function paintPending() {
    const b64 = state.pendingFrame;
    if (!b64) {
      state.frameBusy = false;
      return;
    }
    state.pendingFrame = null;
    state.frameBusy = true;
    const img = new Image();
    const url = `data:image/jpeg;base64,${b64}`;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      state.frameBusy = false;
      if (state.pendingFrame) paintPending();
    };
    img.onload = () => {
      try {
        if (stream.width !== img.naturalWidth || stream.height !== img.naturalHeight) {
          stream.width = img.naturalWidth || state.frameW;
          stream.height = img.naturalHeight || state.frameH;
        }
        const ctx = stream.getContext("2d");
        ctx.drawImage(img, 0, 0);
        stream.classList.add("has-frame");
        viewport.classList.add("is-live");
        viewport.classList.remove("is-waiting");
        clearWaitWatchdog();
      } catch {
        // ignore draw errors
      }
      done();
    };
    img.onerror = done;
    img.src = url;
    if (img.complete && img.naturalWidth) img.onload();
    setTimeout(done, 400);
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      credentials: "include",
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
      return true;
    } catch {
      showLogin();
      return false;
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

  async function go(raw) {
    const url = resolveUrl(raw);
    if (!url) return;
    address.value = url;
    setLive(true);
    setStatus("Loading…");
    try {
      const meta = await api("/api/navigate", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      applyMeta(meta);
    } catch (err) {
      setStatus(err.message || "Navigation failed");
    }
    viewport.focus();
  }

  async function doAction(type) {
    setLive(true);
    setStatus(type === "reload" ? "Reloading…" : "Loading…");
    try {
      const meta = await api("/api/action", {
        method: "POST",
        body: JSON.stringify({ type }),
      });
      applyMeta(meta);
    } catch (err) {
      setStatus(err.message || "Action failed");
    }
    viewport.focus();
  }

  function applyMeta(meta) {
    if (!meta) return;
    if (meta.title) tabTitle.textContent = meta.title;
    if (meta.url) {
      if (meta.url === "about:blank") {
        setLive(false);
        return;
      }
      address.value = meta.url;
      setStatus(meta.url);
      document.title = `${meta.title || "Home Browser"} — bytetech.cloud`;
    }
  }

  omniboxForm.addEventListener("submit", (e) => {
    e.preventDefault();
    go(address.value);
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
      if (isFullscreen()) {
        await document.exitFullscreen();
      } else {
        await shell.requestFullscreen();
      }
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
    state.ws = ws;
    ws.addEventListener("open", () => {
      if (gen !== state.wsGen) return;
      wsDot.classList.add("on");
      sendResize();
    });
    ws.addEventListener("close", () => {
      if (gen !== state.wsGen) return;
      wsDot.classList.remove("on");
      if (appScreen.hidden) return;
      state.reconnectTimer = setTimeout(() => {
        if (gen !== state.wsGen) return;
        connectSocket();
      }, 800);
    });
    ws.addEventListener("error", () => {
      if (gen !== state.wsGen) return;
      wsDot.classList.remove("on");
    });
    ws.addEventListener("message", (ev) => {
      if (gen !== state.wsGen) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "frame" && msg.data) {
        state.frameW = msg.width || state.frameW;
        state.frameH = msg.height || state.frameH;
        showFrame(msg.data);
      } else if (msg.type === "meta") {
        const remote = msg.url && msg.url !== "about:blank";
        if (remote && !state.live) setLive(true);
        if (state.live) applyMeta(msg);
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

  function sendResize() {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      const { width, height } = viewportSize();
      sendWs({ type: "resize", width, height });
    }, 400);
  }

  new ResizeObserver(() => sendResize()).observe(viewport);

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
      prev.count += 1;
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
    const payload = {
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
    };
    sendWs(payload);
  }

  viewport.addEventListener("mousedown", (e) => {
    if (!state.live) return;
    e.preventDefault();
    viewport.focus();
    state.pointerDown = true;
    const p = localPoint(e.clientX, e.clientY);
    sendMouse("down", e, { clickCount: clickCount(p.x, p.y) });
  });

  window.addEventListener("mousemove", (e) => {
    if (!state.live) return;
    if (!state.pointerDown && e.target !== viewport && e.target !== stream) return;
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
    if (!state.pointerDown && e.target !== viewport && e.target !== stream) return;
    state.pointerDown = false;
    sendMouse("up", e);
  });

  viewport.addEventListener("contextmenu", (e) => {
    if (!state.live) return;
    e.preventDefault();
  });

  viewport.addEventListener("wheel", (e) => {
    if (!state.live) return;
    e.preventDefault();
    const p = localPoint(e.clientX, e.clientY);
    sendWs({
      type: "wheel",
      x: p.x,
      y: p.y,
      vw: p.vw,
      vh: p.vh,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      ...mods(e),
    });
  }, { passive: false });

  function touchToMouse(touch, button, buttons) {
    return {
      clientX: touch.clientX,
      clientY: touch.clientY,
      button,
      buttons,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
  }

  viewport.addEventListener("touchstart", (e) => {
    if (!state.live) return;
    e.preventDefault();
    viewport.focus();
    const t = e.changedTouches[0];
    state.pointerDown = true;
    sendMouse("down", touchToMouse(t, 0, 1), { clickCount: 1 });
  }, { passive: false });

  viewport.addEventListener("touchmove", (e) => {
    if (!state.live) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    sendMouse("move", touchToMouse(t, 0, 1));
  }, { passive: false });

  viewport.addEventListener("touchend", (e) => {
    if (!state.live) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    state.pointerDown = false;
    sendMouse("up", touchToMouse(t, 0, 0));
  }, { passive: false });

  function isTypingTarget(el) {
    if (!el) return false;
    if (el === address || el === passwordInput || el === startQ) return true;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  window.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;

    if (e.key === "F11") {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    if (meta && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      address.focus();
      address.select();
      return;
    }

    if (e.key === "Escape" && isFullscreen()) {
      return;
    }

    if (!state.live) return;
    if (isTypingTarget(e.target)) return;

    if (meta && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text) sendWs({ type: "paste", text });
      }).catch(() => {});
      return;
    }

    e.preventDefault();
    sendWs({
      type: "key",
      action: "down",
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      repeat: e.repeat,
      ...mods(e),
    });
  });

  window.addEventListener("keyup", (e) => {
    if (!state.live) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === "F11") return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === "l" || e.key === "L")) return;
    sendWs({
      type: "key",
      action: "up",
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      ...mods(e),
    });
  });

  viewport.addEventListener("paste", (e) => {
    if (!state.live) return;
    const text = e.clipboardData && e.clipboardData.getData("text");
    if (text) {
      e.preventDefault();
      sendWs({ type: "paste", text });
    }
  });

  checkSession();
})();
