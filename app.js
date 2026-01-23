const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const chatLog = document.getElementById("chat-log");
const voiceBtn = document.getElementById("voice-btn");

const workerEndpoint = "https://enlace.grabem-holdem-nuts-right.workers.dev/";
const allowedOrigins = [
  "https://chattiavato-a11y.github.io",
  "https://chattia.io",
  "https://www.chattia.io",
  "https://opsonlinesupport.com",
  "https://www.opsonlinesupport.com",
];

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

  const payload = {
    source: "chattia-ui",
    timestamp: new Date().toISOString(),
    currentUrl: window.location.href,
    allowedOrigins,
  };

  await fetch(workerEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    keepalive: true,
  });
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  addMessage(message, true);
  input.value = "";
  updateSendState();
  input.blur();

  setTimeout(() => {
    addMessage("Thanks! A specialist reply would appear here in production.", false);
  }, 500);
});

updateSendState();
notifyWorker();
