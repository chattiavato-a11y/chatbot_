const CONFIG = {
  links: {
    tc: "/terms",
    cookies: "/cookies",
    contact: "/contact",
    support: "/support",
    about: "/about"
  },
  assetIdentity: {
    id: "",
    sha256: ""
  }
};

const ENLACE_API = "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat";

// ---- DOM ----
const elApp = document.getElementById("app");
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

const elLinkTc = document.getElementById("lnkTc");
const elLinkCookies = document.getElementById("lnkCookies");
const elLinkContact = document.getElementById("lnkContact");
const elLinkSupport = document.getElementById("lnkSupport");
const elLinkAbout = document.getElementById("lnkAbout");

// ---- State ----
const MAX_INPUT_CHARS = 1500;
const MAX_TRANSCRIPT_LINES = 200;

const state = {
  lang: "EN",
  theme: document.body.classList.contains("dark") ? "dark" : "light",
  transcript: [],
  history: [],
  sending: false,
  listening: false,
  sideOpen: true
};

// ---- UI helpers ----
function setStatus(text, busy) {
  if (elStatusTxt) elStatusTxt.textContent = text;
  if (elStatusDot) elStatusDot.classList.toggle("busy", !!busy);
}

function updateLinks() {
  if (elLinkTc) elLinkTc.href = CONFIG.links.tc || "#";
  if (elLinkCookies) elLinkCookies.href = CONFIG.links.cookies || "#";
  if (elLinkContact) elLinkContact.href = CONFIG.links.contact || "#";
  if (elLinkSupport) elLinkSupport.href = CONFIG.links.support || "#";
  if (elLinkAbout) elLinkAbout.href = CONFIG.links.about || "#";
}

function renderTranscript() {
  if (!elMainList || !elSideList) return;

  const fragment = document.createDocumentFragment();
  const fragmentSide = document.createDocumentFragment();

  state.transcript.forEach((item) => {
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = `${item.label}: ${item.text}`;
    fragment.appendChild(line);

    const sideLine = document.createElement("div");
    sideLine.className = "line";
    sideLine.textContent = `${item.label}: ${item.text}`;
    fragmentSide.appendChild(sideLine);
  });

  elMainList.innerHTML = "";
  elSideList.innerHTML = "";
  elMainList.appendChild(fragment);
  elSideList.appendChild(fragmentSide);

  if (state.transcript.length) {
    elMainList.parentElement.scrollTop = elMainList.parentElement.scrollHeight;
    elSideList.parentElement.scrollTop = elSideList.parentElement.scrollHeight;
  }
}

function renderControls() {
  const isDark = state.theme === "dark";
  document.body.classList.toggle("dark", isDark);
  document.body.classList.toggle("listening", state.listening);

  const themeLabel = isDark ? "Light" : "Dark";
  if (elBtnThemeTop) elBtnThemeTop.textContent = themeLabel;
  if (elBtnThemeLower) elBtnThemeLower.textContent = themeLabel;
  if (elSideMode) elSideMode.textContent = themeLabel.toUpperCase();

  if (elBtnLangTop) elBtnLangTop.textContent = state.lang;
  if (elBtnLangLower) elBtnLangLower.textContent = state.lang;
  if (elSideLang) elSideLang.textContent = state.lang;

  if (elBtnMic) elBtnMic.setAttribute("aria-pressed", String(state.listening));
  if (elBtnWave) elBtnWave.setAttribute("aria-pressed", String(state.listening));

  if (elApp) elApp.classList.toggle("side-collapsed", !state.sideOpen);
}

function render() {
  renderTranscript();
  renderControls();
}

function addLine(role, text) {
  const label = role === "assistant" ? "Chattia" : role === "user" ? "You" : "System";
  state.transcript.push({ role, label, text });
  if (state.transcript.length > MAX_TRANSCRIPT_LINES) {
    state.transcript.shift();
  }
  renderTranscript();
}

function toggleLang() {
  state.lang = state.lang === "EN" ? "ES" : "EN";
  renderControls();
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  renderControls();
}

function toggleSidePanel() {
  state.sideOpen = !state.sideOpen;
  renderControls();
}

function clearTranscript() {
  state.transcript = [];
  state.history = [];
  renderTranscript();
  setStatus("Ready", false);
}

function safeTextOnly(s) {
  if (!s) return "";
  return String(s).replace(/\u0000/g, "").trim().slice(0, MAX_INPUT_CHARS);
}

function updateCharCount() {
  if (!elCharCount || !elInput) return;
  const length = (elInput.value || "").length;
  const clamped = Math.min(length, MAX_INPUT_CHARS);
  elCharCount.textContent = `${clamped} / ${MAX_INPUT_CHARS}`;
}

function syncInputs(value, source) {
  if (elInput && source !== "composer") elInput.value = value;
  if (elChatInput && source !== "quick") elChatInput.value = value;
  updateCharCount();
}

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

async function requestFromEnlace(payload) {
  const resp = await fetch(ENLACE_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "x-ops-asset-id": CONFIG.assetIdentity.id || "",
      "x-ops-asset-sha256": CONFIG.assetIdentity.sha256 || "",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${text}`);
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const obj = await resp.json().catch(() => null);
    return extractTokenFromAnyShape(obj) || JSON.stringify(obj || {});
  }

  return resp.text();
}

async function sendMessage(userText) {
  const cleaned = safeTextOnly(userText);
  if (!cleaned || state.sending) return;

  state.sending = true;
  setStatus("Thinking…", true);
  addLine("user", cleaned);
  state.history.push({ role: "user", content: cleaned });

  try {
    const responseText = await requestFromEnlace({ messages: state.history });
    const assistantText = responseText && responseText.trim() ? responseText : "(no output)";
    addLine("assistant", assistantText);
    state.history.push({ role: "assistant", content: assistantText });
    setStatus("Ready", false);
  } catch (err) {
    addLine("system", `Error: ${String(err?.message || err)}`);
    setStatus("Error", false);
  } finally {
    state.sending = false;
  }
}

let recognition = null;

function canSpeech() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function startSpeech() {
  if (!canSpeech()) {
    addLine("system", "Voice input not supported in this browser. (Try Chrome/Edge.)");
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = state.lang === "EN" ? "en-US" : "es-ES";

  let finalText = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk + " ";
      else interim += chunk;
    }
    syncInputs((finalText + interim).trim(), "voice");
  };

  recognition.onerror = () => {
    stopSpeech();
    addLine("system", "Voice error. Try again.");
  };

  recognition.onend = () => {
    if (!state.listening) return;
    state.listening = false;
    renderControls();
  };

  state.listening = true;
  renderControls();
  recognition.start();
}

function stopSpeech() {
  try {
    if (recognition) recognition.stop();
  } catch (_) {
    // no-op
  }
  state.listening = false;
  renderControls();
}

function toggleSpeech() {
  if (state.listening) stopSpeech();
  else startSpeech();
}

function handleActionKey(event, action) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

// ---- Events ----
if (elForm) {
  elForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = elInput ? elInput.value || "" : "";
    syncInputs("", "composer");
    await sendMessage(text);
    if (elInput) elInput.focus();
  });
}

if (elInput) {
  elInput.addEventListener("input", () => {
    syncInputs(elInput.value || "", "composer");
  });
}

if (elChatInput) {
  elChatInput.addEventListener("input", () => {
    syncInputs(elChatInput.value || "", "quick");
  });
  elChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const current = elChatInput.value || "";
      syncInputs("", "quick");
      sendMessage(current);
    }
  });
}

if (elBtnLangTop) {
  elBtnLangTop.addEventListener("click", toggleLang);
  elBtnLangTop.addEventListener("keydown", (e) => handleActionKey(e, toggleLang));
}
if (elBtnLangLower) {
  elBtnLangLower.addEventListener("click", toggleLang);
  elBtnLangLower.addEventListener("keydown", (e) => handleActionKey(e, toggleLang));
}
if (elBtnThemeTop) {
  elBtnThemeTop.addEventListener("click", toggleTheme);
  elBtnThemeTop.addEventListener("keydown", (e) => handleActionKey(e, toggleTheme));
}
if (elBtnThemeLower) {
  elBtnThemeLower.addEventListener("click", toggleTheme);
  elBtnThemeLower.addEventListener("keydown", (e) => handleActionKey(e, toggleTheme));
}

if (elBtnMenu) {
  elBtnMenu.addEventListener("click", toggleSidePanel);
  elBtnMenu.addEventListener("keydown", (e) => handleActionKey(e, toggleSidePanel));
}
if (elBtnMiniMenu) {
  elBtnMiniMenu.addEventListener("click", toggleSidePanel);
  elBtnMiniMenu.addEventListener("keydown", (e) => handleActionKey(e, toggleSidePanel));
}

if (elBtnMic) {
  elBtnMic.addEventListener("click", toggleSpeech);
  elBtnMic.addEventListener("keydown", (e) => handleActionKey(e, toggleSpeech));
}
if (elBtnWave) {
  elBtnWave.addEventListener("click", toggleSpeech);
  elBtnWave.addEventListener("keydown", (e) => handleActionKey(e, toggleSpeech));
}

if (elBtnClear) elBtnClear.addEventListener("click", clearTranscript);

// ---- Boot ----
updateLinks();
renderControls();
renderTranscript();
setStatus("Ready", false);
updateCharCount();
if (elBtnSend) elBtnSend.disabled = false;
if (elInput) elInput.focus();
