/**
 * app.js — REPO UI (GitHub Pages) (v0.3 KEYS UPDATED)
 * UI -> Enlace (/api/chat) with SSE streaming + Voice (mic -> /api/voice?mode=stt)
 *
 * Repo file (NOT a CF Worker).
 *
 * Changes (your new scheme):
 * - UI identity now uses ops-keys.json:
 *   - ASSET_ID_ZULU_Pu (public) -> sent as: x-ops-asset-id
 *   - src_PUBLIC_SHA512_B64     -> sent as: x-ops-src-sha512-b64
 * - Removed old hardcoded:
 *   - OPS_ASSET_ID = "https://github..."
 *   - x-ops-asset-sha256 = (hex)
 *
 * Still optional:
 * - cf-turnstile-response header ONLY if you actually render Turnstile on the page.
 */

// -------------------------
// 0) Enlace endpoint config
// -------------------------
function readEnlaceBaseFromMeta() {
  // supports either:
  // <meta name="chattia-enlace-base" content="https://...workers.dev">
  // or legacy: <meta name="chattia-enlace" content="https://...workers.dev">
  const m1 = document.querySelector('meta[name="chattia-enlace-base"]');
  const m2 = document.querySelector('meta[name="chattia-enlace"]');
  const raw = (m1 && m1.content ? String(m1.content) : (m2 && m2.content ? String(m2.content) : "")).trim();
  return raw.replace(/\/+$/, "");
}

// If meta tag is missing, fallback to your current worker
const ENLACE_BASE = readEnlaceBaseFromMeta() || "https://enlace.grabem-holdem-nuts-right.workers.dev";
const ENLACE_CHAT = `${ENLACE_BASE}/api/chat`;
const ENLACE_VOICE = `${ENLACE_BASE}/api/voice`;

// -------------------------
// 0.1) Public repo keys loader (ops-keys.json)
// -------------------------
const OPS_KEYS_URL = "ops-keys.json"; // same folder as index.html on GitHub Pages

let OPS_KEYS_CACHE = null;
let OPS_KEYS_PROMISE = null;

async function loadOpsKeys() {
  if (OPS_KEYS_CACHE) return OPS_KEYS_CACHE;
  if (OPS_KEYS_PROMISE) return OPS_KEYS_PROMISE;

  OPS_KEYS_PROMISE = (async () => {
    try {
      const resp = await fetch(OPS_KEYS_URL, { cache: "no-store" });
      if (!resp.ok) throw new Error(`ops-keys.json HTTP ${resp.status}`);
      const obj = await resp.json();
      OPS_KEYS_CACHE = (obj && typeof obj === "object") ? obj : {};
      return OPS_KEYS_CACHE;
    } catch {
      // Safe fallback: run without identity headers if file missing
      OPS_KEYS_CACHE = {};
      return OPS_KEYS_CACHE;
    } finally {
      OPS_KEYS_PROMISE = null;
    }
  })();

  return OPS_KEYS_PROMISE;
}

// UI identity headers (public)
// - Pull from ops-keys.json:
//   ASSET_ID_ZULU_Pu -> x-ops-asset-id
//   src_PUBLIC_SHA512_B64 -> x-ops-src-sha512-b64
async function getUiIdentity() {
  const k = await loadOpsKeys();
  return {
    assetIdZuluPu: String(k?.ASSET_ID_ZULU_Pu || "").trim(),
    srcSha512B64: String(k?.src_PUBLIC_SHA512_B64 || "").trim(),
  };
}

// Turnstile header:
// Set true ONLY if Turnstile is actually rendered on the UI and Enlace enforces it.
const SEND_TURNSTILE_HEADER = true;

// -------------------------
// 1) DOM
// -------------------------
const elMainList = document.getElementById("mainList");
const elChatInput = document.getElementById("chatInput");
const elEmptyState = document.getElementById("emptyState");

const elBtnMiniMenu = document.getElementById("btnMiniMenu"); // COPY transcript
const elBtnWave = document.getElementById("btnWave");
const elWaveSvg = document.getElementById("waveSvg");
const elBtnSend = document.getElementById("btnSend");
const elBtnThemeMenu = document.getElementById("btnThemeMenu");

const elBtnLangTop = document.getElementById("btnLangTop");
const elBtnLangLower = document.getElementById("btnLangLower");

const elLangBadge = document.getElementById("langBadge");

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

// Language mode: AUTO -> detect, EN -> force, ES -> force
let langMode = "AUTO"; // "AUTO" | "EN" | "ES"

// Session language (iso2) used for TTS + meta.lang
let sessionIso2 = "en";
let lastSttIso2 = "en";

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

function abortActiveStream() {
  try { if (abortCtrl) abortCtrl.abort(); } catch {}
  abortCtrl = null;
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
  document.documentElement.lang = tag;
}

function showLangBadge(label) {
  if (!elLangBadge) return;
  const txt = String(label || "").trim();
  if (!txt) {
    elLangBadge.style.display = "none";
    elLangBadge.textContent = "";
    return;
  }
  elLangBadge.style.display = "block";
  elLangBadge.textContent = txt;
}

function applyLangMode(mode) {
  langMode = mode;

  const label = (mode === "AUTO") ? "AUTO" : mode;
  if (elBtnLangTop) elBtnLangTop.textContent = label;
  if (elBtnLangLower) elBtnLangLower.textContent = label;

  if (mode === "EN") sessionIso2 = "en";
  if (mode === "ES") sessionIso2 = "es";

  setDocLangFromIso2(sessionIso2);
  showLangBadge(`Lang: ${label} • ${iso2ToBcp47(sessionIso2)}`);
}

function nextLangMode(current) {
  if (current === "AUTO") return "EN";
  if (current === "EN") return "ES";
  return "AUTO";
}

function appendLine(role, text) {
  const safeText = String(text || "");
  const mainLine = document.createElement("div");
  mainLine.className = "line";
  mainLine.classList.add(`line-${role}`);
  mainLine.textContent = safeText;

  if (elMainList) elMainList.appendChild(mainLine);
  if (elEmptyState) elEmptyState.classList.add("is-hidden");

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

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      setStatus("Copied chat", false);
      return;
    }
  } catch {}

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

function stopTracks() {
  try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
  mediaStream = null;
}

function stopAll() {
  // stop streaming
  abortActiveStream();

  // stop recording
  try {
    if (mediaRecorder && state.recording && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}
  state.recording = false;
  setListening(false);
  stopTracks();
  mediaRecorder = null;

  // stop tts
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}

  setStatus("Ready", false);
}

// -------------------------
// 4) TTS voice selection
// -------------------------
function pickVoiceForBcp47(langTag) {
  const tag = String(langTag || "").toLowerCase();
  if (!ttsVoices || !ttsVoices.length) return null;

  const prefix = tag.split("-")[0];

  let v = ttsVoices.find((x) => String(x.lang || "").toLowerCase().startsWith(prefix + "-"));
  if (v) return v;

  v = ttsVoices.find((x) => String(x.lang || "").toLowerCase() === tag);
  if (v) return v;

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

async function buildCommonHeaders(acceptValue) {
  const headers = {
    "content-type": "application/json",
    "accept": acceptValue || "text/event-stream",
  };

  // NEW: UI identity from ops-keys.json
  const ident = await getUiIdentity();
  if (ident.assetIdZuluPu) headers["x-ops-asset-id"] = ident.assetIdZuluPu;
  if (ident.srcSha512B64) headers["x-ops-src-sha512-b64"] = ident.srcSha512B64;

  // Optional: Turnstile token
  const ts = getTurnstileToken();
  if (ts) headers["cf-turnstile-response"] = ts;

  return headers;
}

async function streamChatSse(payload, onToken, onHeaders) {
  // Abort any prior stream before starting a new one
  abortActiveStream();
  abortCtrl = new AbortController();

  const bodyText = JSON.stringify(payload);
  const headers = await buildCommonHeaders("text/event-stream");

  const resp = await fetch(ENLACE_CHAT, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    headers,
    body: bodyText,
    signal: abortCtrl.signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${text}`);
  }

  if (typeof onHeaders === "function") onHeaders(resp.headers);

  const ct = (resp.headers.get("content-type") || "").toLowerCase();

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
function decideIso2ForUserText(userText) {
  if (langMode === "EN") return "en";
  if (langMode === "ES") return "es";
  const guess = detectIso2FastENES(userText);
  return guess || sessionIso2 || "en";
}

async function sendMessage(userText) {
  userText = safeTextOnly(userText);
  if (!userText) return;

  const honeypotValue = getHoneypotValue();
  if (honeypotValue) {
    setStatus("Blocked: spam detected.", false);
    return;
  }

  sessionIso2 = decideIso2ForUserText(userText);
  setDocLangFromIso2(sessionIso2);

  appendLine("user", userText);
  history.push({ role: "user", content: userText });

  setStatus("Thinking…", true);

  const assistantEl = appendLine("assistant", "");
  let botText = "";

  try {
    const payload = {
      messages: history,
      honeypot: honeypotValue,
      meta: {
        lang: iso2ToMetaLang(sessionIso2),       // "EN"/"ES" (legacy preferred)
        lang_iso2: sessionIso2,                  // "en"/"es"
        lang_bcp47: iso2ToBcp47(sessionIso2),    // "en-US"/"es-ES"
      },
    };

    await streamChatSse(
      payload,
      (token) => {
        botText += token;
        if (assistantEl) assistantEl.textContent = botText;
        if (elMainList && elMainList.parentElement) {
          const box = elMainList.parentElement;
          box.scrollTop = box.scrollHeight;
        }
      },
      (hdrs) => {
        const iso2 = String(hdrs.get("x-chattia-text-iso2") || "").trim().toLowerCase();
        if (iso2) {
          if (langMode === "AUTO") sessionIso2 = iso2;
          setDocLangFromIso2(sessionIso2);
          showLangBadge(`Lang: ${langMode} • ${iso2ToBcp47(sessionIso2)}`);
        }
      }
    );

    if (!botText.trim()) botText = "(no output)";
    if (assistantEl) assistantEl.textContent = botText;

    history.push({ role: "assistant", content: botText });

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
  } catch {
    setStatus("Mic permission blocked.", false);
    return;
  }

  recChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream);
  } catch {
    try {
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm;codecs=opus" });
    } catch {
      setStatus("Cannot start recorder on this browser.", false);
      stopTracks();
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

    stopTracks();

    if (!blob || blob.size < 200) {
      setStatus("No audio captured.", false);
      return;
    }

    await handleVoiceBlob(blob);
  };

  state.recording = true;
  setVoiceMode(true);
  setListening(true);
  setStatus("Listening… (release to send)", true);

  try {
    mediaRecorder.start();
  } catch {
    setStatus("Recorder failed to start.", false);
    setListening(false);
    state.recording = false;
    stopTracks();
  }
}

function stopRecording() {
  if (!state.recording) return;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {
    stopTracks();
    setListening(false);
    state.recording = false;
    setStatus("Ready", false);
  }
}

async function headersForVoiceBlob(blob) {
  const headers = {
    "accept": "application/json",
  };

  // NEW: UI identity from ops-keys.json
  const ident = await getUiIdentity();
  if (ident.assetIdZuluPu) headers["x-ops-asset-id"] = ident.assetIdZuluPu;
  if (ident.srcSha512B64) headers["x-ops-src-sha512-b64"] = ident.srcSha512B64;

  const ts = getTurnstileToken();
  if (ts) headers["cf-turnstile-response"] = ts;

  if (blob && blob.type) headers["content-type"] = blob.type;

  return headers;
}

function iso2FromVoiceResponse(respHeaders, bodyObj, transcriptFallback) {
  const hIso2 = String(respHeaders.get("x-chattia-stt-iso2") || "").trim().toLowerCase();
  if (hIso2) return hIso2;

  const hLegacy = String(respHeaders.get("x-chattia-stt-lang") || "").trim().toUpperCase();
  if (hLegacy === "ES") return "es";
  if (hLegacy === "EN") return "en";

  const bIso2 = String((bodyObj && (bodyObj.lang_iso2 || bodyObj.langIso2)) || "").trim().toLowerCase();
  if (bIso2) return bIso2;

  const bLegacy = String((bodyObj && bodyObj.lang) || "").trim().toUpperCase();
  if (bLegacy === "ES") return "es";
  if (bLegacy === "EN") return "en";

  return detectIso2FastENES(transcriptFallback || "");
}

async function voiceStt(blob) {
  const resp = await fetch(`${ENLACE_VOICE}?mode=stt`, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    headers: await headersForVoiceBlob(blob),
    body: blob,
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Voice STT failed: HTTP ${resp.status}\n${t}`);
  }

  const obj = await resp.json().catch(() => null);

  const transcript = safeTextOnly(
    (obj && (obj.transcript || obj.text || obj.result?.text)) ? (obj.transcript || obj.text || obj.result?.text) : ""
  );

  const iso2 = iso2FromVoiceResponse(resp.headers, obj, transcript);

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

    lastSttIso2 = iso2;

    if (langMode === "AUTO") sessionIso2 = iso2;
    if (langMode === "EN") sessionIso2 = "en";
    if (langMode === "ES") sessionIso2 = "es";

    setDocLangFromIso2(sessionIso2);
    showLangBadge(`Lang: ${langMode} • ${iso2ToBcp47(sessionIso2)}`);

    if (elChatInput) elChatInput.value = transcript;

    setStatus("Sending…", true);
    if (elChatInput) {
      const txt = elChatInput.value || "";
      elChatInput.value = "";
      await sendMessage(txt);
    } else {
      await sendMessage(transcript);
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

wireButtonLike(elBtnMiniMenu, copyTranscript);
wireButtonLike(elBtnThemeMenu, () => setTheme(state.theme === "DARK" ? "LIGHT" : "DARK"));

function toggleLangMode() {
  const next = nextLangMode(langMode);
  applyLangMode(next);
}
wireButtonLike(elBtnLangTop, toggleLangMode);
wireButtonLike(elBtnLangLower, toggleLangMode);

wireButtonLike(elBtnSend, sendFromInput);

if (elBtnWave) {
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
    if (state.recording) endPtr(e);
  });

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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") stopAll();
});

// -------------------------
// 9) Init
// -------------------------
setTheme(state.theme);
setStatus("Ready", false);

applyLangMode("AUTO");
setVoiceMode(false);
setDocLangFromIso2(sessionIso2);
showLangBadge(`Lang: ${langMode} • ${iso2ToBcp47(sessionIso2)}`);

// Preload ops-keys.json (non-blocking)
loadOpsKeys().catch(() => {});
