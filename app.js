/**
 * app.js — Chattia UI -> Enlace (/api/chat) with SSE streaming
 *
 * ✅ No libraries
 * ✅ Safe DOM writes (textContent only)
 * ✅ SSE parsing (blank-line framed, multi-line data tolerant)
 * ✅ Works with your index.html IDs + your styles.css classes
 *
 * Flow:
 * UI -> ENLACE_API (/api/chat) -> (Enlace -> Brain) -> SSE -> UI
 */

// 1) Set this to your Enlace endpoint
const ENLACE_API = "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat";

// 2) OPTIONAL: asset identity headers (only if Enlace OPS_ASSET_ALLOWLIST is enabled)
const OPS_ASSET_ID = "";      // e.g. "CHATTIA_WEB_01"
const OPS_ASSET_SHA256 = "";  // e.g. "abcdef1234... (hex sha256)"

// ---- DOM ----
const elFrame = document.getElementById("app");
const elMainList = document.getElementById("mainList");
const elSideList = document.getElementById("sideList");

const elChatInput = document.getElementById("chatInput");

const elBtnClear = document.getElementById("btnClear");

const elBtnMenu = document.getElementById("btnMenu");
const elBtnMiniMenu = document.getElementById("btnMiniMenu");

const elBtnMic = document.getElementById("btnMic");
const elBtnWave = document.getElementById("btnWave");
const elWaveSvg = document.getElementById("waveSvg");

const elBtnLangTop = document.getElementById("btnLangTop");
const elBtnLangLower = document.getElementById("btnLangLower");

const elBtnThemeTop = document.getElementById("btnThemeTop");
const elBtnThemeLower = document.getElementById("btnThemeLower");

const elSideLang = document.getElementById("sideLang");
const elSideMode = document.getElementById("sideMode");

const elStatusDot = document.getElementById("statusDot");
const elStatusTxt = document.getElementById("statusText");

const elLinkTc = document.getElementById("lnkTc");
const elLinkCookies = document.getElementById("lnkCookies");
const elLinkContact = document.getElementById("lnkContact");
const elLinkSupport = document.getElementById("lnkSupport");
const elLinkAbout = document.getElementById("lnkAbout");

// ---- Config (edit safely) ----
const CONFIG = {
  links: {
    tc: "#",
    cookies: "#",
    contact: "#",
    support: "#",
    about: "#",
  },
  starterMessage: "Hi — I’m ready. Ask me anything (plain text).",
};

// ---- State ----
const MAX_INPUT_CHARS = 1500;
let history = []; // {role:"user"|"assistant", content:string}[]
let abortCtrl = null;

let state = {
  lang: "EN",     // EN | ES
  theme: "DARK",  // DARK | LIGHT
  sideOpen: true,
  listening: false,
};

// ---- Helpers ----
function setStatus(text, busy) {
  if (elStatusTxt) elStatusTxt.textContent = text || "";
  if (elStatusDot) elStatusDot.classList.toggle("busy", !!busy);
}

function updateLinks() {
  if (elLinkTc) elLinkTc.href = CONFIG.links.tc || "#";
  if (elLinkCookies) elLinkCookies.href = CONFIG.links.cookies || "#";
  if (elLinkContact) elLinkContact.href = CONFIG.links.contact || "#";
  if (elLinkSupport) elLinkSupport.href = CONFIG.links.support || "#";
  if (elLinkAbout) elLinkAbout.href = CONFIG.links.about || "#";
}

function safeTextOnly(s) {
  if (!s) return "";
  return String(s).replace(/\u0000/g, "").trim().slice(0, MAX_INPUT_CHARS);
}

function timeStamp() {
  return new Date().toLocaleString();
}

function appendLine(role, text) {
  const line = document.createElement("div");
  line.className = "line";
  line.textContent = `${role.toUpperCase()} • ${timeStamp()}\n${text || ""}`;

  if (elMainList) elMainList.appendChild(line);
  if (elSideList) elSideList.appendChild(line.cloneNode(true)); // mirror

  // Keep scrolled
  if (elMainList && elMainList.parentElement) {
    const box = elMainList.parentElement;
    box.scrollTop = box.scrollHeight;
  }
  if (elSideList && elSideList.parentElement) {
    const box2 = elSideList.parentElement;
    box2.scrollTop = box2.scrollHeight;
  }
}

function clearTranscript() {
  if (elMainList) elMainList.innerHTML = "";
  if (elSideList) elSideList.innerHTML = "";
  history = [];
  setStatus("Ready", false);
}

function setTheme(nextTheme) {
  state.theme = nextTheme;
  const dark = state.theme === "DARK";
  document.body.classList.toggle("dark", dark);

  if (elBtnThemeTop) elBtnThemeTop.textContent = dark ? "Dark" : "Light";
  if (elBtnThemeLower) elBtnThemeLower.textContent = dark ? "Dark" : "Light";
  if (elSideMode) elSideMode.textContent = dark ? "DARK" : "LIGHT";
}

function setLang(nextLang) {
  state.lang = nextLang;
  if (elBtnLangTop) elBtnLangTop.textContent = state.lang;
  if (elBtnLangLower) elBtnLangLower.textContent = state.lang;
  if (elSideLang) elSideLang.textContent = state.lang;
}

function toggleSide() {
  state.sideOpen = !state.sideOpen;
  if (elFrame) elFrame.classList.toggle("side-collapsed", !state.sideOpen);
}

function setListening(on) {
  state.listening = !!on;
  // CSS listens on a "listening" class (we attach to the svg parent)
  if (elWaveSvg) elWaveSvg.classList.toggle("listening", state.listening);
}

// ---- Token extraction (handles multiple AI response shapes) ----
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

// ---- SSE event data handler ----
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

// ---- Streaming call ----
async function streamFromEnlace(payload, onToken) {
  abortCtrl = new AbortController();

  const headers = {
    "content-type": "application/json",
    "accept": "text/event-stream",
  };

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

  // If it returns JSON for any reason (non-stream), handle once.
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

// ---- Send message ----
async function sendMessage(userText) {
  userText = safeTextOnly(userText);
  if (!userText) return;

  appendLine("user", userText);
  history.push({ role: "user", content: userText });

  setStatus("Thinking…", true);

  let botText = "";
  let rafId = null;

  const flush = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      // Show partial streaming output as a single growing line:
      // We clear the last "assistant" line visually by re-rendering at end
      // (simple and safe; avoids innerHTML)
      // For 2026 UX, we keep it minimal and stable.
    });
  };

  try {
    // Let backend know current language preference (Brain can use it or ignore it)
    const payload = {
      messages: history,
      meta: { lang: state.lang }, // EN or ES
    };

    await streamFromEnlace(payload, (token) => {
      botText += token;
      flush();
    });

    if (rafId) cancelAnimationFrame(rafId);

    if (!botText.trim()) botText = "(no output)";
    appendLine("assistant", botText);
    history.push({ role: "assistant", content: botText });

    setStatus("Ready", false);
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Stopped."
        : `Error:\n${String(err?.message || err)}`;

    appendLine("assistant", msg);
    setStatus("Ready", false);
  } finally {
    abortCtrl = null;
  }
}

// ---- Events ----
function wireButtonLike(el, onClick) {
  if (!el) return;
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  });
}

if (elChatInput) {
  elChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const current = elChatInput.value || "";
      elChatInput.value = "";
      sendMessage(current);
    }
  });
}

wireButtonLike(elBtnMenu, toggleSide);
wireButtonLike(elBtnMiniM
