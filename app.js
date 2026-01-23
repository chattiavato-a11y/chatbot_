const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const chatLog = document.getElementById("chat-log");
const voiceBtn = document.getElementById("voice-btn");
const voiceHelper = document.getElementById("voice-helper");

const configUrl = "worker.config.json";
const defaultConfig = {
  workerEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev",
  allowedOrigins: [
    "https://chattiavato-a11y.github.io",
    "https://www.chattia.io",
    "https://chattia.io",
  ],
  requiredHeaders: ["Content-Type", "Accept"],
};
let workerEndpoint = defaultConfig.workerEndpoint;
let allowedOrigins = [...defaultConfig.allowedOrigins];
let requiredHeaders = [...defaultConfig.requiredHeaders];

const isOriginAllowed = (origin, allowedList) =>
  allowedList.some((allowedOrigin) => allowedOrigin === origin);

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
  sendBtn.disabled = input.value.trim().length === 0;
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
let isListening = false;

const setVoiceState = (active) => {
  isListening = active;
  voiceBtn.classList.toggle("active", active);
  voiceBtn.setAttribute("aria-pressed", String(active));
  voiceBtn.setAttribute("aria-label", active ? "Stop voice input" : "Start voice input");
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

voiceBtn.addEventListener("click", () => {
  if (!recognition) return;
  if (isListening) {
    recognition.stop();
    return;
  }
  recognition.start();
});

const notifyWorker = async () => {
  if (!window.fetch) return;
  if (!isOriginAllowed(window.location.origin, allowedOrigins)) return;

  await fetch(`${workerEndpoint}/health`, {
    method: "GET",
    mode: "cors",
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
      if (!data || data === "[DONE]") return;
      appendText(data);
    });
  }
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  addMessage(message, true);
  input.value = "";
  updateSendState();
  input.blur();

  const assistantBubble = addMessage("Thinking…", false);

  if (!isOriginAllowed(window.location.origin, allowedOrigins)) {
    assistantBubble.textContent =
      "This origin is not authorized to reach the secure assistant endpoint.";
    return;
  }

  fetch(`${workerEndpoint}/api/chat`, {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      messages: buildMessages(message),
      meta: {
        source: "chattia-ui",
        currentUrl: window.location.href,
        allowedOrigins,
      },
    }),
  })
    .then((response) => {
      if (!response.ok) {
        return response.text().then((text) => {
          throw new Error(text || `Request failed (${response.status})`);
        });
      }
      return streamWorkerResponse(response, assistantBubble);
    })
    .catch((error) => {
      assistantBubble.textContent =
        "We couldn't reach the secure assistant. Please try again shortly.";
      console.error(error);
    });
});

const init = async () => {
  await loadRegistryConfig();
  updateSendState();
  notifyWorker();
};

init();
