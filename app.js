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
  // strip null bytes; keep normal unicode
  return s.replace(/\u0000/g, "").trim();
}

// ---- SSE parsing ----
function normalizeNewlines(s) {
  // convert CRLF to LF to simplify parsing
  return s.replace(/\r\n/g, "\n");
}

function extractSseData(block) {
  // SSE block is lines ending with \n\n; we keep "data:" lines
  const lines = block.split("\n");
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return dataLines.join("\n");
}

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

  // If Enlace returns a JSON error, show it cleanly
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${text}`);
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();

  // Fallback: if response is JSON (non-stream), parse once
  if (ct.includes("application/json")) {
    const obj = await resp.json().catch(() => null);
    const content =
      (obj && typeof obj.response === "string" && obj.response) ||
      (obj && typeof obj.text === "string" && obj.text) ||
      JSON.stringify(obj || {});
    onToken(content);
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
    buffer = normalizeNewlines(buffer);

    // SSE events end with a blank line
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const data = extractSseData(block);
      if (!data) continue;

      if (data === "[DONE]") {
        doneSeen = true;
        break;
      }

      // Typical Workers AI streaming chunk: data: {"response":"token"}
      let token = "";
      try {
        const obj = JSON.parse(data);
        token = (obj && typeof obj.response === "string") ? obj.response : "";
        if (!token && obj && typeof obj.text === "string") token = obj.text;
      } catch {
        // sometimes token may arrive as plain text
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
    if (!ENLACE_API.includes("workers.dev")) {
      // Not hard-required, but helps catch “forgot to set URL”
      console.warn("ENLACE_API looks unset. Update it in app.js.");
    }

    const payload = { messages: history };

    await streamFromEnlace(payload, (token) => {
      botText += token;
      updateBubble(botBubble, botText);
    });

    // Save assistant message
    history.push({ role: "assistant", content: botText || "(no output)" });

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
  // friendly greeting after clearing
  addBubble("bot", "Hi — I’m ready. Ask me anything (plain text).");
});

// ---- Boot ----
clearChat();
addBubble("bot", "Hi — I’m ready. Ask me anything (plain text).");
elBtnStop.disabled = true;
elInput.focus();
