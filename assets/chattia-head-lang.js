/* assets/chattia-head-lang.js
   Chattia / OPS — Head Language + i18n bootstrap (v2)
   - Detect & persist language (en/es)
   - Sets <html lang=""> early
   - Exposes minimal window.__OPS_LANG + window.__OPS_I18N
   - No network calls, no cookies (localStorage only)
*/

(() => {
  const STORAGE_KEY = "ops_lang";
  const SUPPORTED = new Set(["en", "es"]);

  function safeGetLS(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSetLS(key, val) {
    try { localStorage.setItem(key, val); } catch {}
  }

  function normalizeLang(v) {
    const s = String(v || "").toLowerCase().trim();
    if (s.startsWith("es")) return "es";
    return "en";
  }

  function getPreferredLang() {
    const saved = safeGetLS(STORAGE_KEY);
    if (SUPPORTED.has(saved)) return saved;

    const navLang =
      (navigator.languages && navigator.languages[0]) ||
      navigator.language ||
      "en";

    return normalizeLang(navLang);
  }

  function setHtmlLang(lang) {
    const l = SUPPORTED.has(lang) ? lang : "en";
    document.documentElement.setAttribute("lang", l);
    document.documentElement.dataset.lang = l;
  }

  // Minimal i18n strings used by the chat-only UI
  const I18N = {
    en: {
      fab_chat: "Chat",

      consent_title: "Privacy & Consent",
      consent_body:
        "Chat interactions may be used to improve the chatbot experience. Please do not enter sensitive personal information. " +
        "OPS Online Support does not intentionally collect payment card data, banking info, passwords, or one-time codes.",
      consent_deny: "Deny",
      consent_accept: "Accept",
      consent_note: "If you deny consent, chat will remain disabled until you accept.",

      chat_title: "OPS Assistant",
      chat_subtitle: "Chat support • Routing help",
      chat_lang_toggle_text: "EN/ES",
      chat_theme_toggle_text: "Dark/Light",
      chat_label: "Your message",
      chat_placeholder: "Type your message…",
      chat_send: "Send",
      chat_disclaimer:
        "Do not share passwords, OTP codes, banking info, or card numbers in chat. Use official OPS channels for sensitive matters."
    },

    es: {
      fab_chat: "Chat",

      consent_title: "Privacidad y consentimiento",
      consent_body:
        "Las interacciones del chat pueden usarse para mejorar la experiencia del chatbot. No ingreses información personal sensible. " +
        "OPS Online Support no recolecta intencionalmente datos de tarjeta, bancarios, contraseñas ni códigos de un solo uso.",
      consent_deny: "Denegar",
      consent_accept: "Aceptar",
      consent_note: "Si niegas el consentimiento, el chat quedará deshabilitado hasta que aceptes.",

      chat_title: "Asistente OPS",
      chat_subtitle: "Soporte por chat • Ayuda de ruta",
      chat_lang_toggle_text: "EN/ES",
      chat_theme_toggle_text: "Oscuro/Claro",
      chat_label: "Tu mensaje",
      chat_placeholder: "Escribe tu mensaje…",
      chat_send: "Enviar",
      chat_disclaimer:
        "No compartas contraseñas, códigos OTP, información bancaria ni números de tarjeta en el chat. Usa canales oficiales de OPS para asuntos sensibles."
    }
  };

  function applyI18n(lang) {
    const dict = I18N[lang] || I18N.en;

    // text nodes via data-i18n
    const nodes = document.querySelectorAll("[data-i18n]");
    for (const el of nodes) {
      const key = el.getAttribute("data-i18n");
      if (!key) continue;
      const val = dict[key];
      if (typeof val === "string") el.textContent = val;
    }

    // placeholders via data-i18n-placeholder
    const pnodes = document.querySelectorAll("[data-i18n-placeholder]");
    for (const el of pnodes) {
      const key = el.getAttribute("data-i18n-placeholder");
      if (!key) continue;
      const val = dict[key];
      if (typeof val === "string") el.setAttribute("placeholder", val);
    }
  }

  function setLang(lang) {
    const l = SUPPORTED.has(lang) ? lang : "en";
    safeSetLS(STORAGE_KEY, l);
    setHtmlLang(l);
    // If DOM is ready, apply translations now
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => applyI18n(l), { once: true });
    } else {
      applyI18n(l);
    }
    // expose for other modules
    window.__OPS_LANG = l;
  }

  // Initial
  const initial = getPreferredLang();
  setHtmlLang(initial);
  window.__OPS_LANG = initial;
  window.__OPS_I18N = I18N;

  // Apply when ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => applyI18n(initial), { once: true });
  } else {
    applyI18n(initial);
  }

  // Public API
  window.__OPS_setLang = setLang;
})();
