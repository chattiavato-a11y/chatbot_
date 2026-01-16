/**
 * app.js — Chattia UI -> Enlace (/api/chat) (SSE streaming)
 *
 * ✅ No libraries
 * ✅ Safe DOM writes (textContent only)
 * ✅ Works with BOTH inputs: quick input (#chatInput) + composer textarea (#input)
 * ✅ Writes transcript to BOTH panels: #mainList + #sideList
 * ✅ Language toggle (EN/ES) controls Brain behavior via payload.meta.lang
 * ✅ Theme toggle sync (top + lower)
 * ✅ Stop + Clear
 * ✅ Turnstile token included if present (no hard dependency)
 *
 * IMPORTANT:
 * If Enlace enforces OPS_ASSET_ALLOWLIST, set OPS_ASSET_ID (+ optional SHA) below.
 */

const ENLACE_API = "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat";

// ---- Asset identity (OPTIONAL but recommended) ----
const OPS_ASSET_ID = "";       // e.g. "CHATTIA_WEB_01"
const OPS_ASSET_SHA256 = "";   // e.g. "9f2c... (hex sha256)"

// ---- DOM ----
const elMainList = document.getElementById("mainList");
const elSideList = document.getElementById("sideList");

const elForm = document.getElementById("chatForm");
const elInput = document.getElementById("input");
const elChatInput = document.getElementById("chatInput");

const elBtnSend = document.getElementById("btnSend");
const elBtnClear = document.getElementById("btnClear");
const elBtnMenu = document.getElementById("btnMenu");
const elBtnMiniMenu = document.getElementById("btnMiniMenu");

const elBtnMic = document.getElementById("btnMic");
const elBtnWave = document.getElementById("btnWave");

const elBtnLangTop = document.getElementById("btnLangTop");
const elBtnLangLower = document.getElementById("btnLangLower");
const elBtnThemeTop = document.getElementById("btnThemeTop");
const elBtnThemeLower = document.getElementById("btnThemeLower");

const elSideLang = document.getElementById("sideLang");
const elSideMode = document.getElementById("sideMode");

const elStatusDot = document.getElementById("statusDot");
const elStatusTxt = document.getElementById("statusText");
const elCharCount = document.getElementById("charCount");

// Footer links (optional)
const elLinkTc = document.getElementById("lnkTc");
const elLinkCookies = document.getElementById("lnkCookies");
const elLinkContact = document.getElementById("lnkContact");
const elLinkSupport = document.getElementById("lnkSupport");
const elLinkAbout = document.getElementById("lnkAbout");

// Turnstile widget response lives in a hidden input created by Turnstile.
// We'll read it if present.
const TURNSTILE_RESPONSE_SELECTOR = 'input[name="cf-turnstile-response"]';

const MAX_INPUT_CHARS = 1500;
const MAX_HISTORY = 40;

// ---- State ----
let history = []; // { role: "user"|"assistant", content: string }[]
let abortCtrl = null;
let lang = "en";        // "en" | "es"
let theme = "dark";     // "dark" | "light"

// ---- Utilities ----
function setStatus(text, busy) {
  if (elStatusTxt) elStatusTxt.textContent = text;
  if (elStatusDot) elStatusDot.classList.toggle("busy", !!busy);
}

function nowStamp() {
  return new Date().toLocaleString();
}

function safeTextOnly(s) {
  if (!s) return "";
  return String(s).replace(/\u0000/g, "").trim().slice(0, MAX_INPUT_CHARS);
}

function clampHistory() {
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }
}

function getTurnstileToken() {
  const el = document.querySelector(TURNSTILE_RESPONSE_SELECTOR);
  const tok = el && typeof el.value === "string" ? el.value.trim() : "";
  return tok || "";
}

function scrollListsToBottom() {
  if (elMainList && elMainList.parentElement) {
    elMainList.parentElement.scrollTop = elMainList.parentElement.scrollHeight;
  }
  if (elSideList && elSideList.parentElement) {
    elSideList.parentElement.scrollTop = elSideList.parentElement.scrollHeight;
  }
}

function updateCharCount() {
  if (!elCharCount || !elInput) return;
  const length = (elInput.value || "").length;
  const clamped = Math.min(length, MAX_INPUT_CHARS);
  elCharCount.textContent = `${clamped} / ${MAX_INPUT_CHARS}`;
}

function setLang(next) {
  lang = next === "es" ? "es" : "en";
  if (elBtnLangTop) elBtnLangTop.textContent = lang.toUpperCase();
  if (elBtnLangLower) elBtnLangLower.textContent = lang.toUpperCase();
  if (elSideLang) elSideLang.textContent = lang.toUpperCase();
}

function setTheme(next) {
  theme = next === "light" ? "light" : "dark";
  document.body.classList.toggle("dark", theme === "dark");
  if (elBtnThemeTop) elBtnThemeTop.textContent = theme === "dark" ? "Dark" : "Light";
  if (elBtnThemeLower) elBtnThemeLower.textContent = theme === "dark" ? "Dark" : "Light";
  if (elSideMode) elSideMode.textContent = theme.toUpperCase();

  // Keep Turnstile theme consistent (best-effort)
  const widget = document.querySelector(".cf-turnstile");
  if (widget) widget.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
}

function toggleLang() {
  setLang(lang === "en" ? "es" : "en");
}

function toggleTheme() {
  setTheme(theme === "dark" ? "light" : "dark");
}

// ---- Transcript rendering ----
function makeLine(role, text) {
  const line = document.createElement("div");
  line.className = "line";
  line.setAttribute("data-role", role);

  // Simple prefix for readability (HCI: quick scanning)
  const prefix = role === "user" ? "You" : "Chattia";
  line.textContent = `${prefix} • ${nowStamp()}\n${text || ""}`;
  return line;
}

function appendLineToBoth(role, text) {
  const lineA = makeLine(role, text);
  const lineB = makeLine(role, text);

  if (elMainList) elMainList.appendChild(lineA);
  if (elSideList) elSideList.appendChild(lineB);

  scrollListsToBottom();
  return { lineA, lineB };
}

function updateLine(lineEl, role, text) {
  if (!lineEl) return;
  const prefix = role === "user" ? "You" : "Chattia";
  lineEl.textContent = `${prefix} • ${nowStamp()}\n${text || ""}`;
}

function updateBothLines(lines, role, text) {
  updateLine(lines.lineA, role, text);
  updateLine(lines.lineB, role, text);
  scrollListsToBottom();
}

function clearTranscript() {
  if (elMainList) elMainList.textContent = "";
  if (elSideList) elSideList.textContent = "";
  history = [];
  setStatus("Ready", false);
  // Seed a greeting for UX
  appendLineToBoth("assistant", lang === "es"
    ? "Hola — estoy listo. Pregúntame lo que quieras (solo texto)."
    : "Hi — I’m ready. Ask me anything (plain text)."
  );
}

// ---- SSE parsing ----
// SSE frames separated by blank line. We collect "data:" lines per event.
function extractTokenFromAnyShape(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;

  if (typeof obj.response === "string") return obj.response;
  if (typeof obj.text === "string") return obj.text;

  if (obj.result && typeof obj.result === "object") {
    if (typeof obj.result.response === "string") return obj.result.response;
    if (typeof obj.result.text === "string") return obj.result.text;
  }

  if (obj.response && typeof obj.response === "object") {
    if (typeof obj.response.content === "string") return obj.response.content;
    if (typeof obj.response.response === "string") return obj.response.response;
  }

  if (Array.isArray(obj.choices) && obj.choices[0]) {
    const c = obj.choices[0];
    const delta = c.delta || c.message || c;
    if (delta && typeof delta.content === "string") return delta.content;
    if (typeof c.text === "string") return c.text;
  }

  return "";
}

function processSseEventData(data, onToken) {
  const trimmed = String(data || "").trim();
  if (!trimmed) return { done: false };

  if (trimmed === "[DONE]") return { done: true };

  let token = "";
  try {
    const obj = JSON.parse(trimmed);
    token = extractTokenFromAnyShape(obj);
  } catch {
    token = trimmed;
  }

  if (token) onToken(token);
  return { done: false };
}

async function streamFromEnlace(payload, onToken) {
  abortCtrl = new AbortController();

  const headers = {
    "content-type": "application/json",
    "accept": "text/event-stream",
  };

  // Optional asset headers
  if (OPS_ASSET_ID) headers["x-ops-asset-id"] = OPS_ASSET_ID;
  if (OPS_ASSET_SHA256) headers["x-ops-asset-sha256"] = OPS_ASSET_SHA256;

  const resp = await fetch(ENLACE_API, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers,
    body: JSON.stringify(payload),
    signal: abortCtrl.signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${text}`);
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();

  // If Enlace ever returns JSON (non-stream), handle once.
  if (ct.includes("application/json")) {
    const obj = await resp.json().catch(() => null);
    const token = extractTokenFromAnyShape(obj) || JSON.stringify(obj || {});
    if (token) onToken(token);
    return;
  }

  if (!resp.body) throw new Error("No response body (stream missing).");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let buffer = "";
  let eventData = "";
  let doneSeen = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");

    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);

      if (line === "") {
        const res = processSseEventData(eventData, onToken);
        eventData = "";
        if (res.done) {
          doneSeen = true;
          break;
        }
        continue;
      }

      if (line.startsWith("data:")) {
        let chunk = line.slice(5);
        if (chunk.startsWith(" ")) chunk = chunk.slice(1);
        eventData += (eventData ? "\n" : "") + chunk;
      }
    }

    if (doneSeen) break;
  }

  if (!doneSeen && eventData) {
    processSseEventData(eventData, onToken);
  }
}

// ---- Send flow ----
function setBusy(busy) {
  if (elBtnSend) elBtnSend.disabled = !!busy;
  if (elChatInput) elChatInput.disabled = !!busy;
  if (elInput) elInput.disabled = !!busy;
}

async function sendMessage(userText) {
  userText = safeTextOnly(userText);
  if (!userText) return;

  // Show user line
  appendLineToBoth("user", userText);
  history.push({ role: "user", content: userText });
  clampHistory();

  // Create assistant line we’ll update
  const assistantLines = appendLineToBoth("assistant", "");
  let assistantText = "";

  setBusy(true);
  setStatus(lang === "es" ? "Pensando…" : "Thinking…", true);

  let rafId = null;
  const scheduleUpdate = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateBothLines(assistantLines, "assistant", assistantText);
    });
  };

  try {
    const turnstile = getTurnstileToken();

    // IMPORTANT: keep the flow minimal and stable.
    // We pass language + optional turnstile token as meta.
    const payload = {
      messages: history,
      meta: {
        lang,                 // "en"|"es" (Brain honors this)
        turnstile: turnstile || undefined,
      },
    };

    await streamFromEnlace(payload, (token) => {
      assistantText += token;
      scheduleUpdate();
    });

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (!assistantText.trim()) {
      assistantText = lang === "es" ? "(sin salida)" : "(no output)";
    }
    updateBothLines(assistantLines, "assistant", assistantText);

    history.push({ role: "assistant", content: assistantText });
    clampHistory();
    setStatus("Ready", false);
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? (lang === "es" ? "Detenido." : "Stopped.")
        : `Error:\n${String(err?.message || err)}`;

    updateBothLines(assistantLines, "assistant", msg);
    setStatus("Ready", false);
  } finally {
    setBusy(false);
    abortCtrl = null;
  }
}

// ---- Footer links (optional) ----
function wireLinks() {
  // You can set these to your real pages if you want
  const links = {
    tc: "#",
    cookies: "#",
    contact: "#",
    support: "#",
    about: "#",
  };
  if (elLinkTc) elLinkTc.href = links.tc;
  if (elLinkCookies) elLinkCookies.href = links.cookies;
  if (elLinkContact) elLinkContact.href = links.contact;
  if (elLinkSupport) elLinkSupport.href = links.support;
  if (elLinkAbout) elLinkAbout.href = links.about;
}

// ---- UI wiring ----
function onKeyActivate(el, fn) {
  if (!el) return;
  el.addEventListener("click", fn);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  });
}

function wireControls() {
  // Language toggles
  onKeyActivate(elBtnLangTop, toggleLang);
  onKeyActivate(elBtnLangLower, toggleLang);

  // Theme toggles
  onKeyActivate(elBtnThemeTop, toggleTheme);
  onKeyActivate(elBtnThemeLower, toggleTheme);

  // Clear
  if (elBtnClear) elBtnClear.addEventListener("click", () => {
    if (abortCtrl) abortCtrl.abort();
    clearTranscript();
  });

  // Menu collapse (optional): collapses side panel
  onKeyActivate(elBtnMenu, () => {
    const frame = document.getElementById("app");
    if (!frame) return;
    frame.classList.toggle("side-collapsed");
  });
  onKeyActivate(elBtnMiniMenu, () => {
    const frame = document.getElementById("app");
    if (!frame) return;
    frame.classList.toggle("side-collapsed");
  });

  // Mic/Wave placeholders (future voice)
  onKeyActivate(elBtnMic, () => {
    // placeholder UX: toggle listening animation
    document.body.classList.toggle("listening");
  });
  onKeyActivate(elBtnWave, () => {
    document.body.classList.toggle("listening");
  });

  // Composer textarea: Enter sends, Shift+Enter newline
  if (elInput && elForm) {
    elInput.addEventListener("input", updateCharCount);
    elInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        elForm.requestSubmit();
      }
    });

    elForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = elInput.value || "";
      elInput.value = "";
      updateCharCount();
      await sendMessage(text);
      elInput.focus();
    });
  }

  // Quick input: Enter sends
  if (elChatInput) {
    elChatInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = elChatInput.value || "";
        elChatInput.value = "";
        await sendMessage(text);
        elChatInput.focus();
      }
    });
  }
}

// ---- Boot ----
(function boot() {
  wireLinks();

  // Defaults
  setTheme("dark");
  setLang("en");

  wireControls();
  setStatus("Ready", false);
  updateCharCount();

  // Greeting
  clearTranscript();
})();
