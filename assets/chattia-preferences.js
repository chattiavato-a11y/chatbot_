/* assets/chattia-preferences.js
   Chattia / OPS — Preferences (v3)
   - Manages: language, theme, chat consent (local only)
   - No cookies, no network calls
   - localStorage only (fails safe if blocked)
   - Aligns keys with assets/chattia-ui.js:
     ops_lang, ops_theme, ops_consent
*/

(() => {
  "use strict";

  const KEYS = {
    lang: "ops_lang",
    theme: "ops_theme",      // "dark" | "light"
    consent: "ops_consent"   // "accepted" | "denied" | null
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

  function normalizeTheme(v) {
    const s = String(v || "").toLowerCase().trim();
    return (s === "light") ? "light" : "dark";
  }
  function normalizeLang(v) {
    const s = String(v || "").toLowerCase().trim();
    if (s.startsWith("es")) return "es";
    return "en";
  }
  function normalizeConsent(v) {
    const s = String(v || "").toLowerCase().trim();
    if (s === "accepted") return "accepted";
    if (s === "denied") return "denied";
    return null;
  }

  /* ---------------- Theme ---------------- */

  function getTheme() {
    const saved = safeGet(KEYS.theme);
    if (saved === "light" || saved === "dark") return saved;
    return "dark";
  }

  function applyTheme(theme) {
    const t = normalizeTheme(theme);
    document.documentElement.dataset.theme = t;
    safeSet(KEYS.theme, t);
    window.__OPS_THEME = t;
    window.dispatchEvent(new CustomEvent("ops:theme", { detail: { theme: t } }));
    return t;
  }

  /* ---------------- Language ---------------- */

  function getLang() {
    const saved = safeGet(KEYS.lang);
    if (saved === "es" || saved === "en") return saved;

    const htmlLang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (htmlLang.startsWith("es")) return "es";

    const nav = (navigator.language || "en").toLowerCase();
    return nav.startsWith("es") ? "es" : "en";
  }

  function applyLang(lang) {
    const l = normalizeLang(lang);
    safeSet(KEYS.lang, l);

    // Prefer head-lang bootstrap if present (also applies i18n)
    if (typeof window.__OPS_setLang === "function") {
      window.__OPS_setLang(l);
    } else {
      document.documentElement.setAttribute("lang", l);
      document.documentElement.dataset.lang = l;
      window.__OPS_LANG = l;
    }

    window.dispatchEvent(new CustomEvent("ops:lang", { detail: { lang: l } }));
    return l;
  }

  /* ---------------- Consent ---------------- */

  function getConsent() {
    return normalizeConsent(safeGet(KEYS.consent));
  }

  function setConsent(state /* "accepted" | "denied" | null */) {
    const s = normalizeConsent(state);
    if (!s) {
      safeDel(KEYS.consent);
      window.__OPS_CHAT_CONSENT = null;
      window.dispatchEvent(new CustomEvent("ops:consent", { detail: { consent: null } }));
      return null;
    }
    safeSet(KEYS.consent, s);
    window.__OPS_CHAT_CONSENT = s;
    window.dispatchEvent(new CustomEvent("ops:consent", { detail: { consent: s } }));
    return s;
  }

  function isChatEnabled() {
    return getConsent() === "accepted";
  }

  /* ---------------- Init ---------------- */

  applyTheme(getTheme());
  applyLang(getLang());
  window.__OPS_CHAT_CONSENT = getConsent();

  /* ---------------- Optional data-action hooks ----------------
     Any element with:
     - data-action="set-lang"        data-value="en|es"
     - data-action="set-theme"       data-value="dark|light"
     - data-action="accept-consent"
     - data-action="deny-consent"
  */

  function onClick(e) {
    const el = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
    if (!el) return;

    const action = el.getAttribute("data-action") || "";
    const value = el.getAttribute("data-value") || "";

    if (action === "set-lang") { applyLang(value); return; }
    if (action === "set-theme") { applyTheme(value); return; }
    if (action === "accept-consent") { setConsent("accepted"); return; }
    if (action === "deny-consent") { setConsent("denied"); return; }
  }

  document.addEventListener("click", onClick, { passive: true });

  /* ---------------- Public API ---------------- */

  window.__OPS_PREFS = {
    keys: KEYS,
    getLang,
    setLang: applyLang,
    getTheme,
    setTheme: applyTheme,
    getConsent,
    setConsent,
    isChatEnabled
  };
})();
