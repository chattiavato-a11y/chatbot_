/* assets/chattia-head-lang.js */
(() => {
  "use strict";

  const titleEl = document.querySelector("title[data-en][data-es]");
  const descEl = document.querySelector('meta[name="description"][data-en][data-es]');

  const applyHeadLang = (lang) => {
    const toES = (lang === "es");
    if (titleEl) document.title = toES ? titleEl.dataset.es : titleEl.dataset.en;
    if (descEl) descEl.setAttribute("content", toES ? descEl.dataset.es : descEl.dataset.en);
  };

  applyHeadLang(document.documentElement.lang === "es" ? "es" : "en");
  document.addEventListener("ops:lang-change", (event) => applyHeadLang(event.detail?.lang || "en"));
})();
