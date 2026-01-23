const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const chatLog = document.getElementById("chat-log");

const defaultConfig = {
  assetRegistry: "worker_files/worker.assets.json",
  workerEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev",
  gatewayEndpoint: "",

  workerEndpointAssetId: "asset_01J7Y2D4XABCD3EFGHJKMNPRTA",
  gatewayEndpointAssetId: "asset_01J7Y2D4XABCD3EFGHJKMNPRTE",

  allowedOrigins: [
    "https://www.chattia.io",
    "https://chattia.io",
    "https://chattiavato-a11y.github.io",
  ],

  allowedOriginAssetIds: [
    "asset_01J7Y2D4XABCD3EFGHJKMNPRTB",
    "asset_01J7Y2D4XABCD3EFGHJKMNPRTC",
    "asset_01J7Y2D4XABCD3EFGHJKMNPRTD",
  ],

  requiredHeaders: ["Content-Type", "Accept"],
};

const configUrl = "worker_files/worker.config.json";
const defaultAssetRegistryUrl = defaultConfig.assetRegistry;
let workerEndpoint = defaultConfig.workerEndpoint;
let gatewayEndpoint = defaultConfig.gatewayEndpoint;
let allowedOrigins = [...defaultConfig.allowedOrigins];
let allowedOriginAssetIds = [...defaultConfig.allowedOriginAssetIds];
let requiredHeaders = [...defaultConfig.requiredHeaders];
let originToAssetId = new Map();
let isStreaming = false;
let activeController = null;
let activeAssistantBubble = null;

const isOriginAllowed = (origin, allowedList) =>
  allowedList.some((allowedOrigin) => allowedOrigin === origin);

const originStatus = document.getElementById("origin-status");
const endpointStatus = document.getElementById("endpoint-status");
const thinkingStatus = document.getElementById("thinking-status");
const thinkingFrames = ["Thinking.", "Thinking..", "Thinking...", "Thinking...."];
let thinkingInterval = null;
let thinkingIndex = 0;
let activeThinkingBubble = null;

const setStatusLine = (element, text, isWarning = false) => {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("warning", isWarning);
};

const rebuildOriginMap = () => {
  originToAssetId = new Map();
  for (let i = 0; i < allowedOrigins.length; i++) {
    const origin = allowedOrigins[i];
    const assetId = allowedOriginAssetIds[i] || "";
    if (origin && assetId) {
      originToAssetId.set(origin, assetId);
    }
  }
};

const getAssetIdForThisOrigin = () => {
  const origin = window.location.origin;
  return originToAssetId.get(origin) || "";
};

const getRequestHeaders = () => {
  const assetId = getAssetIdForThisOrigin();

  if (!assetId) {
    throw new Error(
      `Origin not registered: ${window.location.origin}. Add it to worker.config.json allowedOrigins + allowedOriginAssetIds.`
    );
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-ops-asset-id": assetId,
  };

  if (requiredHeaders.length > 0) {
    requiredHeaders.forEach((header) => {
      if (!headers[header]) {
        console.warn(`Missing required header: ${header}`);
      }
    });
  }

  return headers;
};

rebuildOriginMap();

const updateSendState = () => {
  sendBtn.disabled = isStreaming || input.value.trim().length === 0;
};

const updateThinkingText = () => {
  const text = thinkingFrames[thinkingIndex % thinkingFrames.length];
  thinkingIndex += 1;
  if (thinkingStatus) {
    thinkingStatus.textContent = text;
  }
  if (activeThinkingBubble) {
    activeThinkingBubble.textContent = text;
  }
};

const startThinking = (bubble) => {
  activeThinkingBubble = bubble ?? activeThinkingBubble;
  thinkingIndex = 0;
  updateThinkingText();
  if (!thinkingInterval) {
    thinkingInterval = setInterval(updateThinkingText, 500);
  }
};

const stopThinking = () => {
  if (thinkingInterval) {
    clearInterval(thinkingInterval);
    thinkingInterval = null;
  }
  activeThinkingBubble = null;
  if (thinkingStatus) {
    thinkingStatus.textContent = "Standing by.";
  }
};

input.addEventListener("input", updateSendState);
input.addEventListener("focus", () => {
  chatLog.scrollTop = chatLog.scrollHeight;
});

const addMessage = (text, isUser) => {
  const row = document.createElement("div");
  row.className = `message-row${isUser ? " user" : ""}`;

  if (!isUser) {
    const avatar = document.createElement("div");
    avatar.className = "avatar assistant";
    avatar.textContent = "AI";
    row.appendChild(avatar);
  }

  const content = document.createElement("div");
  const bubble = document.createElement("div");
  bubble.className = `bubble ${isUser ? "user" : "assistant"}`;
  bubble.textContent = text;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = isUser ? "You · just now" : "Chattia · just now";

  content.appendChild(bubble);
  content.appendChild(meta);

  row.appendChild(content);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
};

/**
 * app.js — add a dynamic Voice icon (mic) that records + sends to Enlace /api/voice?mode=stt
 *
 * ✅ No libraries
 * ✅ Creates its own floating mic button (no HTML edits needed)
 * ✅ Click = start/stop recording
 * ✅ Shows live states: idle / recording / uploading / error
 * ✅ Works with your Enlace:
 *    - POST https://enlace.../api/voice?mode=stt  (binary audio)
 *    - returns JSON { transcript, lang_iso2, ... }
 *
 * NOTE:
 * - This snippet assumes you have a "Send" flow already. If you have an input box,
 *   we will auto-insert the transcript into it and optionally auto-send (toggle below).
 */

// -------------------------
// 0) CONFIG
// -------------------------

const ENLACE_VOICE_STT =
  "https://enlace.grabem-holdem-nuts-right.workers.dev/api/voice?mode=stt";

// If you want it to auto-send after STT result:
// - set to true if you already have window.sendMessageFromUI(text) OR a button click handler below
const AUTO_SEND_AFTER_STT = false;

// If you have a text input, set its selector (or leave null to auto-detect common ones)
const INPUT_SELECTOR = null; // e.g. "#msgInput" or ".composer textarea"

// -------------------------
// 1) Minimal styling + button creation
// -------------------------

function injectMicStyles() {
  const css = `
  .chattia-mic-btn{
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 9999;
    width: 56px;
    height: 56px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,.18);
    background: rgba(0,0,0,.45);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display:flex;
    align-items:center;
    justify-content:center;
    cursor:pointer;
    user-select:none;
    transition: transform .12s ease, opacity .12s ease;
  }
  .chattia-mic-btn:hover{ transform: translateY(-1px); }
  .chattia-mic-btn:active{ transform: translateY(1px) scale(.98); }

  .chattia-mic-ring{
    position:absolute;
    inset: -10px;
    border-radius: 999px;
    border: 2px solid rgba(255,255,255,.18);
    opacity: 0;
    pointer-events:none;
  }

  /* states */
  .chattia-mic-idle{ opacity: 0.92; }
  .chattia-mic-rec{
    background: rgba(180,0,0,.55);
    border-color: rgba(255,80,80,.35);
  }
  .chattia-mic-rec .chattia-mic-ring{
    opacity: .85;
    animation: chattiaPulse 1.15s ease-in-out infinite;
  }
  .chattia-mic-busy{
    opacity: 0.75;
    cursor: progress;
  }
  .chattia-mic-err{
    background: rgba(255,140,0,.45);
    border-color: rgba(255,180,80,.35);
  }

  @keyframes chattiaPulse{
    0%{ transform: scale(.85); opacity:.35; }
    50%{ transform: scale(1.05); opacity:.85; }
    100%{ transform: scale(.85); opacity:.35; }
  }

  .chattia-mic-ico{
    width: 22px; height: 22px;
    fill: rgba(255,255,255,.95);
  }
  .chattia-mic-tip{
    position: fixed;
    right: 18px;
    bottom: 82px;
    z-index: 9999;
    font: 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;
    background: rgba(0,0,0,.55);
    border: 1px solid rgba(255,255,255,.18);
    color: rgba(255,255,255,.92);
    padding: 8px 10px;
    border-radius: 12px;
    max-width: 260px;
    display:none;
  }
  .chattia-mic-tip.show{ display:block; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

function micSVG() {
  return `
  <svg class="chattia-mic-ico" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>
  </svg>`;
}

function createMicButton() {
  injectMicStyles();

  const tip = document.createElement("div");
  tip.className = "chattia-mic-tip";
  tip.textContent = "Click to talk • Click again to stop";
  document.body.appendChild(tip);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chattia-mic-btn chattia-mic-idle";
  btn.setAttribute("aria-label", "Voice input");
  btn.innerHTML = `<span class="chattia-mic-ring"></span>${micSVG()}`;
  document.body.appendChild(btn);

  const showTip = (msg) => {
    tip.textContent = msg;
    tip.classList.add("show");
    clearTimeout(showTip._t);
    showTip._t = setTimeout(() => tip.classList.remove("show"), 2200);
  };

  return { btn, showTip };
}

// -------------------------
// 2) Audio capture (MediaRecorder) + send to Enlace
// -------------------------

function pickInputEl() {
  if (INPUT_SELECTOR) return document.querySelector(INPUT_SELECTOR);
  return (
    document.querySelector('textarea#message') ||
    document.querySelector('textarea[name="message"]') ||
    document.querySelector("textarea") ||
    document.querySelector('input[type="text"]')
  );
}

async function postBinarySTT(blob) {
  const res = await fetch(ENLACE_VOICE_STT, {
    method: "POST",
    headers: {
      accept: "application/json",
      // content-type will be set by browser for Blob body in most cases,
      // but we can set it explicitly to the recorder mime:
      "content-type": blob.type || "audio/webm",
    },
    body: blob,
  });

  const text = await res.text().catch(() => "");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const detail = json?.error || json?.detail || json?.raw || `HTTP ${res.status}`;
    throw new Error(String(detail).slice(0, 400));
  }
  return json;
}

function safeTextOnly(value) {
  const text = String(value || "");
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0) continue;
    const ok =
      code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || code >= 160;
    if (ok) out += text[i];
  }
  return out.trim();
}

// Optional: if you already have a chat send function, wire it here
function tryAutoSend(transcript) {
  if (!AUTO_SEND_AFTER_STT) return false;

  // 1) If you have an explicit function:
  if (typeof window.sendMessageFromUI === "function") {
    window.sendMessageFromUI(transcript);
    return true;
  }

  // 2) Or try clicking an obvious send button:
  const sendButton =
    document.querySelector("button#send") ||
    document.querySelector('button[data-send="true"]') ||
    document.querySelector('button[type="submit"]');

  if (sendButton) {
    sendButton.click();
    return true;
  }

  return false;
}

// -------------------------
// 3) Main: dynamic mic button behavior
// -------------------------

(function initVoiceMic() {
  const { btn, showTip } = createMicButton();

  let recorder = null;
  let chunks = [];
  let isRecording = false;
  let isBusy = false;

  const setState = (state) => {
    btn.classList.remove(
      "chattia-mic-idle",
      "chattia-mic-rec",
      "chattia-mic-busy",
      "chattia-mic-err"
    );
    btn.classList.add(state);
  };

  const startRecording = async () => {
    if (isBusy || isRecording) return;

    // Browser permission prompt happens here
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setState("chattia-mic-err");
      showTip("Mic permission blocked");
      return;
    }

    // Choose a supported mime
    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    let mimeType = "";
    for (const mt of preferred) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(mt)) {
        mimeType = mt;
        break;
      }
    }

    chunks = [];
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    recorder.onstop = async () => {
      // stop tracks (release mic)
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch {}

      const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
      recorder = null;
      chunks = [];

      // If user stopped immediately, ignore tiny blobs
      if (!blob || blob.size < 800) {
        setState("chattia-mic-idle");
        showTip("No audio captured");
        isRecording = false;
        return;
      }

      // Send to Enlace STT
      try {
        isBusy = true;
        setState("chattia-mic-busy");
        showTip("Transcribing…");

        const stt = await postBinarySTT(blob);
        const transcript = safeTextOnly(stt?.transcript || "");

        if (!transcript) {
          setState("chattia-mic-err");
          showTip("No transcript");
          return;
        }

        // Put transcript into input if present
        const inputEl = pickInputEl();
        if (inputEl) {
          inputEl.value = transcript;
          // Trigger input event so frameworks/listeners update state
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        }

        showTip(stt?.lang_iso2 === "es" ? "Listo ✅" : "Ready ✅");

        // Optional auto-send
        const sent = tryAutoSend(transcript);
        if (sent) showTip("Sent ✅");

        setState("chattia-mic-idle");
      } catch (error) {
        setState("chattia-mic-err");
        showTip(`STT error: ${String(error?.message || error).slice(0, 120)}`);
      } finally {
        isBusy = false;
        isRecording = false;
      }
    };

    recorder.start(250); // collect chunks every 250ms
    isRecording = true;
    setState("chattia-mic-rec");
    showTip("Recording… click again to stop");
  };

  const stopRecording = () => {
    if (!recorder || !isRecording) return;
    try {
      recorder.stop();
    } catch {}
    isRecording = false;
    setState("chattia-mic-busy");
    showTip("Uploading…");
  };

  btn.addEventListener("click", () => {
    if (isBusy) return;
    if (isRecording) stopRecording();
    else startRecording();
  });

  // Keyboard shortcut: Ctrl+Shift+V toggles voice
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && (event.key === "V" || event.key === "v")) {
      event.preventDefault();
      btn.click();
    }
  });
})();


const setStreamingState = (active) => {
  isStreaming = active;
  updateSendState();
};

const notifyWorker = async () => {
  const endpoint = getActiveEndpoint();
  if (!window.fetch || !endpoint) return;

  await fetch(`${endpoint}/health`, {
    method: "GET",
    mode: "cors",
    cache: "no-store",
  }).catch(() => null);
};

const loadAssetRegistry = async (registryUrl) => {
  const response = await fetch(registryUrl, { cache: "no-store" });
  if (!response.ok) return [];
  const registry = await response.json();
  if (Array.isArray(registry.assets)) {
    return registry.assets;
  }
  if (Array.isArray(registry)) {
    return registry;
  }
  return [];
};

const resolveAssetUrl = (assets, assetId) => {
  if (!assetId) return "";
  const asset = assets.find((entry) => entry.asset_id === assetId);
  return asset?.serving?.primary_url || asset?.source?.origin_url || "";
};

const loadRegistryConfig = async () => {
  if (!window.fetch) return;
  try {
    const response = await fetch(configUrl, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    if (data.workerEndpoint) {
      workerEndpoint = data.workerEndpoint;
    }
    if (data.gatewayEndpoint) {
      gatewayEndpoint = data.gatewayEndpoint;
    }
    if (Array.isArray(data.allowedOrigins) && data.allowedOrigins.length > 0) {
      allowedOrigins = data.allowedOrigins;
    }
    if (Array.isArray(data.requiredHeaders) && data.requiredHeaders.length > 0) {
      requiredHeaders = data.requiredHeaders;
    }
    if (
      Array.isArray(data.allowedOriginAssetIds) &&
      data.allowedOriginAssetIds.length > 0
    ) {
      allowedOriginAssetIds = data.allowedOriginAssetIds;
    }

    rebuildOriginMap();

    if (data.workerEndpointAssetId || data.gatewayEndpointAssetId) {
      const registryUrl = data.assetRegistry || defaultAssetRegistryUrl;
      const assets = await loadAssetRegistry(registryUrl);
      if (data.workerEndpointAssetId) {
        workerEndpoint = resolveAssetUrl(assets, data.workerEndpointAssetId);
      }
      if (data.gatewayEndpointAssetId) {
        gatewayEndpoint = resolveAssetUrl(assets, data.gatewayEndpointAssetId);
      }
    }
  } catch (error) {
    console.warn("Unable to load worker registry config.", error);
  }
};

const getActiveEndpoint = () => gatewayEndpoint || workerEndpoint;

const buildMessages = (message) => [
  {
    role: "user",
    content: message,
  },
];

const streamWorkerResponse = async (response, bubble) => {
  if (!response.body) {
    bubble.textContent = "We couldn't connect to the assistant stream.";
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let hasChunk = false;
  const appendText = (text) => {
    if (!hasChunk) {
      stopThinking();
      bubble.textContent = "";
      hasChunk = true;
    }
    bubble.textContent += text;
    chatLog.scrollTop = chatLog.scrollHeight;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    parts.forEach((part) => {
      const lines = part.split("\n");
      const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s?/, ""));
      const data = dataLines.join("\n").trim();
      if (data && data !== "[DONE]") {
        appendText(data);
      }
    });
  }
};

const readWorkerError = async (response) => {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      const payload = await response.json();
      if (payload?.error) {
        return payload.detail
          ? `${payload.error}: ${payload.detail}`
          : payload.error;
      }
      return JSON.stringify(payload);
    } catch (error) {
      console.error(error);
    }
  }
  return response.text();
};

const warnIfOriginMissing = () => {
  const originAllowed = isOriginAllowed(window.location.origin, allowedOrigins);
  if (!originAllowed) {
    console.warn(
      `Origin ${window.location.origin} is not listed in worker_files/worker.config.json.`
    );
  }
  setStatusLine(
    originStatus,
    originAllowed
      ? `Origin: ${window.location.origin}`
      : `Origin: ${window.location.origin} (not listed)`,
    !originAllowed
  );
};

const updateEndpointStatus = () => {
  const activeEndpoint = getActiveEndpoint();
  const isConfigured = Boolean(activeEndpoint);
  setStatusLine(
    endpointStatus,
    isConfigured
      ? `Endpoint: ${activeEndpoint}${gatewayEndpoint ? " (gateway)" : ""}`
      : "Endpoint: not configured",
    !isConfigured
  );
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || isStreaming) return;

  addMessage(message, true);
  input.value = "";
  updateSendState();
  input.blur();

  const assistantBubble = addMessage("Thinking.", false);
  startThinking(assistantBubble);

  const endpoint = getActiveEndpoint();
  if (!endpoint) {
    assistantBubble.textContent =
      "The assistant endpoint is not configured. Please check worker_files/worker.config.json.";
    stopThinking();
    return;
  }

  warnIfOriginMissing();
  setStreamingState(true);
  const controller = new AbortController();
  activeController = controller;

  try {
    let headers;
    try {
      headers = getRequestHeaders();
    } catch (error) {
      assistantBubble.textContent = String(error?.message || error);
      stopThinking();
      return;
    }

    const response = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers,
      body: JSON.stringify({
        messages: buildMessages(message),
        meta: {
          source: "chattia-ui",
          currentUrl: window.location.href,
          allowedOrigins,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await readWorkerError(response);
      assistantBubble.textContent =
        errorText || `Request failed (${response.status}).`;
      stopThinking();
      return;
    }

    await streamWorkerResponse(response, assistantBubble);
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    assistantBubble.textContent =
      error?.message ||
      "We couldn't reach the secure assistant. Please try again shortly.";
    console.error(error);
  } finally {
    activeController = null;
    activeAssistantBubble = null;
    setStreamingState(false);
    stopThinking();
  }
});

const init = async () => {
  await loadRegistryConfig();
  warnIfOriginMissing();
  updateEndpointStatus();
  updateSendState();
  notifyWorker();
  stopThinking();
};

init();
