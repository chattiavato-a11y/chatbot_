const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const chatLog = document.getElementById("chat-log");
const voiceBtn = document.getElementById("voice-btn");
const voiceHelper = document.getElementById("voice-helper");

const configUrl = "worker.config.json";
let workerEndpoint = "";
let allowedOrigins = [];
let requiredHeaders = [];
let isStreaming = false;
let activeController = null;
let activeAssistantBubble = null;

const isOriginAllowed = (origin, allowedList) =>
  allowedList.some((allowedOrigin) => allowedOrigin === origin);

const originStatus = document.getElementById("origin-status");
const endpointStatus = document.getElementById("endpoint-status");
const cancelBtn = document.getElementById("cancel-btn");

const setStatusLine = (element, text, isWarning = false) => {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("warning", isWarning);
};

const getRequestHeaders = () => {
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
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

const updateSendState = () => {
  sendBtn.disabled = isStreaming || input.value.trim().length === 0;
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

const recognitionEngine = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let isVoiceActive = false;
let mediaRecorder;
let recordingChunks = [];
let recordingTimeout;

const setVoiceState = (active) => {
  isVoiceActive = active;
  voiceBtn.classList.toggle("active", active);
  voiceBtn.setAttribute("aria-pressed", String(active));
  voiceBtn.setAttribute(
    "aria-label",
    active ? "Stop voice input" : "Start voice input"
  );
};

if (recognitionEngine) {
  recognition = new recognitionEngine();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.addEventListener("start", () => {
    setVoiceState(true);
    input.focus();
  });

  recognition.addEventListener("end", () => {
    setVoiceState(false);
  });

  recognition.addEventListener("result", (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0].transcript)
      .join("")
      .trim();
    if (transcript) {
      input.value = transcript;
      updateSendState();
    }
  });
} else {
  voiceBtn.disabled = true;
  voiceBtn.setAttribute("aria-label", "Voice input not supported");
  if (voiceHelper) {
    voiceHelper.textContent =
      "Voice input is unavailable in this browser. Use the message box to continue.";
  }
}

const resetRecording = () => {
  recordingChunks = [];
  if (recordingTimeout) {
    clearTimeout(recordingTimeout);
    recordingTimeout = null;
  }
};

const startVoiceFallback = async () => {
  if (isVoiceActive) {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
    return;
  }

  if (!workerEndpoint) {
    console.warn("Voice fallback requires a configured worker endpoint.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    console.warn("Media devices not available for voice fallback.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    resetRecording();
    setVoiceState(true);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        recordingChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("stop", async () => {
      setVoiceState(false);
      stream.getTracks().forEach((track) => track.stop());
      const audioBlob = new Blob(recordingChunks, {
        type: mediaRecorder.mimeType || "audio/webm",
      });
      resetRecording();
      if (!audioBlob.size) return;

      try {
        const response = await fetch(`${workerEndpoint}/api/voice?mode=stt`, {
          method: "POST",
          mode: "cors",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": audioBlob.type,
          },
          body: audioBlob,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || "Voice transcription failed.");
        }

        const payload = await response.json();
        const transcript =
          payload.transcript || payload.text || payload.message || "";
        if (transcript) {
          input.value = transcript.trim();
          updateSendState();
        }
      } catch (error) {
        console.error(error);
      }
    });

    mediaRecorder.start();
    recordingTimeout = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
    }, 5000);
  } catch (error) {
    console.error("Unable to start voice fallback.", error);
    setVoiceState(false);
  }
};

voiceBtn.addEventListener("click", () => {
  if (recognition) {
    if (isVoiceActive) {
      recognition.stop();
      return;
    }
    recognition.start();
    return;
  }

  startVoiceFallback();
});

const setStreamingState = (active) => {
  isStreaming = active;
  updateSendState();
  if (cancelBtn) {
    cancelBtn.disabled = !active;
    cancelBtn.classList.toggle("active", active);
  }
};

const cancelStream = () => {
  if (!activeController) return;
  activeController.abort();
  activeController = null;
  setStreamingState(false);
  if (activeAssistantBubble) {
    activeAssistantBubble.textContent = activeAssistantBubble.textContent
      ? `${activeAssistantBubble.textContent}\n\nRequest canceled.`
      : "Request canceled.";
    activeAssistantBubble = null;
  }
};

cancelBtn?.addEventListener("click", cancelStream);

const notifyWorker = async () => {
  if (!window.fetch || !workerEndpoint) return;

  await fetch(`${workerEndpoint}/health`, {
    method: "GET",
    mode: "cors",
    cache: "no-store",
  }).catch(() => null);
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
    if (Array.isArray(data.allowedOrigins) && data.allowedOrigins.length > 0) {
      allowedOrigins = data.allowedOrigins;
    }
    if (Array.isArray(data.requiredHeaders) && data.requiredHeaders.length > 0) {
      requiredHeaders = data.requiredHeaders;
    }
  } catch (error) {
    console.warn("Unable to load worker registry config.", error);
  }
};

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
      `Origin ${window.location.origin} is not listed in worker.config.json.`
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
  const isConfigured = Boolean(workerEndpoint);
  setStatusLine(
    endpointStatus,
    isConfigured ? `Endpoint: ${workerEndpoint}` : "Endpoint: not configured",
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

  const assistantBubble = addMessage("Thinking…", false);

  if (!workerEndpoint) {
    assistantBubble.textContent =
      "The assistant endpoint is not configured. Please check worker.config.json.";
    return;
  }

  warnIfOriginMissing();
  setStreamingState(true);
  const controller = new AbortController();
  activeController = controller;

  try {
    const response = await fetch(`${workerEndpoint}/api/chat`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: getRequestHeaders(),
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
  }
});

const init = async () => {
  await loadRegistryConfig();
  warnIfOriginMissing();
  updateEndpointStatus();
  updateSendState();
  notifyWorker();
};

init();
