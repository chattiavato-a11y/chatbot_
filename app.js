/**
 * app.js — Simple Chat UI -> Enlace (/api/chat) with SSE streaming over fetch()
 *
 * ✅ Keep simple
 * ✅ No libraries
 * ✅ Safe DOM writes (textContent only)
 *
 * IMPORTANT:
 * Since your UI is on GitHub Pages, ENLACE_API MUST be the full URL to:
 *   https://enlace.<your>.workers.dev/api/chat
 */

const ENLACE_API = "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat";

// ---- DOM ----
const elMessages  = document.getElementById("messages");
const elForm      = document.getElementById("chatForm");
const elInput     = document.getElementById("input");
const elBtnSend   = document.getElementById("btnSend");
const elBtnStop   = document.getElementById("btnStop");
const elBtnClear  = document.getElementById("btnClear");
const elStatusDot = document.getElementById("statusDot");
const elStatusTxt = document.getElementById("statusText");
const elCharCount = document.getElementById("charCount");

// ---- State ----
const MAX_INPUT_CHARS = 1500;
let history = [];                 // { role: "user"|"assistant", content: string }[]
let abortCtrl = null;

// ---- UI helpers ----
function setStatus(text, busy) {
  elStatusTxt.textContent = text;
  elStatusDot.classList.toggle("busy", !!busy);
}

  if (state.transcript.length) {
    mainList.parentElement.scrollTop = mainList.parentElement.scrollHeight;
    sideList.parentElement.scrollTop = sideList.parentElement.scrollHeight;
  }
}

function toggleLang() {
  state.lang = (state.lang === "EN") ? "ES" : "EN";
  render();
}

function toggleTheme() {
  state.theme = (state.theme === "dark") ? "light" : "dark";
  render();
}

function clearTranscript() {
  state.transcript = [];
  state.history = [];
  render();
}

function clearChat() {
  elMessages.innerHTML = "";
  history = [];
  setStatus("Ready", false);
  updateCharCount();
}

function safeTextOnly(s) {
  if (!s) return "";
  return String(s).replace(/\u0000/g, "").trim().slice(0, MAX_INPUT_CHARS);
}

function updateCharCount() {
  if (!elCharCount) return;
  const length = (elInput.value || "").length;
  const clamped = Math.min(length, MAX_INPUT_CHARS);
  elCharCount.textContent = `${clamped} / ${MAX_INPUT_CHARS}`;
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
  addLine("user", cleaned);
  state.history.push({ role: "user", content: cleaned });

  try {
    const responseText = await requestFromEnlace({ messages: state.history });
    const assistantText = responseText && responseText.trim() ? responseText : "(no output)";
    addLine("assistant", assistantText);
    state.history.push({ role: "assistant", content: assistantText });
  } catch (err) {
    addLine("system", `Error: ${String(err?.message || err)}`);
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
  recognition.lang = (state.lang === "EN") ? "en-US" : "es-ES";

  let finalText = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk + " ";
      else interim += chunk;
    }
    chatInput.value = (finalText + interim).trim();
  };

  recognition.onerror = () => {
    stopSpeech();
    addLine("system", "Voice error. Try again.");
  };

  recognition.onend = () => {
    if (!state.listening) return;
    state.listening = false;
    render();
  };

  state.listening = true;
  render();
  recognition.start();
}

function stopSpeech() {
  try { recognition && recognition.stop(); } catch (_) {}
  state.listening = false;
  render();

  const spoken = chatInput.value.trim();
  if (spoken) {
    sendMessage(spoken);
    chatInput.value = "";
  }
}

// ---- Events ----
elForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = elInput.value || "";
  elInput.value = "";
  updateCharCount();
  await sendMessage(text);
  elInput.focus();
});

btnLangTop.addEventListener("click", toggleLang);
btnLangLower.addEventListener("click", toggleLang);
btnThemeTop.addEventListener("click", toggleTheme);
btnThemeLower.addEventListener("click", toggleTheme);

elInput.addEventListener("input", () => {
  updateCharCount();
});

elBtnStop.addEventListener("click", () => {
  if (abortCtrl) abortCtrl.abort();
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const current = chatInput.value;
    chatInput.value = "";
    sendMessage(current);
  }
});

// ---- Boot ----
clearChat();
addBubble("bot", "Hi — I’m ready. Ask me anything (plain text).");
elBtnStop.disabled = true;
elInput.focus();
updateCharCount();
