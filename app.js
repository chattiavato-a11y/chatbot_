/**
 * app.js — REPO UI (GitHub Pages)
 * UI -> Enlace (/api/chat) with SSE streaming + Voice (mic -> /api/voice?mode=stt)
 *
 * Repo file (NOT a CF Worker).
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

// OPTIONAL: asset identity headers (only if Enlace OPS_ASSET_ALLOWLIST is enabled)
const OPS_ASSET_ID = "https://github.com/chattiavato-a11y/chatbot_";
const OPS_ASSET_SHA256 = "A43194265A4D9D670083B2C19675C6D1F10E000EEE3300B79704C59BF9CF26F1";
// OPTIONAL: private key (JWK string) used to sign requests for replay protection
const OPS_ASSET_ID_PRIV_KEY = "";

// OPTIONAL: Turnstile header (only if your Enlace allows this header in CORS)
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

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function normalizeJwkForSigning(raw) {
  const jwk = { ...raw };
  jwk.alg = "RS256";
  jwk.key_ops = ["sign"];
  return jwk;
}

async function signAssetPayload(payload) {
  if (!OPS_ASSET_ID_PRIV_KEY || !crypto?.subtle) return null;
  let jwk;
  try {
    jwk = normalizeJwkForSigning(JSON.parse(OPS_ASSET_ID_PRIV_KEY));
  } catch {
    return null;
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(payload)
  );
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

async function buildAssetSignatureHeaders(bodyText) {
  if (!OPS_ASSET_ID_PRIV_KEY || !OPS_ASSET_ID || !bodyText) return {};
  const timestamp = Date.now().toString();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = base64UrlEncodeBytes(nonceBytes);
  const bodyHash = await sha256Hex(bodyText);
  const payload = `${OPS_ASSET_ID}.${timestamp}.${nonce}.${bodyHash}`;
  const signature = await signAssetPayload(payload);
  if (!signature) return {};
  return {
    "x-ops-asset-timestamp": timestamp,
    "x-ops-asset-nonce": nonce,
    "x-ops-asset-signature": signature,
  };
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

  // button text
  const label = (mode === "AUTO") ? "AUTO" : mode;
  if (elBtnLangTop) elBtnLangTop.textContent = label;
  if (elBtnLangLower) elBtnLangLower.textContent = label;

  // sessionIso2 for forced modes
  if (mode === "EN") sessionIso2 = "en";
  if (mode === "ES") sessionIso2 = "es";

  setDocLangFromIso2(sessionIso2);
  showLangBadge(`Lang: ${label} • ${iso2ToBcp47(sessionIso2)}`);
}

function nextLangMode(current) {
  // cycle: AUTO -> EN -> ES -> AUTO
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

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      setStatus("Copied chat", false);
      return;
    }
  } catch {
    // fallback below
  }

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
  try { if (abortCtrl) abortCtrl.abort(); } catch {}
  abortCtrl = null;

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
// 4) TTS voice selection (fix Spanish accent)
// -------------------------
function pickVoiceForBcp47(langTag) {
  const tag = String(langTag || "").toLowerCase();
  if (!ttsVoices || !ttsVoices.length) return null;

  const prefix = tag.split("-")[0];

  // 1) prefix match "es-" / "en-"
  let v = ttsVoices.find((x) => String(x.lang || "").toLowerCase().startsWith(prefix + "-"));
  if (v) return v;

  // 2) exact tag
  v = ttsVoices.find((x) => String(x.lang || "").toLowerCase() === tag);
  if (v) return v;

  // 3) contains prefix
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

async function buildCommonHeaders(acceptValue, bodyText) {
  const headers = {
    "content-type": "application/json",
    "accept": acceptValue || "text/event-stream",
  };

  if (OPS_ASSET_ID) headers["x-ops-asset-id"] = OPS_ASSET_ID;
  if (OPS_ASSET_SHA256) headers["x-ops-asset-sha256"] = OPS_ASSET_SHA256;

  const assetSigHeaders = await buildAssetSignatureHeaders(bodyText);
  Object.assign(headers, assetSigHeaders);

  const ts = getTurnstileToken();
  if (ts) headers["cf-turnstile-response"] = ts;

  return headers;
}

async function streamChatSse(payload, onToken, onHeaders) {
  abortCtrl = new AbortController();

  const bodyText = JSON.stringify(payload);
  const headers = await buildCommonHeaders("text/event-stream", bodyText);

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

  // Let caller read language headers BEFORE consuming stream
  if (typeof onHeaders === "function") onHeaders(resp.headers);

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

  if (!doneSeen && eventData) processSseEventData(eventData, onToken);
}

// -------------------------
// 6) Text chat -> /api/chat (SSE)
// -------------------------
function decideIso2ForUserText(userText) {
  if (langMode === "EN") return "en";
  if (langMode === "ES") return "es";

  // AUTO: use text signals; if empty, keep session
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

  // Update session language (AUTO)
  sessionIso2 = decideIso2ForUserText(userText);
  setDocLangFromIso2(sessionIso2);

  appendLine("user", userText);
  history.push({ role: "user", content: userText });

  setStatus("Thinking…", true);

  // Create assistant line NOW and stream into it
  const assistantEl = appendLine("assistant", "");
  let botText = "";

  try {
    const payload = {
      // IMPORTANT: Enlace/Brain normalizeMessages usually ignore "system"
      messages: history,
      honeypot: honeypotValue,
      meta: { lang: iso2ToMetaLang(sessionIso2) }, // "EN"/"ES" (or iso2)
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
        // Prefer Enlace headers (best signal)
        const iso2 = String(hdrs.get("x-chattia-text-iso2") || "").trim().toLowerCase();
        if (iso2) {
          // if forced EN/ES, do not override
          if (langMode === "AUTO") sessionIso2 = iso2;
          setDocLangFromIso2(sessionIso2);
          showLangBadge(`Lang: ${langMode} • ${iso2ToBcp47(sessionIso2)}`);
        }
      }
    );

    if (!botText.trim()) botText = "(no output)";
    if (assistantEl) assistantEl.textContent = botText;

    history.push({ role: "assistant", content: botText });

    // Speak in the session language
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
    // Try default
    mediaRecorder = new MediaRecorder(mediaStream);
  } catch {
    // Common fallback
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
  setVoiceMode(true); // auto-speak replies after voice
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

function headersForVoiceBlob(blob) {
  const headers = {
    "accept": "application/json",
  };

  // Only add if your Enlace CORS allows them for /api/voice
  if (OPS_ASSET_ID) headers["x-ops-asset-id"] = OPS_ASSET_ID;
  if (OPS_ASSET_SHA256) headers["x-ops-asset-sha256"] = OPS_ASSET_SHA256;

  const ts = getTurnstileToken();
  if (ts) headers["cf-turnstile-response"] = ts;

  if (blob && blob.type) headers["content-type"] = blob.type;

  return headers;
}

function iso2FromVoiceResponse(respHeaders, bodyObj, transcriptFallback) {
  // Prefer headers (what we asked Enlace to expose)
  const hIso2 = String(respHeaders.get("x-chattia-stt-iso2") || "").trim().toLowerCase();
  if (hIso2) return hIso2;

  const hLegacy = String(respHeaders.get("x-chattia-stt-lang") || "").trim().toUpperCase();
  if (hLegacy === "ES") return "es";
  if (hLegacy === "EN") return "en";

  // Body shapes Enlace may return
  const bIso2 = String((bodyObj && (bodyObj.lang_iso2 || bodyObj.langIso2)) || "").trim().toLowerCase();
  if (bIso2) return bIso2;

  const bLegacy = String((bodyObj && bodyObj.lang) || "").trim().toUpperCase();
  if (bLegacy === "ES") return "es";
  if (bLegacy === "EN") return "en";

  // fallback: quick guess from transcript
  return detectIso2FastENES(transcriptFallback || "");
}

async function voiceStt(blob) {
  const resp = await fetch(`${ENLACE_VOICE}?mode=stt`, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    headers: headersForVoiceBlob(blob),
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

    // Update language from STT
    lastSttIso2 = iso2;

    // If forced EN/ES, keep forced; otherwise follow STT
    if (langMode === "AUTO") sessionIso2 = iso2;
    if (langMode === "EN") sessionIso2 = "en";
    if (langMode === "ES") sessionIso2 = "es";

    setDocLangFromIso2(sessionIso2);
    showLangBadge(`Lang: ${langMode} • ${iso2ToBcp47(sessionIso2)}`);

    // Show transcript as user's message, then auto-send
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

// Transcript: COPY (no download)
wireButtonLike(elBtnMiniMenu, copyTranscript);

// Theme
wireButtonLike(elBtnThemeMenu, () => setTheme(state.theme === "DARK" ? "LIGHT" : "DARK"));

// Lang toggle (AUTO/EN/ES)
function toggleLangMode() {
  const next = nextLangMode(langMode);
  applyLangMode(next);
}
wireButtonLike(elBtnLangTop, toggleLangMode);
wireButtonLike(elBtnLangLower, toggleLangMode);

// Send
wireButtonLike(elBtnSend, sendFromInput);

// Voice: HOLD TO TALK (pointer + keyboard)
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

// ESC stops everything (streaming, mic, TTS)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") stopAll();
});

// -------------------------
// 9) Init
// -------------------------
setTheme(state.theme);
setStatus("Ready", false);

// default: AUTO language; voiceMode off until you use voice
applyLangMode("AUTO");
setVoiceMode(false);
setDocLangFromIso2(sessionIso2);
showLangBadge(`Lang: ${langMode} • ${iso2ToBcp47(sessionIso2)}`);
