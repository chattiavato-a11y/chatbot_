const form = document.getElementById("chat-form");
const input = document.getElementById("msgInput");
const sendBtn = document.getElementById("send-btn");
const chatLog = document.getElementById("chat-log");
// --- OPS Asset Identity (Origin -> AssetId) ---
const OPS_ASSET_BY_ORIGIN = {
  "https://www.chattia.io": "asset_01J7Y2D4XABCD3EFGHJKMNPRTB",
  "https://chattia.io": "asset_01J7Y2D4XABCD3EFGHJKMNPRTC",
  "https://chattiavato-a11y.github.io": "asset_01J7Y2D4XABCD3EFGHJKMNPRTD",
};
const OPS_ASSET_ID = OPS_ASSET_BY_ORIGIN[window.location.origin] || "";
window.OPS_ASSET_BY_ORIGIN = OPS_ASSET_BY_ORIGIN;
window.OPS_ASSET_ID = OPS_ASSET_ID;

const defaultConfig = {
  assetRegistry: "worker_files/worker.assets.json",
  workerEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev",
  assistantEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat",
  voiceEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev/api/voice",
  ttsEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev/api/tts",
  gatewayEndpoint: "",
  workerEndpointAssetId: "asset_01J7Y2D4XABCD3EFGHJKMNPRTA",
  gatewayEndpointAssetId: "",

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

};

let workerEndpoint = defaultConfig.workerEndpoint;
let gatewayEndpoint = defaultConfig.gatewayEndpoint;
let allowedOrigins = [...defaultConfig.allowedOrigins];
let isStreaming = false;
let activeController = null;
let activeAssistantBubble = null;
const DEFAULT_REQUEST_META = {
  reply_format: "paragraph",
  tone: "friendly",
  spanish_quality: "king",
  model_tier: "quality",
};

const deriveWorkerEndpoint = (assistantEndpoint) => {
  if (!assistantEndpoint) return "";
  try {
    const url = new URL(assistantEndpoint, window.location.origin);
    if (url.pathname.endsWith("/api/chat")) {
      url.pathname = url.pathname.replace(/\/api\/chat\/?$/, "");
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    console.warn("Unable to parse assistant endpoint.", error);
  }
  return "";
};

const normalizeOrigin = (value) => {
  if (!value) return "";
  try {
    return new URL(String(value), window.location.origin).origin.toLowerCase();
  } catch (error) {
    return String(value).trim().replace(/\/$/, "").toLowerCase();
  }
};

const isOriginAllowed = (origin, allowedList) => {
  const normalizedOrigin = normalizeOrigin(origin);
  return allowedList.some(
    (allowedOrigin) => normalizeOrigin(allowedOrigin) === normalizedOrigin
  );
};

const originStatus = document.getElementById("origin-status");
const endpointStatus = document.getElementById("endpoint-status");
const thinkingStatus = document.getElementById("thinking-status");
const responseMeta = document.getElementById("response-meta");
const voiceHelper = document.getElementById("voice-helper");
const cancelBtn = document.getElementById("cancel-btn");
const thinkingFrames = ["Thinking.", "Thinking..", "Thinking...", "Thinking...."];
let thinkingInterval = null;
let thinkingIndex = 0;
let activeThinkingBubble = null;
const setStatusLine = (element, text, isWarning = false) => {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("warning", isWarning);
};

const buildResponseMeta = (headers) => {
  if (!headers) return "";
  const values = [
    { key: "x-chattia-lang-iso2", label: "lang" },
    { key: "x-chattia-model", label: "model" },
    { key: "x-chattia-stt-iso2", label: "stt" },
    { key: "x-chattia-voice-timeout-sec", label: "voice timeout" },
    { key: "x-chattia-tts-iso2", label: "tts" },
  ];
  const items = values
    .map(({ key, label }) => {
      const value = headers.get(key);
      return value ? `${label}: ${value}` : "";
    })
    .filter(Boolean);
  return items.join(" · ");
};

const setResponseMeta = (headers, element) => {
  if (!element) return;
  element.textContent = buildResponseMeta(headers);
};

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

// ===== Voice / Mic (Enlace STT) =====

const ENLACE_ORIGIN = defaultConfig.workerEndpoint;
const ENLACE_VOICE_API = `${ENLACE_ORIGIN}/api/voice?mode=stt`;

let micStream = null;
let micRecorder = null;
let micChunks = [];
let micRecording = false;
let voiceReplyRequested = false;
let activeVoiceAudio = null;

function getSupportedMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return "";
}

function setMicUI(isOn) {
  const btn = document.getElementById("micBtn");
  if (!btn) return;
  const emoji = btn.querySelector(".mic-emoji");
  if (emoji) {
    emoji.textContent = isOn ? "⏹️" : "🎤";
  }
  btn.setAttribute("aria-pressed", isOn ? "true" : "false");
}

async function playVoiceReply(text) {
  if (!text) return;
  if (!window.EnlaceRepo?.postTTS) {
    throw new Error("Enlace TTS module is not loaded.");
  }
  if (activeVoiceAudio) {
    activeVoiceAudio.pause();
    activeVoiceAudio = null;
  }
  const res = await window.EnlaceRepo.postTTS({ text });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`TTS failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  setResponseMeta(res.headers, voiceHelper);
  const audioBlob = await res.blob();
  const audioUrl = URL.createObjectURL(audioBlob);
  const audio = new Audio(audioUrl);
  activeVoiceAudio = audio;
  audio.addEventListener("ended", () => {
    URL.revokeObjectURL(audioUrl);
    if (activeVoiceAudio === audio) {
      activeVoiceAudio = null;
    }
  });
  await audio.play();
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone not supported in this browser.");
  }
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeType = getSupportedMimeType();
  micChunks = [];
  micRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);

  micRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) micChunks.push(event.data);
  };

  micRecorder.start(250);
  micRecording = true;
  setMicUI(true);
}

async function stopMicAndTranscribe() {
  if (!micRecorder) return "";

  const stopped = new Promise((resolve) => {
    micRecorder.onstop = resolve;
  });

  micRecorder.stop();
  await stopped;

  try {
    micStream?.getTracks()?.forEach((track) => track.stop());
  } catch {}
  micStream = null;

  const blob = new Blob(micChunks, { type: micRecorder.mimeType || "audio/webm" });
  micRecorder = null;
  micChunks = [];
  micRecording = false;
  setMicUI(false);

  const headers = { Accept: "application/json" };
  if (OPS_ASSET_ID) {
    headers["x-ops-asset-id"] = OPS_ASSET_ID;
  }
  const res = await fetch(ENLACE_VOICE_API, {
    method: "POST",
    headers,
    body: blob,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`STT failed (${res.status}): ${text.slice(0, 200)}`);
  }

  setResponseMeta(res.headers, voiceHelper);
  const data = await res.json();
  const transcript = data?.transcript ? String(data.transcript) : "";
  if (!transcript) throw new Error("No transcript returned.");

  if (input) {
    input.value = transcript;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    voiceReplyRequested = true;
    form?.requestSubmit();
  }

  return transcript;
}

async function onMicClick() {
  try {
    if (!micRecording) {
      await startMic();
      setTimeout(async () => {
        if (micRecording) {
          try {
            await stopMicAndTranscribe();
          } catch (error) {
            console.error(error);
          }
        }
      }, 8000);
    } else {
      await stopMicAndTranscribe();
    }
  } catch (error) {
    micRecording = false;
    setMicUI(false);
    try {
      micStream?.getTracks()?.forEach((track) => track.stop());
    } catch {}
    micStream = null;
    micRecorder = null;
    micChunks = [];

    console.error("Mic error:", error);

    if (input) {
      input.placeholder =
        error?.message ? String(error.message) : "Microphone error";
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("micBtn");
  if (btn) btn.addEventListener("click", onMicClick);
});


const setStreamingState = (active) => {
  isStreaming = active;
  updateSendState();
};

cancelBtn?.addEventListener("click", cancelStream);

const loadRegistryConfig = async () => {
  if (!window.EnlaceRepo?.init) return;
  try {
    await window.EnlaceRepo.init();
    const data = window.EnlaceRepo.getConfig();
    if (data.workerEndpoint) {
      workerEndpoint = data.workerEndpoint;
    } else if (data.assistantEndpoint) {
      const derivedEndpoint = deriveWorkerEndpoint(data.assistantEndpoint);
      if (derivedEndpoint) {
        workerEndpoint = derivedEndpoint;
      }
    }
    if (Array.isArray(data.allowedOrigins) && data.allowedOrigins.length > 0) {
      allowedOrigins = data.allowedOrigins;
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
    return bubble.textContent;
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

  let fullText = "";
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
        fullText += data;
        appendText(data);
      }
    });
  }
  return fullText.trim();
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
    try {
      if (!window.EnlaceRepo?.postChat) {
        throw new Error("Enlace repo module is not loaded.");
      }
    } catch (error) {
      assistantBubble.textContent = String(error?.message || error);
      stopThinking();
      return;
    }

    const response = await window.EnlaceRepo.postChat(
      {
        messages: buildMessages(message),
        meta: {
          source: "chattia-ui",
          currentUrl: window.location.href,
          allowedOrigins,
          ...DEFAULT_REQUEST_META,
        },
      },
      { signal: controller.signal }
    );

    if (!response.ok) {
      const errorText = await readWorkerError(response);
      assistantBubble.textContent =
        errorText || `Request failed (${response.status}).`;
      stopThinking();
      return;
    }

    setResponseMeta(response.headers, responseMeta);
    const assistantText = await streamWorkerResponse(response, assistantBubble);
    if (voiceReplyRequested && assistantText) {
      try {
        await playVoiceReply(assistantText);
      } catch (error) {
        console.error("Voice reply failed:", error);
      }
    }
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
    voiceReplyRequested = false;
  }
});

const init = async () => {
  await loadRegistryConfig();
  warnIfOriginMissing();
  updateEndpointStatus();
  updateSendState();
  stopThinking();
};

init();
