/* assets/chattia-preferences.js
   Chattia / OPS — Preferences (v2)
   - Manages: language, theme, chat consent
   - No cookies, no network calls
   - localStorage only (fails safe if blocked)
*/

(() => {
  const KEYS = {
    lang: "ops_lang",
    theme: "ops_theme",           // "dark" | "light"
    consent: "ops_chat_consent"   // "accepted" | "denied" | null
  };

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, val); } catch {}
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

  function applyTheme(theme) {
    const t = normalizeTheme(theme);
    document.documentElement.dataset.theme = t;
    document.documentElement.classList.toggle("theme-light", t === "light");
    document.documentElement.classList.toggle("theme-dark", t !== "light");
    if (getConsent() === "accepted") safeSet(KEYS.theme, t);
    window.__OPS_THEME = t;
    return t;
  }

  function getTheme() {
    const saved = safeGet(KEYS.theme);
    if (saved === "light" || saved === "dark") return saved;
    return "light";
  }

  /* ---------------- Language ---------------- */

  function applyLang(lang) {
    const l = normalizeLang(lang);
    if (getConsent() === "accepted") safeSet(KEYS.lang, l);
    // delegate to head-lang bootstrap if present
    if (typeof window.__OPS_setLang === "function") window.__OPS_setLang(l);
    else {
      document.documentElement.setAttribute("lang", l);
      document.documentElement.dataset.lang = l;
      window.__OPS_LANG = l;
    }
    return l;
  }

  function getLang() {
    const saved = safeGet(KEYS.lang);
    if (saved === "es" || saved === "en") return saved;
    return "en";
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
      return null;
    }
    safeSet(KEYS.consent, s);
    window.__OPS_CHAT_CONSENT = s;
    return s;
  }

  function isChatEnabled() {
    return getConsent() === "accepted";
  }

  /* ---------------- Init ---------------- */

  // theme
  applyTheme(getTheme());

  // lang (head-lang already sets; we keep consistent)
  applyLang(getLang());

  // consent
  window.__OPS_CHAT_CONSENT = getConsent();

  /* ---------------- UI hooks (optional) ----------------
     Any element with:
     - data-action="set-lang"  data-value="en|es"
     - data-action="set-theme" data-value="dark|light"
     - data-action="accept-consent"
     - data-action="deny-consent"
  */
  function onClick(e) {
    const el = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
    if (!el) return;

    const action = el.getAttribute("data-action") || "";
    const value = el.getAttribute("data-value") || "";

    if (action === "set-lang") {
      applyLang(value);
      return;
    }

    if (action === "set-theme") {
      applyTheme(value);
      return;
    }

    if (action === "accept-consent") {
      setConsent("accepted");
      window.dispatchEvent(new CustomEvent("ops:consent", { detail: { consent: "accepted" } }));
      return;
    }

    if (action === "deny-consent") {
      setConsent("denied");
      window.dispatchEvent(new CustomEvent("ops:consent", { detail: { consent: "denied" } }));
      return;
    }
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
