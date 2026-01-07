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

  // Minimal i18n strings used across pages (extend as needed)
  const I18N = {
    en: {
      nav_home: "Home",
      nav_about: "About",
      nav_contact: "Contact",
      nav_policies: "Policies",

      footer_policies: "Privacy & Terms",
      footer_contact: "Contact",
      footer_about: "About",

      fab_contact: "Contact",
      fab_join: "Join",
      fab_chat: "Chat",

      consent_title: "Privacy & Consent",
      consent_body:
        "Chat interactions may be used to improve the chatbot experience. Please do not enter sensitive personal information. " +
        "OPS Online Support does not intentionally collect payment card data, banking info, passwords, or one-time codes.",
      consent_deny: "Deny",
      consent_accept: "Accept",
      consent_note: "If you deny consent, chat will remain disabled until you accept.",

      chat_title: "OPS Assistant",
      chat_subtitle: "Website help • Contact • Careers",
      chat_label: "Your message",
      chat_placeholder: "Type your message…",
      chat_send: "Send",
      chat_disclaimer:
        "Do not share passwords, OTP codes, banking info, or card numbers in chat. Use Contact for sensitive matters.",

      policies_title: "Policies",
      policies_subtitle:
        "Privacy & consent, terms, fair use, and security guidance for using this site and chat.",
      policies_privacy_title: "Privacy & Consent",
      policies_privacy_p1:
        "This website may provide a chat feature to help you navigate services, contact options, and careers paths. " +
        "Chat interactions may be used to improve the chatbot experience.",
      policies_privacy_p2:
        "Please do not enter sensitive personal information in chat or forms, including payment card numbers, banking details, passwords, " +
        "or one-time codes (OTP). If sensitive topics are necessary, use the official channels shown on the site.",
      policies_privacy_p3:
        "If you deny consent, the chat feature will remain disabled until you accept. You can still use the website content and contact pages.",
      policies_privacy_manage: "Manage chat consent",
      policies_privacy_note:
        "Note: OPS Online Support does not intentionally collect payment card details through chat.",

      policies_terms_title: "Terms & Conditions",
      policies_terms_p1:
        "By using this website, you agree to use it lawfully and in a way that does not harm the service, the organization, or other users. " +
        "The site and chat are provided “as-is” without warranties.",
      policies_terms_p2:
        "Chat responses may be incorrect or incomplete. You are responsible for validating important information. " +
        "For quotes, commitments, and official business communications, use the Contact page and official channels shown on the website.",
      policies_terms_p3:
        "We may apply anti-abuse protections (rate limits, filtering, and monitoring) to maintain availability and protect users. " +
        "Attempts to bypass security controls may be blocked.",

      policies_fairuse_title: "Fair Use",
      policies_fairuse_p1:
        "Do not abuse the chat or website. This includes harassment, hate, threats, illegal content, or attempts to exploit or bypass protections. " +
        "Do not submit spam, automated traffic, or malicious inputs.",
      policies_fairuse_p2:
        "We reserve the right to restrict or block access to protect service integrity, reduce fraud, and keep the experience safe for others.",

      policies_security_title: "Security Guidance",
      policies_security_p1:
        "This site uses security controls aligned with common best practices (OWASP-style protections such as strict headers, input validation, and anti-abuse controls). " +
        "The chat system is designed to reject suspicious payloads and sensitive payment data.",
      policies_security_p2:
        "If you believe you found a security issue, do not attempt to exploit it. Please report it using the official contact channel shown on the website.",
      policies_security_p3:
        "Reminder: never share passwords, OTP codes, banking info, or payment card numbers in chat.",

      policies_careers_title: "Careers / Join Us",
      policies_careers_p1:
        "If you want to apply, follow the Careers / Join Us instructions on this website and submit your profile through the official form or instructions shown there. " +
        "Do not send sensitive personal information via chat.",
      policies_careers_contact_cta: "Questions? Contact us"
    },

    es: {
      nav_home: "Inicio",
      nav_about: "Acerca de",
      nav_contact: "Contacto",
      nav_policies: "Políticas",

      footer_policies: "Privacidad y Términos",
      footer_contact: "Contacto",
      footer_about: "Acerca de",

      fab_contact: "Contacto",
      fab_join: "Únete",
      fab_chat: "Chat",

      consent_title: "Privacidad y consentimiento",
      consent_body:
        "Las interacciones del chat pueden usarse para mejorar la experiencia del chatbot. No ingreses información personal sensible. " +
        "OPS Online Support no recolecta intencionalmente datos de tarjeta, bancarios, contraseñas ni códigos de un solo uso.",
      consent_deny: "Denegar",
      consent_accept: "Aceptar",
      consent_note: "Si niegas el consentimiento, el chat quedará deshabilitado hasta que aceptes.",

      chat_title: "Asistente OPS",
      chat_subtitle: "Ayuda del sitio • Contacto • Carreras",
      chat_label: "Tu mensaje",
      chat_placeholder: "Escribe tu mensaje…",
      chat_send: "Enviar",
      chat_disclaimer:
        "No compartas contraseñas, códigos OTP, información bancaria ni números de tarjeta en el chat. Usa Contacto para asuntos sensibles.",

      policies_title: "Políticas",
      policies_subtitle:
        "Privacidad y consentimiento, términos, uso justo y guía de seguridad para este sitio y chat.",
      policies_privacy_title: "Privacidad y consentimiento",
      policies_privacy_p1:
        "Este sitio puede ofrecer un chat para ayudarte a navegar servicios, opciones de contacto y rutas de carrera. " +
        "Las interacciones pueden usarse para mejorar la experiencia del chatbot.",
      policies_privacy_p2:
        "No ingreses información personal sensible en el chat o formularios, incluyendo números de tarjeta, datos bancarios, contraseñas o códigos OTP. " +
        "Si necesitas tratar temas sensibles, usa los canales oficiales mostrados en el sitio.",
      policies_privacy_p3:
        "Si niegas el consentimiento, el chat quedará deshabilitado hasta que aceptes. Aun así puedes usar el contenido del sitio y la página de contacto.",
      policies_privacy_manage: "Administrar consentimiento del chat",
      policies_privacy_note:
        "Nota: OPS Online Support no recolecta intencionalmente datos de tarjeta mediante el chat.",

      policies_terms_title: "Términos y condiciones",
      policies_terms_p1:
        "Al usar este sitio, aceptas usarlo de forma legal y sin perjudicar el servicio, la organización u otros usuarios. " +
        "El sitio y el chat se proporcionan “tal cual”, sin garantías.",
      policies_terms_p2:
        "Las respuestas del chat pueden ser incorrectas o incompletas. Debes validar información importante. " +
        "Para cotizaciones, compromisos y comunicaciones oficiales, usa la página de Contacto y los canales oficiales del sitio.",
      policies_terms_p3:
        "Podemos aplicar protecciones anti-abuso (límites, filtros y monitoreo) para mantener disponibilidad y proteger a los usuarios. " +
        "Intentos de evadir controles de seguridad pueden ser bloqueados.",

      policies_fairuse_title: "Uso justo",
      policies_fairuse_p1:
        "No abuses del chat ni del sitio. Esto incluye acoso, odio, amenazas, contenido ilegal o intentos de explotar o evadir protecciones. " +
        "No envíes spam, tráfico automatizado o entradas maliciosas.",
      policies_fairuse_p2:
        "Nos reservamos el derecho de restringir o bloquear acceso para proteger la integridad del servicio, reducir fraude y mantener seguridad.",

      policies_security_title: "Guía de seguridad",
      policies_security_p1:
        "Este sitio utiliza controles de seguridad alineados a buenas prácticas comunes (protecciones estilo OWASP como headers estrictos, validación de entradas y controles anti-abuso). " +
        "El sistema de chat está diseñado para rechazar payloads sospechosos y datos sensibles de pago.",
      policies_security_p2:
        "Si crees que encontraste un problema de seguridad, no intentes explotarlo. Repórtalo usando el canal oficial de contacto del sitio.",
      policies_security_p3:
        "Recordatorio: nunca compartas contraseñas, códigos OTP, información bancaria o números de tarjeta en el chat.",

      policies_careers_title: "Carreras / Únete",
      policies_careers_p1:
        "Si deseas aplicar, sigue las instrucciones de Carreras / Únete en este sitio y envía tu perfil por el formulario o instrucciones oficiales. " +
        "No envíes información personal sensible por el chat.",
      policies_careers_contact_cta: "¿Preguntas? Contáctanos"
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
