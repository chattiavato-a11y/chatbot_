/**
 * app.js — Simple Chat UI -> Enlace (/api/chat) with SSE streaming over fetch()
 *
 * ✅ No libraries
 * ✅ Safe DOM writes (textContent only)
 * ✅ SSE parsing (multi-line tolerant)
 * ✅ Optional ASSET_ID + SHA256 identification headers
 *
 * IMPORTANT:
 * If Enlace has OPS_ASSET_ALLOWLIST enabled, you MUST set these two constants
 * to match your allowlist values, or requests will be blocked.
 */

const ENLACE_API = "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat";

// ---- Asset identity (OPTIONAL but recommended) ----
// If you enforce allowlist on Enlace, set these.
// If you leave empty, headers won’t be sent.
const OPS_ASSET_ID = "";       // e.g. "CHATTIA_WEB_01"
const OPS_ASSET_SHA256 = "";   // e.g. "9f2c... (hex sha256)"

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
let history = []; // { role: "user"|"assistant", content: string }[]
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
  return new Date().toLocaleString();
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
  updateCharCount();
}

// ---- Lightweight input cleanup ----
function safeTextOnly(s) {
  if (!s) return "";
  // Remove NUL, trim, clamp
  return String(s).replace(/\u0000/g, "").trim().slice(0, MAX_INPUT_CHARS);
}

function updateCharCount() {
  if (!elCharCount) return;
  const length = (elInput.value || "").length;
  const clamped = Math.min(length, MAX_INPUT_CHARS);
  elCharCount.textContent = `${clamped} / ${MAX_INPUT_CHARS}`;
}

// ---- Token extraction (handles multiple shapes) ----
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

// ---- SSE event parser (more correct than line-only) ----
// SSE frames are separated by a blank line.
// We collect all "data:" lines for an event, join with "\n", then process.
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

// ---- Streaming (SSE) ----
async function streamFromEnlace(payload, onToken) {
  abortCtrl = new AbortController();

  const headers = {
    "content-type": "application/json",
    "accept": "text/event-stream",
  };

  // Optional asset identity headers (only attach if configured)
  if (OPS_ASSET_ID) headers["x-ops-asset-id"] = OPS_ASSET_ID;
  if (OPS_ASSET_SHA256) headers["x-ops-asset-sha256"] = OPS_ASSET_SHA256;

  const resp = await fetch(ENLACE_API, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers,
    body: JSON.stringify(payload),
    signal: abortCtrl.signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${text}`);
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();

  // If Enlace ever returns JSON (non-stream), handle once.
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
    buffer = buffer.replace(/\r\n/g, "\n"); // normalize CRLF -> LF

    // Process line by line
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);

      // Blank line means "dispatch event"
      if (line === "") {
        const res = processSseEventData(eventData, onToken);
        eventData = "";
        if (res.done) {
          doneSeen = true;
          break;
        }
        continue;
      }

      // Ignore comments/fields except data:
      if (line.startsWith("data:")) {
        // Per SSE spec, keep exact data after "data:"
        let chunk = line.slice(5);
        if (chunk.startsWith(" ")) chunk = chunk.slice(1);
        // multiple data lines append with newline
        eventData += (eventData ? "\n" : "") + chunk;
      }
    }

    if (doneSeen) break;
  }

  // Flush any trailing event without final blank line
  if (!doneSeen && eventData) {
    processSseEventData(eventData, onToken);
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
  let rafId = null;

  const scheduleUpdate = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateBubble(botBubble, botText);
    });
  };

  try {
    const payload = { messages: history };

    await streamFromEnlace(payload, (token) => {
      botText += token;
      scheduleUpdate();
    });

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (!botText.trim()) botText = "(no output)";
    updateBubble(botBubble, botText);

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
  updateCharCount();
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

elInput.addEventListener("input", () => {
  updateCharCount();
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
updateCharCount();
