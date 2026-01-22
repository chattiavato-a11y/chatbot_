/**
 * app.js — REPO UI (GitHub Pages) (v0.4.4)
 * UI -> EnlaceRepo -> Enlace Worker (/api/chat SSE, /api/voice?mode=stt, optional /api/tts)
 *
 * Requirements:
 * 1) <script src="enlace-worker.js"></script> MUST load before this file.
 * 2) ops-keys.json must exist and include OPS_ASSET_ID + SRC_PUBLIC_SHA512_B64 (unless you disabled REQUIRE_IDENTITY_HEADERS)
 *
 * Safe DOM:
 * - textContent only (no innerHTML)
 */

(function () {
  "use strict";

  // -------------------------
  // 0) DOM helpers
  // -------------------------
  function $(sel) {
    return document.querySelector(sel);
  }

  function pickEl(selectors) {
    for (const s of selectors) {
      const el = $(s);
      if (el) return el;
    }
    return null;
  }

  function must(el, name) {
    if (!el) throw new Error(`Missing UI element: ${name}`);
    return el;
  }

  function setText(el, txt) {
    if (!el) return;
    el.textContent = String(txt == null ? "" : txt);
  }

  function nowTime() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // -------------------------
  // 1) Find your UI elements (tries common IDs/classes)
  // -------------------------
  const elThread = pickEl([
    "#messages",
    "#chatMessages",
    "#chat",
    ".messages",
    ".chatMessages",
    ".thread",
    ".chat-thread",
  ]);

  const elForm = pickEl([
    "#chatForm",
    "form.chatForm",
    "form#composer",
    "form",
  ]);

  const elInput = pickEl([
    "#chatInput",
    "#messageInput",
    "textarea#prompt",
    "textarea",
    "input[type='text']",
  ]);

  const elSendBtn = pickEl([
    "#sendBtn",
    "#send",
    "button[type='submit']",
    ".sendBtn",
  ]);

  const elMicBtn = pickEl([
    "#micBtn",
    "#mic",
    "button[data-mic]",
    ".micBtn",
  ]);

  const elStatus = pickEl([
    "#status",
    "#chatStatus",
    ".status",
    ".hint",
  ]);

  // Optional: a stop button to abort streaming
  const elStopBtn = pickEl([
    "#stopBtn",
    "#stop",
    "button[data-stop]",
    ".stopBtn",
  ]);

  // Optional: a speak button (TTS) for the last assistant message
  const elSpeakBtn = pickEl([
    "#speakBtn",
    "#speak",
    "button[data-speak]",
    ".speakBtn",
  ]);

  // -------------------------
  // 2) Render helpers
  // -------------------------
  function ensureThread() {
    return must(elThread, "message thread container (#chatMessages/#messages/.messages etc.)");
  }

  function makeBubble(role, text) {
    const wrap = document.createElement("div");
    wrap.className = role === "user" ? "msg user" : "msg assistant";

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    setText(meta, `${role === "user" ? "You" : "Chattia"} • ${nowTime()}`);

    const body = document.createElement("div");
    body.className = "msg-body";
    setText(body, text || "");

    wrap.appendChild(meta);
    wrap.appendChild(body);
    return { wrap, body };
  }

  function appendBubble(role, text) {
    const thread = ensureThread();
    const b = makeBubble(role, text);
    thread.appendChild(b.wrap);
    thread.scrollTop = thread.scrollHeight;
    return b;
  }

  function setStatus(msg) {
    if (!elStatus) return;
    setText(elStatus, msg || "");
  }

  function setBusy(isBusy) {
    if (elSendBtn) elSendBtn.disabled = !!isBusy;
    if (elInput) elInput.disabled = !!isBusy;
    if (elStopBtn) elStopBtn.disabled = !isBusy;
  }

  // -------------------------
  // 3) Chat flow (SSE)
  // -------------------------
  let activeAbort = null;
  let lastAssistantText = "";

  async function sendChatText(userText, meta) {
    const clean = window.EnlaceRepo.sanitizeText(userText, 1500);
    if (!clean) return;

    // Show user bubble
    appendBubble("user", clean);

    // Create assistant bubble placeholder (we’ll stream into it)
    const a = appendBubble("assistant", "");
    lastAssistantText = "";

    // Abort previous stream if any
    if (activeAbort) {
      try { activeAbort.abort(); } catch {}
      activeAbort = null;
    }

    const ac = new AbortController();
    activeAbort = ac;

    setBusy(true);
    setStatus("Thinking...");

    try {
      await window.EnlaceRepo.chatSSE(
        {
          messages: [
            { role: "user", content: clean }
          ],
          meta: meta && typeof meta === "object" ? meta : {},
          honeypot: ""
        },
        {
          signal: ac.signal,
          onHeaders: (hdrs) => {
            // Optional debug status
            const iso2 = hdrs.get("x-chattia-text-iso2") || "";
            const bcp = hdrs.get("x-chattia-text-bcp47") || "";
            const brainSeen = hdrs.get("x-chattia-brain-id-seen") || "";
            if (iso2 || bcp) {
              setStatus(`Connected • lang=${iso2 || "?"} ${bcp ? `(${bcp})` : ""} • brainID=${brainSeen || "?"}`);
            } else {
              setStatus("Connected");
            }
          },
          onToken: (tok) => {
            const t = String(tok || "");
            if (!t) return;
            lastAssistantText += t;
            // safe write
            a.body.textContent = lastAssistantText;
            const thread = ensureThread();
            thread.scrollTop = thread.scrollHeight;
          },
        }
      );

      setStatus("Done");
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      setStatus("Error");
      a.body.textContent = `⚠️ ${msg}`;
    } finally {
      setBusy(false);
      activeAbort = null;
    }
  }

  function stopStreaming() {
    if (activeAbort) {
      try { activeAbort.abort(); } catch {}
      activeAbort = null;
      setStatus("Stopped");
      setBusy(false);
    }
  }

  // -------------------------
  // 4) Voice (record -> STT -> send)
  // -------------------------
  let recorder = null;
  let recChunks = [];
  let isRecording = false;

  function pickMimeType() {
    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    for (const t of preferred) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser does not support microphone capture.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recChunks = [];

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
    };

    recorder.onstop = () => {
      // stop tracks to release mic
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
    };

    recorder.start(250);
    isRecording = true;
    setStatus("🎙️ Recording… click mic again to stop");
  }

  async function stopRecordingAndSend() {
    if (!recorder) return;

    const r = recorder;
    recorder = null;
    isRecording = false;

    const stopped = new Promise((resolve) => {
      r.onstop = () => resolve(true);
    });

    try { r.stop(); } catch {}
    await stopped;

    const blob = new Blob(recChunks, { type: (r.mimeType || "audio/webm") });
    recChunks = [];

    setStatus("Transcribing…");

    try {
      const out = await window.EnlaceRepo.voiceSTT(blob, {});
      if (out.blocked) {
        setStatus("Blocked transcript");
        appendBubble("assistant", "⚠️ Voice transcript blocked (looked like code/markup). Try speaking in plain language.");
        return;
      }

      const transcript = String(out.transcript || "").trim();
      if (!transcript) {
        setStatus("No transcript");
        appendBubble("assistant", "⚠️ No transcript produced. Try again.");
        return;
      }

      // Optional: set meta language hint
      const meta = {};
      if (out.lang_iso2) meta.lang_iso2 = out.lang_iso2;
      if (out.lang_bcp47) meta.lang_bcp47 = out.lang_bcp47;

      // If input exists, fill it, then send
      if (elInput) elInput.value = transcript;

      setStatus("Sending…");
      await sendChatText(transcript, meta);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      setStatus("Voice error");
      appendBubble("assistant", `⚠️ Voice failed: ${msg}`);
    }
  }

  async function onMicClick() {
    try {
      if (!window.EnlaceRepo) throw new Error("EnlaceRepo missing. Ensure enlace-worker.js loads before app.js");
      await window.EnlaceRepo.ready();

      if (!isRecording) {
        await startRecording();
        if (elMicBtn) elMicBtn.setAttribute("aria-pressed", "true");
      } else {
        if (elMicBtn) elMicBtn.setAttribute("aria-pressed", "false");
        await stopRecordingAndSend();
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      setStatus("Mic error");
      appendBubble("assistant", `⚠️ Mic failed: ${msg}`);
      isRecording = false;
      if (elMicBtn) elMicBtn.setAttribute("aria-pressed", "false");
    }
  }

  // -------------------------
  // 5) Optional: Speak last assistant message (TTS)
  // -------------------------
  let currentAudio = null;

  async function speakLast() {
    if (!lastAssistantText.trim()) {
      setStatus("Nothing to speak yet");
      return;
    }

    try {
      await window.EnlaceRepo.ready();
      setStatus("Generating voice…");

      const audioBlob = await window.EnlaceRepo.tts(
        { text: lastAssistantText, speaker: "angus", encoding: "mp3", container: "none" },
        {}
      );

      if (currentAudio) {
        try { currentAudio.pause(); } catch {}
        currentAudio = null;
      }

      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      currentAudio = audio;

      audio.onended = () => {
        try { URL.revokeObjectURL(url); } catch {}
        currentAudio = null;
        setStatus("Done");
      };

      audio.onerror = () => {
        try { URL.revokeObjectURL(url); } catch {}
        currentAudio = null;
        setStatus("Audio error");
      };

      await audio.play();
      setStatus("Speaking…");
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      setStatus("TTS error");
      appendBubble("assistant", `⚠️ TTS failed: ${msg}`);
    }
  }

  // -------------------------
  // 6) Wire up events
  // -------------------------
  async function boot() {
    // Hard fail if repo helper missing
    if (!window.EnlaceRepo) {
      throw new Error("EnlaceRepo is missing. Ensure: <script src='enlace-worker.js'></script> loads before app.js");
    }

    // Ensure required elements
    ensureThread();
    must(elInput, "chat input (textarea/input)");
    must(elForm, "chat form (form)");

    // Ready config (fail fast if keys missing)
    await window.EnlaceRepo.ready();
    const cfg = window.EnlaceRepo.getConfig();
    setStatus(`Ready • ${cfg && cfg.ENLACE_BASE ? cfg.ENLACE_BASE : ""}`);

    // submit handler
    elForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const txt = String(elInput.value || "");
      elInput.value = "";
      await sendChatText(txt, {});
    });

    // send button (optional)
    if (elSendBtn && elSendBtn.type !== "submit") {
      elSendBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const txt = String(elInput.value || "");
        elInput.value = "";
        await sendChatText(txt, {});
      });
    }

    // mic button (optional)
    if (elMicBtn) {
      elMicBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await onMicClick();
      });
    }

    // stop streaming (optional)
    if (elStopBtn) {
      elStopBtn.disabled = true;
      elStopBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        stopStreaming();
      });
    }

    // speak (optional)
    if (elSpeakBtn) {
      elSpeakBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await speakLast();
      });
    }
  }

  // -------------------------
  // 7) Start
  // -------------------------
  (async () => {
    try {
      await boot();
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      setStatus("Boot error");
      // Render error safely
      try {
        appendBubble("assistant", `⚠️ Boot failed: ${msg}`);
      } catch {
        // last resort
        console.error(msg);
      }
    }
  })();
})();
