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
    CONSENT: "ops_chat_consent",  // "accepted" | "denied"
    CONSENT_LEGACY: "ops_consent_v1",
    TRANSCRIPT: "ops_transcript"  // JSON array (local only)
  };

  const LIMITS = {
    MAX_MSG_CHARS: 256,
    MAX_HISTORY_ITEMS: 12
  };

  const prefs = typeof window !== "undefined" ? window.__OPS_PREFS : null;

  /* -------------------- DOM helpers -------------------- */

  const $ = (sel) => document.querySelector(sel);

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

  /* -------------------- Safe text helpers (UI-level) -------------------- */

  function normalizeUserText(s) {
    let out = String(s || "");
    out = out.replace(/[\u0000-\u001F\u007F]/g, " ");
    out = out.replace(/\s+/g, " ").trim();
    if (out.length > LIMITS.MAX_MSG_CHARS) out = out.slice(0, LIMITS.MAX_MSG_CHARS);
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
    turnstileSlot: $("#turnstileSlot"),

    // Chat drawer
    chatDrawer: $("#chatDrawer"),
    chatClose: $("#chatClose"),
    chatForm: $("#chatForm"),

    // Consent modal
    consentModal: $("#consentModal"),
    consentAccept: $("#consentAccept"),
    consentDeny: $("#consentDeny"),

    // Toggles
    langToggle: $("#langToggle"),
    themeToggle: $("#themeToggle"),

    // FABs
    fabChat: $("#fabChat")
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
    transcript: [] // { role, content, ts }
  };

  /* -------------------- Copy (EN/ES) -------------------- */

  const COPY = {
    en: {
      sending: "Sending…",
      badInput: "Message blocked. Please remove unsafe content.",
      mustConsent: "To use chat, please accept Privacy & Consent.",
      configError: "Site configuration error.",
      chat_placeholder: "Type your message…",
      fallbackReply:
        "Thanks. To continue, please review the content archive at opsonlinesupport.com/content.md.",
      gatewayError:
        "There was a problem connecting to the assistant. Please try again or review opsonlinesupport.com/content.md."
    },
    es: {
      sending: "Enviando…",
      badInput: "Mensaje bloqueado. Elimina contenido inseguro.",
      mustConsent: "Para usar el chat, acepta Privacidad y consentimiento.",
      configError: "Error de configuración del sitio.",
      chat_placeholder: "Escribe tu mensaje…",
      fallbackReply:
        "Gracias. Para continuar, revisa el archivo de contenido en opsonlinesupport.com/content.md.",
      gatewayError:
        "Hubo un problema al conectar con el asistente. Inténtalo de nuevo o revisa opsonlinesupport.com/content.md."
    }
  };

  function t(key) {
    const d = COPY[state.lang] || COPY.en;
    return d[key] || COPY.en[key] || "";
  }

  /* -------------------- Storage helpers -------------------- */

  function readLS(key, fallback = "") {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function writeLS(key, value) {
    try { localStorage.setItem(key, String(value)); } catch {}
  }

  function readConsent() {
    if (prefs && typeof prefs.getConsent === "function") {
      return prefs.getConsent() === "accepted" ? "accepted" : "denied";
    }
    const legacy = readLS(LS.CONSENT_LEGACY, "");
    if (legacy === "accept") return "accepted";
    if (legacy === "deny") return "denied";
    const c = readLS(LS.CONSENT, "denied");
    return c === "accepted" ? "accepted" : "denied";
  }

  function setConsent(val) {
    const v = (val === "accepted") ? "accepted" : "denied";
    state.consent = v;
    if (prefs && typeof prefs.setConsent === "function") {
      prefs.setConsent(v);
    } else {
      writeLS(LS.CONSENT, v);
    }
  }

  function loadTranscript() {
    const raw = readLS(LS.TRANSCRIPT, "");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(x => x && typeof x === "object")
        .slice(-200); // keep local history bounded
    } catch {
      return [];
    }
  }

  function saveTranscript() {
    try {
      writeLS(LS.TRANSCRIPT, JSON.stringify(state.transcript.slice(-200)));
    } catch {}
  }

  /* -------------------- Theme -------------------- */

  function applyTheme(theme) {
    const th = (theme === "light") ? "light" : "dark";
    state.theme = th;
    if (prefs && typeof prefs.setTheme === "function") {
      prefs.setTheme(th);
    } else {
      document.documentElement.setAttribute("data-theme", th);
      writeLS(LS.THEME, th);
    }

    if (UI.themeToggle) {
      const isOn = (th === "dark");
      UI.themeToggle.classList.toggle("is-on", isOn);
      UI.themeToggle.setAttribute("aria-pressed", String(isOn));
    }
  }

  /* -------------------- Language -------------------- */

  function applyLang(lang) {
    const lg = (lang === "es") ? "es" : "en";
    state.lang = lg;
    if (prefs && typeof prefs.setLang === "function") {
      prefs.setLang(lg);
    } else if (typeof window.__OPS_setLang === "function") {
      window.__OPS_setLang(lg);
    } else {
      document.documentElement.lang = lg;
      writeLS(LS.LANG, lg);
    }

    if (UI.chatMessage && !UI.chatMessage.hasAttribute("data-i18n-placeholder")) {
      UI.chatMessage.setAttribute("placeholder", t("chat_placeholder"));
    }
  }

  /* -------------------- Consent modal -------------------- */

  function openConsentModal() {
    if (!UI.consentModal) return;
    UI.consentModal.classList.add("is-open");
    UI.consentModal.setAttribute("aria-hidden", "false");

    if (typeof UI.consentModal.showModal === "function") {
      if (!UI.consentModal.open) UI.consentModal.showModal();
    } else {
      UI.consentModal.setAttribute("open", "");
    }

    if (UI.consentAccept) UI.consentAccept.focus();
  }

  function closeConsentModal() {
    if (!UI.consentModal) return;
    UI.consentModal.classList.remove("is-open");
    UI.consentModal.setAttribute("aria-hidden", "true");

    if (typeof UI.consentModal.close === "function") {
      if (UI.consentModal.open) UI.consentModal.close();
    } else {
      UI.consentModal.removeAttribute("open");
    }
  }

  function ensureConsentOrPrompt() {
    if (state.consent === "accepted") return true;
    openConsentModal();
    return false;
  }

  function setChatEnabled(enabled) {
    if (UI.chatMessage) UI.chatMessage.disabled = !enabled;
    if (UI.sendBtn) UI.sendBtn.disabled = !enabled;
    if (UI.chatForm) UI.chatForm.setAttribute("aria-disabled", String(!enabled));
  }

  function updateChatEnabled() {
    setChatEnabled(state.consent === "accepted" && state.configOk);
  }

  /* -------------------- Drawer controls -------------------- */

  function setChatExpanded(isOpen) {
    if (UI.fabChat) UI.fabChat.setAttribute("aria-expanded", String(isOpen));
    if (UI.chatDrawer) UI.chatDrawer.setAttribute("aria-hidden", String(!isOpen));
  }

  function openChatDrawer({ focus = true } = {}) {
    if (!UI.chatDrawer) return;
    UI.chatDrawer.classList.add("is-open");
    setChatExpanded(true);
    if (focus && UI.chatMessage) UI.chatMessage.focus();
  }

  function closeChatDrawer({ returnFocus = true } = {}) {
    if (!UI.chatDrawer) return;
    UI.chatDrawer.classList.remove("is-open");
    setChatExpanded(false);
    if (returnFocus && UI.fabChat) UI.fabChat.focus();
  }

  /* -------------------- Transcript + message rendering -------------------- */

  function pushTranscript(role, content) {
    const msg = {
      role: (role === "assistant") ? "assistant" : "user",
      content: String(content || ""),
      ts: new Date().toISOString()
    };
    state.transcript.push(msg);
    saveTranscript();
  }

  function renderMessage(role, content) {
    if (!UI.chatBody) return;

    const safeRole = (role === "assistant") ? "assistant" : "user";
    const wrap = el("div", { class: `msg ${safeRole}` });
    const bubble = el("div", { class: "bubble", text: String(content || "") });
    const stamp = el("div", { class: "stamp", text: new Date().toLocaleString() });

    wrap.appendChild(bubble);
    wrap.appendChild(stamp);
    UI.chatBody.appendChild(wrap);
    UI.chatBody.scrollTop = UI.chatBody.scrollHeight;
  }

  function rebuildChatFromTranscript() {
    if (!UI.chatBody) return;
    UI.chatBody.innerHTML = "";
    for (const m of state.transcript.slice(-50)) {
      renderMessage(m.role, m.content);
    }
  }

  /* -------------------- Gateway call -------------------- */

  function buildHistoryForGateway() {
    const last = state.transcript.slice(-LIMITS.MAX_HISTORY_ITEMS);
    return last.map(m => ({
      role: (m.role === "assistant") ? "assistant" : "user",
      content: normalizeUserText(m.content)
    }));
  }

  async function sendToGateway(message) {
    requireConfigOrThrow();

    const url = `${GATEWAY_BASE}/api/ops-online-chat`;
    const payload = {
      lang: state.lang,
      message,
      history: buildHistoryForGateway(),
      // Honeypots: must be empty
      hp_email: "",
      hp_website: ""
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
    if (!ensureConsentOrPrompt()) return;

    const hpEmail = UI.hpEmail ? String(UI.hpEmail.value || "") : "";
    const hpWebsite = UI.hpWebsite ? String(UI.hpWebsite.value || "") : "";
    if (hpEmail || hpWebsite) {
      renderMessage("assistant", t("badInput"));
      return;
    }

    const raw = normalizeUserText(UI.chatMessage.value || "");
    if (!raw) return;

    if (looksSuspicious(raw)) {
      renderMessage("assistant", t("badInput"));
      return;
    }

    UI.chatMessage.value = "";
    renderMessage("user", raw);
    pushTranscript("user", raw);

    isSending = true;
    if (UI.sendBtn) UI.sendBtn.disabled = true;

    try {
      const reply = await sendToGateway(raw);
      const finalReply = reply || t("fallbackReply");
      renderMessage("assistant", finalReply);
      pushTranscript("assistant", finalReply);
    } catch (e) {
      console.error(e);
      const errorMessage = e.message === "Missing meta[name=ops-gateway]." ||
        e.message === "Missing meta[name=ops-asset-id]."
        ? t("configError")
        : t("gatewayError");
      renderMessage("assistant", errorMessage);
      pushTranscript("assistant", errorMessage);
    } finally {
      isSending = false;
      if (UI.sendBtn) UI.sendBtn.disabled = false;
    }
  }

  /* -------------------- Event wiring -------------------- */

  function wireEvents() {
    if (UI.chatForm) UI.chatForm.addEventListener("submit", onSend);

    if (UI.fabChat) {
      UI.fabChat.addEventListener("click", () => {
        if (!ensureConsentOrPrompt()) return;
        openChatDrawer({ focus: true });
      });
    }
    if (UI.chatForm) {
      UI.chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        onSend();
      });
    }

    if (UI.chatClose) {
      UI.chatClose.addEventListener("click", () => closeChatDrawer({ returnFocus: true }));
    }

    if (UI.consentAccept) {
      UI.consentAccept.addEventListener("click", () => {
        setConsent("accepted");
        updateChatEnabled();
        closeConsentModal();
        if (state.configOk) openChatDrawer({ focus: true });
      });
    }

    if (UI.consentDeny) {
      UI.consentDeny.addEventListener("click", () => {
        setConsent("denied");
        updateChatEnabled();
        closeConsentModal();
      });
    }

    if (UI.themeToggle) {
      UI.themeToggle.addEventListener("click", () => {
        applyTheme(state.theme === "dark" ? "light" : "dark");
      });
    }

    if (UI.langToggle) {
      UI.langToggle.addEventListener("click", () => {
        applyLang(state.lang === "en" ? "es" : "en");
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      closeChatDrawer({ returnFocus: false });
      closeConsentModal();
    });
  }

  /* -------------------- Init -------------------- */

  function init() {
    const isChatbotOnly = document.body && document.body.classList.contains("chatbot-only");
    const autoOpen = document.body && document.body.dataset.chatOpen === "true";

    state.theme = prefs && typeof prefs.getTheme === "function"
      ? prefs.getTheme()
      : readLS(LS.THEME, "dark") === "light" ? "light" : "dark";

    state.lang = prefs && typeof prefs.getLang === "function"
      ? prefs.getLang()
      : readLS(LS.LANG, document.documentElement.lang === "es" ? "es" : "en");

    state.consent = readConsent();
    state.transcript = loadTranscript();

    applyTheme(state.theme);
    applyLang(state.lang);
    rebuildChatFromTranscript();

    if (isChatbotOnly || autoOpen) {
      if (UI.chatDrawer) UI.chatDrawer.classList.add("is-open");
      setChatExpanded(true);
    } else {
      setChatExpanded(false);
    }

    try {
      requireConfigOrThrow();
      state.configOk = true;
    } catch (e) {
      console.error(e);
      state.configOk = false;
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
