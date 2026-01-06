/* assets/chattia-preferences.js */
(() => {
  "use strict";

  const qs  = (s) => document.querySelector(s);
  const qsa = (s) => [...document.querySelectorAll(s)];

  const STORAGE_KEY = "ops-chat-preferences";
  const SESSION_KEY = "ops-chat-preferences-session";
  const CONSENT_KEY = "ops-chat-consent";

  const langCtrl = qs("#langCtrl");
  const themeCtrl = qs("#themeCtrl");

  const transNodes = qsa("[data-en]");

  function safeJSONParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  function readConsent() {
    try { return localStorage.getItem(CONSENT_KEY) || "pending"; }
    catch { return "pending"; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function readStorage(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? safeJSONParse(raw, null) : null;
    } catch {
      return null;
    }
  }

  function writeSession(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function readSession(key) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? safeJSONParse(raw, null) : null;
    } catch {
      return null;
    }
  }

  const initialDocLang = (document.documentElement.lang === "es" ? "es" : "en");

  function detectInitialTheme() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;

    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }

    return "light";
  }

  const state = {
    lang: initialDocLang,
    theme: detectInitialTheme()
  };

  function readPersisted() {
    const consent = readConsent();
    const allowPersist = (consent === "accepted");
    if (!allowPersist) return null;
    return readStorage(STORAGE_KEY);
  }

  function persistState() {
    const consent = readConsent();
    const allowPersist = (consent === "accepted");
    if (!allowPersist) {
      writeSession(SESSION_KEY, state);
      return;
    }
    writeStorage(STORAGE_KEY, state);
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);

    const isDark = state.theme === "dark";
    document.documentElement.classList.toggle("dark-cycle", isDark);
    document.body?.classList.toggle("dark-cycle", isDark);

    document.documentElement.classList.toggle("light-cycle", !isDark);
    document.body?.classList.toggle("light-cycle", !isDark);

    if (themeCtrl) {
      themeCtrl.textContent = isDark ? "Light" : "Dark";
      themeCtrl.setAttribute("aria-pressed", isDark ? "true" : "false");
    }

    document.dispatchEvent(new CustomEvent("ops:theme-change", { detail: { theme: state.theme } }));
  }

  function translateDom() {
    const toES = state.lang === "es";
    document.documentElement.lang = state.lang;

    transNodes.forEach((node) => {
      const en = node.getAttribute("data-en");
      const es = node.getAttribute("data-es");
      if (!en || !es) return;
      node.textContent = toES ? es : en;
    });

    const inEl = qs("#chatbot-input");
    if (inEl) {
      const enPh = inEl.getAttribute("data-en-placeholder");
      const esPh = inEl.getAttribute("data-es-placeholder");
      if (enPh && esPh) inEl.setAttribute("placeholder", toES ? esPh : enPh);
    }

    qsa("[data-en-label][data-es-label]").forEach((node) => {
      const enL = node.getAttribute("data-en-label");
      const esL = node.getAttribute("data-es-label");
      if (enL && esL) node.setAttribute("aria-label", toES ? esL : enL);
    });

    if (langCtrl) {
      langCtrl.textContent = toES ? "ES" : "EN";
      langCtrl.setAttribute("aria-pressed", toES ? "true" : "false");
    }

    document.dispatchEvent(new CustomEvent("ops:lang-change", { detail: { lang: state.lang } }));
  }

  function setLang(next) {
    state.lang = (next === "es") ? "es" : "en";
    persistState();
    translateDom();
  }

  function toggleLang() {
    setLang(state.lang === "es" ? "en" : "es");
  }

  function setTheme(next) {
    state.theme = (next === "dark") ? "dark" : "light";
    persistState();
    applyTheme();
  }

  function toggleTheme() {
    setTheme(state.theme === "dark" ? "light" : "dark");
  }

  const persisted = readPersisted() || readSession(SESSION_KEY);
  if (persisted && typeof persisted === "object") {
    if (persisted.lang === "en" || persisted.lang === "es") state.lang = persisted.lang;
    if (persisted.theme === "dark" || persisted.theme === "light") state.theme = persisted.theme;
  }

  applyTheme();
  translateDom();

  if (langCtrl) langCtrl.addEventListener("click", toggleLang);
  if (themeCtrl) themeCtrl.addEventListener("click", toggleTheme);

  window.OPS_PREFS = {
    getLang: () => state.lang,
    getTheme: () => state.theme,
    setPersistenceAllowed: (allowed) => {
      if (allowed) {
        const session = readSession(SESSION_KEY);
        if (session) writeStorage(STORAGE_KEY, session);
      } else {
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
      }
    }
  };
})();
