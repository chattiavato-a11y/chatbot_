/* assets/chattia-ui.js
   OPS Online Support — Chattia UI Controller (v3)
   - No external libs
   - Handles:
     - Language toggle (delegates to assets/chattia-head-lang.js)
     - Theme toggle (delegates to assets/chattia-preferences.js)
     - Privacy/Consent modal (localStorage consent gate)
     - Chat drawer (right-to-left)
     - Chat send -> OPS Gateway (/api/ops-online-chat)
     - Minimal client-side sanitization (UI-level) + honeypots
     - Asset ID header (X-Ops-Asset-Id) from meta tag

   REQUIRED in index.html:
   - <meta name="ops-gateway" content="https://ops-gateway.grabem-holdem-nuts-right.workers.dev">
   - <meta name="ops-asset-id" content="YOUR_ASSET_ID_VALUE">
   - Basic elements with IDs used below (see selectors)
*/

(() => {
  "use strict";

  /* -------------------- Config keys -------------------- */

  const LS = {
    THEME: "ops_theme",           // "dark" | "light"
    LANG: "ops_lang",             // "en" | "es"
    CONSENT: "ops_consent",       // "accepted" | "denied"
    TRANSCRIPT: "ops_transcript"  // JSON array
  };

  const MAX_MSG_CHARS = 256;
  const MAX_HISTORY_ITEMS = 12;
  const MAX_TRANSCRIPT_ITEMS = 50;

  /* -------------------- Helpers -------------------- */

  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = String(v);
      else if (k.startsWith("aria-")) n.setAttribute(k, String(v));
      else if (k === "html") n.innerHTML = String(v);
      else n.setAttribute(k, String(v));
    }
    for (const c of children) n.appendChild(c);
    return n;
  }

  function clampText(s, max = MAX_MSG_CHARS) {
    let out = String(s || "");
    out = out.replace(/[\u0000-\u001F\u007F]/g, " ");
    out = out.replace(/\s+/g, " ").trim();
    if (out.length > max) out = out.slice(0, max);
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
    return bad.some(p => t.includes(p));
  }

  /* -------------------- Meta config -------------------- */

  function getMeta(name) {
    const m = document.querySelector(`meta[name="${name}"]`);
    return m ? (m.getAttribute("content") || "") : "";
  }

  const GATEWAY_BASE = (getMeta("ops-gateway") || "").replace(/\/+$/, "");
  const ASSET_ID = (getMeta("ops-asset-id") || "").trim();

  function requireConfigOrThrow() {
    if (!GATEWAY_BASE) throw new Error("Missing meta[name=ops-gateway].");
    if (!ASSET_ID) throw new Error("Missing meta[name=ops-asset-id].");
  }

  /* -------------------- UI selectors (IDs expected) -------------------- */

  const UI = {
    // Chat
    chatDrawer: $("#chatDrawer"),
    chatClose: $("#chatClose"),
    chatBody: $("#chatBody"),
    chatForm: $("#chatForm"),
    chatMessage: $("#chatMessage"),
    sendBtn: $("#chatForm button[type=submit]"),
    hpEmail: $("#hp_email"),
    hpWebsite: $("#hp_website"),
    chatBackdrop: $("#chatBackdrop"),

    // Consent modal
    consentModal: $("#consentModal"),
    consentAccept: $("#consentAccept"),
    consentDeny: $("#consentDeny"),
    consentClose: $("#consentClose"),

    // Toggles
    langToggle: $("#langToggle"),
    themeToggle: $("#themeToggle"),
    chatClear: $("#chatClear"),
    chatTranscript: $("#chatTranscript"),

    // FABs
    fabChat: $("#fabChat"),

    // Transcript modal
    transcriptModal: $("#transcriptModal"),
    transcriptClose: $("#transcriptClose"),
    transcriptText: $("#transcriptText"),
    transcriptCopy: $("#transcriptCopy"),
    transcriptDownload: $("#transcriptDownload")
  };

  if (!UI.sendBtn && UI.chatForm) {
    UI.sendBtn = UI.chatForm.querySelector("button[type='submit']");
  }

  /* -------------------- State -------------------- */

  const state = {
    lang: "en",
    theme: "dark",
    consent: "denied",
    configOk: true,
    transcript: [], // { role, content, ts }
    requestId: 0,
    sessionBlocked: false
  };

  /* -------------------- Copy (EN/ES) -------------------- */

  const COPY = {
    en: {
      sending: "Sending…",
      badInput: "Message blocked. Please remove unsafe content.",
      sessionBlocked: "Session blocked due to failed security checks.",
      mustConsent: "To use chat, please accept Privacy & Consent.",
      configError: "Site configuration error.",
      chat_placeholder: "Type your message…",
      openChat: "Open chat",
      closeChat: "Close chat",
      transcriptTitle: "Transcript",
      transcriptEmpty: "No transcript yet.",
      transcriptCopied: "Copied.",
      transcriptDownloaded: "Downloaded.",
      clearConfirm: "Clear chat history?",
      gatewayError: "Sorry—chat is unavailable right now.",
      fallbackReply: "Thanks—someone will follow up soon.",
      accept: "Accept",
      deny: "Deny",
      close: "Close"
    },
    es: {
      sending: "Enviando…",
      badInput: "Mensaje bloqueado. Elimina contenido inseguro.",
      sessionBlocked: "Sesión bloqueada por fallas de seguridad.",
      mustConsent: "Para usar el chat, acepta Privacidad y Consentimiento.",
      configError: "Error de configuración del sitio.",
      chat_placeholder: "Escribe tu mensaje…",
      openChat: "Abrir chat",
      closeChat: "Cerrar chat",
      transcriptTitle: "Transcripción",
      transcriptEmpty: "Aún no hay transcripción.",
      transcriptCopied: "Copiado.",
      transcriptDownloaded: "Descargado.",
      clearConfirm: "¿Borrar historial del chat?",
      gatewayError: "Lo siento—el chat no está disponible ahora.",
      fallbackReply: "Gracias—alguien te contactará pronto.",
      accept: "Aceptar",
      deny: "Rechazar",
      close: "Cerrar"
    }
  };

  function t(key) {
    const dict = COPY[state.lang] || COPY.en;
    return dict[key] || COPY.en[key] || key;
  }

  /* -------------------- Storage helpers -------------------- */

  function readLS(key, fallback = "") {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function writeLS(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {}
  }

  function removeLS(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }

  function readConsent() {
    const v = readLS(LS.CONSENT, "denied");
    return v === "accepted" ? "accepted" : "denied";
  }

  function setConsent(v) {
    state.consent = v === "accepted" ? "accepted" : "denied";
    writeLS(LS.CONSENT, state.consent);
  }

  function loadTranscript() {
    try {
      const raw = readLS(LS.TRANSCRIPT, "[]");
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(x => x && typeof x === "object" && (x.role === "user" || x.role === "assistant"))
        .map(x => ({
          role: x.role,
          content: clampText(String(x.content || ""), 2048),
          ts: typeof x.ts === "number" ? x.ts : Date.now()
        }))
        .slice(-MAX_TRANSCRIPT_ITEMS);
    } catch {
      return [];
    }
  }

  function saveTranscript() {
    try {
      writeLS(LS.TRANSCRIPT, JSON.stringify(state.transcript.slice(-MAX_TRANSCRIPT_ITEMS)));
    } catch {}
  }

  function clearTranscript() {
    state.transcript = [];
    removeLS(LS.TRANSCRIPT);
  }

  /* -------------------- Consent modal -------------------- */

  function openConsentModal() {
    if (!UI.consentModal) return;
    UI.consentModal.classList.add("is-open");
    UI.consentModal.setAttribute("aria-hidden", "false");
  }

  function closeConsentModal() {
    if (!UI.consentModal) return;
    UI.consentModal.classList.remove("is-open");
    UI.consentModal.setAttribute("aria-hidden", "true");
  }

  function ensureConsentOrPrompt() {
    if (state.consent === "accepted") return true;
    openConsentModal();
    return false;
  }

  /* -------------------- Theme + Language -------------------- */

  function applyTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    writeLS(LS.THEME, state.theme);
    document.documentElement.dataset.theme = state.theme;
    if (UI.themeToggle) {
      UI.themeToggle.setAttribute("aria-pressed", state.theme === "dark" ? "true" : "false");
    }
  }

  function applyLang(lang) {
    state.lang = lang === "es" ? "es" : "en";
    writeLS(LS.LANG, state.lang);
    document.documentElement.lang = state.lang;

    if (UI.langToggle) {
      UI.langToggle.setAttribute("aria-pressed", state.lang === "es" ? "true" : "false");
    }

    if (UI.chatMessage) UI.chatMessage.placeholder = t("chat_placeholder");
    if (UI.chatTranscript) UI.chatTranscript.title = t("transcriptTitle");
    if (UI.chatClose) UI.chatClose.title = t("closeChat");
  }

  /* -------------------- Chat UI rendering -------------------- */

  function setChatBackdrop(on) {
    if (!UI.chatBackdrop) return;
    UI.chatBackdrop.classList.toggle("is-on", !!on);
    UI.chatBackdrop.setAttribute("aria-hidden", on ? "false" : "true");
  }

  function setChatExpanded(expanded) {
    if (!UI.chatDrawer) return;
    UI.chatDrawer.classList.toggle("is-open", !!expanded);
    UI.chatDrawer.setAttribute("aria-hidden", expanded ? "false" : "true");
  }

  function openChatDrawer(opts = {}) {
    if (!UI.chatDrawer) return;
    if (!state.configOk) return;
    setChatExpanded(true);
    setChatBackdrop(true);
    if (UI.fabChat) UI.fabChat.setAttribute("aria-expanded", "true");
    if (opts.focus && UI.chatMessage) UI.chatMessage.focus();
  }

  function closeChatDrawer() {
    if (!UI.chatDrawer) return;
    setChatExpanded(false);
    setChatBackdrop(false);
    if (UI.fabChat) UI.fabChat.setAttribute("aria-expanded", "false");
  }

  function renderMessage(role, content) {
    if (!UI.chatBody) return;
    const safe = clampText(content, 2048);

    const row = el("div", { class: `chat-row ${role}` });
    const bubble = el("div", { class: "chat-bubble", text: safe });
    row.appendChild(bubble);

    UI.chatBody.appendChild(row);
    UI.chatBody.scrollTop = UI.chatBody.scrollHeight;
  }

  function rebuildChatFromTranscript() {
    if (!UI.chatBody) return;
    UI.chatBody.innerHTML = "";
    for (const m of state.transcript) renderMessage(m.role, m.content);
  }

  function pushTranscript(role, content) {
    state.transcript.push({ role, content: clampText(content, 2048), ts: Date.now() });
    if (state.transcript.length > MAX_TRANSCRIPT_ITEMS) {
      state.transcript = state.transcript.slice(-MAX_TRANSCRIPT_ITEMS);
    }
    saveTranscript();
  }

  function buildHistoryForGateway() {
    const out = [];
    const last = state.transcript.slice(-MAX_HISTORY_ITEMS * 2);
    for (const m of last) {
      if (!m || typeof m !== "object") continue;
      if (out.length >= MAX_HISTORY_ITEMS) break;
      const role = m.role === "assistant" ? "assistant" : "user";
      const content = clampText(m.content, MAX_MSG_CHARS);
      if (!content) continue;
      if (looksSuspicious(content)) continue;
      out.push({ role, content });
    }
    return out;
  }

  /* -------------------- Session blocking -------------------- */

  function blockSession(reasonKey = "sessionBlocked") {
    state.sessionBlocked = true;
    if (UI.sendBtn) UI.sendBtn.disabled = true;
    renderMessage("assistant", t(reasonKey));
    pushTranscript("assistant", t(reasonKey));
  }

  function updateChatEnabled() {
    const allowed = state.consent === "accepted" && !state.sessionBlocked;
    if (UI.chatMessage) UI.chatMessage.disabled = !allowed;
    if (UI.sendBtn) UI.sendBtn.disabled = !allowed;
  }

  /* -------------------- Transcript modal -------------------- */

  function openTranscriptModal() {
    if (!UI.transcriptModal) return;
    UI.transcriptModal.classList.add("is-open");
    UI.transcriptModal.setAttribute("aria-hidden", "false");

    const text = state.transcript.length
      ? state.transcript.map(m => {
          const when = new Date(m.ts || Date.now()).toISOString();
          return `[${when}] ${m.role}: ${m.content}`;
        }).join("\n")
      : t("transcriptEmpty");

    if (UI.transcriptText) UI.transcriptText.value = text;
  }

  function closeTranscriptModal() {
    if (!UI.transcriptModal) return;
    UI.transcriptModal.classList.remove("is-open");
    UI.transcriptModal.setAttribute("aria-hidden", "true");
  }

  async function copyTranscript() {
    if (!UI.transcriptText) return;
    try {
      await navigator.clipboard.writeText(UI.transcriptText.value || "");
      if (UI.transcriptCopy) UI.transcriptCopy.textContent = t("transcriptCopied");
      setTimeout(() => { if (UI.transcriptCopy) UI.transcriptCopy.textContent = "Copy"; }, 1200);
    } catch {}
  }

  function downloadTranscript() {
    // Optional; if the button exists, we keep it.
    if (!UI.transcriptText) return;
    try {
      const blob = new Blob([UI.transcriptText.value || ""], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ops-transcript-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      if (UI.transcriptDownload) UI.transcriptDownload.textContent = t("transcriptDownloaded");
      setTimeout(() => { if (UI.transcriptDownload) UI.transcriptDownload.textContent = "Download"; }, 1200);
    } catch {}
  }

  /* -------------------- Gateway call -------------------- */

  async function sendToGateway(message, honeypots = {}) {
    requireConfigOrThrow();

    const url = `${GATEWAY_BASE}/api/ops-online-chat`;
    const payload = {
      lang: state.lang,
      message,
      history: buildHistoryForGateway(),
      // Honeypots: must be empty
      hp_email: String(honeypots.email || ""),
      hp_website: String(honeypots.website || "")
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Ops-Asset-Id": ASSET_ID
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) ? String(data.error || data.message) : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const reply = (data && typeof data.reply === "string") ? data.reply : "";
    return reply || "";
  }

  /* -------------------- Main chat flow -------------------- */

  let isSending = false;

  async function onSend(event) {
    if (event) event.preventDefault();
    if (isSending) return;
    if (!UI.chatMessage) return;
    if (state.sessionBlocked) return;
    if (!ensureConsentOrPrompt()) return;

    const hpEmail = UI.hpEmail ? String(UI.hpEmail.value || "") : "";
    const hpWebsite = UI.hpWebsite ? String(UI.hpWebsite.value || "") : "";
    if (hpEmail || hpWebsite) {
      blockSession("sessionBlocked");
      return;
    }

    const message = clampText(UI.chatMessage.value || "", MAX_MSG_CHARS);
    if (!message) return;

    if (looksSuspicious(message)) {
      renderMessage("assistant", t("badInput"));
      pushTranscript("assistant", t("badInput"));
      return;
    }

    state.requestId += 1;
    const requestId = state.requestId;

    renderMessage("user", message);
    pushTranscript("user", message);
    UI.chatMessage.value = "";

    isSending = true;
    if (UI.sendBtn) UI.sendBtn.disabled = true;

    try {
      renderMessage("assistant", t("sending"));
      const reply = await sendToGateway(message, { email: hpEmail, website: hpWebsite });
      if (requestId !== state.requestId) return;
      const finalReply = reply || t("fallbackReply");
      renderMessage("assistant", finalReply);
      pushTranscript("assistant", finalReply);
    } catch (e) {
      console.error(e);
      if (requestId !== state.requestId) return;
      const errorMessage = e.message === "Missing meta[name=ops-gateway]." ||
        e.message === "Missing meta[name=ops-asset-id]."
        ? t("configError")
        : t("gatewayError");
      renderMessage("assistant", errorMessage);
      pushTranscript("assistant", errorMessage);
    } finally {
      if (requestId !== state.requestId) return;
      isSending = false;
      if (UI.sendBtn) UI.sendBtn.disabled = false;
      updateChatEnabled();
    }
  }

  /* -------------------- Wire events -------------------- */

  function wireEvents() {
    if (UI.fabChat) {
      UI.fabChat.addEventListener("click", () => {
        if (!ensureConsentOrPrompt()) return;
        const isOpen = UI.chatDrawer && UI.chatDrawer.classList.contains("is-open");
        if (isOpen) closeChatDrawer();
        else openChatDrawer({ focus: true });
      });
    }

    if (UI.chatClose) UI.chatClose.addEventListener("click", closeChatDrawer);
    if (UI.chatBackdrop) UI.chatBackdrop.addEventListener("click", closeChatDrawer);

    if (UI.chatForm) UI.chatForm.addEventListener("submit", onSend);

    if (UI.langToggle) {
      UI.langToggle.addEventListener("click", () => {
        applyLang(state.lang === "en" ? "es" : "en");
      });
    }

    if (UI.themeToggle) {
      UI.themeToggle.addEventListener("click", () => {
        applyTheme(state.theme === "dark" ? "light" : "dark");
      });
    }

    if (UI.chatClear) {
      UI.chatClear.addEventListener("click", () => {
        const ok = confirm(t("clearConfirm"));
        if (!ok) return;
        clearTranscript();
        rebuildChatFromTranscript();
      });
    }

    if (UI.chatTranscript) {
      UI.chatTranscript.addEventListener("click", openTranscriptModal);
    }

    if (UI.transcriptClose) UI.transcriptClose.addEventListener("click", closeTranscriptModal);
    if (UI.transcriptCopy) UI.transcriptCopy.addEventListener("click", copyTranscript);
    if (UI.transcriptDownload) UI.transcriptDownload.addEventListener("click", downloadTranscript);

    if (UI.consentClose) UI.consentClose.addEventListener("click", closeConsentModal);

    if (UI.consentDeny) {
      UI.consentDeny.addEventListener("click", () => {
        setConsent("denied");
        updateChatEnabled();
        closeConsentModal();
      });
    }

    if (UI.consentAccept) {
      UI.consentAccept.addEventListener("click", () => {
        setConsent("accepted");
        updateChatEnabled();
        applyTheme(state.theme);
        applyLang(state.lang);
        closeConsentModal();
        if (state.configOk) openChatDrawer({ focus: true });
      });
    }
  }

  /* -------------------- Init -------------------- */

  function init() {
    // config check (soft)
    try {
      requireConfigOrThrow();
      state.configOk = true;
    } catch (e) {
      console.warn(e);
      state.configOk = false;
    }

    // Initial state from LS
    state.theme = readLS(LS.THEME, "dark") === "light" ? "light" : "dark";
    state.lang = readLS(LS.LANG, document.documentElement.lang === "es" ? "es" : "en") === "es" ? "es" : "en";

    state.consent = readConsent();
    state.transcript = loadTranscript();

    applyTheme(state.theme);
    applyLang(state.lang);
    rebuildChatFromTranscript();

    const isChatbotOnly = document.body && document.body.classList.contains("chatbot-only");
    const autoOpen = (new URLSearchParams(location.search)).get("chat") === "1";

    if (isChatbotOnly || autoOpen) {
      if (UI.chatDrawer) UI.chatDrawer.classList.add("is-open");
      setChatExpanded(true);
      setChatBackdrop(true);
    } else {
      setChatExpanded(false);
      setChatBackdrop(false);
    }

    updateChatEnabled();

    if (state.consent !== "accepted") openConsentModal();

    wireEvents();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
