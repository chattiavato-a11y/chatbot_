/* assets/chattia-ui.js
   OPS Online Support — Chattia UI (v3, NO TURNSTILE)
   - Gateway POST JSON → /api/ops-online-chat
   - Consent gating (localStorage ops_consent)
   - Theme + Language toggles (localStorage ops_theme / ops_lang)
   - Transcript modal (copy/download)
   - Honeypots supported (hp_email / hp_website)
*/

(() => {
  "use strict";

  /* -------------------- Constants / Keys -------------------- */

  const LS = {
    CONSENT: "ops_consent", // "accepted" | "denied" | null
    THEME: "ops_theme",     // "dark" | "light"
    LANG: "ops_lang"        // "en" | "es"
  };

  const LIMITS = {
    MAX_MSG_CHARS: 256,
    MAX_HISTORY: 12
  };

  /* -------------------- DOM helpers -------------------- */

  const $ = (id) => document.getElementById(id);

  const UI = {
    // Shell
    fabChat: $("fabChat"),
    drawer: $("chatDrawer"),
    backdrop: $("chatBackdrop"),
    close: $("chatClose"),

    // Chat
    body: $("chatBody"),
    form: $("chatForm"),
    input: $("chatMessage"),
    hpEmail: $("hp_email"),
    hpWebsite: $("hp_website"),
    chatClear: $("chatClear"),
    chatTranscript: $("chatTranscript"),

    // Consent modal
    consentModal: $("consentModal"),
    consentAccept: $("consentAccept"),
    consentDeny: $("consentDeny"),
    consentClose: $("consentClose"),

    // Preferences
    langToggle: $("langToggle"),
    themeToggle: $("themeToggle"),

    // Transcript modal
    transcriptModal: $("transcriptModal"),
    transcriptText: $("transcriptText"),
    transcriptClose: $("transcriptClose"),
    transcriptCopy: $("transcriptCopy"),
    transcriptDownload: $("transcriptDownload")
  };

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, String(val)); } catch {}
  }
  function safeDel(key) {
    try { localStorage.removeItem(key); } catch {}
  }

  function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? String(el.getAttribute("content") || "").trim() : "";
  }

  /* -------------------- Modal helpers (dialog-safe) -------------------- */

  function openModal(el) {
    if (!el) return;
    el.classList.add("is-open");
    try {
      if (typeof el.showModal === "function" && !el.open) el.showModal();
    } catch {
      // ignore (some browsers block showModal if not a <dialog>)
    }
    el.setAttribute("aria-hidden", "false");
  }

  function closeModal(el) {
    if (!el) return;
    el.classList.remove("is-open");
    try {
      if (typeof el.close === "function" && el.open) el.close();
    } catch {}
    el.setAttribute("aria-hidden", "true");
  }

  /* -------------------- Drawer helpers -------------------- */

  function openDrawer() {
    if (!UI.drawer || !UI.backdrop) return;
    UI.drawer.classList.add("is-open");
    UI.drawer.setAttribute("aria-hidden", "false");
    UI.backdrop.classList.add("is-on");
    UI.backdrop.setAttribute("aria-hidden", "false");
    if (UI.fabChat) UI.fabChat.setAttribute("aria-expanded", "true");
    setTimeout(() => { try { UI.input && UI.input.focus(); } catch {} }, 0);
  }

  function closeDrawer() {
    if (!UI.drawer || !UI.backdrop) return;
    UI.drawer.classList.remove("is-open");
    UI.drawer.setAttribute("aria-hidden", "true");
    UI.backdrop.classList.remove("is-on");
    UI.backdrop.setAttribute("aria-hidden", "true");
    if (UI.fabChat) UI.fabChat.setAttribute("aria-expanded", "false");
  }

  /* -------------------- Consent -------------------- */

  function getConsent() {
    const v = (safeGet(LS.CONSENT) || "").toLowerCase().trim();
    if (v === "accepted") return "accepted";
    if (v === "denied") return "denied";
    return null;
  }

  function setConsent(v) {
    const s = (String(v || "")).toLowerCase().trim();
    if (s === "accepted" || s === "denied") {
      safeSet(LS.CONSENT, s);
      window.__OPS_CHAT_CONSENT = s;
      window.dispatchEvent(new CustomEvent("ops:consent", { detail: { consent: s } }));
      return s;
    }
    safeDel(LS.CONSENT);
    window.__OPS_CHAT_CONSENT = null;
    window.dispatchEvent(new CustomEvent("ops:consent", { detail: { consent: null } }));
    return null;
  }

  function requireConsentThenOpenChat() {
    const c = getConsent();
    if (c === "accepted") {
      openDrawer();
      return;
    }
    openModal(UI.consentModal);
  }

  /* -------------------- Theme + Language -------------------- */

  function normalizeTheme(v) {
    const s = String(v || "").toLowerCase().trim();
    return s === "light" ? "light" : "dark";
  }

  function getTheme() {
    const saved = safeGet(LS.THEME);
    if (saved === "light" || saved === "dark") return saved;
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  function applyTheme(theme) {
    const t = normalizeTheme(theme);
    document.documentElement.dataset.theme = t;
    safeSet(LS.THEME, t);
    if (UI.themeToggle) UI.themeToggle.setAttribute("aria-pressed", t === "light" ? "true" : "false");
    window.dispatchEvent(new CustomEvent("ops:theme", { detail: { theme: t } }));
    return t;
  }

  function normalizeLang(v) {
    const s = String(v || "").toLowerCase().trim();
    return s.startsWith("es") ? "es" : "en";
  }

  function getLang() {
    const saved = safeGet(LS.LANG);
    if (saved === "en" || saved === "es") return saved;
    const htmlLang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (htmlLang.startsWith("es")) return "es";
    const nav = (navigator.language || "en").toLowerCase();
    return nav.startsWith("es") ? "es" : "en";
  }

  function applyLang(lang) {
    const l = normalizeLang(lang);
    safeSet(LS.LANG, l);

    // Prefer head bootstrap translator if present
    if (typeof window.__OPS_setLang === "function") {
      window.__OPS_setLang(l);
    } else {
      document.documentElement.setAttribute("lang", l);
      document.documentElement.dataset.lang = l;
      window.__OPS_LANG = l;
    }

    if (UI.langToggle) UI.langToggle.setAttribute("aria-pressed", l === "es" ? "true" : "false");
    window.dispatchEvent(new CustomEvent("ops:lang", { detail: { lang: l } }));
    return l;
  }

  function toggleTheme() {
    const cur = getTheme();
    return applyTheme(cur === "dark" ? "light" : "dark");
  }

  function toggleLang() {
    const cur = getLang();
    return applyLang(cur === "en" ? "es" : "en");
  }

  /* -------------------- Chat rendering -------------------- */

  const state = {
    history: [], // { role: "user"|"assistant", content: "..." }
    sending: false
  };

  function normalizeUserText(s) {
    let out = String(s || "");
    out = out.replace(/[\u0000-\u001F\u007F]/g, " ");
    out = out.replace(/\s+/g, " ").trim();
    if (out.length > LIMITS.MAX_MSG_CHARS) out = out.slice(0, LIMITS.MAX_MSG_CHARS);
    return out;
  }

  function pushHistory(role, content) {
    const item = { role: role === "assistant" ? "assistant" : "user", content: String(content || "") };
    state.history.push(item);
    if (state.history.length > LIMITS.MAX_HISTORY) {
      state.history = state.history.slice(-LIMITS.MAX_HISTORY);
    }
  }

  function el(tag, attrs = {}, text = "") {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, String(v));
    }
    if (text) n.textContent = text;
    return n;
  }

  function appendMessage(role, text) {
    if (!UI.body) return;
    const wrap = el("div", { class: `msg ${role}` });
    const bubble = el("div", { class: "bubble" });
    bubble.textContent = String(text || "");
    wrap.appendChild(bubble);
    UI.body.appendChild(wrap);
    try { UI.body.scrollTop = UI.body.scrollHeight; } catch {}
  }

  function systemNote(text) {
    appendMessage("assistant", text);
  }

  function clearChat() {
    state.history = [];
    if (UI.body) UI.body.innerHTML = "";
  }

  /* -------------------- Transcript -------------------- */

  function buildTranscriptText() {
    const lines = [];
    for (const item of state.history) {
      const who = item.role === "assistant" ? "Assistant" : "User";
      lines.push(`${who}: ${item.content}`);
      lines.push("");
    }
    return lines.join("\n").trim() + "\n";
  }

  function openTranscript() {
    if (!UI.transcriptModal || !UI.transcriptText) return;
    UI.transcriptText.value = buildTranscriptText();
    openModal(UI.transcriptModal);
    setTimeout(() => {
      try { UI.transcriptText.focus(); UI.transcriptText.select(); } catch {}
    }, 0);
  }

  async function copyTranscript() {
    if (!UI.transcriptText) return;
    const txt = UI.transcriptText.value || "";
    try {
      await navigator.clipboard.writeText(txt);
    } catch {
      // fallback: select + execCommand
      try {
        UI.transcriptText.focus();
        UI.transcriptText.select();
        document.execCommand("copy");
      } catch {}
    }
  }

  function downloadTranscript() {
    const txt = buildTranscriptText();
    const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chattia-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* -------------------- Network (Gateway) -------------------- */

  function getGatewayBase() {
    const fromMeta = getMeta("ops-gateway");
    return fromMeta || `${location.origin}`;
  }

  function getAssetId() {
    const fromMeta = getMeta("ops-asset-id");
    return fromMeta || "ops-online-support-site";
  }

  async function postChat(message) {
    const base = getGatewayBase().replace(/\/+$/, "");
    const url = `${base}/api/ops-online-chat`;

    const payload = {
      lang: getLang(),
      message,
      history: state.history,
      // honeypots (must remain empty)
      hp_email: UI.hpEmail ? String(UI.hpEmail.value || "") : "",
      hp_website: UI.hpWebsite ? String(UI.hpWebsite.value || "") : ""
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ops-Asset-Id": getAssetId()
      },
      body: JSON.stringify(payload)
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    // Gateway/brain usually returns JSON
    if (ct.includes("application/json")) {
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    }

    // Fallback: text
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, data: { text } };
  }

  function extractAssistantText(respData) {
    if (!respData) return "";
    // Common patterns
    if (typeof respData.reply === "string") return respData.reply;
    if (typeof respData.message === "string") return respData.message;
    if (typeof respData.text === "string") return respData.text;

    // Cloudflare AI style payload: { result: { response: "..." } } or { response: "..." }
    if (typeof respData.response === "string") return respData.response;
    if (respData.result && typeof respData.result.response === "string") return respData.result.response;

    // If the brain returns OpenAI-like: { choices: [{ message: { content } }] }
    const c0 = respData.choices && respData.choices[0];
    const content = c0 && c0.message && c0.message.content;
    if (typeof content === "string") return content;

    return "";
  }

  function friendlyError(status, data) {
    const code = data && (data.error_code || data.code);
    const msg = data && (data.error || data.message);

    if (status === 401) return msg || "Unauthorized client (asset ID check failed).";
    if (status === 403) return msg || "Blocked (origin not allowed).";
    if (status === 413) return msg || "Message too large.";
    if (status === 415) return msg || "JSON only.";
    if (status === 429) return msg || "Too many requests. Please wait and try again.";
    if (status >= 500) return msg || "Service error. Please try again.";
    return msg || (code ? `Request failed: ${code}` : "Request failed.");
  }

  /* -------------------- Events -------------------- */

  async function onSubmit(e) {
    e.preventDefault();
    if (state.sending) return;

    // Consent gate
    if (getConsent() !== "accepted") {
      openModal(UI.consentModal);
      return;
    }

    const raw = UI.input ? UI.input.value : "";
    const message = normalizeUserText(raw);
    if (!message) return;

    // Honeypots must be empty; if not, do nothing (bot)
    if ((UI.hpEmail && UI.hpEmail.value) || (UI.hpWebsite && UI.hpWebsite.value)) return;

    // UI
    if (UI.input) UI.input.value = "";
    appendMessage("user", message);
    pushHistory("user", message);

    state.sending = true;

    try {
      const { ok, status, data } = await postChat(message);

      if (!ok) {
        const errText = friendlyError(status, data);
        systemNote(errText);
        pushHistory("assistant", errText);
        return;
      }

      const reply = extractAssistantText(data) || (getLang() === "es"
        ? "Listo. ¿En qué más puedo ayudarte?"
        : "Done. How else can I help?");

      appendMessage("assistant", reply);
      pushHistory("assistant", reply);
    } catch (err) {
      const msg = (getLang() === "es")
        ? "Error de red. Inténtalo de nuevo."
        : "Network error. Please try again.";
      systemNote(msg);
      pushHistory("assistant", msg);
      console.error(err);
    } finally {
      state.sending = false;
    }
  }

  function wireEvents() {
    if (UI.fabChat) UI.fabChat.addEventListener("click", requireConsentThenOpenChat);
    if (UI.close) UI.close.addEventListener("click", closeDrawer);
    if (UI.backdrop) UI.backdrop.addEventListener("click", closeDrawer);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeModal(UI.consentModal);
        closeModal(UI.transcriptModal);
        closeDrawer();
      }
    });

    if (UI.form) UI.form.addEventListener("submit", onSubmit);

    if (UI.chatClear) UI.chatClear.addEventListener("click", () => {
      clearChat();
      systemNote(getLang() === "es" ? "Chat limpiado." : "Chat cleared.");
    });

    if (UI.chatTranscript) UI.chatTranscript.addEventListener("click", openTranscript);

    if (UI.transcriptClose) UI.transcriptClose.addEventListener("click", () => closeModal(UI.transcriptModal));
    if (UI.transcriptCopy) UI.transcriptCopy.addEventListener("click", copyTranscript);
    if (UI.transcriptDownload) UI.transcriptDownload.addEventListener("click", downloadTranscript);

    if (UI.consentClose) UI.consentClose.addEventListener("click", () => closeModal(UI.consentModal));

    if (UI.consentAccept) UI.consentAccept.addEventListener("click", (e) => {
      e.preventDefault();
      setConsent("accepted");
      closeModal(UI.consentModal);
      openDrawer();
    });

    if (UI.consentDeny) UI.consentDeny.addEventListener("click", (e) => {
      e.preventDefault();
      setConsent("denied");
      closeModal(UI.consentModal);
      // keep chat closed; user can accept later
    });

    if (UI.langToggle) UI.langToggle.addEventListener("click", () => toggleLang());
    if (UI.themeToggle) UI.themeToggle.addEventListener("click", () => toggleTheme());
  }

  /* -------------------- Init -------------------- */

  function init() {
    // Apply stored prefs (even if chattia-preferences.js also does it — harmless)
    applyTheme(getTheme());
    applyLang(getLang());

    // If consent was accepted earlier, allow direct open
    const c = getConsent();
    window.__OPS_CHAT_CONSENT = c;

    wireEvents();

    // Optional: greet only once per page load
    systemNote(getLang() === "es"
      ? "Hola — soy Chattia. Pregúntame sobre OPS Online Support."
      : "Hi — I’m Chattia. Ask me about OPS Online Support.");
  }

  // Run
  init();
})();
