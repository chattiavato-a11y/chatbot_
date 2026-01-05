/* assets/chattia-ui.js */
/* OPS UI — v3 (repo-coordinated with ops-gateway v2 + Turnstile) */
(() => {
  "use strict";

  const qs  = (s) => document.querySelector(s);
  const qsa = (s) => [...document.querySelectorAll(s)];

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

  // Turnstile tokens are typically short-lived and single-use.
  // Always refresh after a submit attempt to avoid “already consumed” failures.
  const TURNSTILE_MAX_AGE_MS = 110_000;

  // === ELEMENTS ===
  const log = qs("#chat-log");
  const form = qs("#chatbot-input-row");
  const input = qs("#chatbot-input");
  const sendBtn = qs("#chatbot-send");

  const langCtrl = qs("#langCtrl");
  const themeCtrl = qs("#themeCtrl");
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

  const turnstileWidget = qs("#turnstile-widget");
  const turnstileContainer = qs("#turnstile-container");

  const clearChatBtn = qs("#clearChat");
  const transcriptAccordion = qs("#transcriptAccordion");
  const transcriptList = qs("#transcriptInlineList");
  const transcriptCopy = qs("#transcript-copy-inline");
  const clearTranscriptBtn = qs("#clearTranscriptInline");

  const tncButton = qs("#tnc-button");

  const privacyTrigger = qs("#privacyTrigger");
  const termsTrigger = qs("#termsTrigger");
  const privacyOverlay = qs("#privacyOverlay");
  const privacyModal = qs("#privacyModal");
  const termsOverlay = qs("#termsOverlay");
  const termsModal = qs("#termsModal");
  const privacyAcceptBtn = qs("#btnAcceptPrivacy");
  const privacyDenyBtn = qs("#btnDenyPrivacy");
  const termsCloseBtn = qs("#btnCloseTerms");

  // === I18N NODES ===
  const transNodes = qsa("[data-en]");
  const phNodes = qsa("[data-en-ph]");
  const ariaNodes = qsa("[data-en-label]");

  // === CONSENT + PREFS ===
  const STORAGE_KEYS = {
    prefs: "ops-chat-preferences",
    consent: "ops-chat-consent"
  };

  let consentState = "pending"; // pending | accepted | denied
  const memoryPrefs = {}; // used when denied/pending

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

  function loadPrefs() {
    if (consentState !== "accepted") return memoryPrefs;
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.prefs);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function savePrefs(next) {
    const payload = next || {};
    if (consentState === "accepted") {
      try { localStorage.setItem(STORAGE_KEYS.prefs, JSON.stringify(payload)); } catch {}
    } else {
      Object.assign(memoryPrefs, payload);
    }
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
      savePrefs({ lang: currentLang, theme: currentTheme });
      setChatEnabled(true);
    } else if (next === "denied") {
      try { localStorage.removeItem(STORAGE_KEYS.prefs); } catch {}
      setChatEnabled(false);
    }
    applyConsentUI();
  }

  function openPrivacyModal() {
    if (!privacyModal || !privacyOverlay) return;
    privacyModal.hidden = false;
    privacyOverlay.classList.add("open");
    privacyOverlay.setAttribute("aria-hidden", "false");
  }

  function closePrivacyModal() {
    if (!privacyModal || !privacyOverlay) return;
    privacyModal.hidden = true;
    privacyOverlay.classList.remove("open");
    privacyOverlay.setAttribute("aria-hidden", "true");
  }

  function acceptPrivacy() {
    handleConsent("accepted");
    closePrivacyModal();
  }

  function denyPrivacy() {
    handleConsent("denied");
    closePrivacyModal();
  }

  function openTermsModal() {
    if (!termsModal || !termsOverlay) return;
    termsModal.hidden = false;
    termsOverlay.classList.add("open");
    termsOverlay.setAttribute("aria-hidden", "false");
  }

  function closeTermsModal() {
    if (!termsModal || !termsOverlay) return;
    termsModal.hidden = true;
    termsOverlay.classList.remove("open");
    termsOverlay.setAttribute("aria-hidden", "true");
  }

  // === THEME + LANGUAGE ===
  consentState = readConsent();
  const prefs = loadPrefs();

  const initialDocLang = (document.documentElement.lang === "es") ? "es" : "en";
  let currentLang = (prefs.lang === "es") ? "es" : initialDocLang;

  function detectInitialTheme() {
    if (prefs.theme === "dark" || prefs.theme === "light") return prefs.theme;

    const attrTheme = document.documentElement.getAttribute("data-theme");
    if (attrTheme === "dark" || attrTheme === "light") return attrTheme;

    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }

    return "light";
  }

  let currentTheme = detectInitialTheme();
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

  // === TURNSTILE ===
  let turnstileToken = "";
  let turnstileTokenTs = 0;
  let showedTurnstileDown = false;

  function markTurnstileCleared() {
    if (!turnstileContainer) return;
    turnstileContainer.classList.add("ts-cleared");
    turnstileContainer.setAttribute("aria-hidden", "true");
  }

  function showTurnstileAgain() {
    if (!turnstileContainer) return;
    turnstileContainer.classList.remove("ts-cleared");
    turnstileContainer.removeAttribute("aria-hidden");
  }

  // Global callbacks used by the Turnstile widget data-* attributes
  window.opsTurnstileCallback = (token) => {
    turnstileToken = (typeof token === "string") ? token : "";
    turnstileTokenTs = Date.now();
    if (turnstileToken) markTurnstileCleared();
  };
  window.opsTurnstileExpired = () => {
    turnstileToken = "";
    turnstileTokenTs = 0;
    showTurnstileAgain();
  };
  window.opsTurnstileErrored = () => {
    turnstileToken = "";
    turnstileTokenTs = 0;
    showTurnstileAgain();
  };

  function getTurnstileToken() {
    if (turnstileToken && (Date.now() - turnstileTokenTs) <= TURNSTILE_MAX_AGE_MS) return turnstileToken;

    // Try asking the Turnstile API directly (works when there is a single widget)
    if (window.turnstile && typeof window.turnstile.getResponse === "function") {
      try {
        const resp = window.turnstile.getResponse();
        if (resp) {
          turnstileToken = String(resp);
          turnstileTokenTs = Date.now();
          return turnstileToken;
        }
      } catch {}
      // Best-effort fallback (some builds accept an element reference)
      try {
        const resp = window.turnstile.getResponse(turnstileWidget);
        if (resp) {
          turnstileToken = String(resp);
          turnstileTokenTs = Date.now();
          return turnstileToken;
        }
      } catch {}
    }
    return "";
  }

  function resetTurnstile() {
    turnstileToken = "";
    turnstileTokenTs = 0;
    showTurnstileAgain();

    if (window.turnstile && typeof window.turnstile.reset === "function") {
      try { window.turnstile.reset(); } catch {}
    }
  }

  function turnstileUnavailableOnce() {
    if (showedTurnstileDown) return;
    showedTurnstileDown = true;
    sendTelemetry("turnstile_unavailable");
    addBotLine(currentLang === "es"
      ? "La verificación no está disponible ahora. Intenta de nuevo en unos segundos."
      : "Security verification is unavailable right now. Try again in a few seconds."
    );
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

  // === EVENTS ===
  if (consentAccept) consentAccept.onclick = () => handleConsent("accepted");
  if (consentDeny) consentDeny.onclick = () => handleConsent("denied");

  if (langCtrl) langCtrl.addEventListener("click", () => setLanguage(currentLang === "es" ? "en" : "es"));
  if (themeCtrl) themeCtrl.addEventListener("click", () => setTheme(currentTheme === "dark" ? "light" : "dark"));

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
      savePrefs({ lang: currentLang, theme: currentTheme }); // no voice stored (by design)
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
  if (tncButton) tncButton.onclick = showTncDetails;

  if (transcriptAccordion) {
    transcriptAccordion.addEventListener("toggle", () => {
      if (transcriptAccordion.open) renderTranscriptList();
    });
  }

  if (privacyTrigger) privacyTrigger.onclick = openPrivacyModal;
  if (termsTrigger) termsTrigger.onclick = openTermsModal;
  if (privacyOverlay) privacyOverlay.onclick = closePrivacyModal;
  if (termsOverlay) termsOverlay.onclick = closeTermsModal;
  if (privacyAcceptBtn) privacyAcceptBtn.onclick = acceptPrivacy;
  if (privacyDenyBtn) privacyDenyBtn.onclick = denyPrivacy;
  if (termsCloseBtn) termsCloseBtn.onclick = closeTermsModal;

  // Close modals on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePrivacyModal();
      closeTermsModal();
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

    // Turnstile token required
    const ts = getTurnstileToken();
    if (!ts) {
      if (!window.turnstile) turnstileUnavailableOnce();
      else {
        const warn = (currentLang === "es")
          ? "Completa la verificación de seguridad para continuar."
          : "Please complete the security check to continue.";
        addBotLine(warn);
        speak(warn, currentLang);
      }
      sendTelemetry("turnstile_missing");
      return;
    }

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
          turnstileToken: ts,
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

        // If Turnstile was rejected/consumed, reset to obtain a fresh token
        if (res.status === 403 && /turnstile/i.test(errMsg)) {
          resetTurnstile();
        }

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
      // Turnstile tokens are often single-use; refresh after any submit attempt.
      resetTurnstile();

      if (sendBtn) sendBtn.disabled = false;
      inFlight = false;
    }
  });

  // === INIT ===
  if (!document.documentElement.getAttribute("data-theme")) {
    document.documentElement.setAttribute("data-theme", currentTheme);
  }

  setLanguage(currentLang);
  setTheme(currentTheme);

  if (synth) synth.onvoiceschanged = () => getVoiceForLang(currentLang);

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
