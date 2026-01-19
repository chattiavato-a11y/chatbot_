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

// 3) OPTIONAL: Enlace Transcribe endpoint (for voice input Option B)
// NOTE: the transcribe worker must allowlist your origin and allow these headers:
// "content-type", "x-ops-asset-id", "x-ops-asset-sha256"
const ENLACE_TRANSCRIBE = "https://enlace.grabem-holdem-nuts-right.workers.dev/api/transcribe";

// Voice input mode: "auto" (default) | "enlace" | "browser"
const VOICE_INPUT_MODE = "auto";

// ---- DOM ----
const elMainList = document.getElementById("mainList");

const elChatInput = document.getElementById("chatInput");

const elEmptyState = document.getElementById("emptyState");

const elBtnMiniMenu = document.getElementById("btnMiniMenu");
const elBtnWave = document.getElementById("btnWave");
const elWaveSvg = document.getElementById("waveSvg");
const elBtnSend = document.getElementById("btnSend");
const elBtnLangTop = document.getElementById("btnLangTop");
const elBtnLangLower = document.getElementById("btnLangLower");

const elBtnThemeMenu = document.getElementById("btnThemeMenu");


const elStatusDot = document.getElementById("statusDot");
const elStatusTxt = document.getElementById("statusText");

const elHoneypot = document.getElementById("hpField");

const elSupportModal = document.getElementById("supportModal");
const elSupportClose = document.getElementById("supportClose");
const elSupportBackdrop = document.getElementById("supportModalBackdrop");

// ---- State ----
const MAX_INPUT_CHARS = 1500;
let history = []; // {role:"user"|"assistant", content:string}[]
let abortCtrl = null;
const SYSTEM_MESSAGE = {
  role: "system",
  content:
    "You are Chattia, the assistant for this chat. Identify yourself as Chattia when asked or introducing yourself.",
};

let state = {
  theme: "DARK",  // DARK | LIGHT
  listening: false,
  voiceMode: false,
};

let lastFocusEl = null;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let voiceInputBase = "";
let voiceInputText = "";
let voiceEndTimeout = null;

// ---- Helpers ----
function setStatus(text, busy) {
  if (elStatusTxt) elStatusTxt.textContent = text || "";
  if (elStatusDot) elStatusDot.classList.toggle("busy", !!busy);
}

function safeTextOnly(s) {
  if (!s) return "";
  return String(s).replace(/\u0000/g, "").trim().slice(0, MAX_INPUT_CHARS);
}

function getHoneypotValue() {
  if (!elHoneypot) return "";
  return String(elHoneypot.value || "").trim();
}

function getTurnstileToken() {
  try {
    if (window.turnstile && typeof window.turnstile.getResponse === "function") {
      return window.turnstile.getResponse();
    }
  } catch {
    return "";
  }
  return "";
}

function appendLine(role, text) {
  const safeText = text || "";
  const mainLine = document.createElement("div");
  mainLine.className = "line";
  mainLine.classList.add(`line-${role}`);
  mainLine.textContent = safeText;

  if (elMainList) elMainList.appendChild(mainLine);

  if (elEmptyState) elEmptyState.classList.add("is-hidden");

  // Keep scrolled
  if (elMainList && elMainList.parentElement) {
    const box = elMainList.parentElement;
    box.scrollTop = box.scrollHeight;
  }
}

function buildTranscriptText() {
  if (!history.length) {
    return "No conversation yet.";
  }
  return history
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
    .join("\n\n");
}

function downloadTranscript() {
  const text = buildTranscriptText();
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chattia-transcript-${stamp}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("Transcript downloaded", false);
}

function setTheme(nextTheme) {
  state.theme = nextTheme;
  const dark = state.theme === "DARK";
  document.body.classList.toggle("dark", dark);
  document.body.classList.toggle("light", !dark);

  if (elBtnThemeMenu) elBtnThemeMenu.textContent = dark ? "Dark" : "Light";
}

function openSupportModal() {
  if (!elSupportModal) return;
  lastFocusEl = document.activeElement;
  elSupportModal.classList.remove("is-hidden");
  document.body.classList.add("modal-open");
  if (elSupportClose) elSupportClose.focus();
}

function closeSupportModal() {
  if (!elSupportModal) return;
  elSupportModal.classList.add("is-hidden");
  document.body.classList.remove("modal-open");
  if (lastFocusEl && typeof lastFocusEl.focus === "function") {
    lastFocusEl.focus();
  }
  lastFocusEl = null;
}

function setListening(on) {
  state.listening = !!on;
  // CSS listens on a "listening" class (we attach to the svg parent)
  if (elWaveSvg) elWaveSvg.classList.toggle("listening", state.listening);
  if (elBtnWave) {
    elBtnWave.classList.toggle("is-listening", state.listening);
    elBtnWave.setAttribute("aria-pressed", String(state.listening));
  }
}

function setVoiceMode(on) {
  state.voiceMode = !!on;
  if (elBtnWave) {
    elBtnWave.classList.toggle("is-active", state.voiceMode);
    elBtnWave.setAttribute(
      "aria-label",
      state.voiceMode ? "Voice activated" : "Activate voice"
    );
    elBtnWave.title = state.voiceMode ? "Voice activated" : "Activate voice";
  }
  if (!state.voiceMode && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

function speakReply(text) {
  if (!state.voiceMode || !window.speechSynthesis) return;
  const cleaned = safeTextOnly(text);
  if (!cleaned) return;
  const utterance = new SpeechSynthesisUtterance(cleaned);
  utterance.lang = document.documentElement.lang || "en-US";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function initSpeechRecognition() {
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = document.documentElement.lang || "en-US";

  rec.onstart = () => {
    if (voiceEndTimeout) {
      clearTimeout(voiceEndTimeout);
      voiceEndTimeout = null;
    }
    voiceInputBase = elChatInput ? (elChatInput.value || "").trim() : "";
    voiceInputText = "";
    setVoiceMode(true);
    setListening(true);
    setStatus("Listening…", true);
  };

  rec.onresult = (event) => {
    if (!elChatInput) return;
    let finalTranscript = "";
    let interimTranscript = "";
    for (let i = 0; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0] ? result[0].transcript : "";
      if (result.isFinal) {
        finalTranscript += text;
      } else {
        interimTranscript += text;
      }
    }
    voiceInputText = `${finalTranscript}${interimTranscript}`.trim();
    if (voiceInputText) {
      const separator = voiceInputBase ? " " : "";
      elChatInput.value = `${voiceInputBase}${separator}${voiceInputText}`;
    } else {
      elChatInput.value = voiceInputBase;
    }
  };

  rec.onerror = (event) => {
    setListening(false);
    setVoiceMode(false);
    setStatus(`Mic error: ${event.error || "unknown"}`, false);
  };

  rec.onend = () => {
    const shouldAutoSend = elChatInput && elChatInput.value.trim().length > 0;
    if (shouldAutoSend) {
      sendFromInput();
    }
    setListening(false);
    setStatus("Ready", false);
    voiceInputBase = "";
    voiceInputText = "";
    voiceEndTimeout = window.setTimeout(() => {
      setVoiceMode(false);
      voiceEndTimeout = null;
    }, 30000);
  };

  return rec;
}

function toggleVoiceInput() {
  if (!SpeechRecognition) {
    setStatus("Voice input not supported in this browser.", false);
    return;
  }
  if (!recognition) recognition = initSpeechRecognition();
  if (!recognition) return;

  if (state.voiceMode) {
    setVoiceMode(false);
    if (state.listening) recognition.stop();
    if (voiceEndTimeout) {
      clearTimeout(voiceEndTimeout);
      voiceEndTimeout = null;
    }
    setStatus("Voice off", false);
    return;
  }

  setVoiceMode(true);
  if (elChatInput) elChatInput.focus();
  recognition.start();
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
  const ts = getTurnstileToken();
  if (ts) headers["cf-turnstile-response"] = ts;

  const resp = await fetch(ENLACE_API, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
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

  const honeypotValue = getHoneypotValue();
  if (honeypotValue) {
    setStatus("Blocked: spam detected.", false);
    return;
  }

  appendLine("user", userText);
  history.push({ role: "user", content: userText });

  setStatus("Thinking…", true);

  let botText = "";

  try {
    const payload = {
      messages: [SYSTEM_MESSAGE, ...history],
      honeypot: honeypotValue,
    };

    await streamFromEnlace(payload, (token) => {
      botText += token;
    });

    if (!botText.trim()) botText = "(no output)";
    appendLine("assistant", botText);
    history.push({ role: "assistant", content: botText });
    speakReply(botText);

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

function sendFromInput() {
  if (!elChatInput) return;
  const current = elChatInput.value || "";
  elChatInput.value = "";
  sendMessage(current);
  elChatInput.focus();
}

if (elChatInput) {
  elChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendFromInput();
    }
  });
}

wireButtonLike(elBtnMiniMenu, downloadTranscript);

function toggleTheme() {
  setTheme(state.theme === "DARK" ? "LIGHT" : "DARK");
}

wireButtonLike(elBtnThemeMenu, toggleTheme);

wireButtonLike(elBtnWave, toggleVoiceInput);
wireButtonLike(elBtnSend, sendFromInput);

if (elSupportClose) {
  elSupportClose.addEventListener("click", () => {
    closeSupportModal();
  });
}

if (elSupportBackdrop) {
  elSupportBackdrop.addEventListener("click", () => {
    closeSupportModal();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (elSupportModal && !elSupportModal.classList.contains("is-hidden")) {
    closeSupportModal();
  }
});

setTheme(state.theme);
setStatus("Ready", false);
