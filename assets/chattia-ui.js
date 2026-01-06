/* assets/chattia-ui.js */
(() => {
  "use strict";

  const qs  = (s) => document.querySelector(s);

  const ASSET_ID = "CAFF600A21B457E5D909FD887AF48018B3CBFDDF6F9746E56238B23AF061F9E2";
  const GATEWAY_ORIGIN = "https://ops-gateway.grabem-holdem-nuts-right.workers.dev";
  const API_URL = `${GATEWAY_ORIGIN}/api/ops-online-chat`;
  const TELEMETRY_URL = `${GATEWAY_ORIGIN}/reports/telemetry`;

  const AUTH_RULES = [
    { origin: "https://chattiavato-a11y.github.io", pathPrefixes: ["/ops-online-support", "/ops-online-support/"] },
    { origin: "https://www.chattia.io", pathPrefixes: ["/"] },
    { origin: "https://chattia.io", pathPrefixes: ["/"] }
  ];

  const MAX_INPUT_CHARS = 256;

  const log = qs("#chat-log");
  const form = qs("#chatbot-input-row");
  const input = qs("#chatbot-input");
  const sendBtn = qs("#chatbot-send");

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

  const privacyTrigger = qs("#privacyTrigger");
  const termsTrigger = qs("#termsTrigger");
  const policyOverlay = qs("#policyOverlay");
  const policyModal = qs("#policyModal");
  const btnClosePolicy = qs("#btnClosePolicy");
  const btnAcceptPrivacy = qs("#btnAcceptPrivacy");
  const btnDenyPrivacy = qs("#btnDenyPrivacy");

  const prefsApi = window.OPS_PREFS;

  const CONSENT_KEY = "ops-chat-consent";
  let currentLang = prefsApi?.getLang?.() || (document.documentElement.lang === "es" ? "es" : "en");
  let currentTheme = prefsApi?.getTheme?.() || (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  let consentState = "pending";

  const transcript = [];

  const clamp = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
  const safeText = (s) => clamp(String(s || ""), MAX_INPUT_CHARS);

  function setNet(ok, enText, esText) {
    if (!netDot || !netText) return;
    netDot.style.background = ok ? "rgba(44,242,162,.9)" : "rgba(255,59,143,.9)";
    netText.textContent = (currentLang === "es") ? (esText || enText || "") : (enText || esText || "");
  }

  function normalizeUserText(s) {
    return safeText(s).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  }

  function looksSuspicious(s) {
    const x = String(s || "").toLowerCase();
    return [
      "<script", "</script", "javascript:", "<img", "onerror", "onload", "<iframe", "<object", "<embed",
      "<svg", "<link", "<meta", "<style", "document.cookie", "onmouseover", "onmouseenter", "<form", "<input", "<textarea"
    ].some((p) => x.includes(p));
  }

  function isFullyAuthorized() {
    try {
      const origin = window.location.origin;
      const path = window.location.pathname || "/";
      return AUTH_RULES.some((r) => r.origin === origin && (r.pathPrefixes || ["/"]).some((pref) => path.startsWith(pref)));
    } catch {
      return false;
    }
  }

  function setChatEnabled(enabled) {
    if (input) input.disabled = !enabled;
    if (sendBtn) sendBtn.disabled = !enabled;
    if (listenCtrl) listenCtrl.disabled = !enabled;
    if (consentNote) consentNote.hidden = enabled;
  }

  function readConsent() {
    try { return localStorage.getItem(CONSENT_KEY) || "pending"; }
    catch { return "pending"; }
  }

  function persistConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch {}
  }

  function applyConsentUI() {
    const hide = (consentState === "accepted" || consentState === "denied");
    if (consentBanner) {
      consentBanner.style.display = hide ? "none" : "flex";
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

  let releasePolicyTrap = null;
  let releaseTranscriptTrap = null;
  let lastFocusPolicy = null;
  let lastFocusTranscript = null;

  function trapFocus(container) {
    if (!container) return () => {};
    const getFocusable = () => {
      const nodes = container.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      return [...nodes].filter(el => !el.hasAttribute("hidden") && el.offsetParent !== null);
    };

    function onKeyDown(e) {
      if (e.key !== "Tab") return;
      const focusables = getFocusable();
      if (!focusables.length) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || document.activeElement === container) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }

  function openPolicyModal(anchorId) {
    if (!policyModal || !policyOverlay) return;

    lastFocusPolicy = document.activeElement;

    policyModal.hidden = false;
    policyOverlay.classList.add("open");
    policyOverlay.setAttribute("aria-hidden", "false");

    try { releasePolicyTrap?.(); } catch {}
    releasePolicyTrap = trapFocus(policyModal);

    if (anchorId) {
      const target = policyModal.querySelector(`#${anchorId}`);
      target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }

    (btnAcceptPrivacy || btnClosePolicy || policyModal.querySelector("button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])"))?.focus?.();
  }

  function closePolicyModal() {
    if (!policyModal || !policyOverlay) return;

    policyModal.hidden = true;
    policyOverlay.classList.remove("open");
    policyOverlay.setAttribute("aria-hidden", "true");

    try { releasePolicyTrap?.(); } catch {}
    releasePolicyTrap = null;

    try { lastFocusPolicy?.focus?.(); } catch {}
    lastFocusPolicy = null;
  }

  function acceptPrivacy() { handleConsent("accepted"); closePolicyModal(); }
  function denyPrivacy() { handleConsent("denied"); closePolicyModal(); }

  function renderTranscriptList() {
    if (!transcriptList) return;
    transcriptList.textContent = "";

    if (!transcript.length) {
      const empty = document.createElement("div");
      empty.className = "transcript-empty";
      empty.textContent = (currentLang === "es") ? "No hay transcripción todavía." : "No transcript yet.";
      transcriptList.appendChild(empty);
      return;
    }

    transcript.forEach((item) => {
      const row = document.createElement("div");
      row.className = "transcript-row";

      const who = document.createElement("div");
      who.className = "transcript-who";
      who.textContent = item.role === "user"
        ? (currentLang === "es" ? "Usuario" : "End User")
        : (currentLang === "es" ? "Chatbot" : "Chatbot");

      const txt = document.createElement("div");
      txt.className = "transcript-text";
      txt.textContent = item.text;

      row.appendChild(who);
      row.appendChild(txt);
      transcriptList.appendChild(row);
    });
  }

  function recordTranscript(role, text) {
    if (!text) return;
    transcript.push({ role, text, ts: Date.now() });
    renderTranscriptList();
  }

  function copyTranscriptNow() {
    const txt = transcript.map((item) => {
      const roleLabel = item.role === "user"
        ? (currentLang === "es" ? "Usuario" : "End User")
        : (currentLang === "es" ? "Chatbot" : "Chatbot");
      return `${roleLabel}: ${item.text}`;
    }).join("\n\n");
    if (!txt) return;

    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(txt).catch(() => {});
      return;
    }

    try {
      const ta = document.createElement("textarea");
      ta.value = txt;
      ta.setAttribute("readonly", "true");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {}
  }

  function openTranscriptDrawer() {
    if (!transcriptDrawer || !transcriptOverlay) return;

    lastFocusTranscript = document.activeElement;

    transcriptDrawer.hidden = false;
    transcriptDrawer.classList.add("open");
    transcriptOverlay.classList.add("open");
    transcriptOverlay.setAttribute("aria-hidden", "false");

    renderTranscriptList();

    try { releaseTranscriptTrap?.(); } catch {}
    releaseTranscriptTrap = trapFocus(transcriptDrawer);

    transcriptClose?.focus?.();
  }

  function closeTranscriptDrawer() {
    if (!transcriptDrawer || !transcriptOverlay) return;

    transcriptDrawer.classList.remove("open");
    transcriptOverlay.classList.remove("open");
    transcriptOverlay.setAttribute("aria-hidden", "true");

    try { releaseTranscriptTrap?.(); } catch {}
    releaseTranscriptTrap = null;

    try { lastFocusTranscript?.focus?.(); } catch {}
    lastFocusTranscript = null;

    window.setTimeout(() => { transcriptDrawer.hidden = true; }, 220);
  }

  function addLine(text, who, opts = {}) {
    const o = (opts && typeof opts === "object") ? opts : {};
    const record = (o.record !== false);
    const typing = (o.typing === true);

    const wrap = document.createElement("div");
    wrap.className = `msg ${who}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (typing) {
      const t = document.createElement("span");
      t.className = "typing";
      for (let i = 0; i < 3; i++) {
        const d = document.createElement("span");
        d.className = "typing-dot";
        t.appendChild(d);
      }
      bubble.appendChild(t);
    } else {
      bubble.textContent = text;
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    wrap.appendChild(bubble);
    wrap.appendChild(meta);

    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;

    if (record && !typing) recordTranscript(who, text);
    return bubble;
  }

  function addUserLine(text) { return addLine(text, "user"); }
  function addBotLine(text, opts) { return addLine(text, "bot", opts); }

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

  const telemetrySampleRate = 0.25;

  function sendTelemetry(eventType, detail = {}) {
    if (consentState !== "accepted") return;
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
          detail: (detail && typeof detail === "object") ? detail : {}
        })
      }).catch(() => {});
    } catch {}
  }

  const synth = ("speechSynthesis" in window) ? window.speechSynthesis : null;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = Recognition ? new Recognition() : null;

  let speechEnabled = false;
  const VOICE_SESSION_MS = 45000;
  let voiceSessionTimer = null;
  let listening = false;
  let lastVoiceTranscript = "";
  let requestedRepeat = false;
  let inFlight = false;

  function setVoiceStatus(en, es) {
    if (!voiceStatus) return;
    voiceStatus.textContent = (currentLang === "es") ? (es || en || "") : (en || es || "");
  }

  function updateListenUI() {
    if (!listenCtrl) return;
    const active = listening || speechEnabled;
    listenCtrl.classList.toggle("active", active);
    listenCtrl.setAttribute("aria-pressed", active ? "true" : "false");
  }

  function enableVoiceSession() {
    if (!synth) return false;
    speechEnabled = true;
    clearTimeout(voiceSessionTimer);
    voiceSessionTimer = setTimeout(() => {
      speechEnabled = false;
      try { synth.cancel(); } catch {}
      updateListenUI();
      setVoiceStatus("", "");
    }, VOICE_SESSION_MS);
    return true;
  }

  function speak(text, lang) {
    if (!synth || !speechEnabled) return;

    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return;

    try {
      synth.cancel();
      const toSpeak = clean.replace(/\bOPS\b/gi, "Ops");
      const u = new SpeechSynthesisUtterance(toSpeak);
      u.lang = (lang === "es") ? "es-ES" : "en-US";
      synth.speak(u);
      enableVoiceSession();
    } catch {}
  }

  function requestSubmitIfInput() {
    if (!form || !input) return false;
    const msg = normalizeUserText(input.value);
    if (!msg) return false;
    input.value = msg;
    try {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return true;
    } catch {
      try { form.submit(); return true; } catch { return false; }
    }
  }

  function promptRepeat() {
    if (requestedRepeat) return;
    requestedRepeat = true;
    const apology = (currentLang === "es")
      ? "Disculpame, ¿podrías repetir eso? No te escuché."
      : "My apologies, would you please repeat that? I'm sorry, I didn't get that.";
    addBotLine(apology);
    speak(apology, currentLang);
  }

  function startListening() {
    if (!recognition || listening) return;
    if (consentState === "denied") return;

    try {
      recognition.lang = (currentLang === "es") ? "es-ES" : "en-US";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      lastVoiceTranscript = "";
      requestedRepeat = false;

      listening = true;
      setVoiceStatus("Listening…", "Escuchando…");
      updateListenUI();

      recognition.onresult = (e) => {
        const t = e?.results?.[0]?.[0]?.transcript;
        const normalized = normalizeUserText(t);
        if (normalized && input) {
          lastVoiceTranscript = normalized;
          input.value = normalized;
        }
      };

      recognition.onerror = () => {
        listening = false;
        setVoiceStatus("", "");
        updateListenUI();
        if (!lastVoiceTranscript) promptRepeat();
      };

      recognition.onend = () => {
        listening = false;
        setVoiceStatus("", "");
        updateListenUI();
        if (lastVoiceTranscript) {
          requestSubmitIfInput();
        } else if (!requestedRepeat) {
          promptRepeat();
        }
      };

      recognition.start();
    } catch {
      listening = false;
      setVoiceStatus("", "");
      updateListenUI();
    }
  }

  function stopListening() {
    if (!recognition || !listening) return;
    try { recognition.stop(); } catch {}
    listening = false;
    setVoiceStatus("", "");
    updateListenUI();
  }

  consentState = readConsent();
  if (consentState === "accepted") prefsApi?.setPersistenceAllowed(true);
  if (consentState === "denied") prefsApi?.setPersistenceAllowed(false);

  currentLang = prefsApi?.getLang?.() || currentLang;
  currentTheme = prefsApi?.getTheme?.() || currentTheme;

  setChatEnabled(consentState !== "denied");
  applyConsentUI();

  document.addEventListener("ops:lang-change", (e) => {
    const l = e?.detail?.lang;
    currentLang = (l === "es") ? "es" : "en";
    ensureWelcome();
    renderTranscriptList();
    setNet(true, "Ready", "Listo");
  });

  document.addEventListener("ops:theme-change", (e) => {
    const t = e?.detail?.theme;
    currentTheme = (t === "dark") ? "dark" : "light";
  });

  if (clearChatBtn) clearChatBtn.onclick = clearChat;

  if (transcriptTrigger) transcriptTrigger.onclick = openTranscriptDrawer;
  if (transcriptOverlay) transcriptOverlay.onclick = closeTranscriptDrawer;
  if (transcriptClose) transcriptClose.onclick = closeTranscriptDrawer;
  if (transcriptCopy) transcriptCopy.onclick = copyTranscriptNow;
  if (clearTranscriptBtn) clearTranscriptBtn.onclick = () => { transcript.length = 0; renderTranscriptList(); };

  if (privacyTrigger) privacyTrigger.onclick = () => openPolicyModal("policy-privacy");
  if (termsTrigger) termsTrigger.onclick = () => openPolicyModal("policy-terms");
  if (policyOverlay) policyOverlay.onclick = closePolicyModal;
  if (btnClosePolicy) btnClosePolicy.onclick = closePolicyModal;
  if (btnAcceptPrivacy) btnAcceptPrivacy.onclick = acceptPrivacy;
  if (btnDenyPrivacy) btnDenyPrivacy.onclick = denyPrivacy;

  if (consentAccept) consentAccept.onclick = () => handleConsent("accepted");
  if (consentDeny) consentDeny.onclick = () => handleConsent("denied");

  if (listenCtrl) listenCtrl.onclick = () => {
    if (!recognition) {
      setVoiceStatus(
        "Voice input not available in this browser.",
        "La entrada de voz no está disponible en este navegador."
      );
      return;
    }

    enableVoiceSession();
    updateListenUI();

    if (listening) {
      try { recognition.stop(); } catch {}
      return;
    }

    startListening();
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeTranscriptDrawer();
      closePolicyModal();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && listening && recognition) {
      try { recognition.stop(); } catch {}
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (inFlight) return;

    const msg = normalizeUserText(input.value);
    if (!msg) return;

    if (!isFullyAuthorized()) {
      const m = (currentLang === "es")
        ? "Este asistente solo acepta mensajes desde sitios autorizados."
        : "This assistant only accepts messages from authorized sites.";
      addBotLine(m);
      sendTelemetry("auth_block", { reason: "origin_or_path" });
      return;
    }

    if (looksSuspicious(msg)) {
      const warn = (currentLang === "es")
        ? "Mensaje bloqueado por seguridad. Escribe sin etiquetas o scripts."
        : "Message blocked for security. Please write without tags or scripts.";
      addBotLine(warn);
      speak(warn, currentLang);
      sendTelemetry("client_suspicious");
      return;
    }

    const hp1 = normalizeUserText(hpEmail?.value || "");
    const hp2 = normalizeUserText(hpWebsite?.value || "");

    addUserLine(msg);
    input.value = "";
    input.focus();

    setNet(navigator.onLine, "Sending…", "Enviando…");
    if (sendBtn) sendBtn.disabled = true;
    inFlight = true;

    const botBubble = addBotLine("", { record: false, typing: true });

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);

      const res = await fetch(API_URL, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json", "X-Ops-Asset-Id": ASSET_ID },
        body: JSON.stringify({ message: msg, lang: currentLang, hp_email: hp1, hp_website: hp2 }),
        signal: ctrl.signal
      });

      clearTimeout(timeout);

      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch {}

      if (!res.ok) {
        const fallback = (currentLang === "es") ? "Error del gateway de OPS." : "OPS gateway error.";
        const errMsg = (data && (data.error || data.public_error)) ? String(data.error || data.public_error) : (raw || fallback);
        botBubble.textContent = errMsg;
        recordTranscript("bot", errMsg);
        speak(errMsg, currentLang);
        sendTelemetry("api_error", { status: res.status });
        setNet(false, "Error", "Error");
        return;
      }

      const replyLang = (data && data.lang === "es") ? "es" : currentLang;
      const reply = (data && typeof data.reply === "string" && data.reply.trim())
        ? data.reply.trim()
        : (currentLang === "es" ? "Sin respuesta." : "No reply.");

      botBubble.textContent = reply;
      recordTranscript("bot", reply);
      speak(reply, replyLang);
      setNet(true, "Ready", "Listo");
    } catch {
      const fallback = (currentLang === "es") ? "No puedo conectar con el asistente OPS." : "Can’t reach OPS assistant.";
      botBubble.textContent = fallback;
      recordTranscript("bot", fallback);
      speak(fallback, currentLang);
      sendTelemetry("network_error", { online: !!navigator.onLine });
      setNet(false, "Offline", "Sin conexión");
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      inFlight = false;
    }
  });

  if (!document.documentElement.getAttribute("data-theme")) {
    document.documentElement.setAttribute("data-theme", currentTheme);
  }

  updateListenUI();
  setNet(true, "Ready", "Listo");
  ensureWelcome();
})();
