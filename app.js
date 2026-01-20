/**
 * app.js — REPO UI (GitHub Pages)
 * UI -> Enlace (/api/chat) with SSE streaming + Voice (mic -> /api/voice?mode=stt)

 */

// -------------------------
// 0) Enlace endpoint config
// -------------------------
function readEnlaceBaseFromMeta() {
  const m = document.querySelector('meta[name="chattia-enlace"]');
  const raw = (m && m.content ? String(m.content) : "").trim();
  return raw.replace(/\/+$/, "");
}

// If meta tag is missing, fallback to your current worker
const ENLACE_BASE =
  readEnlaceBaseFromMeta() ||
  "https://enlace.grabem-holdem-nuts-right.workers.dev";

const ENLACE_CHAT = `${ENLACE_BASE}/api/chat`;
const ENLACE_VOICE = `${ENLACE_BASE}/api/voice`;

// OPTIONAL: asset identity headers (only if Enlace OPS_ASSET_ALLOWLIST is enabled)
const OPS_ASSET_ID = "";      // e.g. "CHATTIA_WEB_01"
const OPS_ASSET_SHA256 = "";  // e.g. "abcdef1234... (hex sha256)"

// OPTIONAL: Turnstile header (only if your Enlace allows this header in CORS)
const SEND_TURNSTILE_HEADER = true;

// -------------------------
// 1) DOM
// -------------------------
const elMainList = document.getElementById("mainList");
const elChatInput = document.getElementById("chatInput");
const elEmptyState = document.getElementById("emptyState");

const elBtnMiniMenu = document.getElementById("btnMiniMenu"); // we will treat as COPY
const elBtnWave = document.getElementById("btnWave");
const elWaveSvg = document.getElementById("waveSvg");
const elBtnSend = document.getElementById("btnSend");
const elBtnThemeMenu = document.getElementById("btnThemeMenu");

const elStatusDot = document.getElementById("statusDot");
const elStatusTxt = document.getElementById("statusText");

const elHoneypot = document.getElementById("hpField");

// -------------------------
// 2) State
// -------------------------
const MAX_INPUT_CHARS = 1500;
const MAX_TTS_CHARS = 2500;

let history = []; // {role:"user"|"assistant", content:string}[]
let abortCtrl = null;

let state = {
  theme: "LIGHT", // DARK | LIGHT
  listening: false,
  recording: false,
  voiceMode: false, // when true: auto-speak replies
};

// Language state (fixes Spanish accent issue)
let sessionIso2 = "en"; // "en" | "es" | other (2-letter)
let lastSttIso2 = "en"; // from /api/voice?mode=stt

// TTS voices cache
let ttsVoices = [];
if (window.speechSynthesis) {
  const loadVoices = () => { ttsVoices = window.speechSynthesis.getVoices() || []; };
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

// Mic recording
let mediaStream = null;
let mediaRecorder = null;
let recChunks = [];

// Optional system (Brain will inject its own; safe to include but not required)
const SYSTEM_MESSAGE = {
  role: "system",
  content:
    "You are Chattia, the assistant for this chat. Follow the user's language and reply naturally.",
};

// -------------------------
// 3) Helpers
// -------------------------
function setStatus(text, busy) {
  if (elStatusTxt) elStatusTxt.textContent = text || "";
  if (elStatusDot) elStatusDot.classList.toggle("busy", !!busy);
}

function safeTextOnly(s) {
  if (!s) return "";
  return String(s).replace(/\u0000/g, "").trim().slice(0, MAX_INPUT_CHARS);
}

function safeTtsText(s) {
  if (!s) return "";
  return String(s).replace(/\u0000/g, "").trim().slice(0, MAX_TTS_CHARS);
}

function getHoneypotValue() {
  if (!elHoneypot) return "";
  return String(elHoneypot.value || "").trim();
}

function getTurnstileToken() {
  if (!SEND_TURNSTILE_HEADER) return "";
  try {
    if (window.turnstile && typeof window.turnstile.getResponse === "function") {
      return window.turnstile.getResponse() || "";
    }
  } catch {
    return "";
  }
  return "";
}

function detectIso2FastENES(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "en";
  if (/[ñáéíóúü¿¡]/i.test(t)) return "es";
  const esHits = [
    "hola","gracias","por favor","buenos","buenas","como","qué","que ",
    "dónde","donde","cuánto","cuanto","necesito","ayuda","quiero",
    "tengo","puedo","hacer","porque","también","pagar","factura","pedido",
  ].filter((w) => t.includes(w)).length;
  return esHits >= 2 ? "es" : "en";
}

function iso2ToMetaLang(iso2) {
  const x = String(iso2 || "").toLowerCase();
  if (x === "es") return "ES";
  if (x === "en") return "EN";
  return x ? x : "EN";
}

function iso2ToBcp47(iso2) {
  const x = String(iso2 || "").toLowerCase();
  if (x === "es") return "es-ES";
  if (x === "en") return "en-US";
  return x || "en-US";
}

function setDocLangFromIso2(iso2) {
  const tag = iso2ToBcp47(iso2);
  document.documentElement.lang = tag; // fixes TTS defaulting to English accent
}

function appendLine(role, text) {
  const safeText = String(text || "");
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
  return mainLine;
}

function buildTranscriptText() {
  if (!history.length) return "No conversation yet.";
  return history.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n\n");
}

async function copyTranscript() {
  const text = buildTranscriptText();
  if (!text) return;

  // Preferred modern clipboard
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      setStatus("Copied chat", false);
      return;
    }
  } catch {
    // fallback below
  }

  // Fallback copy
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "true");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    setStatus("Copied chat", false);
  } catch {
    setStatus("Copy failed (browser blocked).", false);
  }
  ta.remove();
}

function setTheme(nextTheme) {
  state.theme = nextTheme;
  const dark = state.theme === "DARK";
  document.body.classList.toggle("dark", dark);
  document.body.classList.toggle("light", !dark);
  if (elBtnThemeMenu) elBtnThemeMenu.textContent = dark ? "Light" : "Dark";
}

function setListening(on) {
  state.listening = !!on;
  if (elWaveSvg) elWaveSvg.classList.toggle("listening", state.listening);
  if (elBtnWave) {
    elBtnWave.classList.toggle("is-listening", state.listening);
    elBtnWave.setAttribute("aria-pressed", String(state.listening));
  }
}

function setVoiceMode(on) {
  state.voiceMode = !!on;
  if (!state.voiceMode && window.speechSynthesis) window.speechSynthesis.cancel();
}

function stopAll() {
  // stop streaming
  try { if (abortCtrl) abortCtrl.abort(); } catch {}
  abortCtrl = null;

  // stop recording
  try {
    if (mediaRecorder && state.recording) mediaRecorder.stop();
  } catch {}

  // stop tts
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}

  setListening(false);
  state.recording = false;
  setStatus("Ready", false);
}

// -------------------------
// 4) TTS voice selection (fix Spanish accent)
// -------------------------
function pickVoiceForBcp47(langTag) {
  const tag = String(langTag || "").toLowerCase();
  if (!ttsVoices || !ttsVoices.length) return null;

  // 1) exact prefix match: "es-" or "en-"
  const prefix = tag.split("-")[0];
  let v = ttsVoices.find((x) => String(x.lang || "").toLowerCase().startsWith(prefix + "-"));
  if (v) return v;

  // 2) exact lang match
  v = ttsVoices.find((x) => String(x.lang || "").toLowerCase() === tag);
  if (v) return v;

  // 3) contains (some browsers have weird casing)
  v = ttsVoices.find((x) => String(x.lang || "").toLowerCase().includes(prefix));
  if (v) return v;

  return null;
}

function speakReply(text, iso2Hint) {
  if (!state.voiceMode || !window.speechSynthesis) return;

  const cleaned = safeTtsText(text);
  if (!cleaned) return;

  const iso2 = String(iso2Hint || sessionIso2 || "en").toLowerCase();
  const tag = iso2ToBcp47(iso2);

  const u = new SpeechSynthesisUtterance(cleaned);
  u.lang = tag;

  const voice = pickVoiceForBcp47(tag);
  if (voice) u.voice = voice;

  // Always cancel before speaking to prevent overlap
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

// -------------------------
// 5) SSE helpers
// -------------------------
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

async function streamSse(url, headers, bodyJson, onToken) {
  abortCtrl = new AbortController();

  const resp = await fetch(url, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    headers,
    body: JSON.stringify(bodyJson),
    signal: abortCtrl.signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${text}`);
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();

  // Non-stream JSON fallback
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

  if (!doneSeen && eventData) processSseEventData(eventData, onToken);
}

// -------------------------
// 6) Text chat -> /api/chat (SSE)
// -------------------------
function buildCommonHeaders(acceptValue) {
  const headers = {
    "content-type": "application/json",
    "accept": acceptValue || "text/event-stream",
  };

  if (OPS_ASSET_ID) headers["x-ops-asset-id"] = OPS_ASSET_ID;
  if (OPS_ASSET_SHA256) headers["x-ops-asset-sha256"] = OPS_ASSET_SHA256;

  const ts = getTurnstileToken();
  if (ts) headers["cf-turnstile-response"] = ts;

  return headers;
}

async function sendMessage(userText, opts) {
  userText = safeTextOnly(userText);
  if (!userText) return;

  const honeypotValue = getHoneypotValue();
  if (honeypotValue) {
    setStatus("Blocked: spam detected.", false);
    return;
  }

  // Update session language from user input (prevents wrong TTS accent)
  sessionIso2 = detectIso2FastENES(userText);
  setDocLangFromIso2(sessionIso2);

  appendLine("user", userText);
  history.push({ role: "user", content: userText });

  setStatus("Thinking…", true);

  // Create assistant line NOW and stream into it
  const assistantEl = appendLine("assistant", "");
  let botText = "";

  try {
    const metaLang = (opts && opts.meta && opts.meta.lang)
      ? String(opts.meta.lang)
      : iso2ToMetaLang(sessionIso2);

    const payload = {
      // Many brains ignore caller-provided system; safe to include
      messages: [SYSTEM_MESSAGE, ...history],
      honeypot: honeypotValue,
      meta: { lang: metaLang },
    };

    const headers = buildCommonHeaders("text/event-stream");

    await streamSse(ENLACE_CHAT, headers, payload, (token) => {
      botText += token;
      if (assistantEl) assistantEl.textContent = botText;

      // keep scrolled
      if (elMainList && elMainList.parentElement) {
        const box = elMainList.parentElement;
        box.scrollTop = box.scrollHeight;
      }
    });

    if (!botText.trim()) botText = "(no output)";
    if (assistantEl) assistantEl.textContent = botText;

    history.push({ role: "assistant", content: botText });

    // Speak using the CURRENT language (prevents English accent when Spanish)
    speakReply(botText, sessionIso2);

    setStatus("Ready", false);
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Stopped."
        : `Error:\n${String(err?.message || err)}`;

    if (assistantEl) assistantEl.textContent = msg;
    setStatus("Ready", false);
  } finally {
    abortCtrl = null;
  }
}

// -------------------------
// 7) Voice: Hold-to-talk -> /api/voice?mode=stt -> then /api/chat
// -------------------------
function canRecordAudio() {
  return !!(navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia &&
    window.MediaRecorder);
}

async function startRecording() {
  if (state.recording) return;

  if (!canRecordAudio()) {
    setStatus("Mic recording not supported in this browser.", false);
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setStatus("Mic permission blocked.", false);
    return;
  }

  recChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream);
  } catch {
    // Some browsers require explicit mimeType; try common ones
    try {
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm;codecs=opus" });
    } catch {
      setStatus("Cannot start recorder on this browser.", false);
      try { mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
      mediaStream = null;
      return;
    }
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e && e.data && e.data.size > 0) recChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    setListening(false);
    state.recording = false;

    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    recChunks = [];

    // stop tracks
    try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
    mediaStream = null;

    if (!blob || blob.size < 200) {
      setStatus("No audio captured.", false);
      return;
    }

    await handleVoiceBlob(blob);
  };

  state.recording = true;
  setVoiceMode(true); // auto-speak replies after voice
  setListening(true);
  setStatus("Listening… (release to send)", true);

  try {
    mediaRecorder.start();
  } catch {
    setStatus("Recorder failed to start.", false);
    setListening(false);
    state.recording = false;
    try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
    mediaStream = null;
  }
}

function stopRecording() {
  if (!state.recording) return;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  } catch {
    // force stop tracks
    try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
    mediaStream = null;
    setListening(false);
    state.recording = false;
    setStatus("Ready", false);
  }
}

async function voiceStt(blob) {
  // /api/voice?mode=stt returns JSON: { transcript, lang, voice_timeout_sec }
  // lang expected "EN" or "ES"
  const headers = {};

  // IMPORTANT: If your Enlace CORS does NOT allow custom headers for /api/voice,
  // leave these empty. Only add them if you already allowlist them in Enlace.
  if (OPS_ASSET_ID) headers["x-ops-asset-id"] = OPS_ASSET_ID;
  if (OPS_ASSET_SHA256) headers["x-ops-asset-sha256"] = OPS_ASSET_SHA256;

  const ts = getTurnstileToken();
  if (ts) headers["cf-turnstile-response"] = ts;

  // Set content-type to the blob type so Enlace can treat it as audio/*
  if (blob.type) headers["content-type"] = blob.type;

  const resp = await fetch(`${ENLACE_VOICE}?mode=stt`, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    headers,
    body: blob,
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Voice STT failed: HTTP ${resp.status}\n${t}`);
  }

  const obj = await resp.json().catch(() => null);
  const transcript = safeTextOnly(obj && obj.transcript ? obj.transcript : "");
  const langRaw = String(obj && obj.lang ? obj.lang : "").toUpperCase().trim();

  let iso2 = "en";
  if (langRaw === "ES") iso2 = "es";
  else if (langRaw === "EN") iso2 = "en";
  else iso2 = detectIso2FastENES(transcript);

  return { transcript, iso2 };
}

async function handleVoiceBlob(blob) {
  try {
    setStatus("Transcribing…", true);

    const { transcript, iso2 } = await voiceStt(blob);

    if (!transcript) {
      setStatus("No transcription produced.", false);
      return;
    }

    // Update language based on STT result
    lastSttIso2 = iso2;
    sessionIso2 = iso2;
    setDocLangFromIso2(sessionIso2);

    // Show transcript as user's message
    if (elChatInput) elChatInput.value = transcript;

    // Auto-send transcript
    setStatus("Sending…", true);
    if (elChatInput) {
      const txt = elChatInput.value || "";
      elChatInput.value = "";
      await sendMessage(txt, { meta: { lang: iso2ToMetaLang(sessionIso2) } });
    } else {
      await sendMessage(transcript, { meta: { lang: iso2ToMetaLang(sessionIso2) } });
    }

    setStatus("Ready", false);
  } catch (e) {
    setStatus("Ready", false);
    appendLine("assistant", `Voice error:\n${String(e?.message || e)}`);
  }
}

// -------------------------
// 8) Events
// -------------------------
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

// Mini button: COPY transcript (no downloads)
wireButtonLike(elBtnMiniMenu, copyTranscript);

// Theme
function toggleTheme() {
  setTheme(state.theme === "DARK" ? "LIGHT" : "DARK");
}
wireButtonLike(elBtnThemeMenu, toggleTheme);

// Send button
wireButtonLike(elBtnSend, sendFromInput);

// Voice button: HOLD TO TALK (pointer + keyboard)
if (elBtnWave) {
  // Pointer (mouse / touch)
  elBtnWave.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (state.recording) return;
    startRecording();
  });

  const endPtr = (e) => {
    e.preventDefault();
    stopRecording();
  };

  elBtnWave.addEventListener("pointerup", endPtr);
  elBtnWave.addEventListener("pointercancel", endPtr);
  elBtnWave.addEventListener("pointerleave", (e) => {
    // only stop if currently recording
    if (state.recording) endPtr(e);
  });

  // Keyboard hold (Space/Enter): start on keydown, stop on keyup
  elBtnWave.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    if (e.repeat) return;
    e.preventDefault();
    startRecording();
  });

  elBtnWave.addEventListener("keyup", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    stopRecording();
  });
}

// Safety: ESC stops everything (streaming, mic, TTS)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") stopAll();
});

// -------------------------
// 9) Init
// -------------------------
setTheme(state.theme);
setStatus("Ready", false);

// Keep voiceMode off by default (you can set true if you want auto-speak always)
setVoiceMode(false);

// Ensure doc lang is set for TTS baseline
setDocLangFromIso2(sessionIso2);
