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
  const tabsEl = document.getElementById("tabs");
  const btnNewTab = document.getElementById("btn-newtab");
  const btnLatency = document.getElementById("btn-latency");
  const latencyDot = document.getElementById("latency-dot");
  const latencyPanel = document.getElementById("latency-panel");
  const latRtt = document.getElementById("lat-rtt");
  const latFps = document.getElementById("lat-fps");
  const latBw = document.getElementById("lat-bw");
  const latSize = document.getElementById("lat-size");
  const latQuality = document.getElementById("lat-quality");
  const statusText = document.getElementById("status-text");
  const wsDot = document.getElementById("ws-dot");
  const ipChip = document.getElementById("ip-chip");
  const btnFocus = document.getElementById("btn-focus");
  const btnAudio = document.getElementById("btn-audio");
  const btnAdblock = document.getElementById("btn-adblock");
  const adblockCheck = document.getElementById("adblock-check");
  const adblockCount = document.getElementById("adblock-count");
  const audioOnIcon = document.getElementById("audio-on-icon");
  const audioOffIcon = document.getElementById("audio-off-icon");
  const latAudio = document.getElementById("lat-audio");
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
  // The instance identity shown around the UI: whatever host this page was opened on
  // (perch.example.com, a LAN IP, localhost, ...) rather than a hardcoded domain.
  const HOST_LABEL = location.hostname || "this device";
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
    tabs: [],
    activeTab: null,
    tabsUnsupported: false,
    latencyTimer: null,
    adblock: false,
    hitSeq: 0,
    remoteFs: false,
    fsByRemote: false,
    settings: null,
    settingsOpen: false,
    hasCustomBg: false,
    searchUrl: "https://www.google.com/search?q=%s",
    rtt: null,
    stream: null,
    wheel: null,
    wheelFrame: 0,
    fallbackTimer: null,
    editable: null, // { epoch, w, h, rects } — where the remote page's text fields are
    lastHit: null,
    kbdUnsure: false, // the keyboard was raised on a guess; a probe may take it down

    statFrames: 0,
    statBytes: 0,
    statAt: 0,
  };

  // ——— tabs ———

  function setTabTitle(text) {
    const el = tabsEl.querySelector(".tab.active .tab-title");
    if (el) el.textContent = text;
  }

  // A single placeholder so the strip is never empty before the server list arrives.
  function seedTabs() {
    if (state.tabs.length) return;
    renderTabs([{ id: "local", url: "about:blank", title: "New Tab", active: true }], "local");
  }

  // Belt-and-suspenders: the tab list normally arrives as a WebSocket push, but fetch it
  // over HTTP too so a missed push (or a proxy that drops the message) still fills the strip.
  async function refreshTabs() {
    try {
      const data = await api("/api/tabs");
      if (data && Array.isArray(data.tabs)) renderTabs(data.tabs, data.active);
    } catch (err) {
      // An old server without /api/tabs: keep the placeholder rather than blanking the strip.
      if (err && err.status === 404) {
        markTabsUnsupported();
        seedTabs();
      }
    }
  }

  function renderTabs(tabs, active) {
    // Never blank the strip on an empty/failed list; keep what is already shown.
    if (!Array.isArray(tabs) || tabs.length === 0) {
      seedTabs();
      return;
    }
    state.tabs = tabs;
    state.activeTab = active || (tabs.find((t) => t.active) || {}).id || null;
    tabsEl.textContent = "";
    for (const tab of state.tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab.id === state.activeTab ? " active" : "");
      el.setAttribute("role", "tab");
      el.dataset.id = tab.id;
      el.title = tab.url || "";
      const dot = document.createElement("span");
      dot.className = "tab-favicon";
      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.title || tab.url || "New Tab";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.setAttribute("aria-label", "Close tab");
      close.textContent = "×";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        tabAction("close", tab.id);
      });
      el.appendChild(dot);
      el.appendChild(title);
      el.appendChild(close);
      el.addEventListener("click", () => {
        if (tab.id !== state.activeTab) tabAction("switch", tab.id);
      });
      el.addEventListener("auxclick", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          tabAction("close", tab.id);
        }
      });
      tabsEl.appendChild(el);
    }
    const activeEl = tabsEl.querySelector(".tab.active");
    if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // Old server without tab support: say so loudly and once, not a silent flash.
  function markTabsUnsupported() {
    if (state.tabsUnsupported) return;
    state.tabsUnsupported = true;
    btnNewTab.title = "Tabs need a newer server — restart / redeploy it";
    btnNewTab.classList.add("is-stale");
    flashStatus("This server is out of date — restart it to enable tabs.", 8000);
    console.warn("[home-browser] /api/tab is missing; the running server is an older build.");
  }

  async function tabAction(action, id, url) {
    if (!id || id === "local") {
      // The seeded placeholder has no real server id; only "new" is meaningful on it.
      if (action !== "new") return;
    }
    try {
      const meta = await api("/api/tab", {
        method: "POST",
        body: JSON.stringify({ action, id, url }),
      });
      if (meta && meta.url === "about:blank") setLive(false);
      else if (meta) applyMeta(meta);
      state.tabsUnsupported = false;
      btnNewTab.classList.remove("is-stale");
      refreshTabs();
    } catch (err) {
      if (err && err.status === 404) markTabsUnsupported();
      else flashStatus(err.message || "Tab action failed");
    }
    viewport.focus();
  }

  btnNewTab.addEventListener("click", () => tabAction("new"));

  // ——— settings ———

  // Settings live on the server and are pushed to every device. A copy in localStorage
  // only exists so the top bar does not flash hidden tools in before the first reply.
  const SETTINGS_CACHE_KEY = "perch.settings";
  const BG_MAX_W = 2560;
  const BG_MAX_H = 1600;
  const btnSettings = document.getElementById("btn-settings");
  const settingsPage = document.getElementById("settings-page");
  const settingsBody = document.getElementById("settings-body");
  const settingsSaved = document.getElementById("settings-saved");
  const startPage = document.getElementById("start-page");
  const bgFile = document.getElementById("bg-file");
  const bgUpload = document.getElementById("bg-upload");
  const bgRemove = document.getElementById("bg-remove");
  const bgError = document.getElementById("bg-error");
  const bgThumbCustom = document.getElementById("bg-thumb-custom");
  const setAdblock = document.getElementById("set-adblock");
  const searchEngineSelect = document.getElementById("set-search-engine");
  const homeUrlInput = document.getElementById("set-home-url");
  const TOOL_ELEMENTS = {
    latency: document.querySelector(".latency-wrap"),
    adblock: btnAdblock,
    audio: btnAudio,
    focus: document.getElementById("btn-focus"),
    maximize: document.getElementById("btn-maximize"),
    home: document.getElementById("btn-home"),
    keyboard: document.getElementById("btn-kbd"),
    statusbar: document.getElementById("statusbar"),
  };
  let savedTimer = null;
  let saveTimer = null;
  let pendingPatch = {};

  function getPath(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  function customBgUrl(s) {
    return `/api/background?v=${s.backgroundVersion}`;
  }

  // "system" follows the device, so the same setting can resolve differently on a phone
  // and a laptop. The resolved value goes on <html>; the choice is cached for the inline
  // script in index.html, which themes the page before first paint.
  const THEME_KEY = "perch.theme";
  const THEME_COLORS = { dark: "#07080b", light: "#e6eaf2" };
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)");

  // Bundled images carry their content hash, so they are cached forever yet a replaced
  // file shows up at once (the hashes arrive with the page, in window.__PERCH).
  function assetUrl(rel) {
    const hash = window.__PERCH && window.__PERCH.assets && window.__PERCH.assets[rel];
    return hash ? `${rel}?v=${hash}` : rel;
  }

  // Bundled wallpapers: "dark" and "light" are explicit picks. "default" (from older
  // settings) still follows the chrome theme. A custom image is left alone.
  function applyWallpaper() {
    const s = state.settings;
    if (!s) return;
    const bg = s.newTab.background;
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const bundled = bg === "dark" || bg === "light" ? bg : bg === "default" ? theme : "";
    const url = bg === "custom" ? customBgUrl(s) : bundled ? assetUrl(`img/newtab-${bundled}.webp`) : "";
    startPage.classList.toggle("has-bg", Boolean(url));
    startPage.style.setProperty("--start-bg", url ? `url("${url}")` : "none");
  }

  function applyTheme(theme) {
    const choice = theme === "light" || theme === "system" ? theme : "dark";
    const resolved = choice === "system" ? (prefersLight.matches ? "light" : "dark") : choice;
    document.documentElement.dataset.theme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEME_COLORS[resolved];
    applyWallpaper();
    for (const btn of settingsPage.querySelectorAll("[data-theme-choice]")) {
      btn.setAttribute("aria-checked", String(btn.dataset.themeChoice === choice));
    }
    try {
      localStorage.setItem(THEME_KEY, choice);
    } catch {
      // ignore
    }
  }

  prefersLight.addEventListener("change", () => {
    if (state.settings && state.settings.appearance.theme === "system") applyTheme("system");
  });

  function applySettings(payload) {
    if (!payload || !payload.settings) return;
    const s = payload.settings;
    // A server from before themes existed sends no appearance block. The theme then
    // lives on this device only, rather than snapping back to dark.
    if (!s.appearance) {
      let local = null;
      try {
        local = localStorage.getItem(THEME_KEY);
      } catch {
        // ignore
      }
      s.appearance = { theme: local || "dark" };
    }
    applyTheme(s.appearance.theme);
    state.settings = s;
    if (payload.searchUrl) state.searchUrl = payload.searchUrl;
    if (typeof payload.hasCustomBackground === "boolean") state.hasCustomBg = payload.hasCustomBackground;
    try {
      localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ settings: s, searchUrl: state.searchUrl }));
    } catch {
      // private mode / storage full: the cache is only a nicety
    }

    for (const [key, el] of Object.entries(TOOL_ELEMENTS)) {
      if (el) el.classList.toggle("is-user-hidden", s.toolbar[key] === false);
    }
    if (s.toolbar.latency === false) toggleLatency(false);

    applyWallpaper();
    startPage.style.setProperty("--start-dim", String(s.newTab.dim / 100));
    startPage.classList.toggle("no-search", !s.newTab.search);
    startPage.classList.toggle("no-shortcuts", !s.newTab.shortcuts);

    renderSettingsForm(payload);
  }

  function renderSettingsForm(payload) {
    const s = state.settings;
    if (payload.searchEngines && searchEngineSelect.options.length === 0) {
      for (const engine of payload.searchEngines) searchEngineSelect.add(new Option(engine.label, engine.id));
    }
    if (payload.defaultHomeUrl) homeUrlInput.placeholder = payload.defaultHomeUrl;
    const engine = searchEngineSelect.querySelector(`option[value="${s.browsing.searchEngine}"]`);
    if (engine) {
      address.placeholder = `Search ${engine.textContent} or type a URL`;
      startQ.placeholder = address.placeholder;
    }
    for (const input of settingsPage.querySelectorAll("[data-setting]")) {
      // Never overwrite what the user is in the middle of typing or dragging.
      if (input === document.activeElement && input.type !== "checkbox") continue;
      const value = getPath(s, input.dataset.setting);
      if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = value == null ? "" : String(value);
    }
    for (const out of settingsPage.querySelectorAll("[data-output]")) {
      out.textContent = `${getPath(s, out.dataset.output)}${out.dataset.suffix || ""}`;
    }
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const selectedBg = s.newTab.background === "default" ? theme : s.newTab.background;
    for (const choice of settingsPage.querySelectorAll(".bg-choice")) {
      const kind = choice.dataset.bg;
      choice.setAttribute("aria-checked", String(selectedBg === kind));
      if (kind === "custom") choice.disabled = !state.hasCustomBg;
    }
    bgThumbCustom.style.backgroundImage = state.hasCustomBg ? `url("${customBgUrl(s)}")` : "";
    bgRemove.hidden = !state.hasCustomBg;
  }

  // The page is read from disk on every load but API routes only when the server starts,
  // so after an update the new page can be talking to an old process. Say so plainly
  // instead of surfacing that process's bare 404.
  const STALE_SERVER = "The Perch server is running an older version — restart it to use settings";

  function saveError(prefix, err) {
    showSaved(err && err.status === 404 ? STALE_SERVER : `${prefix}: ${err.message}`, true);
  }

  function showSaved(text, isError) {
    settingsSaved.textContent = text;
    settingsSaved.classList.toggle("is-error", Boolean(isError));
    settingsSaved.classList.add("is-visible");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => settingsSaved.classList.remove("is-visible"), isError ? 6000 : 1600);
  }

  // Changes save themselves; rapid ones (dragging a slider) are folded into one request.
  function queueSave(path, value) {
    const [section, key] = path.split(".");
    pendingPatch[section] = { ...pendingPatch[section], [key]: value };
    if (state.settings) {
      state.settings[section][key] = value;
      applySettings({ settings: state.settings });
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 250);
  }

  async function flushSave() {
    const patch = pendingPatch;
    pendingPatch = {};
    try {
      const reply = await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
      // An older server answers 200 but silently drops sections it has never heard of.
      const dropped = Object.keys(patch).filter((section) => !(reply.settings && section in reply.settings));
      for (const section of dropped) reply.settings[section] = { ...state.settings[section], ...patch[section] };
      // …or clamps a number to a limit it had before an update (e.g. quality 100 -> 95).
      const clamped = Object.entries(patch).some(([section, values]) =>
        Object.entries(values).some(
          ([key, value]) => typeof value === "number" && reply.settings[section] && reply.settings[section][key] !== value
        )
      );
      applySettings(reply);
      if (dropped.length) showSaved(STALE_SERVER.replace("to use settings", "to keep this setting"), true);
      else if (clamped) showSaved("The server changed that value — if Perch was just updated, restart the server", true);
      else showSaved("Saved");
    } catch (err) {
      saveError("Could not save", err);
      if (err.status !== 404) loadSettings();
    }
  }

  async function loadSettings() {
    try {
      applySettings(await api("/api/settings"));
    } catch (err) {
      // An older server without settings: everything simply stays visible.
      if (err.status === 404 && state.settingsOpen) showSaved(STALE_SERVER, true);
    }
  }

  function toggleSettings(show) {
    const on = show == null ? settingsPage.hidden : show;
    if (on === !settingsPage.hidden) return;
    settingsPage.hidden = !on;
    state.settingsOpen = on;
    btnSettings.classList.toggle("is-on", on);
    btnSettings.setAttribute("aria-expanded", String(on));
    if (on) {
      toggleLatency(false);
      blurKbd();
      loadSettings();
      refreshAbout();
      refreshCache();
      settingsBody.scrollTop = 0;
      document.getElementById("settings-close").focus({ preventScroll: true });
    } else {
      viewport.focus();
    }
  }

  async function refreshAbout() {
    document.getElementById("about-ip").textContent = ipChip.textContent.replace(/^IP · /, "");
    try {
      const health = await api("/health");
      if (health.user) document.getElementById("pw-user").value = health.user;
      document.getElementById("about-server").textContent =
        `build ${health.build ?? "?"} · ${(health.features || []).join(", ")}`;
    } catch {
      // ignore
    }
  }

  // Phones shoot 12-megapixel HEIC/JPEG files; the wallpaper never needs more than the
  // screen can show. Decode, scale down (never up) and re-encode as WebP, falling back to
  // JPEG where the browser cannot encode WebP. The aspect ratio is kept: the page crops
  // with `background-size: cover`, which suits every screen shape better than a fixed crop.
  async function prepareBackground(file) {
    let source;
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      throw new Error("This file is not an image this browser can read");
    }
    const scale = Math.min(1, BG_MAX_W / source.width, BG_MAX_H / source.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (source.close) source.close();
    const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    let blob = await encode("image/webp", 0.86);
    if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg", 0.88);
    if (!blob) throw new Error("Could not convert the image");
    return blob;
  }

  async function uploadBackground(file) {
    bgError.hidden = true;
    bgUpload.disabled = true;
    bgUpload.textContent = "Converting…";
    try {
      const blob = await prepareBackground(file);
      bgUpload.textContent = "Uploading…";
      applySettings(
        await api("/api/settings/background", { method: "PUT", headers: { "Content-Type": blob.type }, body: blob })
      );
      showSaved("Background updated");
    } catch (err) {
      bgError.textContent = err.status === 404 ? STALE_SERVER : err.message;
      bgError.hidden = false;
    } finally {
      bgUpload.disabled = false;
      bgUpload.textContent = "Upload image…";
      bgFile.value = "";
    }
  }

  // The shortcut hint names the modifier this device actually has.
  const IS_APPLE = /mac|iphone|ipad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "");
  document.getElementById("start-kbd").textContent = IS_APPLE ? "⌘ K" : "Ctrl K";

  // ——— phone: tools live behind a "⋯" button ———

  const btnMore = document.getElementById("btn-more");
  const titlebarEl = document.getElementById("titlebar");

  function toggleTools(show) {
    const on = show == null ? !titlebarEl.classList.contains("is-tools-open") : show;
    titlebarEl.classList.toggle("is-tools-open", on);
    btnMore.classList.toggle("is-on", on);
    btnMore.setAttribute("aria-expanded", String(on));
    if (!on) toggleLatency(false);
  }

  btnMore.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTools();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!titlebarEl.classList.contains("is-tools-open")) return;
    if (e.target.closest("#titlebar-actions") || e.target.closest("#btn-more")) return;
    toggleTools(false);
  });
  // Opening settings, going fullscreen or signing out should not leave the tray hanging.
  for (const id of ["btn-settings", "btn-fullscreen", "btn-logout", "btn-focus"]) {
    document.getElementById(id).addEventListener("click", () => toggleTools(false));
  }

  btnSettings.addEventListener("click", () => toggleSettings());
  document.getElementById("settings-close").addEventListener("click", () => toggleSettings(false));

  settingsPage.addEventListener("input", (e) => {
    const input = e.target.closest("[data-setting]");
    if (!input || input.type === "checkbox" || input.type === "url" || input.tagName === "SELECT") return;
    queueSave(input.dataset.setting, Number(input.value));
  });

  settingsPage.addEventListener("change", (e) => {
    const input = e.target.closest("[data-setting]");
    if (!input || input.type === "range") return;
    queueSave(input.dataset.setting, input.type === "checkbox" ? input.checked : input.value.trim());
  });

  homeUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") homeUrlInput.blur();
  });

  for (const btn of settingsPage.querySelectorAll("[data-theme-choice]")) {
    btn.addEventListener("click", () => queueSave("appearance.theme", btn.dataset.themeChoice));
  }

  for (const choice of settingsPage.querySelectorAll(".bg-choice")) {
    choice.addEventListener("click", () => queueSave("newTab.background", choice.dataset.bg));
  }

  bgUpload.addEventListener("click", () => bgFile.click());
  bgFile.addEventListener("change", () => {
    if (bgFile.files && bgFile.files[0]) uploadBackground(bgFile.files[0]);
  });
  bgRemove.addEventListener("click", async () => {
    try {
      applySettings(await api("/api/settings/background", { method: "DELETE" }));
      showSaved("Your image was removed");
    } catch (err) {
      saveError("Could not remove", err);
    }
  });

  setAdblock.addEventListener("change", () => {
    sendWs({ type: "adblock", enabled: setAdblock.checked });
  });

  // ——— password ———

  const pwForm = document.getElementById("pw-form");
  const pwCurrent = document.getElementById("pw-current");
  const pwNew = document.getElementById("pw-new");
  const pwConfirm = document.getElementById("pw-confirm");
  const pwSubmit = document.getElementById("pw-submit");
  const pwStatus = document.getElementById("pw-status");

  function pwMessage(text, isError) {
    pwStatus.textContent = text;
    pwStatus.classList.toggle("is-error", Boolean(isError));
    pwStatus.hidden = !text;
  }

  for (const btn of pwForm.querySelectorAll("[data-reveal]")) {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.reveal);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("aria-pressed", String(show));
    });
  }

  pwForm.addEventListener("input", () => {
    pwMessage("");
    for (const input of [pwCurrent, pwNew, pwConfirm]) input.classList.remove("is-invalid");
  });

  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fail = (input, text) => {
      input.classList.add("is-invalid");
      input.focus();
      pwMessage(text, true);
    };
    if (pwNew.value.trim() === "") return fail(pwNew, "New password cannot be blank");
    if (pwNew.value === pwCurrent.value) return fail(pwNew, "New password must be different from the current one");
    if (pwNew.value !== pwConfirm.value) return fail(pwConfirm, "The two new passwords do not match");

    pwSubmit.disabled = true;
    pwSubmit.textContent = "Updating…";
    try {
      const res = await api("/api/password", {
        method: "POST",
        body: JSON.stringify({ current: pwCurrent.value, next: pwNew.value }),
      });
      pwForm.reset();
      for (const input of [pwCurrent, pwNew, pwConfirm]) input.type = "password";
      for (const btn of pwForm.querySelectorAll("[data-reveal]")) btn.setAttribute("aria-pressed", "false");
      const others = res.signedOut === 1 ? "1 other device was" : `${res.signedOut} other devices were`;
      pwMessage(`Password updated. ${res.signedOut ? `${others} signed out.` : "You stay signed in here."}`);
    } catch (err) {
      if (err.status === 404) pwMessage(STALE_SERVER.replace("to use settings", "to change the password"), true);
      else if (/current password/i.test(err.message)) fail(pwCurrent, err.message);
      else pwMessage(err.message, true);
    } finally {
      pwSubmit.disabled = false;
      pwSubmit.textContent = "Update password";
    }
  });

  // ——— cache ———

  const btnCache = document.getElementById("cache-clear");
  const cacheSize = document.getElementById("cache-size");

  function fmtSize(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${Math.round(bytes)} B`;
  }

  function renderCacheSize(bytes) {
    // Below 1 KB only Chromium's empty index files remain.
    cacheSize.textContent = typeof bytes !== "number" ? "" : bytes < 1024 ? "Nothing cached right now." : `Using ${fmtSize(bytes)} on disk.`;
  }

  async function refreshCache() {
    try {
      renderCacheSize((await api("/api/cache")).bytes);
    } catch {
      // An older server without the route: the button will explain when clicked.
      renderCacheSize(null);
    }
  }

  btnCache.addEventListener("click", async () => {
    btnCache.disabled = true;
    btnCache.textContent = "Clearing…";
    try {
      const reply = await api("/api/cache/clear", { method: "POST" });
      showSaved(reply.freed > 0 ? `Cache cleared — ${fmtSize(reply.freed)} freed` : "Cache cleared");
      renderCacheSize(reply.bytes);
    } catch (err) {
      saveError("Could not clear the cache", err);
    } finally {
      btnCache.disabled = false;
      btnCache.textContent = "Clear";
    }
  });

  // Two-step so a stray click cannot wipe the wallpaper.
  const btnReset = document.getElementById("settings-reset");
  let resetArmed = null;
  btnReset.addEventListener("click", async () => {
    if (!resetArmed) {
      btnReset.textContent = "Click again to reset";
      resetArmed = setTimeout(() => {
        resetArmed = null;
        btnReset.textContent = "Reset";
      }, 4000);
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = null;
    btnReset.textContent = "Reset";
    try {
      applySettings(await api("/api/settings/reset", { method: "POST" }));
      showSaved("Settings reset");
    } catch (err) {
      saveError("Could not reset", err);
    }
  });

  const settingsLinks = [...settingsPage.querySelectorAll(".settings-nav a")];
  for (const link of settingsLinks) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelector(link.getAttribute("href")).scrollIntoView({ block: "start" });
    });
  }
  settingsBody.addEventListener("scroll", () => {
    let current = settingsLinks[0];
    for (const link of settingsLinks) {
      const section = document.querySelector(link.getAttribute("href"));
      if (section.offsetTop - settingsBody.scrollTop <= 90) current = link;
    }
    for (const link of settingsLinks) link.classList.toggle("is-current", link === current);
  });

  try {
    const cached = JSON.parse(localStorage.getItem(SETTINGS_CACHE_KEY) || "null");
    if (cached && cached.settings && cached.settings.toolbar && cached.settings.newTab) applySettings(cached);
  } catch {
    // ignore a corrupt cache
  }

  // ——— ad blocker ———

  // The switch lives on the server (one Chromium for every client), so the button only
  // ever reflects what the server last reported.
  function renderAdblock(msg) {
    const on = msg.status === "on";
    const loading = msg.status === "loading";
    state.adblock = Boolean(msg.enabled);
    btnAdblock.classList.toggle("is-on", on);
    btnAdblock.classList.toggle("is-loading", loading);
    btnAdblock.classList.toggle("is-error", msg.status === "error");
    btnAdblock.setAttribute("aria-pressed", msg.enabled ? "true" : "false");
    setAdblock.checked = Boolean(msg.enabled);
    adblockCheck.hidden = !on;
    const blocked = Number(msg.blocked) || 0;
    adblockCount.hidden = !on || blocked === 0;
    adblockCount.textContent = blocked > 99 ? "99+" : String(blocked);
    btnAdblock.title = on
      ? `Ad blocker: on — ${blocked} blocked on this page, ${Number(msg.total) || 0} this session`
      : loading
        ? "Ad blocker: downloading filter lists…"
        : msg.status === "error"
          ? `Ad blocker unavailable: ${msg.error || "could not load filter lists"} (click to retry)`
          : "Ad blocker: off";
  }

  btnAdblock.addEventListener("click", () => {
    if (btnAdblock.classList.contains("is-loading")) return;
    const retry = btnAdblock.classList.contains("is-error");
    sendWs({ type: "adblock", enabled: retry ? true : !state.adblock });
  });

  // ——— latency ———

  function fmtBytes(perSec) {
    if (perSec >= 1024 * 1024) return `${(perSec / (1024 * 1024)).toFixed(1)} MB/s`;
    if (perSec >= 1024) return `${Math.round(perSec / 1024)} KB/s`;
    return `${Math.round(perSec)} B/s`;
  }

  function renderLatency() {
    const now = performance.now();
    const secs = Math.max(0.001, (now - state.statAt) / 1000);
    const fps = state.statFrames / secs;
    const bw = state.statBytes / secs;
    state.statFrames = 0;
    state.statBytes = 0;
    state.statAt = now;
    latRtt.textContent = state.rtt == null ? "…" : `${Math.round(state.rtt)} ms`;
    latFps.textContent = `${fps < 10 ? fps.toFixed(1) : Math.round(fps)} fps`;
    latBw.textContent = fmtBytes(bw);
    latSize.textContent = `${state.frameW} × ${state.frameH}`;
    renderQuality();
    const pkts = Math.round(audio.packets / secs);
    audio.packets = 0;
    latAudio.textContent = !audio.format
      ? "unsupported"
      : !audio.enabled
        ? "off"
        : `${audio.format === "opus" ? "Opus" : "PCM"}${pkts ? ` · ${pkts} pkt/s` : ""}`;
    latencyDot.className = "latency-dot";
    if (state.rtt == null) delete btnLatency.dataset.level;
    if (state.rtt != null) {
      latencyDot.classList.add(state.rtt < 80 ? "good" : state.rtt < 200 ? "fair" : "poor");
      btnLatency.dataset.level = state.rtt < 80 ? "good" : state.rtt < 200 ? "fair" : "poor";
    }
    btnLatency.title = state.rtt == null ? "Latency" : `Latency: ${Math.round(state.rtt)} ms`;
  }

  // What the server is actually streaming. "(auto)" means it has stepped down — fewer
  // frames, a smaller picture, then a lower quality — because this link could not keep
  // up; it climbs back once the link has been calm for a few seconds.
  function renderQuality() {
    const q = state.stream;
    if (!q) {
      latQuality.textContent = "…";
      return;
    }
    if (!q.level) {
      latQuality.textContent = `${q.quality}%`;
      return;
    }
    const parts = [`${q.quality}%`];
    if (q.everyNthFrame > 1) parts.push(`1/${q.everyNthFrame} frames`);
    if (q.scale < 1) parts.push(`${Math.round(q.scale * 100)}% size`);
    latQuality.textContent = `${parts.join(" · ")} (auto)`;
  }

  function sendPing() {
    sendWs({ type: "ping", t: performance.now() });
  }

  function startLatency() {
    if (state.latencyTimer) return;
    state.statFrames = 0;
    state.statBytes = 0;
    state.statAt = performance.now();
    sendPing();
    state.latencyTimer = setInterval(() => {
      sendPing();
      renderLatency();
    }, 1000);
  }

  function stopLatency() {
    clearInterval(state.latencyTimer);
    state.latencyTimer = null;
  }

  function toggleLatency(show) {
    const on = show == null ? latencyPanel.hidden : show;
    latencyPanel.hidden = !on;
    btnLatency.classList.toggle("is-on", on);
    if (on) {
      renderLatency();
      startLatency();
    }
  }

  btnLatency.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLatency();
  });

  document.addEventListener("mousedown", (e) => {
    if (latencyPanel.hidden) return;
    if (latencyPanel.contains(e.target) || btnLatency.contains(e.target)) return;
    toggleLatency(false);
  });

  // Keep a cheap background ping so the gauge on the icon stays meaningful.
  setInterval(() => {
    if (!latencyPanel.hidden || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    sendPing();
  }, 5000);

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
      return state.searchUrl.replace("%s", encodeURIComponent(raw));
    }
    return `https://${raw}`;
  }

  const loginCard = document.querySelector(".login-card");
  const togglePw = document.getElementById("toggle-pw");
  function showError(msg) {
    loginError.hidden = !msg;
    loginError.textContent = msg || "";
    if (msg && loginCard) {
      loginCard.classList.remove("shake");
      // reflow so the animation restarts on repeated failures
      void loginCard.offsetWidth;
      loginCard.classList.add("shake");
    }
  }

  // Show / hide the password, useful for long passwords typed on a phone.
  togglePw.addEventListener("click", () => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    togglePw.classList.toggle("is-on", show);
    togglePw.setAttribute("aria-pressed", String(show));
    togglePw.setAttribute("aria-label", show ? "Hide password" : "Show password");
    passwordInput.focus();
  });

  function setStatus(text) {
    statusText.textContent = text;
  }

  // Temporary notice (dialog auto-handled, navigation error) that reverts to the URL.
  function flashStatus(text, ms) {
    setStatus(text);
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(() => {
      state.statusTimer = null;
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
    if (viewport.classList.contains("is-waiting")) {
      viewport.classList.remove("is-waiting");
      // The first frame is what ends "Loading…" in the status bar, not the meta message
      // (which usually arrives before the picture).
      if (state.live && !state.statusTimer) setStatus(address.value || "");
    }
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
      setTabTitle("New Tab");
      address.value = "";
      setStatus("Start page");
      document.title = `Perch — ${HOST_LABEL}`;
      blurKbd();
    }
  }

  function beginNav(url, label) {
    state.wasLive = state.live;
    state.prevAddress = address.value;
    state.live = true;
    state.minEpoch = state.epoch + 1;
    address.value = url || address.value;
    setTabTitle("Loading…");
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
      return createImageBitmap(blob, { premultiplyAlpha: "none" });
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

  // ——— audio ———
  //
  // Sound arrives as binary messages next to the frames: a 6-byte header (type 2, format,
  // sequence) and either an Opus packet (decoded with WebCodecs) or 20 ms of raw PCM
  // (for browsers without an Opus AudioDecoder). Either way playback is a chain of
  // AudioBufferSourceNodes scheduled a few tens of milliseconds ahead of the clock.

  const AUDIO_FRAME_TYPE = 2;
  const AUDIO_HEADER_BYTES = 6;
  const AUDIO_LEAD = 0.08; // jitter buffer, seconds
  const AUDIO_MAX_LAG = 0.4; // resync when queued audio runs this far ahead of the clock
  const OPUS_RATE = 48000;
  const PCM_RATE = 24000;
  const audio = {
    enabled: readAudioPref(),
    format: null, // "opus" | "pcm" | null when this browser cannot play remote sound
    ctx: null,
    gain: null,
    decoder: null,
    nextTime: 0,
    seq: -1,
    pending: new Set(),
    hinted: false,
    packets: 0,
  };

  function readAudioPref() {
    try {
      return localStorage.getItem("perch-audio") !== "0";
    } catch {
      return true;
    }
  }

  function writeAudioPref(on) {
    try {
      localStorage.setItem("perch-audio", on ? "1" : "0");
    } catch {
      // ignore
    }
  }

  async function detectAudioFormat() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (typeof AudioDecoder === "function" && typeof EncodedAudioChunk === "function") {
      try {
        const r = await AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 2 });
        if (r && r.supported) return "opus";
      } catch {
        // fall through to PCM
      }
    }
    return "pcm";
  }

  function sendAudioPref() {
    sendWs({ type: "audio", format: audio.enabled && audio.format ? audio.format : null });
  }

  function renderAudioButton() {
    const on = audio.enabled && Boolean(audio.format);
    btnAudio.classList.toggle("is-on", on);
    btnAudio.setAttribute("aria-pressed", on ? "true" : "false");
    btnAudio.title = !audio.format
      ? "Sound is not supported in this browser"
      : on
        ? "Sound on (click to mute)"
        : "Sound off (click to unmute)";
    audioOnIcon.hidden = !on;
    audioOffIcon.hidden = on;
  }

  function audioRunning() {
    return Boolean(audio.ctx && audio.ctx.state === "running");
  }

  // Browsers only let a page make noise after a user gesture; call this from one.
  function unlockAudio() {
    if (!audio.format || !audio.enabled) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!audio.ctx) {
      try {
        audio.ctx = new AC({ latencyHint: "interactive" });
      } catch {
        return;
      }
      audio.gain = audio.ctx.createGain();
      audio.gain.connect(audio.ctx.destination);
    }
    if (audio.ctx.state !== "running") audio.ctx.resume().catch(() => {});
  }

  function resetAudioClock() {
    audio.seq = -1;
    audio.nextTime = 0;
    for (const src of audio.pending) {
      try {
        src.stop();
      } catch {
        // ignore
      }
    }
    audio.pending.clear();
  }

  function ensureDecoder() {
    if (audio.decoder && audio.decoder.state === "configured") return audio.decoder;
    if (audio.decoder) {
      try {
        audio.decoder.close();
      } catch {
        // ignore
      }
    }
    try {
      const dec = new AudioDecoder({
        output: (data) => {
          try {
            playAudioData(data);
          } finally {
            data.close();
          }
        },
        error: (err) => {
          console.warn(`[perch] audio decoder: ${err && err.message}`);
          audio.decoder = null;
        },
      });
      dec.configure({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 2 });
      audio.decoder = dec;
      return dec;
    } catch {
      audio.decoder = null;
      return null;
    }
  }

  function deinterleave(all, ch, frames, scale) {
    const planes = [];
    for (let c = 0; c < ch; c += 1) {
      const p = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) p[i] = all[i * ch + c] * scale;
      planes.push(p);
    }
    return planes;
  }

  function playAudioData(data) {
    const ch = data.numberOfChannels;
    const frames = data.numberOfFrames;
    const fmt = data.format || "";
    let planes = [];
    if (fmt === "f32-planar") {
      for (let c = 0; c < ch; c += 1) {
        const p = new Float32Array(frames);
        data.copyTo(p, { planeIndex: c });
        planes.push(p);
      }
    } else if (fmt === "f32") {
      const all = new Float32Array(frames * ch);
      data.copyTo(all, { planeIndex: 0 });
      planes = deinterleave(all, ch, frames, 1);
    } else if (fmt === "s16") {
      const all = new Int16Array(frames * ch);
      data.copyTo(all, { planeIndex: 0 });
      planes = deinterleave(all, ch, frames, 1 / 32768);
    } else if (fmt === "s16-planar") {
      for (let c = 0; c < ch; c += 1) {
        const raw = new Int16Array(frames);
        data.copyTo(raw, { planeIndex: c });
        planes.push(Float32Array.from(raw, (v) => v / 32768));
      }
    } else {
      try {
        for (let c = 0; c < ch; c += 1) {
          const p = new Float32Array(frames);
          data.copyTo(p, { planeIndex: c, format: "f32-planar" });
          planes.push(p);
        }
      } catch {
        return;
      }
    }
    scheduleAudio(planes, data.sampleRate);
  }

  function scheduleAudio(planes, rate) {
    if (!audioRunning() || !planes.length || !planes[0].length) return;
    const ctx = audio.ctx;
    const buf = ctx.createBuffer(planes.length, planes[0].length, rate);
    for (let c = 0; c < planes.length; c += 1) buf.getChannelData(c).set(planes[c]);
    const now = ctx.currentTime;
    if (audio.nextTime < now + 0.005) {
      // First packet, or we ran dry: start again a little ahead of the clock.
      audio.nextTime = now + AUDIO_LEAD;
    } else if (audio.nextTime > now + AUDIO_MAX_LAG) {
      // A burst after a stall left us far behind live: drop the queue and catch up.
      for (const src of audio.pending) {
        try {
          src.stop();
        } catch {
          // ignore
        }
      }
      audio.pending.clear();
      audio.nextTime = now + AUDIO_LEAD;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.gain);
    src.onended = () => audio.pending.delete(src);
    audio.pending.add(src);
    src.start(audio.nextTime);
    audio.nextTime += buf.duration;
  }

  function onAudioMessage(buf) {
    if (buf.byteLength <= AUDIO_HEADER_BYTES) return;
    const dv = new DataView(buf);
    const code = dv.getUint8(1);
    const format = code === 1 ? "opus" : code === 2 ? "pcm" : null;
    const seq = dv.getUint32(2);
    state.statBytes += buf.byteLength;
    audio.packets += 1;
    if (!audio.enabled || !format) return;
    if (!audioRunning()) {
      if (!audio.hinted) {
        audio.hinted = true;
        flashStatus("Tap or click the page to enable sound", 6000);
      }
      return;
    }
    audio.seq = seq;
    if (format === "opus") {
      const dec = ensureDecoder();
      if (!dec) return;
      if (dec.decodeQueueSize > 25) return; // hopelessly behind; skip this packet
      try {
        dec.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: seq * 20000,
            data: new Uint8Array(buf, AUDIO_HEADER_BYTES),
          })
        );
      } catch {
        audio.decoder = null;
      }
      return;
    }
    const frames = (buf.byteLength - AUDIO_HEADER_BYTES) >> 2;
    if (!frames) return;
    const all = new Int16Array(buf, AUDIO_HEADER_BYTES, frames * 2);
    scheduleAudio(deinterleave(all, 2, frames, 1 / 32768), PCM_RATE);
  }

  btnAudio.addEventListener("click", () => {
    if (!audio.format) {
      flashStatus("Sound is not supported in this browser", 4000);
      return;
    }
    audio.enabled = !audio.enabled;
    writeAudioPref(audio.enabled);
    renderAudioButton();
    if (audio.enabled) unlockAudio();
    else resetAudioClock();
    sendAudioPref();
    flashStatus(audio.enabled ? "Sound on" : "Sound off", 1500);
  });

  for (const type of ["pointerdown", "keydown", "touchend", "click"]) {
    document.addEventListener(
      type,
      () => {
        if (audio.enabled && audio.format && !audioRunning()) unlockAudio();
      },
      { capture: true, passive: true }
    );
  }

  detectAudioFormat().then((format) => {
    audio.format = format;
    renderAudioButton();
    sendAudioPref();
  });

  function onBinaryFrame(buf) {
    if (buf.byteLength > 0 && new DataView(buf).getUint8(0) === AUDIO_FRAME_TYPE) {
      onAudioMessage(buf);
      return;
    }
    const header = decodeHeader(buf);
    if (!header) return;
    state.statFrames += 1;
    state.statBytes += buf.byteLength;
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

  // Whether this device was signed in last time. It only decides what is shown first:
  // a remembered device opens straight into the app and starts the live connection
  // while the session is confirmed in the background, instead of waiting a round trip
  // (and painting the sign-in page) first. The server still has the final say.
  const SIGNED_IN_KEY = "perch.signedIn";

  function rememberSignedIn(on) {
    try {
      if (on) localStorage.setItem(SIGNED_IN_KEY, "1");
      else localStorage.removeItem(SIGNED_IN_KEY);
    } catch {
      // ignore
    }
    if (on) document.documentElement.dataset.session = "remembered";
    else delete document.documentElement.dataset.session;
  }

  function wasSignedIn() {
    try {
      return localStorage.getItem(SIGNED_IN_KEY) === "1";
    } catch {
      return false;
    }
  }

  // The app opens as soon as the session is confirmed — at once on a remembered device;
  // the home IP (an outside lookup that can take seconds) is filled in afterwards.
  async function checkSession() {
    const remembered = wasSignedIn();
    if (remembered) enterApp();
    try {
      await api("/api/session");
      if (!remembered) enterApp();
      rememberSignedIn(true);
    } catch (err) {
      if (err.status === 401 || err.status === 403) return showLogin();
      if (err.status !== 404) {
        // Server unreachable: a remembered device stays in the app and keeps trying to
        // connect (the status dot shows it); anyone else gets the sign-in page.
        if (!remembered) showLogin();
        return;
      }
      // A server from before /api/session existed.
      try {
        enterApp((await api("/api/ip")).egress_ip);
        rememberSignedIn(true);
      } catch {
        showLogin();
      }
    }
  }

  function showLogin() {
    rememberSignedIn(false);
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
    seedTabs();
    ensureSocket();
    refreshIp();
    sendResize();
    viewport.focus();
  }

  // Settings and the tab list arrive on the socket as it opens. If they have not within
  // a moment (an older server, or a proxy that dropped the message), fetch them instead.
  const FALLBACK_MS = 1500;
  let gotSettings = false;
  let gotTabs = false;

  function armFallback() {
    clearTimeout(state.fallbackTimer);
    gotSettings = false;
    gotTabs = false;
    state.fallbackTimer = setTimeout(() => {
      if (!gotSettings) loadSettings();
      if (!gotTabs) refreshTabs();
    }, FALLBACK_MS);
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
    loginBtn.classList.add("is-loading");
    const label = loginBtn.querySelector(".btn-label");
    const prevLabel = label ? label.textContent : "";
    if (label) label.textContent = "Signing in…";
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ password: passwordInput.value }),
      });
      passwordInput.value = "";
      rememberSignedIn(true);
      enterApp();
    } catch (err) {
      showError(err.status === 429
        ? "Too many attempts. Wait a few minutes."
        : (err.message || "Invalid credentials"));
      passwordInput.focus();
      passwordInput.select();
    } finally {
      loginBtn.disabled = false;
      loginBtn.classList.remove("is-loading");
      if (label) label.textContent = prevLabel || "Sign in";
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
      document.title = `${meta.title || "Perch"} — ${HOST_LABEL}`;
    }
    if (meta.title && !(viewport.classList.contains("is-waiting") && meta.title === meta.url)) {
      setTabTitle(meta.title);
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
    // Left fullscreen here (Esc, swipe, back) while the remote video is still in it:
    // take the remote page out too, or its player keeps its fullscreen layout.
    if (!on && state.remoteFs) {
      state.fsByRemote = false;
      sendWs({ type: "exitFullscreen" });
    }
    sendResize();
  });

  // A remote page went fullscreen (a video's maximize button). That only fills the
  // *remote* view, so mirror it here: hide Perch's chrome so the stream fills the window,
  // and ask this browser for real fullscreen. The request is honoured because the tap on
  // the video's button was a user gesture in this browser a moment ago; where it is not
  // (another device watching, or iPhone Safari, which has no element fullscreen) the
  // chrome-less "immersive" view is still the largest picture available.
  async function mirrorRemoteFullscreen(on) {
    state.remoteFs = on;
    document.body.classList.toggle("is-immersive", on);
    if (on) {
      toggleTools(false);
      toggleLatency(false);
      if (!isFullscreen() && shell.requestFullscreen) {
        try {
          await shell.requestFullscreen({ navigationUI: "hide" });
          state.fsByRemote = true;
        } catch {
          // no recent gesture, or unsupported: immersive view only
        }
      }
    } else if (state.fsByRemote) {
      state.fsByRemote = false;
      if (isFullscreen()) await document.exitFullscreen().catch(() => {});
    }
    // No explicit resize here. The viewport's ResizeObserver sends one, debounced, once
    // the layout has settled — resizing the remote view in the middle of its fullscreen
    // transition makes Chromium drop back out of fullscreen.
  }

  // ——— on-screen keyboard ———

  // A phone's keyboard does not shrink the page, it covers the bottom of it — often the
  // very field being typed into. Shrink the app to the space above the keyboard; the
  // remote view resizes with it (ResizeObserver -> sendResize) and the server scrolls the
  // focused field back into view. Touch devices only, and not while pinch-zoomed, where
  // the visual viewport shrinks for a different reason.
  if (window.visualViewport && window.matchMedia("(pointer: coarse)").matches) {
    const vv = window.visualViewport;
    const syncKeyboardInset = () => {
      if (vv.scale > 1.01) return;
      const inset = Math.round(window.innerHeight - vv.height - vv.offsetTop);
      const open = inset > 100;
      document.documentElement.style.setProperty("--kb-inset", open ? `${inset}px` : "0px");
      // iOS scrolls the page to reveal the (invisible) focused textarea; undo that.
      if (open && (window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
    };
    vv.addEventListener("resize", syncKeyboardInset);
    vv.addEventListener("scroll", syncKeyboardInset);
  }

  // ——— visibility ———

  // When Perch is not on screen (another browser tab, phone app in the background) the
  // server is told to stop sending pictures to this device; sound carries on. Coming
  // back asks for a fresh frame, so the view is current the moment it is visible again.
  // Phones do not always fire visibilitychange on the way back, so focus and pageshow
  // report too, and the server treats any input from a device as proof it is watching.
  function sendVisibility() {
    sendWs({ type: "visibility", hidden: document.visibilityState === "hidden" });
  }

  document.addEventListener("visibilitychange", sendVisibility);
  window.addEventListener("focus", sendVisibility);
  window.addEventListener("pageshow", sendVisibility);

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

  // Connect only if there is no live or pending connection (the speculative one opened
  // at start-up, or one that is already reconnecting).
  function ensureSocket() {
    const ws = state.ws;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    connectSocket();
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
      armFallback();
      sendResize(true);
      sendAudioPref();
      sendVisibility();
      if (isTouchDevice) sendWs({ type: "editable", on: true });
      // Measure at once so the gauge needle settles without waiting for the 5 s tick.
      sendPing();
    });
    ws.addEventListener("close", (ev) => {
      if (gen !== state.wsGen) return;
      wsDot.classList.remove("on");
      resetAudioClock();
      // Never strand the user in a chrome-less view with a dead connection.
      if (state.remoteFs) mirrorRemoteFullscreen(false);
      // 4001: the password was changed on another device and this session was ended.
      if (ev.code === 4001) {
        toggleSettings(false);
        showLogin();
        showError("The password was changed. Sign in again.");
        return;
      }
      if (appScreen.hidden) return;
      if (!gotSettings && !state.fallbackTimer) armFallback();
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
        if (msg.url === "about:blank") {
          setLive(false);
          return;
        }
        if (msg.url && document.activeElement !== address) address.value = msg.url;
        setTabTitle("Loading…");
        setStatus("Loading…");
        blurKbd();
        return;
      }
      if (msg.type === "tabs") {
        gotTabs = true;
        renderTabs(msg.tabs, msg.active);
        return;
      }
      if (msg.type === "adblock") {
        renderAdblock(msg);
        return;
      }
      if (msg.type === "settings") {
        gotSettings = true;
        applySettings(msg);
        return;
      }
      if (msg.type === "fullscreen") {
        mirrorRemoteFullscreen(msg.on === true);
        return;
      }
      if (msg.type === "stream") {
        state.stream = {
          quality: Number(msg.quality) || 0,
          target: Number(msg.target) || 0,
          level: Number(msg.level) || 0,
          everyNthFrame: Number(msg.everyNthFrame) || 1,
          scale: Number(msg.scale) || 1,
        };
        if (!latencyPanel.hidden) renderQuality();
        return;
      }
      if (msg.type === "pong") {
        if (typeof msg.t === "number") {
          state.rtt = performance.now() - msg.t;
          latencyDot.className = "latency-dot " + (state.rtt < 80 ? "good" : state.rtt < 200 ? "fair" : "poor");
          btnLatency.dataset.level = state.rtt < 80 ? "good" : state.rtt < 200 ? "fair" : "poor";
          btnLatency.title = `Latency: ${Math.round(state.rtt)} ms`;
        }
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
      if (msg.type === "editable") {
        state.editable = msg;
        return;
      }
      if (msg.type === "hit") {
        state.lastHit = msg;
        if (state.touch && state.touch.seq === msg.seq) state.touch.editable = msg.editable;
        return;
      }
      if (msg.type === "focus") {
        // Ground truth after the tap: what the remote page actually focused.
        if (msg.editable) {
          state.kbdUnsure = false;
          if (document.activeElement !== kbd) focusKbd();
        } else if (state.kbdUnsure && document.activeElement === kbd) {
          // The keyboard went up on a guess (a field's box, or a field beneath an
          // overlay) and the tap did not land in a field after all: take it down.
          blurKbd();
        }
        return;
      }
    });
  }

  function sendWs(obj) {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // A click or key press must not overtake scrolling that happened just before it.
    if (state.wheel && obj && obj.type !== "wheel" && (obj.type === "key" || obj.type === "paste" || (obj.type === "mouse" && obj.action !== "move"))) {
      flushWheel();
    }
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

  // Trackpads fire 60–120 wheel events a second. They are summed and sent once per
  // display frame: the same total scroll, a fraction of the messages, and nothing is
  // ever sent faster than the screen could show the result. A change of modifier keys
  // (Ctrl+wheel zoom vs. plain scroll) flushes first, so deltas never mix meanings.
  // Touch scrolling (below) has its own path and is not affected.
  function flushWheel() {
    cancelAnimationFrame(state.wheelFrame);
    state.wheelFrame = 0;
    const w = state.wheel;
    state.wheel = null;
    if (w && (w.deltaX || w.deltaY)) sendWs(w);
  }

  viewport.addEventListener("wheel", (e) => {
    if (!state.live) return;
    e.preventDefault();
    const p = localPoint(e.clientX, e.clientY);
    let scale = 1;
    if (e.deltaMode === 1) scale = 32;
    else if (e.deltaMode === 2) scale = p.vh;
    const m = mods(e);
    const w = state.wheel;
    if (w && (w.alt !== m.alt || w.ctrl !== m.ctrl || w.meta !== m.meta || w.shift !== m.shift)) flushWheel();
    if (state.wheel) {
      state.wheel.deltaX += e.deltaX * scale;
      state.wheel.deltaY += e.deltaY * scale;
      Object.assign(state.wheel, { x: p.x, y: p.y, vw: p.vw, vh: p.vh });
    } else {
      state.wheel = { type: "wheel", x: p.x, y: p.y, vw: p.vw, vh: p.vh, deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, ...m };
    }
    if (!state.wheelFrame) state.wheelFrame = requestAnimationFrame(flushWheel);
  }, { passive: false });

  // ——— touch: one finger drags scroll, a still finger taps, a long press right-clicks ———

  // Is this viewport point inside one of the remote page's text fields, according to the
  // map the server last pushed? Only trusted for the page it was made for.
  function inEditableBox(p) {
    const map = state.editable;
    if (!map || !Array.isArray(map.rects) || map.epoch < state.minEpoch) return false;
    const kx = (map.w || state.frameW) / Math.max(1, p.vw);
    const ky = (map.h || state.frameH) / Math.max(1, p.vh);
    const x = p.x * kx;
    const y = p.y * ky;
    const slop = 4;
    return map.rects.some(([rx, ry, rw, rh]) => x >= rx - slop && x <= rx + rw + slop && y >= ry - slop && y <= ry + rh + slop);
  }

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
    // Find out now what is under the finger, so that by touchend we know whether to
    // raise the keyboard (see endTouch).
    state.hitSeq += 1;
    const hp = localPoint(t.clientX, t.clientY);
    sendWs({ type: "hittest", seq: state.hitSeq, x: hp.x, y: hp.y, vw: hp.vw, vh: hp.vh });
    state.touch = {
      seq: state.hitSeq,
      editable: undefined, // true | false | null (unknowable) once the server answers
      guess: inEditableBox(hp), // known now, from the map the server pushed
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
    // Phones — iOS strictly — open the keyboard only if a field is focused *inside* the
    // tap's own event handler; focusing later, when a server reply arrives, is ignored.
    // On a fast link the hit test sent at touchstart has answered by now; on a slow one
    // (a round trip is longer than a tap) the map of text fields decides instead, and
    // the server's probe of what really got focus corrects a wrong guess afterwards.
    // The map wins even over a quick "no" from the hit test: a tap on a search bar's
    // icon or padding usually focuses the field by the page's own script.
    const hit = state.lastHit && state.lastHit.seq === cur.seq ? state.lastHit : null;
    if (cur.editable === true || cur.guess) {
      state.kbdUnsure = !(cur.editable === true && hit && hit.direct);
      focusKbd();
    } else if (cur.editable === false && document.activeElement === kbd) {
      blurKbd();
    }
    // Fallback and confirmation: a slow link (no answer yet), or a tap on something that
    // moves focus into a field by script. Works where late focus is allowed (Android).
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
    // Only on the start page: once a site is showing, ⌘K belongs to that site.
    if (meta && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K") && !state.live && !startPage.classList.contains("no-search")) {
      e.preventDefault();
      startQ.focus();
      startQ.select();
      return true;
    }
    return false;
  }

  window.addEventListener("keydown", (e) => {
    // The settings page owns the keyboard while it is open; nothing reaches the remote.
    if (state.settingsOpen) {
      if (e.key === "Escape") toggleSettings(false);
      return;
    }
    if (handleShortcut(e)) return;
    if (e.key === "Escape" && isFullscreen()) {
      // Browsers leave fullscreen on Esc by themselves; asking too is harmless and covers
      // the ones that hand the key to the page instead. The fullscreenchange handler
      // then takes the remote video out of fullscreen as well.
      if (state.remoteFs) document.exitFullscreen().catch(() => {});
      return;
    }
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
    if (!state.live || state.settingsOpen) return;
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
    state.kbdUnsure = false;
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

  (function brandHost() {
    const foot = document.querySelector(".login-foot");
    if (foot) foot.textContent = `Single session · password-protected · ${HOST_LABEL}`;
    const kicker = document.querySelector(".start-kicker");
    if (kicker) kicker.textContent = `Perch · ${HOST_LABEL}`;
    document.title = `Perch — ${HOST_LABEL}`;
  })();

  checkSession();

  // Installable app + instant repeat loads. The worker only caches content-hashed files
  // and never pages or API calls, so it cannot pin anyone to an old version.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
    // The page opens from the worker's cache and is re-fetched behind it. When the
    // server has a newer build, this message arrives: reload while still starting up
    // (nothing is lost yet), otherwise leave it to the user.
    let updateNoted = false;
    navigator.serviceWorker.addEventListener("message", (ev) => {
      const msg = ev.data || {};
      if (msg.type !== "perch-update") return;
      const mine = window.__PERCH && window.__PERCH.v;
      if (msg.version && mine && msg.version === mine) return;
      if (performance.now() < 15000) {
        location.reload();
        return;
      }
      if (updateNoted) return;
      updateNoted = true;
      flashStatus("Perch was updated — reload the page to get the new version", 10000);
    });
  }
})();
