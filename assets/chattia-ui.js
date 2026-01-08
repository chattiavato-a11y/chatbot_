/* assets/chattia-ui.js
   OPS Online Support — Chattia UI Controller (v2)
   - No external libs
   - Handles:
     - Language toggle (expects assets/chattia-head-lang.js sets <html lang>)
     - Theme toggle (expects assets/chattia-theme.css + localStorage key)
     - Privacy/Consent modal (localStorage consent gate)
     - Transcript drawer (right-to-left)
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
    CONSENT: "ops_consent_v1",    // "accept" | "deny"
    TRANSCRIPT: "ops_transcript"  // JSON array (local only)
  };

  const LIMITS = {
    MAX_MSG_CHARS: 256,
    MAX_HISTORY_ITEMS: 12
  };

  /* -------------------- DOM helpers -------------------- */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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
    messages: $("#messages") || $("#chatBody"),
    composer: $("#composer") || $("#chatMessage"),
    sendBtn: $("#sendBtn"),
    statusPill: $("#statusPill"),
    langBtn: $("#langBtn"),
    themeBtn: $("#themeBtn"),
    transcriptBtn: $("#transcriptBtn"),

    // Drawer
    drawer: $("#transcriptDrawer"),
    drawerBody: $("#drawerBody"),
    drawerClose: $("#drawerClose"),
    drawerClear: $("#drawerClear"),
    backdrop: $("#backdrop"),

    // Chat drawer
    chatDrawer: $("#chatDrawer"),
    chatClose: $("#chatClose"),
    chatForm: $("#chatForm"),

    // Consent modal
    consentModal: $("#consentModal"),
    consentAccept: $("#consentAccept"),
    consentDeny: $("#consentDeny"),
    consentClose: $("#consentClose"),

    // FABs
    fabChatbot: $("#fabChatbot") || $("#fabChat"),
    fabContact: $("#fabContact"),
    fabJoin: $("#fabJoin")
  };

  if (!UI.sendBtn && UI.chatForm) {
    UI.sendBtn = UI.chatForm.querySelector("button[type='submit']");
  }

  /* -------------------- State -------------------- */

  const state = {
    lang: (document.documentElement.lang === "es") ? "es" : "en",
    theme: "dark",
    consent: "deny",
    transcript: [] // { role, content, ts }
  };

  /* -------------------- Copy (EN/ES) -------------------- */

  const COPY = {
    en: {
      online: "Online",
      offline: "Offline",
      sending: "Sending…",
      blocked: "Blocked",
      consentTitle: "Privacy & Consent",
      consentBody:
        "This chat is for general information about OPS Online Support. Please do not share sensitive personal data (passwords, OTP codes, bank or card details). Messages may be processed to provide the chat experience. If you do not consent, chat will be disabled until you accept.",
      accept: "Accept",
      deny: "Deny",
      close: "Close",
      transcriptTitle: "Transcript",
      clear: "Clear",
      emptyTranscript: "No messages yet.",
      placeholder: "Type your message…",
      send: "Send",
      mustConsent: "To use chat, please accept Privacy & Consent.",
      badInput: "Message blocked. Please remove unsafe content.",
      configError: "Site configuration error."
    },
    es: {
      online: "En línea",
      offline: "Fuera de línea",
      sending: "Enviando…",
      blocked: "Bloqueado",
      consentTitle: "Privacidad y consentimiento",
      consentBody:
        "Este chat es para información general sobre OPS Online Support. No compartas datos sensibles (contraseñas, códigos, banco o tarjetas). Los mensajes pueden procesarse para brindar la experiencia de chat. Si no das consentimiento, el chat quedará deshabilitado hasta que aceptes.",
      accept: "Aceptar",
      deny: "Denegar",
      close: "Cerrar",
      transcriptTitle: "Transcripción",
      clear: "Borrar",
      emptyTranscript: "Aún no hay mensajes.",
      placeholder: "Escribe tu mensaje…",
      send: "Enviar",
      mustConsent: "Para usar el chat, acepta Privacidad y consentimiento.",
      badInput: "Mensaje bloqueado. Elimina contenido inseguro.",
      configError: "Error de configuración del sitio."
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
    document.documentElement.setAttribute("data-theme", th);
    writeLS(LS.THEME, th);

    // Update toggle UI if present
    const isOn = (th === "dark");
    if (UI.themeBtn) {
      UI.themeBtn.classList.toggle("is-on", isOn);
      UI.themeBtn.setAttribute("aria-pressed", String(isOn));
    }
  }

  /* -------------------- Language -------------------- */

  function applyLang(lang) {
    const lg = (lang === "es") ? "es" : "en";
    state.lang = lg;
    document.documentElement.lang = lg;
    writeLS(LS.LANG, lg);

    // placeholder / labels (if elements exist)
    if (UI.composer) UI.composer.setAttribute("placeholder", t("placeholder"));
    if (UI.sendBtn) UI.sendBtn.textContent = t("send");

    // modal content
    const title = $("#consentTitle");
    const body = $("#consentBody");
    if (title) title.textContent = t("consentTitle");
    if (body) body.textContent = t("consentBody");
    if (UI.consentAccept) UI.consentAccept.textContent = t("accept");
    if (UI.consentDeny) UI.consentDeny.textContent = t("deny");
    if (UI.consentClose) UI.consentClose.textContent = t("close");

    const drTitle = $("#drawerTitle");
    if (drTitle) drTitle.textContent = t("transcriptTitle");
    if (UI.drawerClear) UI.drawerClear.textContent = t("clear");

    // FAB labels (optional)
    const fabChatLabel = $("#fabChatLabel");
    const fabContactLabel = $("#fabContactLabel");
    const fabJoinLabel = $("#fabJoinLabel");
    if (fabChatLabel) fabChatLabel.textContent = "Chatbot";
    if (fabContactLabel) fabContactLabel.textContent = "Contact";
    if (fabJoinLabel) fabJoinLabel.textContent = "Join Us";
    // (Keep labels consistent; pages handle EN/ES content)
  }

  /* -------------------- Consent -------------------- */

  function readConsent() {
    const c = readLS(LS.CONSENT, "deny");
    return (c === "accept") ? "accept" : "deny";
  }

  function setConsent(val) {
    const v = (val === "accept") ? "accept" : "deny";
    state.consent = v;
    writeLS(LS.CONSENT, v);
  }

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
    if (state.consent === "accept") return true;
    openConsentModal();
    status(t("mustConsent"), "warn");
    return false;
  }

  /* -------------------- Status pill -------------------- */

  function status(text, level = "ok") {
    if (!UI.statusPill) return;
    UI.statusPill.textContent = String(text || "");
    UI.statusPill.dataset.level = level;
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
    if (!UI.messages) return;

    const safeRole = (role === "assistant") ? "assistant" : "user";
    const wrap = el("div", { class: `msg ${safeRole}` });
    const bubble = el("div", { class: "bubble", text: String(content || "") });
    const stamp = el("div", { class: "stamp", text: new Date().toLocaleString() });

    wrap.appendChild(bubble);
    wrap.appendChild(stamp);
    UI.messages.appendChild(wrap);
    UI.messages.scrollTop = UI.messages.scrollHeight;
  }

  function rebuildChatFromTranscript() {
    if (!UI.messages) return;
    UI.messages.innerHTML = "";
    for (const m of state.transcript.slice(-50)) {
      renderMessage(m.role, m.content);
    }
  }

  function rebuildDrawer() {
    if (!UI.drawerBody) return;

    const items = state.transcript.slice(-150);
    if (!items.length) {
      UI.drawerBody.textContent = t("emptyTranscript");
      return;
    }

    UI.drawerBody.innerHTML = "";
    for (const m of items) {
      const line = el("div", { class: "bubble", text: `${m.role === "user" ? "End User" : "Chatbot"}: ${m.content}` });
      line.style.marginBottom = "10px";
      UI.drawerBody.appendChild(line);
    }
  }

  /* -------------------- Drawer controls -------------------- */

  function openDrawer() {
    if (!UI.drawer || !UI.backdrop) return;
    UI.drawer.classList.add("is-open");
    UI.backdrop.classList.add("is-on");
    UI.drawer.setAttribute("aria-hidden", "false");
    rebuildDrawer();
  }

  function closeDrawer() {
    if (!UI.drawer || !UI.backdrop) return;
    UI.drawer.classList.remove("is-open");
    UI.backdrop.classList.remove("is-on");
    UI.drawer.setAttribute("aria-hidden", "true");
  }

  /* -------------------- Chat drawer controls -------------------- */

  function openChatDrawer() {
    if (!UI.chatDrawer) return;
    UI.chatDrawer.classList.add("is-open");
    UI.chatDrawer.removeAttribute("hidden");
    UI.chatDrawer.setAttribute("aria-hidden", "false");
    if (UI.composer) UI.composer.focus();
  }

  function closeChatDrawer() {
    if (!UI.chatDrawer) return;
    UI.chatDrawer.classList.remove("is-open");
    UI.chatDrawer.setAttribute("hidden", "hidden");
    UI.chatDrawer.setAttribute("aria-hidden", "true");
  }

  function clearTranscript() {
    state.transcript = [];
    saveTranscript();
    rebuildChatFromTranscript();
    rebuildDrawer();
  }

  /* -------------------- Gateway call -------------------- */

  function buildHistoryForGateway() {
    // Convert local transcript -> gateway history
    // Keep within LIMITS.MAX_HISTORY_ITEMS
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

  async function onSend() {
    if (isSending) return;
    if (!UI.composer) return;
    if (!ensureConsentOrPrompt()) return;

    const raw = normalizeUserText(UI.composer.value || "");
    if (!raw) return;

    // UI-level suspicious block (server also blocks)
    if (looksSuspicious(raw)) {
      status(t("badInput"), "warn");
      return;
    }

    // Update UI immediately
    UI.composer.value = "";
    renderMessage("user", raw);
    pushTranscript("user", raw);

    isSending = true;
    status(t("sending"), "busy");
    if (UI.sendBtn) UI.sendBtn.disabled = true;

    try {
      const reply = await sendToGateway(raw);

      // If empty, fallback UI message
      const finalReply = reply || (state.lang === "es"
        ? "Gracias. Para continuar, usa la página de Contacto o Carreras/Únete en opsonlinesupport.com."
        : "Thanks. To continue, please use the Contact or Careers/Join Us section on opsonlinesupport.com.");

      renderMessage("assistant", finalReply);
      pushTranscript("assistant", finalReply);
      status(t("online"), "ok");
    } catch (e) {
      console.error(e);
      renderMessage("assistant", state.lang === "es"
        ? "Hubo un problema al conectar con el asistente. Inténtalo de nuevo o usa la página de Contacto."
        : "There was a problem connecting to the assistant. Please try again or use the Contact page.");
      pushTranscript("assistant", state.lang === "es"
        ? "Hubo un problema al conectar con el asistente. Inténtalo de nuevo o usa la página de Contacto."
        : "There was a problem connecting to the assistant. Please try again or use the Contact page.");
      status(t("offline"), "warn");
    } finally {
      isSending = false;
      if (UI.sendBtn) UI.sendBtn.disabled = false;
    }
  }

  /* -------------------- Event wiring -------------------- */

  function wireEvents() {
    // Send
    if (UI.sendBtn) UI.sendBtn.addEventListener("click", onSend);
    if (UI.composer) {
      UI.composer.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSend();
        }
      });
    }
    if (UI.chatForm) {
      UI.chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        onSend();
      });
    }

    // Transcript drawer
    if (UI.transcriptBtn) UI.transcriptBtn.addEventListener("click", openDrawer);
    if (UI.drawerClose) UI.drawerClose.addEventListener("click", closeDrawer);
    if (UI.backdrop) UI.backdrop.addEventListener("click", closeDrawer);
    if (UI.drawerClear) UI.drawerClear.addEventListener("click", () => {
      clearTranscript();
      closeDrawer();
    });

    // Consent modal open (nav link)
    const privacyBtn = $("#privacyBtn");
    if (privacyBtn) privacyBtn.addEventListener("click", () => openConsentModal());

    if (UI.consentAccept) UI.consentAccept.addEventListener("click", () => {
      setConsent("accept");
      closeConsentModal();
      status(t("online"), "ok");
    });

    if (UI.consentDeny) UI.consentDeny.addEventListener("click", () => {
      setConsent("deny");
      closeConsentModal();
      status(t("offline"), "warn");
    });

    if (UI.consentClose) UI.consentClose.addEventListener("click", () => closeConsentModal());

    // Theme toggle
    if (UI.themeBtn) UI.themeBtn.addEventListener("click", () => {
      applyTheme(state.theme === "dark" ? "light" : "dark");
    });

    // Language toggle
    if (UI.langBtn) UI.langBtn.addEventListener("click", () => {
      applyLang(state.lang === "en" ? "es" : "en");
      // Re-render drawer title + empty state if needed
      rebuildDrawer();
    });

    // FABs
    if (UI.fabChatbot) UI.fabChatbot.addEventListener("click", () => {
      if (!ensureConsentOrPrompt()) {
        openChatDrawer();
        return;
      }
      openChatDrawer();
    });

    if (UI.chatClose) UI.chatClose.addEventListener("click", closeChatDrawer);

    // Contact + Join must go to nav menu links (pages)
    if (UI.fabContact) UI.fabContact.addEventListener("click", () => {
      const a = $("#navContact");
      if (a && a.getAttribute("href")) window.location.href = a.getAttribute("href");
    });

    if (UI.fabJoin) UI.fabJoin.addEventListener("click", () => {
      const a = $("#navJoin");
      if (a && a.getAttribute("href")) window.location.href = a.getAttribute("href");
    });

    // ESC closes drawer/modals
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      closeDrawer();
      closeChatDrawer();
      closeConsentModal();
    });
  }

  /* -------------------- Init -------------------- */

  function init() {
    // Load persisted state
    state.theme = readLS(LS.THEME, "dark") === "light" ? "light" : "dark";
    state.lang = readLS(LS.LANG, document.documentElement.lang === "es" ? "es" : "en");
    state.consent = readConsent();
    state.transcript = loadTranscript();

    applyTheme(state.theme);
    applyLang(state.lang);

    // Build UI from transcript
    rebuildChatFromTranscript();
    rebuildDrawer();

    // Consent gating
    if (state.consent !== "accept") {
      // keep chat visible but blocked until accept
      status(t("offline"), "warn");
      openConsentModal();
    } else {
      status(t("online"), "ok");
    }

    closeChatDrawer();

    wireEvents();

    // Basic config check (non-fatal, but shows status)
    try {
      requireConfigOrThrow();
    } catch (e) {
      console.error(e);
      status(t("configError"), "warn");
      // Also disable send to avoid confusing failures
      if (UI.sendBtn) UI.sendBtn.disabled = true;
    }
  }

  // Run when DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
