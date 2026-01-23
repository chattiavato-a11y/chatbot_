/**
 * app.js — REPO UI (GitHub Pages) (v0.4 ENLACE_REPO MIDDLEMAN)
 * UI -> EnlaceRepo (repo “helper”) -> Cloudflare Enlace (/api/chat SSE, /api/voice?mode=stt)
 *
 * IMPORTANT:
 * - Make sure index.html loads enlace-worker.js BEFORE app.js:
 *     <script src="enlace-worker.js" defer></script>
 *     <script src="app.js" defer></script>
 *
 * What changed:
 * - All network fetch calls are now routed through window.EnlaceRepo:
 *     - EnlaceRepo.chatSSE(...)
 *     - EnlaceRepo.voiceSTT(...)
 * - app.js no longer fetches ops-keys.json or builds identity headers directly.
 *   That is done inside enlace-worker.js (EnlaceRepo).
 *
 * Still optional:
 * - Turnstile token header ONLY if Turnstile is actually rendered on the page
 *   (handled inside EnlaceRepo if enabled there).
 */

// -------------------------
// 0) Require EnlaceRepo
// -------------------------
function getEnlaceRepoOrThrow() {
  const r = window.EnlaceRepo;
  if (!r || typeof r.ready !== "function" || typeof r.chatSSE !== "function" || typeof r.voiceSTT !== "function") {
    throw new Error("Missing EnlaceRepo. Load enlace-worker.js BEFORE app.js.");
  }
  return r;
}

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
// 5) EnlaceRepo network wrappers (REPLACED fetch calls)
// -------------------------
async function streamChatViaEnlaceRepo(payload, onToken, onHeaders) {
  // Abort any prior stream before starting a new one
  abortActiveStream();
  abortCtrl = new AbortController();

  const repo = getEnlaceRepoOrThrow();
  await repo.ready(); // ensure ops-keys.json + meta loaded

  await repo.chatSSE(payload, {
    signal: abortCtrl.signal,
    onToken: (token) => { if (typeof onToken === "function") onToken(token); },
    onHeaders: (hdrs) => { if (typeof onHeaders === "function") onHeaders(hdrs); },
  });
}

// -------------------------
// 6) Text chat -> /api/chat (SSE via EnlaceRepo)
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

    await streamChatViaEnlaceRepo(
      payload,
      (token) => {
        botText += String(token || "");
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
// 7) Voice: Hold-to-talk -> voiceSTT via EnlaceRepo -> then /api/chat
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

async function voiceSttViaEnlaceRepo(blob) {
  const repo = getEnlaceRepoOrThrow();
  await repo.ready();

  // EnlaceRepo.voiceSTT returns:
  // { transcript, lang_iso2, lang_bcp47, blocked, reason }
  const res = await repo.voiceSTT(blob, {});
  const transcript = safeTextOnly(res && res.transcript ? res.transcript : "");

  if (res && res.blocked) {
    return { transcript: "", iso2: "", blocked: true, reason: String(res.reason || "Blocked by client-side gate") };
  }

  const iso2 = String(res && res.lang_iso2 ? res.lang_iso2 : "").trim().toLowerCase() || detectIso2FastENES(transcript);
  return { transcript, iso2, blocked: false };
}

async function handleVoiceBlob(blob) {
  try {
    setStatus("Transcribing…", true);

    const { transcript, iso2, blocked, reason } = await voiceSttViaEnlaceRepo(blob);

    if (blocked) {
      setStatus("Blocked.", false);
      appendLine("assistant", `Voice blocked:\n${reason || "Blocked by client-side gate."}`);
      return;
    }

    if (!transcript) {
      setStatus("No transcription produced.", false);
      return;
    }

    lastSttIso2 = iso2 || "en";

    if (langMode === "AUTO") sessionIso2 = lastSttIso2;
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

// Warm up EnlaceRepo (non-blocking)
try {
  const repo = getEnlaceRepoOrThrow();
  repo.ready().catch(() => {});
} catch (e) {
  setStatus("Config error", false);
  appendLine("assistant", `Setup error:\n${String(e?.message || e)}`);
}
