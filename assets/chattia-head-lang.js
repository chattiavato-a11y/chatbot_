/* assets/chattia-head-lang.js
   Chattia / OPS — Head Language Bootstrap (v3)
   - Runs early (defer in <head>)
   - Reads ops_lang from localStorage
   - Applies <html lang> + dataset.lang
   - Translates DOM nodes with [data-i18n="key"]
   - Exposes: window.__OPS_setLang(lang)

   Keys used by index.html in this project:
   topbar_sub, theme_label, lang_label,
   hero_title, hero_desc,
   card1_title, card1_desc,
   card2_title, card2_desc,
   card3_title, card3_desc,
   consent_title, consent_body, consent_deny, consent_accept, consent_note,
   chat_title, chat_note,
   transcript_title, transcript_body, transcript_copy, transcript_download
*/

(() => {
  "use strict";

  const LS_LANG_KEY = "ops_lang"; // "en" | "es"

  const I18N = {
    en: {
      topbar_sub: "Secure Chat",
      theme_label: "Theme",
      lang_label: "EN/ES",

      hero_title: "Chattia",
      hero_desc: "Ask about OPS services, solutions, and how we can support your operations.",

      card1_title: "Fast answers",
      card1_desc: "Get clear information about OPS offerings and next steps.",

      card2_title: "Secure by design",
      card2_desc: "No uploads, no sensitive info, and anti-abuse protections.",

      card3_title: "Lead-ready",
      card3_desc: "When you’re ready, we’ll route you to contact or sales.",

      consent_title: "Privacy & Consent",
      consent_body:
        "Chat interactions may be used to improve and train the chatbot experience. Please do not enter sensitive personal information. " +
        "OPS Online Support does not intentionally collect payment card data, banking info, passwords, or one-time codes.",
      consent_deny: "Deny",
      consent_accept: "Accept",
      consent_note: "If you deny consent, chat will remain disabled until you accept.",

      chat_title: "Chattia",
      chat_note: "Please avoid sharing personal or sensitive information.",

      transcript_title: "Transcript",
      transcript_body: "Copy or download your chat history.",
      transcript_copy: "Copy",
      transcript_download: "Download"
    },

    es: {
      topbar_sub: "Chat Seguro",
      theme_label: "Tema",
      lang_label: "EN/ES",

      hero_title: "Chattia",
      hero_desc: "Pregunta sobre servicios de OPS, soluciones y cómo podemos apoyar tus operaciones.",

      card1_title: "Respuestas rápidas",
      card1_desc: "Información clara sobre ofertas de OPS y próximos pasos.",

      card2_title: "Seguro por diseño",
      card2_desc: "Sin cargas de archivos, sin datos sensibles y con protecciones anti-abuso.",

      card3_title: "Listo para leads",
      card3_desc: "Cuando estés listo, te guiamos a contacto o ventas.",

      consent_title: "Privacidad y Consentimiento",
      consent_body:
        "Las interacciones del chat pueden usarse para mejorar y entrenar la experiencia del chatbot. No ingreses información personal sensible. " +
        "OPS Online Support no recopila intencionalmente datos de tarjetas, información bancaria, contraseñas ni códigos de un solo uso.",
      consent_deny: "Rechazar",
      consent_accept: "Aceptar",
      consent_note: "Si rechazas el consentimiento, el chat permanecerá deshabilitado hasta que aceptes.",

      chat_title: "Chattia",
      chat_note: "Evita compartir información personal o sensible.",

      transcript_title: "Transcripción",
      transcript_body: "Copia o descarga tu historial del chat.",
      transcript_copy: "Copiar",
      transcript_download: "Descargar"
    }
  };

  function safeGetLang() {
    try {
      const v = localStorage.getItem(LS_LANG_KEY);
      if (v === "es" || v === "en") return v;
    } catch {}
    const htmlLang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (htmlLang.startsWith("es")) return "es";
    const nav = (navigator.language || "en").toLowerCase();
    return nav.startsWith("es") ? "es" : "en";
  }

  function applyTranslations(lang) {
    const l = (lang === "es") ? "es" : "en";
    const dict = I18N[l] || I18N.en;

    // Apply to all [data-i18n]
    const nodes = document.querySelectorAll("[data-i18n]");
    for (const node of nodes) {
      const key = node.getAttribute("data-i18n");
      if (!key) continue;
      const val = dict[key];
      if (typeof val !== "string") continue;

      // If it's an input with placeholder intent:
      const tag = (node.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") {
        // Only set placeholder if attribute exists or if node is clearly an input
        if (node.hasAttribute("placeholder")) node.setAttribute("placeholder", val);
        else node.value = val;
      } else {
        node.textContent = val;
      }
    }

    // Update <html>
    document.documentElement.setAttribute("lang", l);
    document.documentElement.dataset.lang = l;

    // Expose for other scripts
    window.__OPS_LANG = l;
  }

  function setLang(lang) {
    const l = (String(lang || "").toLowerCase().startsWith("es")) ? "es" : "en";
    try { localStorage.setItem(LS_LANG_KEY, l); } catch {}
    applyTranslations(l);
    return l;
  }

  // Public API (used by chattia-preferences.js)
  window.__OPS_setLang = setLang;

  // Init early
  applyTranslations(safeGetLang());
})();
