/* assets/chattia-preferences.js */
/* Theme + language controls isolated from chat logic */
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
  const phNodes = qsa("[data-en-ph]");
  const ariaNodes = qsa("[data-en-label]");

  const memoryPrefs = {};
  let persistenceAllowed = false;

  const initialDocLang = (document.documentElement.lang === "es") ? "es" : "en";

  function detectInitialTheme() {
    const attrTheme = document.documentElement.getAttribute("data-theme");
    if (attrTheme === "dark" || attrTheme === "light") return attrTheme;

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
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function readSessionPrefs() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function hydrateState(preferences) {
    if (!preferences || typeof preferences !== "object") return;
    if (preferences.lang === "es" || preferences.lang === "en") state.lang = preferences.lang;
    if (preferences.theme === "dark" || preferences.theme === "light") state.theme = preferences.theme;
  }

  function hasStoredConsent() {
    try { return localStorage.getItem(CONSENT_KEY) === "accepted"; }
    catch { return false; }
  }

  function persist() {
    const payload = { lang: state.lang, theme: state.theme };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload)); } catch {}
    if (persistenceAllowed) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch {}
    } else {
      Object.assign(memoryPrefs, payload);
    }
  }

  hydrateState(readSessionPrefs());

  if (hasStoredConsent()) {
    persistenceAllowed = true;
    hydratePersistedIfAllowed();
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    document.documentElement.classList.toggle("dark-cycle", state.theme === "dark");
    document.body?.classList.toggle("dark-cycle", state.theme === "dark");

    if (themeCtrl) {
      themeCtrl.textContent = (state.theme === "dark") ? "Light" : "Dark";
      themeCtrl.setAttribute("aria-pressed", state.theme === "dark" ? "true" : "false");
    }

    document.dispatchEvent(new CustomEvent("ops:theme-change", { detail: { theme: state.theme } }));
  }

  function translateDom() {
    const toES = state.lang === "es";
    document.documentElement.lang = state.lang;

    if (langCtrl) {
      langCtrl.textContent = toES ? "ES" : "EN";
      langCtrl.setAttribute("aria-pressed", toES ? "true" : "false");
      langCtrl.classList.toggle("active", toES);
    }

    transNodes.forEach((node) => {
      if (!node.dataset) return;
      node.textContent = toES ? node.dataset.es : node.dataset.en;
    });
    phNodes.forEach((node) => {
      if (!node.dataset) return;
      node.placeholder = toES ? node.dataset.esPh : node.dataset.enPh;
    });
    ariaNodes.forEach((node) => {
      if (!node.dataset) return;
      node.setAttribute("aria-label", toES ? node.dataset.esLabel : node.dataset.enLabel);
    });

    document.dispatchEvent(new CustomEvent("ops:language-change", { detail: { lang: state.lang } }));
  }

  function setLanguage(lang) {
    state.lang = (lang === "es") ? "es" : "en";
    translateDom();
    persist();
  }

  function setTheme(theme) {
    state.theme = (theme === "dark") ? "dark" : "light";
    applyTheme();
    persist();
  }

  function hydratePersistedIfAllowed() {
    if (!persistenceAllowed) return;
    const stored = readPersisted();
    if (stored && typeof stored === "object") {
      if (stored.lang === "es" || stored.lang === "en") state.lang = stored.lang;
      if (stored.theme === "dark" || stored.theme === "light") state.theme = stored.theme;
    }
  }

  function setPersistenceAllowed(allowed) {
    const next = !!allowed;
    const prev = persistenceAllowed;
    persistenceAllowed = next;

    if (!next) {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      persist();
      return;
    }

    if (!prev && next) {
      hydratePersistedIfAllowed();
      applyTheme();
      translateDom();
      persist();
    }
  }

  // EVENTS
  if (langCtrl) langCtrl.addEventListener("click", () => setLanguage(state.lang === "es" ? "en" : "es"));
  if (themeCtrl) themeCtrl.addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));

  // INITIAL RENDER
  applyTheme();
  translateDom();
  persist();

  window.opsUiPrefs = {
    getLang: () => state.lang,
    getTheme: () => state.theme,
    setLanguage,
    setTheme,
    toggleLanguage: () => setLanguage(state.lang === "es" ? "en" : "es"),
    toggleTheme: () => setTheme(state.theme === "dark" ? "light" : "dark"),
    setPersistenceAllowed
  };
})();
