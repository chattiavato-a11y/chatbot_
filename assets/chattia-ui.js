/* assets/chattia-ui.js */
/* OPS UI — v3 (repo-coordinated with ops-gateway v2) */
(() => {
  "use strict";

  const qs  = (s) => document.querySelector(s);

  // === CONFIG ===
  // Keep ASSET_ID in sync with Gateway env: OPS_ASSET_IDS (or ASSET_ID)
  const ASSET_ID = "CAFF600A21B457E5D909FD887AF48018B3CBFDDF6F9746E56238B23AF061F9E2";

  const GATEWAY_ORIGIN = "https://ops-gateway.grabem-holdem-nuts-right.workers.dev";
  const API_URL = `${GATEWAY_ORIGIN}/api/ops-online-chat`;
  const TELEMETRY_URL = `${GATEWAY_ORIGIN}/reports/telemetry`;

  // Optional extra client-side allowlist (gateway still enforces Origin)
  const AUTH_RULES = [
    { origin: "https://chattiavato-a11y.github.io", pathPrefixes: ["/ops-online-support", "/ops-online-support/"] },
    { origin: "https://www.chattia.io", pathPrefixes: ["/"] },
    { origin: "https://chattia.io", pathPrefixes: ["/"] }
  ];

  const MAX_INPUT_CHARS = 256;

  // === ELEMENTS ===
  const log = qs("#chat-log");
  const form = qs("#chatbot-input-row");
  const input = qs("#chatbot-input");
  const sendBtn = qs("#chatbot-send");

  const speechToggle = qs("#speechToggle");
  const listenCtrl = qs("#listenCtrl");
  const voiceStatus = qs("#voice-status");

  const netDot = qs("#netDot");
  const netText = qs("#netText");

  const consentBanner = qs("#consent-banner");
  const consentAccept = qs("#consent-accept");
  const consentDeny = qs("#consent-deny");
  const consentNote = qs("#consent-note");

  const hpEmail = qs("#hp_email");
  const hpWebsite = qs("#hp_website");

  const clearChatBtn = qs("#clearChat");
  const transcriptTrigger = qs("#transcriptTrigger");
  const transcriptDrawer = qs("#transcriptDrawer");
  const transcriptOverlay = qs("#transcriptOverlay");
  const transcriptClose = qs("#transcriptClose");
  const transcriptList = qs("#transcriptList");
  const transcriptCopy = qs("#transcript-copy");
  const clearTranscriptBtn = qs("#clearTranscript");

  const tncButton = qs("#tnc-button");

  const privacyTrigger = qs("#privacyTrigger");
  const termsTrigger = qs("#termsTrigger");
  const policyOverlay = qs("#policyOverlay");
  const policyModal = qs("#policyModal");
  const privacyAcceptBtn = qs("#btnAcceptPrivacy");
  const privacyDenyBtn = qs("#btnDenyPrivacy");
  const policyCloseBtn = qs("#btnClosePolicy");

  // === CONSENT + PREFS ===
  const prefsApi = window.opsUiPrefs || null;

  const STORAGE_KEYS = {
    consent: "ops-chat-consent"
  };

  let currentLang = prefsApi?.getLang?.() || (document.documentElement.lang === "es" ? "es" : "en");
  let currentTheme = prefsApi?.getTheme?.() || (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  let consentState = "pending"; // pending | accepted | denied

  function setChatEnabled(enabled) {
    if (input) input.disabled = !enabled;
    if (sendBtn) sendBtn.disabled = !enabled;
    if (listenCtrl) listenCtrl.disabled = !enabled;

    if (consentNote) consentNote.hidden = enabled;
  }

  function readConsent() {
    try { return localStorage.getItem(STORAGE_KEYS.consent) || "pending"; }
    catch { return "pending"; }
  }

  function persistConsent(value) {
    try { localStorage.setItem(STORAGE_KEYS.consent, value); } catch {}
  }

  function applyConsentUI() {
    const hide = (consentState === "accepted" || consentState === "denied");

    if (consentBanner) {
      consentBanner.style.display = hide ? "none" : "block";
      consentBanner.setAttribute("aria-hidden", hide ? "true" : "false");
    }
  }

  function handleConsent(next) {
    consentState = next;
    persistConsent(next);

    if (next === "accepted") {
      prefsApi?.setPersistenceAllowed(true);
      setChatEnabled(true);
    } else if (next === "denied") {
      prefsApi?.setPersistenceAllowed(false);
      setChatEnabled(false);
    }
    applyConsentUI();
  }

  function openPolicyModal() {
    if (!policyModal || !policyOverlay) return;
    policyModal.hidden = false;
    policyOverlay.classList.add("open");
    policyOverlay.setAttribute("aria-hidden", "false");
  }

  function closePolicyModal() {
    if (!policyModal || !policyOverlay) return;
    policyModal.hidden = true;
    policyOverlay.classList.remove("open");
    policyOverlay.setAttribute("aria-hidden", "true");
  }

  function acceptPrivacy() {
    handleConsent("accepted");
    closePolicyModal();
  }

  function denyPrivacy() {
    handleConsent("denied");
    closePolicyModal();
  }

  // === THEME + LANGUAGE ===
  consentState = readConsent();
  if (consentState === "accepted") prefsApi?.setPersistenceAllowed(true);
  if (consentState === "denied") prefsApi?.setPersistenceAllowed(false);

  currentLang = prefsApi?.getLang?.() || currentLang;
  currentTheme = prefsApi?.getTheme?.() || currentTheme;
  setChatEnabled(consentState !== "denied");
  applyConsentUI();

  function setLanguage(lang) {
    const toES = (lang === "es");
    currentLang = toES ? "es" : "en";
    document.documentElement.lang = currentLang;

    if (langCtrl) {
      langCtrl.textContent = toES ? "ES" : "EN";
      langCtrl.setAttribute("aria-pressed", toES ? "true" : "false");
      langCtrl.classList.toggle("active", toES);
    }

    transNodes.forEach((node) => { node.textContent = toES ? node.dataset.es : node.dataset.en; });
    phNodes.forEach((node) => { node.placeholder = toES ? node.dataset.esPh : node.dataset.enPh; });
    ariaNodes.forEach((node) => { node.setAttribute("aria-label", toES ? node.dataset.esLabel : node.dataset.enLabel); });

    if (recognition) recognition.lang = toES ? "es-ES" : "en-US";

    savePrefs({ lang: currentLang, theme: currentTheme });
    setVoiceStatus("", "");
    setNet(navigator.onLine, "Ready", "Listo");
  }

  function setTheme(mode) {
    currentTheme = (mode === "dark") ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", currentTheme);

    if (themeCtrl) {
      themeCtrl.textContent = (currentTheme === "dark") ? "Light" : "Dark";
      themeCtrl.setAttribute("aria-pressed", currentTheme === "dark" ? "true" : "false");
    }

    document.documentElement.classList.toggle("dark-cycle", currentTheme === "dark");
    document.body?.classList.toggle("dark-cycle", currentTheme === "dark");

    savePrefs({ lang: currentLang, theme: currentTheme });
  }

  // === SAFETY HELPERS ===
  function normalizeUserText(s) {
    let out = String(s || "");
    out = out.replace(/[\u0000-\u001F\u007F]/g, " ");
    out = out.replace(/\s+/g, " ").trim();
    if (out.length > MAX_INPUT_CHARS) out = out.slice(0, MAX_INPUT_CHARS);
    return out;
  }

  function looksSuspicious(s) {
    const t = String(s || "").toLowerCase();
    const bad = [
      "<script", "</script", "javascript:",
      "<img", "onerror", "onload",
      "<iframe", "<object", "<embed",
      "<svg", "<link", "<meta", "<style",
      "document.cookie",
      "onmouseover", "onmouseenter",
      "<form", "<input", "<textarea"
    ];
    return bad.some((p) => t.includes(p));
  }

  function isFullyAuthorized() {
    const o = window.location.origin;
    const p = window.location.pathname || "/";
    return AUTH_RULES.some((r) =>
      (o === r.origin) && r.pathPrefixes.some((pref) => p.startsWith(pref))
    );
  }

  // === TELEMETRY (light sampling) ===
  const telemetrySampleRate = 0.25;
  function sendTelemetry(eventType, detail = {}) {
    if (Math.random() > telemetrySampleRate) return;

    try {
      fetch(TELEMETRY_URL, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: String(eventType || ""),
          lang: currentLang,
          ts: Date.now(),
          detail: detail && typeof detail === "object" ? detail : {}
        })
      }).catch(() => {});
    } catch {}
  }

  // === VOICE (Web Speech API) ===
  const synth = ("speechSynthesis" in window) ? window.speechSynthesis : null;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = Recognition ? new Recognition() : null;

  let speechEnabled = false;
  let listening = false;

  function cleanForSpeech(s) {
    let out = String(s || "");
    out = out.replace(/`{3}[\s\S]*?`{3}/g, " ");
    out = out.replace(/`([^`]+)`/g, "$1");
    out = out.replace(/[*_~]+/g, "");
    out = out.replace(/^-\s+/gm, "");
    out = out.replace(/\s+/g, " ").trim();
    return out;
  }

  function getVoiceForLang(langCode) {
    if (!synth) return null;
    const voices = synth.getVoices();
    const want = (langCode === "es") ? ["es-", "es_"] : ["en-", "en_"];
    const preferred = voices
      .filter(v => want.some(p => (v.lang || "").toLowerCase().startsWith(p)))
      .sort((a,b)=>((b.localService?2:0)+(/google|microsoft|natural/i.test(b.name)?1:0))-((a.localService?2:0)+(/google|microsoft|natural/i.test(a.name)?1:0)));
    return preferred[0] || null;
  }

  function speak(text, langOverride) {
    if (!synth || !speechEnabled) return;

    const clean = cleanForSpeech(normalizeUserText(text));
    if (!clean) return;

    const langForReply = (langOverride === "es") ? "es" : (langOverride === "en" ? "en" : currentLang);

    try { synth.cancel(); } catch {}

    const u = new SpeechSynthesisUtterance(clean);
    u.lang = (langForReply === "es") ? "es-ES" : "en-US";
    const v = getVoiceForLang(langForReply);
    if (v) u.voice = v;

    try { synth.speak(u); } catch {}
  }

  function updateSpeechToggleUI() {
    if (!speechToggle) return;
    speechToggle.classList.toggle("active", speechEnabled);
    speechToggle.setAttribute("aria-pressed", speechEnabled ? "true" : "false");
  }

  function updateListenUI() {
    if (!listenCtrl) return;
    listenCtrl.classList.toggle("active", listening);
    listenCtrl.setAttribute("aria-pressed", listening ? "true" : "false");
  }

  function setVoiceStatus(enText, esText) {
    if (!voiceStatus) return;
    voiceStatus.textContent = (currentLang === "es") ? (esText || enText) : enText;
  }

  if (recognition) {
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = (currentLang === "es") ? "es-ES" : "en-US";

    recognition.onstart = () => {
      listening = true;
      updateListenUI();
      setVoiceStatus("Listening…", "Escuchando…");
    };

    recognition.onresult = (e) => {
      const t = e.results?.[0]?.[0]?.transcript || "";
      const cleaned = normalizeUserText(t);
      if (!cleaned) return;

      input.value = cleaned;
      input.focus();

      // Fast UX: auto-send if authorized
      if (isFullyAuthorized()) form.requestSubmit();
      else addBotLine(currentLang === "es"
        ? "Este asistente solo acepta mensajes desde sitios autorizados."
        : "This assistant only accepts messages from authorized sites."
      );
    };

    recognition.onerror = () => {
      listening = false;
      updateListenUI();
      setVoiceStatus("Voice error.", "Error de voz.");
    };

    recognition.onend = () => {
      listening = false;
      updateListenUI();
      setVoiceStatus("", "");
    };
  }

  function startListening() {
    if (!recognition) return;
    recognition.lang = (currentLang === "es") ? "es-ES" : "en-US";
    try { recognition.start(); } catch {}
  }

  // === TRANSCRIPT ===
  const transcript = [];
  function recordTranscript(role, text) {
    if (!text) return;
    transcript.push({ role, text, ts: Date.now() });
    renderTranscriptList();
  }

  function copyTranscript() {
    if (!transcriptList) return;
    const txt = transcript
      .map(item => `${item.role === "user" ? "End User" : "Chatbot"}: ${item.text}`)
      .join("\n\n");

    // Prefer clipboard API; fallback to textarea copy
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(txt).catch(() => {});
      return;
    }

    try {
      const ta = document.createElement("textarea");
      ta.value = txt;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {}
  }

  function clearTranscriptOnly() {
    transcript.length = 0;
    renderTranscriptList();
  }

  function renderTranscriptList() {
    if (!transcriptList) return;
    transcriptList.innerHTML = "";
    if (!transcript.length) {
      const empty = document.createElement("div");
      empty.className = "transcript-empty";
      empty.dataset.en = "No transcript yet. Start chatting to see history here.";
      empty.dataset.es = "Aún no hay transcripción. Chatea para ver el historial aquí.";
      empty.textContent = (currentLang === "es") ? empty.dataset.es : empty.dataset.en;
      transcriptList.appendChild(empty);
      return;
    }
    transcript.forEach((item) => {
      const wrap = document.createElement("div");
      wrap.className = "transcript-item";

      const role = document.createElement("div");
      role.className = "transcript-role";
      role.textContent = item.role === "user" ? "End User" : "Chatbot";

      const text = document.createElement("div");
      text.textContent = item.text || "";

      wrap.appendChild(role);
      wrap.appendChild(text);
      transcriptList.appendChild(wrap);
    });
  }

  function openTranscriptDrawer() {
    if (!transcriptDrawer || !transcriptOverlay) return;
    transcriptDrawer.hidden = false;
    transcriptDrawer.classList.add("open");
    transcriptOverlay.classList.add("open");
    transcriptOverlay.setAttribute("aria-hidden", "false");
    renderTranscriptList();
    transcriptClose?.focus?.();
  }

  function closeTranscriptDrawer() {
    if (!transcriptDrawer || !transcriptOverlay) return;
    transcriptDrawer.classList.remove("open");
    transcriptOverlay.classList.remove("open");
    transcriptOverlay.setAttribute("aria-hidden", "true");
    window.setTimeout(() => { transcriptDrawer.hidden = true; }, 220);
  }

  // === CHAT UI ===
  function setNet(ok, textEn, textEs) {
    if (!netDot || !netText) return;
    netDot.style.background = ok ? "rgba(44,242,162,.9)" : "rgba(255,59,143,.9)";
    netText.textContent = (currentLang === "es") ? (textEs || textEn) : textEn;
  }

  function addLine(text, who) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${who}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    wrap.appendChild(bubble);
    wrap.appendChild(meta);

    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;

    recordTranscript(who, text);
    return bubble;
  }

  function addUserLine(text) { return addLine(text, "user"); }
  function addBotLine(text) { return addLine(text, "bot"); }

  function clearChat() {
    log.textContent = "";
    transcript.length = 0;
    renderTranscriptList();
    log.dataset.welcomed = "false";
    ensureWelcome();
  }

  function ensureWelcome() {
    if (log.dataset.welcomed === "true") return;
    const welcome = (currentLang === "es")
      ? "Chattia para OPS está listo. Escribe o usa el micrófono para chatear."
      : "Chattia for OPS is ready. Type or use the mic to chat.";
    addBotLine(welcome);
    log.dataset.welcomed = "true";
  }

  function showTncDetails() {
    if (!tncButton) return;
    const msg = (currentLang === "es")
      ? (tncButton.dataset.esMsg || tncButton.dataset.enMsg || "")
      : (tncButton.dataset.enMsg || tncButton.dataset.esMsg || "");
    if (!msg) return;
    addBotLine(msg);
    speak(msg, currentLang);
  }

  document.addEventListener("ops:language-change", (event) => {
    currentLang = (event?.detail?.lang === "es") ? "es" : "en";
    if (recognition) recognition.lang = (currentLang === "es") ? "es-ES" : "en-US";
    setVoiceStatus("", "");
    setNet(navigator.onLine, "Ready", "Listo");
    renderTranscriptList();
  });

  document.addEventListener("ops:theme-change", (event) => {
    currentTheme = (event?.detail?.theme === "dark") ? "dark" : "light";
  });

  // === EVENTS ===
  if (consentAccept) consentAccept.onclick = () => handleConsent("accepted");
  if (consentDeny) consentDeny.onclick = () => handleConsent("denied");

  if (speechToggle) {
    speechToggle.addEventListener("click", () => {
      if (!synth) {
        addBotLine(currentLang === "es"
          ? "La síntesis de voz no está disponible en este navegador."
          : "Speech synthesis is not available in this browser."
        );
        return;
      }
      speechEnabled = !speechEnabled;
      updateSpeechToggleUI();
    });
  }

  if (listenCtrl) {
    listenCtrl.addEventListener("click", () => {
      if (!recognition) {
        addBotLine(currentLang === "es"
          ? "Entrada por voz no disponible en este navegador."
          : "Voice input is not available in this browser."
        );
        return;
      }
      if (listening) { try { recognition.stop(); } catch {} return; }
      startListening();
    });
  }

  if (clearChatBtn) clearChatBtn.onclick = clearChat;

  if (transcriptCopy) transcriptCopy.onclick = copyTranscript;
  if (clearTranscriptBtn) clearTranscriptBtn.onclick = clearTranscriptOnly;
  if (transcriptTrigger) transcriptTrigger.onclick = openTranscriptDrawer;
  if (transcriptClose) transcriptClose.onclick = closeTranscriptDrawer;
  if (transcriptOverlay) transcriptOverlay.onclick = closeTranscriptDrawer;
  if (tncButton) tncButton.onclick = showTncDetails;

  if (privacyTrigger) privacyTrigger.onclick = openPolicyModal;
  if (termsTrigger) termsTrigger.onclick = openPolicyModal;
  if (policyOverlay) policyOverlay.onclick = closePolicyModal;
  if (privacyAcceptBtn) privacyAcceptBtn.onclick = acceptPrivacy;
  if (privacyDenyBtn) privacyDenyBtn.onclick = denyPrivacy;
  if (policyCloseBtn) policyCloseBtn.onclick = closePolicyModal;

  // Close modals on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeTranscriptDrawer();
      closePolicyModal();
    }
  });

  // Stop listening if tab is hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && listening && recognition) {
      try { recognition.stop(); } catch {}
    }
  });

  // === SEND ===
  let inFlight = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (inFlight) return;

    const msg = normalizeUserText(input.value);
    if (!msg) return;

    // Client allowlist (extra)
    if (!isFullyAuthorized()) {
      addBotLine(currentLang === "es"
        ? "Este asistente solo acepta mensajes desde sitios autorizados."
        : "This assistant only accepts messages from authorized sites."
      );
      sendTelemetry("auth_block", { reason: "origin_or_path" });
      return;
    }

    // Local block for obvious injection attempts
    if (looksSuspicious(msg)) {
      const warn = (currentLang === "es")
        ? "Mensaje bloqueado por seguridad. Escribe sin etiquetas o scripts."
        : "Message blocked for security. Please write without tags or scripts.";
      addBotLine(warn);
      speak(warn, currentLang);
      sendTelemetry("client_suspicious");
      return;
    }

    // Honeypots (bots fill these)
    const hp1 = normalizeUserText(hpEmail?.value || "");
    const hp2 = normalizeUserText(hpWebsite?.value || "");

    // UI commit
    addUserLine(msg);
    input.value = "";
    input.focus();

    setNet(navigator.onLine, "Sending…", "Enviando…");
    if (sendBtn) sendBtn.disabled = true;
    inFlight = true;

    const botBubble = addBotLine("…");

    let res = null;

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);

      res = await fetch(API_URL, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          "Content-Type": "application/json",
          "X-Ops-Asset-Id": ASSET_ID
        },
        body: JSON.stringify({
          message: msg,
          lang: currentLang,
          v: 2,
          hp_email: hp1,
          hp_website: hp2
        }),
        signal: ctrl.signal
      });

      clearTimeout(timeout);

      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch {}

      if (!res.ok) {
        const fallback = (currentLang === "es") ? "Error del gateway de OPS." : "OPS gateway error.";
        const errMsg = (data && (data.error || data.public_error))
          ? String(data.error || data.public_error)
          : (text || fallback);

        botBubble.textContent = errMsg;
        speak(errMsg, currentLang);
        sendTelemetry("api_error", { status: res.status });

        setNet(false, "Error", "Error");
        return;
      }

      if (!data || typeof data !== "object") {
        const fallback = (currentLang === "es")
          ? "Respuesta no válida del gateway."
          : "Invalid response from gateway.";
        botBubble.textContent = fallback;
        speak(fallback, currentLang);
        sendTelemetry("api_error", { type: "invalid_json" });
        setNet(false, "Error", "Error");
        return;
      }

      const replyLang = (data.lang === "es") ? "es" : currentLang;
      const reply = (typeof data.reply === "string" && data.reply.trim())
        ? data.reply.trim()
        : (currentLang === "es" ? "Sin respuesta." : "No reply.");

      botBubble.textContent = reply;
      speak(reply, replyLang);

      setNet(true, "Ready", "Listo");
    } catch (err) {
      const fallback = (currentLang === "es")
        ? "No puedo conectar con el asistente OPS."
        : "Can’t reach OPS assistant.";
      botBubble.textContent = fallback;
      speak(fallback, currentLang);
      sendTelemetry("network_error", { online: !!navigator.onLine });
      setNet(false, "Offline", "Sin conexión");
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      inFlight = false;
    }
  });

  // === INIT ===
  if (!document.documentElement.getAttribute("data-theme")) {
    document.documentElement.setAttribute("data-theme", currentTheme);
  }

  if (synth) synth.onvoiceschanged = () => getVoiceForLang(currentLang);
  if (recognition) recognition.lang = (currentLang === "es") ? "es-ES" : "en-US";

  updateSpeechToggleUI();
  updateListenUI();

  applyConsentUI();
  ensureWelcome();

  // Basic online/offline indicator
  const updateOnline = () => setNet(navigator.onLine, "Ready", "Listo");
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", () => setNet(false, "Offline", "Sin conexión"));
  updateOnline();
})();
