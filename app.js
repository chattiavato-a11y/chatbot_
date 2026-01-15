const CONFIG = {
  links: {
    tc: "/terms",
    cookies: "/cookies",
    contact: "/contact",
    support: "/support",
    about: "/about"
  }
};

const ENLACE_API = "https://enlace.example.workers.dev/api/chat";

let state = {
  lang: "EN",
  theme: "light",
  listening: false,
  transcript: [],
  history: [],
  sending: false
};

const $ = (id) => document.getElementById(id);

const mainList = $("mainList");
const sideList = $("sideList");
const chatInput = $("chatInput");

const btnLangTop = $("btnLangTop");
const btnThemeTop = $("btnThemeTop");
const btnLangLower = $("btnLangLower");
const btnThemeLower = $("btnThemeLower");

const sideLang = $("sideLang");
const sideMode = $("sideMode");

const btnClear = $("btnClear");
const btnMic = $("btnMic");
const waveSvg = $("waveSvg");

$("lnkTc").href = CONFIG.links.tc;
$("lnkCookies").href = CONFIG.links.cookies;
$("lnkContact").href = CONFIG.links.contact;
$("lnkSupport").href = CONFIG.links.support;
$("lnkAbout").href = CONFIG.links.about;

function render() {
  if (state.theme === "dark") document.body.classList.add("dark");
  else document.body.classList.remove("dark");

  btnLangTop.textContent = state.lang;
  btnLangLower.textContent = state.lang;
  sideLang.textContent = state.lang;
  btnThemeTop.textContent = "Dark";
  btnThemeLower.textContent = "Dark";
  sideMode.textContent = state.theme === "dark" ? "DARK" : "DARK";

  if (state.listening) waveSvg.classList.add("listening");
  else waveSvg.classList.remove("listening");

  mainList.innerHTML = "";
  sideList.innerHTML = "";

  for (const item of state.transcript) {
    const label = item.role === "user" ? "You" : "System";
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = `${label}: ${item.text}`;
    mainList.appendChild(line);

    const s = document.createElement("div");
    s.className = "line";
    s.textContent = `${label}: ${item.text}`;
    sideList.appendChild(s);
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

function addLine(role, text) {
  const t = String(text || "").trim();
  if (!t) return;
  state.transcript.push({ role, text: t, ts: Date.now() });
  render();
}

function safeTextOnly(s) {
  if (!s) return "";
  return String(s).replace(/\u0000/g, "").trim();
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

function toggleSpeech() {
  if (state.listening) stopSpeech();
  else startSpeech();
}

btnLangTop.addEventListener("click", toggleLang);
btnLangLower.addEventListener("click", toggleLang);
btnThemeTop.addEventListener("click", toggleTheme);
btnThemeLower.addEventListener("click", toggleTheme);

btnClear.addEventListener("click", clearTranscript);
btnMic.addEventListener("click", toggleSpeech);

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const current = chatInput.value;
    chatInput.value = "";
    sendMessage(current);
  }
});

render();
