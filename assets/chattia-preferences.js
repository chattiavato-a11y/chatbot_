/* assets/chattia-preferences.js */
(() => {
  "use strict";

  const qs  = (s) => document.querySelector(s);
  const qsa = (s) => [...document.querySelectorAll(s)];

  const STORAGE_KEY = "ops-chat-preferences";
  const SESSION_KEY = "ops-chat-preferences-session";
  const CONSENT_KEY = "ops-chat-consent";

  const langButtons = qsa("[data-lang-btn]");
  const themeButtons = qsa("[data-theme-btn]");

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

    themeButtons.forEach((btn) => {
      const val = btn.getAttribute("data-theme-btn");
      const active = val === state.theme;
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });

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

    qsa("[data-en-placeholder][data-es-placeholder]").forEach((node) => {
      const enPh = node.getAttribute("data-en-placeholder");
      const esPh = node.getAttribute("data-es-placeholder");
      if (enPh && esPh) node.setAttribute("placeholder", toES ? esPh : enPh);
    });

    qsa("[data-en-label][data-es-label]").forEach((node) => {
      const enL = node.getAttribute("data-en-label");
      const esL = node.getAttribute("data-es-label");
      if (enL && esL) node.setAttribute("aria-label", toES ? esL : enL);
    });

    langButtons.forEach((btn) => {
      const val = btn.getAttribute("data-lang-btn");
      const active = val === state.lang;
      const enTxt = btn.getAttribute("data-en");
      const esTxt = btn.getAttribute("data-es");
      if (enTxt && esTxt) btn.textContent = toES ? esTxt : enTxt;
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });

    document.dispatchEvent(new CustomEvent("ops:lang-change", { detail: { lang: state.lang } }));
  }

  function setLang(next) {
    state.lang = (next === "es") ? "es" : "en";
    persistState();
    translateDom();
  }

  function setTheme(next) {
    state.theme = (next === "dark") ? "dark" : "light";
    persistState();
    applyTheme();
  }

  const persisted = readPersisted() || readSession(SESSION_KEY);
  if (persisted && typeof persisted === "object") {
    if (persisted.lang === "en" || persisted.lang === "es") state.lang = persisted.lang;
    if (persisted.theme === "dark" || persisted.theme === "light") state.theme = persisted.theme;
  }

  applyTheme();
  translateDom();

  langButtons.forEach((btn) => {
    btn.addEventListener("click", () => setLang(btn.getAttribute("data-lang-btn")));
  });
  themeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.getAttribute("data-theme-btn")));
  });

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
