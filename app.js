/**
 * app.js — Simple Chat UI -> Enlace (/api/chat) with SSE streaming over fetch()
 *
 * ✅ Keep simple
 * ✅ No libraries
 * ✅ Safe DOM writes (textContent only)
 *
 * IMPORTANT:
 * Set ENLACE_API to your Enlace worker endpoint:
 *   https://<your-enlace>.workers.dev/api/chat
 */
const ENLACE_API = "https://enlace.grabem-holdem-nuts-right.workers.dev/"; // <-- CHANGE THIS

// ---- DOM ----
const elMessages  = document.getElementById("messages");
const elForm      = document.getElementById("chatForm");
const elInput     = document.getElementById("input");
const elBtnSend   = document.getElementById("btnSend");
const elBtnStop   = document.getElementById("btnStop");
const elBtnClear  = document.getElementById("btnClear");
const elStatusDot = document.getElementById("statusDot");
const elStatusTxt = document.getElementById("statusText");

// ---- State ----
let history = [];                 // { role: "user"|"assistant", content: string }[]
let abortCtrl = null;

// ---- UI helpers ----
function setStatus(text, busy) {
  elStatusTxt.textContent = text;
  elStatusDot.classList.toggle("busy", !!busy);
}

function scrollToBottom() {
  elMessages.scrollTop = elMessages.scrollHeight;
}

function timeStamp() {
  const d = new Date();
  return d.toLocaleString();
}

function addBubble(role, text) {
  const row = document.createElement("div");
  row.className = `msg ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text || "";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${role.toUpperCase()} • ${timeStamp()}`;

  bubble.appendChild(meta);
  row.appendChild(bubble);
  elMessages.appendChild(row);

  scrollToBottom();
  return { row, bubble };
}

function updateBubble(bubble, text) {
  const meta = bubble.querySelector(".meta");
  bubble.textContent = text || "";
  if (meta) bubble.appendChild(meta);
  scrollToBottom();
}

function clearChat() {
  elMessages.innerHTML = "";
  history = [];
  setStatus("Ready", false);
}

// ---- Lightweight input cleanup (client-side) ----
function safeTextOnly(s) {
  if (!s) return "";
  return String(s).replace(/\u0000/g, "").trim();
}

// ---- Token extraction (handles multiple shapes) ----
function extractTokenFromAnyShape(obj) {
  if (!obj) return "";

  // if already a string
  if (typeof obj === "string") return obj;

  // common Workers AI streaming: { response: "..." }
  if (typeof obj.response === "string") return obj.response;

  // sometimes: { text: "..." }
  if (typeof obj.text === "string") return obj.text;

  // sometimes: { result: { response: "..." } }
  if (obj.result && typeof obj.result === "object") {
    if (typeof obj.result.response === "string") return obj.result.response;
    if (typeof obj.result.text === "string") return obj.result.text;
  }

  // sometimes: { response: { content: "..." } } or { response: { response: "..." } }
  if (obj.response && typeof obj.response === "object") {
    if (typeof obj.response.content === "string") return obj.response.content;
    if (typeof obj.response.response === "string") return obj.response.response;
  }

  // OpenAI-like shape: { choices: [ { delta: { content: "..." } } ] }
  if (Array.isArray(obj.choices) && obj.choices[0]) {
    const c = obj.choices[0];
    const delta = c.delta || c.message || c;
    if (delta && typeof delta.content === "string") return delta.content;
    if (typeof c.text === "string") return c.text;
  }

  return "";
}

// ---- Streaming (SSE line tolerant) ----
async function streamFromEnlace(payload, onToken) {
  abortCtrl = new AbortController();

  const resp = await fetch(ENLACE_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal: abortCtrl.signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${text}`);
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();

  // If somehow JSON comes back non-streaming, handle it once.
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
  let doneSeen = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Normalize CRLF -> LF
    buffer = buffer.replace(/\r\n/g, "\n");

    // Process line-by-line (more robust than requiring \n\n)
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);

      // ignore comments/empty lines
      if (!line) continue;

      // Only parse SSE data lines
      if (!line.startsWith("data:")) continue;

      const data = line.slice(5).trim();
      if (!data) continue;

      if (data === "[DONE]") {
        doneSeen = true;
        break;
      }

      // Try JSON, fallback to plain text
      let token = "";
      try {
        const obj = JSON.parse(data);
        token = extractTokenFromAnyShape(obj);
      } catch {
        token = data;
      }

      if (token) onToken(token);
    }

    if (doneSeen) break;
  }
}

// ---- Main send handler ----
async function sendMessage(userText) {
  userText = safeTextOnly(userText);
  if (!userText) return;

  // UI: show user bubble
  addBubble("user", userText);

  // Add to history
  history.push({ role: "user", content: userText });

  // UI: create bot bubble that we keep updating
  const { bubble: botBubble } = addBubble("bot", "");

  elBtnSend.disabled = true;
  elBtnStop.disabled = false;
  setStatus("Thinking…", true);

  let botText = "";

  try {
    const payload = { messages: history };

    await streamFromEnlace(payload, (token) => {
      botText += token;
      updateBubble(botBubble, botText);
    });

    if (!botText.trim()) {
      botText = "(no output)";
      updateBubble(botBubble, botText);
    }

    // Save assistant message
    history.push({ role: "assistant", content: botText });

    setStatus("Ready", false);
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Stopped."
        : `Error:\n${String(err?.message || err)}`;

    updateBubble(botBubble, msg);
    setStatus("Ready", false);
  } finally {
    elBtnSend.disabled = false;
    elBtnStop.disabled = true;
    abortCtrl = null;
  }
}

// ---- Events ----
elForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = elInput.value || "";
  elInput.value = "";
  await sendMessage(text);
  elInput.focus();
});

elInput.addEventListener("keydown", (e) => {
  // Enter sends, Shift+Enter new line
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    elForm.requestSubmit();
  }
});

elBtnStop.addEventListener("click", () => {
  if (abortCtrl) abortCtrl.abort();
});

elBtnClear.addEventListener("click", () => {
  if (abortCtrl) abortCtrl.abort();
  clearChat();
  addBubble("bot", "Hi — I’m ready. Ask me anything (plain text).");
});

// ---- Boot ----
clearChat();
addBubble("bot", "Hi — I’m ready. Ask me anything (plain text).");
elBtnStop.disabled = true;
elInput.focus();
