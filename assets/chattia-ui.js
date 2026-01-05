/* assets/chattia-ui.js */
/* Chattia UI — 2026 HCI refresh (compact)
   Fixes + Enhancements:
   - Removes dead legacy lang/theme code that could throw ReferenceError
   - Adds typing indicator + focus-trap for modal/drawer
   - Telemetry is consent-gated (no consent => no telemetry)
*/

(() => {
  "use strict";
  const qs = (s) => document.querySelector(s);

  // --- CONFIG (keep in sync with gateway) ---
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

  // --- ELEMENTS ---
  const log = qs("#chat-log"), form = qs("#chatbot-input-row"), input = qs("#chatbot-input"), sendBtn = qs("#chatbot-send");
  const speechToggle = qs("#speechToggle"), listenCtrl = qs("#listenCtrl"), voiceStatus = qs("#voice-status");
  const netDot = qs("#netDot"), netText = qs("#netText");

  const hpEmail = qs("#hp_email"), hpWebsite = qs("#hp_website");
  const clearChatBtn = qs("#clearChat");

  const transcriptTrigger = qs("#transcriptTrigger"), transcriptDrawer = qs("#transcriptDrawer"), transcriptOverlay = qs("#transcriptOverlay");
  const transcriptClose = qs("#transcriptClose"), transcriptList = qs("#transcriptList"), transcriptCopy = qs("#transcript-copy"), clearTranscriptBtn = qs("#clearTranscript");

  const privacyTrigger = qs("#privacyTrigger"), termsTrigger = qs("#termsTrigger"), tncButton = qs("#tnc-button");
  const policyOverlay = qs("#policyOverlay"), policyModal = qs("#policyModal"), policyCloseBtn = qs("#btnClosePolicy");
  const privacyAcceptBtn = qs("#btnAcceptPrivacy"), privacyDenyBtn = qs("#btnDenyPrivacy"), consentNote = qs("#consent-note");

  // --- PREFS + CONSENT ---
  const prefsApi = window.opsUiPrefs || null;
  const CONSENT_KEY = "ops-chat-consent";
  let currentLang = prefsApi?.getLang?.() || (document.documentElement.lang === "es" ? "es" : "en");
  let currentTheme = prefsApi?.getTheme?.() || (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  let consentState = "pending"; // pending | accepted | denied

  const readConsent = () => { try { return localStorage.getItem(CONSENT_KEY) || "pending"; } catch { return "pending"; } };
  const writeConsent = (v) => { try { localStorage.setItem(CONSENT_KEY, v); } catch {} };
  const setChatEnabled = (on) => {
    if (input) input.disabled = !on;
    if (sendBtn) sendBtn.disabled = !on;
    if (listenCtrl) listenCtrl.disabled = !on;
    if (consentNote) consentNote.hidden = on;
  };

  const applyConsent = (next) => {
    consentState = next;
    writeConsent(next);
    prefsApi?.setPersistenceAllowed?.(next === "accepted");
    setChatEnabled(next !== "denied");
  };

  // --- SAFETY HELPERS ---
  const normalize = (s) => {
    let out = String(s || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    if (out.length > MAX_INPUT_CHARS) out = out.slice(0, MAX_INPUT_CHARS);
    return out;
  };
  const looksSuspicious = (s) => {
    const t = String(s || "").toLowerCase();
    return [
      "<script", "</script", "javascript:", "<img", "onerror", "onload", "<iframe", "<object", "<embed",
      "<svg", "<link", "<meta", "<style", "document.cookie", "onmouseover", "onmouseenter", "<form", "<input", "<textarea"
    ].some((p) => t.includes(p));
  };
  const isAuthorized = () => {
    const o = window.location.origin, p = window.location.pathname || "/";
    return AUTH_RULES.some((r) => (o === r.origin) && r.pathPrefixes.some((pref) => p.startsWith(pref)));
  };

  // --- NET / UI ---
  const setNet = (ok, en, es) => {
    if (!netDot || !netText) return;
    netDot.style.background = ok ? "rgba(44,242,162,.9)" : "rgba(255,59,143,.9)";
    netText.textContent = (currentLang === "es") ? (es || en) : en;
  };

  // --- TELEMETRY (consent-gated, sampled) ---
  const telemetryRate = 0.25;
  const sendTelemetry = (event, detail = {}) => {
    if (consentState !== "accepted") return;
    if (Math.random() > telemetryRate) return;
    try {
      fetch(TELEMETRY_URL, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: String(event || ""), lang: currentLang, ts: Date.now(), detail: (detail && typeof detail === "object") ? detail : {} })
      }).catch(() => {});
    } catch {}
  };

  // --- FOCUS TRAP (modal/drawer) ---
  let releaseTrap = null, lastFocus = null;
  const focusables = (root) => Array.from(root.querySelectorAll(
    "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"
  )).filter((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  const trapFocus = (root) => {
    releaseTrap?.();
    lastFocus = document.activeElement;
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      const items = focusables(root);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    releaseTrap = () => { document.removeEventListener("keydown", onKey, true); releaseTrap = null; try { lastFocus?.focus?.(); } catch {} };
  };

  // --- MODAL ---
  const openPolicyModal = (anchorId) => {
    if (!policyModal || !policyOverlay) return;
    policyModal.hidden = false;
    policyOverlay.classList.add("open");
    policyOverlay.setAttribute("aria-hidden", "false");
    trapFocus(policyModal);
    (policyCloseBtn || privacyAcceptBtn || policyModal).focus?.();
    if (anchorId) {
      const el = qs(`#${anchorId}`);
      if (el) setTimeout(() => el.scrollIntoView({ block: "start", behavior: "smooth" }), 40);
    }
  };
  const closePolicyModal = () => {
    if (!policyModal || !policyOverlay) return;
    policyModal.hidden = true;
    policyOverlay.classList.remove("open");
    policyOverlay.setAttribute("aria-hidden", "true");
    releaseTrap?.();
  };

  // --- TRANSCRIPT ---
  const transcript = [];
  const renderTranscript = () => {
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
      wrap.append(role, text);
      transcriptList.appendChild(wrap);
    });
  };
  const recordTranscript = (role, text) => { if (text) { transcript.push({ role, text, ts: Date.now() }); renderTranscript(); } };

  const openTranscript = () => {
    if (!transcriptDrawer || !transcriptOverlay) return;
    transcriptDrawer.hidden = false;
    transcriptDrawer.classList.add("open");
    transcriptOverlay.classList.add("open");
    transcriptOverlay.setAttribute("aria-hidden", "false");
    renderTranscript();
    trapFocus(transcriptDrawer);
    transcriptClose?.focus?.();
  };
  const closeTranscript = () => {
    if (!transcriptDrawer || !transcriptOverlay) return;
    transcriptDrawer.classList.remove("open");
    transcriptOverlay.classList.remove("open");
    transcriptOverlay.setAttribute("aria-hidden", "true");
    releaseTrap?.();
    setTimeout(() => { transcriptDrawer.hidden = true; }, 220);
  };
  const copyTranscript = () => {
    const txt = transcript.map((t) => `${t.role === "user" ? "End User" : "Chatbot"}: ${t.text}`).join("\n\n");
    if (!txt) return;
    if (navigator?.clipboard?.writeText) { navigator.clipboard.writeText(txt).catch(() => {}); return; }
    try {
      const ta = document.createElement("textarea");
      ta.value = txt; ta.setAttribute("readonly", "true");
      ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    } catch {}
  };

  // --- CHAT UI ---
  const addLine = (who, text, { record = true, typing = false } = {}) => {
    const wrap = document.createElement("div");
    wrap.className = `msg ${who}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (typing) {
      const t = document.createElement("span");
      t.className = "typing";
      t.append(Object.assign(document.createElement("span"), { className: "typing-dot" }));
      t.append(Object.assign(document.createElement("span"), { className: "typing-dot" }));
      t.append(Object.assign(document.createElement("span"), { className: "typing-dot" }));
      bubble.appendChild(t);
    } else {
      bubble.textContent = text;
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    wrap.append(bubble, meta);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;

    if (record && !typing) recordTranscript(who, text);
    return bubble;
  };

  const addUser = (t) => addLine("user", t);
  const addBot = (t, opts) => addLine("bot", t, opts);

  const ensureWelcome = () => {
    if (log?.dataset?.welcomed === "true") return;
    const msg = (currentLang === "es") ? "Chattia para OPS está listo. Escribe o usa el micrófono para chatear." : "Chattia for OPS is ready. Type or use the mic to chat.";
    addBot(msg);
    log.dataset.welcomed = "true";
  };

  const clearChat = () => {
    log.textContent = "";
    transcript.length = 0;
    renderTranscript();
    log.dataset.welcomed = "false";
    ensureWelcome();
  };

  // --- VOICE (Web Speech API) ---
  const synth = ("speechSynthesis" in window) ? window.speechSynthesis : null;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = Recognition ? new Recognition() : null;
  let speechEnabled = false, listening = false;

  const cleanForSpeech = (s) => String(s || "")
    .replace(/`{3}[\s\S]*?`{3}/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/^\-\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  const getVoiceForLang = (lang) => {
    if (!synth) return null;
    const voices = synth.getVoices();
    const want = (lang === "es") ? ["es-", "es_"] : ["en-", "en_"];
    const list = voices.filter(v => want.some(p => (v.lang || "").toLowerCase().startsWith(p)))
      .sort((a,b)=>((b.localService?2:0)+(/google|microsoft|natural/i.test(b.name)?1:0))-((a.localService?2:0)+(/google|microsoft|natural/i.test(a.name)?1:0)));
    return list[0] || null;
  };

  const setVoiceStatus = (en, es) => { if (voiceStatus) voiceStatus.textContent = (currentLang === "es") ? (es || en) : en; };
  const updateSpeechToggleUI = () => { if (speechToggle) { speechToggle.classList.toggle("active", speechEnabled); speechToggle.setAttribute("aria-pressed", speechEnabled ? "true" : "false"); } };
  const updateListenUI = () => { if (listenCtrl) { listenCtrl.classList.toggle("active", listening); listenCtrl.setAttribute("aria-pressed", listening ? "true" : "false"); } };

  const speak = (text, langOverride) => {
    if (!synth || !speechEnabled) return;
    const clean = cleanForSpeech(normalize(text));
    if (!clean) return;
    const lang = (langOverride === "es") ? "es" : (langOverride === "en" ? "en" : currentLang);
    try { synth.cancel(); } catch {}
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = (lang === "es") ? "es-ES" : "en-US";
    const v = getVoiceForLang(lang);
    if (v) u.voice = v;
    try { synth.speak(u); } catch {}
  };

  if (recognition) {
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = (currentLang === "es") ? "es-ES" : "en-US";
    recognition.onstart = () => { listening = true; updateListenUI(); setVoiceStatus("Listening…", "Escuchando…"); };
    recognition.onresult = (e) => {
      const t = e.results?.[0]?.[0]?.transcript || "";
      const cleaned = normalize(t);
      if (!cleaned) return;
      input.value = cleaned; input.focus();
      if (isAuthorized()) form.requestSubmit();
      else addBot(currentLang === "es" ? "Este asistente solo acepta mensajes desde sitios autorizados." : "This assistant only accepts messages from authorized sites.");
    };
    recognition.onerror = () => { listening = false; updateListenUI(); setVoiceStatus("Voice error.", "Error de voz."); };
    recognition.onend = () => { listening = false; updateListenUI(); setVoiceStatus("", ""); };
  }

  const startListening = () => { if (!recognition) return; recognition.lang = (currentLang === "es") ? "es-ES" : "en-US"; try { recognition.start(); } catch {} };

  // --- EVENTS ---
  document.addEventListener("ops:language-change", (ev) => {
    currentLang = (ev?.detail?.lang === "es") ? "es" : "en";
    if (recognition) recognition.lang = (currentLang === "es") ? "es-ES" : "en-US";
    setVoiceStatus("", "");
    setNet(navigator.onLine, "Ready", "Listo");
    renderTranscript();
  });
  document.addEventListener("ops:theme-change", (ev) => { currentTheme = (ev?.detail?.theme === "dark") ? "dark" : "light"; });

  clearChatBtn?.addEventListener("click", clearChat);
  transcriptTrigger?.addEventListener("click", openTranscript);
  transcriptClose?.addEventListener("click", closeTranscript);
  transcriptOverlay?.addEventListener("click", closeTranscript);
  transcriptCopy?.addEventListener("click", copyTranscript);
  clearTranscriptBtn?.addEventListener("click", () => { transcript.length = 0; renderTranscript(); });

  privacyTrigger?.addEventListener("click", () => openPolicyModal("policy-privacy"));
  termsTrigger?.addEventListener("click", () => openPolicyModal("policy-terms"));
  policyOverlay?.addEventListener("click", closePolicyModal);
  policyCloseBtn?.addEventListener("click", closePolicyModal);
  privacyAcceptBtn?.addEventListener("click", () => { applyConsent("accepted"); closePolicyModal(); });
  privacyDenyBtn?.addEventListener("click", () => { applyConsent("denied"); closePolicyModal(); });

  tncButton?.addEventListener("click", () => {
    const msg = (currentLang === "es") ? (tncButton.dataset.esMsg || tncButton.dataset.enMsg || "") : (tncButton.dataset.enMsg || tncButton.dataset.esMsg || "");
    if (msg) { addBot(msg); speak(msg, currentLang); }
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeTranscript(); closePolicyModal(); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden && listening && recognition) { try { recognition.stop(); } catch {} } });

  if (speechToggle) {
    speechToggle.addEventListener("click", () => {
      if (!synth) { const m = currentLang === "es" ? "La síntesis de voz no está disponible en este navegador." : "Speech synthesis is not available in this browser."; addBot(m); return; }
      speechEnabled = !speechEnabled; updateSpeechToggleUI();
    });
  }
  if (listenCtrl) {
    listenCtrl.addEventListener("click", () => {
      if (!recognition) { const m = currentLang === "es" ? "Entrada por voz no disponible en este navegador." : "Voice input is not available in this browser."; addBot(m); return; }
      if (listening) { try { recognition.stop(); } catch {} return; }
      startListening();
    });
  }

  // --- SEND ---
  let inFlight = false;
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (inFlight) return;

    if (consentState === "denied") {
      const m = currentLang === "es" ? "El chat está deshabilitado hasta que aceptes la privacidad." : "Chat is disabled until you accept privacy.";
      addBot(m); return;
    }

    const msg = normalize(input.value);
    if (!msg) return;

    if (!isAuthorized()) {
      const m = currentLang === "es" ? "Este asistente solo acepta mensajes desde sitios autorizados." : "This assistant only accepts messages from authorized sites.";
      addBot(m); sendTelemetry("auth_block", { reason: "origin_or_path" }); return;
    }

    if (looksSuspicious(msg)) {
      const warn = currentLang === "es" ? "Mensaje bloqueado por seguridad. Escribe sin etiquetas o scripts." : "Message blocked for security. Please write without tags or scripts.";
      addBot(warn); speak(warn, currentLang); sendTelemetry("client_suspicious"); return;
    }

    const hp1 = normalize(hpEmail?.value || "");
    const hp2 = normalize(hpWebsite?.value || "");

    addUser(msg);
    input.value = ""; input.focus();

    setNet(navigator.onLine, "Sending…", "Enviando…");
    if (sendBtn) { sendBtn.disabled = true; sendBtn.setAttribute("aria-busy", "true"); }
    inFlight = true;

    const botBubble = addBot("", { record: false, typing: true });

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
        body: JSON.stringify({ message: msg, lang: currentLang, v: 2, hp_email: hp1, hp_website: hp2 }),
        signal: ctrl.signal
      });
      clearTimeout(timeout);

      const raw = await res.text();
      let data = null; try { data = JSON.parse(raw); } catch {}

      if (!res.ok) {
        const fallback = currentLang === "es" ? "Error del gateway de OPS." : "OPS gateway error.";
        const errMsg = (data && (data.error || data.public_error)) ? String(data.error || data.public_error) : (raw || fallback);
        botBubble.textContent = errMsg; recordTranscript("bot", errMsg); speak(errMsg, currentLang);
        sendTelemetry("api_error", { status: res.status });
        setNet(false, "Error", "Error");
        return;
      }

      const reply = (data && typeof data.reply === "string" && data.reply.trim()) ? data.reply.trim() : (currentLang === "es" ? "Sin respuesta." : "No reply.");
      const replyLang = (data && data.lang === "es") ? "es" : currentLang;
      botBubble.textContent = reply; recordTranscript("bot", reply); speak(reply, replyLang);
      setNet(true, "Ready", "Listo");
    } catch {
      const fallback = currentLang === "es" ? "No puedo conectar con el asistente OPS." : "Can’t reach OPS assistant.";
      botBubble.textContent = fallback; recordTranscript("bot", fallback); speak(fallback, currentLang);
      sendTelemetry("network_error", { online: !!navigator.onLine });
      setNet(false, "Offline", "Sin conexión");
    } finally {
      if (sendBtn) { sendBtn.disabled = false; sendBtn.removeAttribute("aria-busy"); }
      inFlight = false;
    }
  });

  // --- INIT ---
  consentState = readConsent();
  if (consentState === "accepted") prefsApi?.setPersistenceAllowed?.(true);
  if (consentState === "denied") prefsApi?.setPersistenceAllowed?.(false);
  setChatEnabled(consentState !== "denied");
  if (consentNote && consentState !== "accepted") consentNote.hidden = false;

  if (!document.documentElement.getAttribute("data-theme")) document.documentElement.setAttribute("data-theme", currentTheme);
  if (synth) synth.onvoiceschanged = () => getVoiceForLang(currentLang);

  updateSpeechToggleUI();
  updateListenUI();
  ensureWelcome();

  const updateOnline = () => setNet(navigator.onLine, "Ready", "Listo");
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", () => setNet(false, "Offline", "Sin conexión"));
  updateOnline();
})();
