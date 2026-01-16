/**
 * app.js — Chattia UI -> Enlace (/api/chat) with SSE streaming over fetch()
 *
 * ✅ No libraries
 * ✅ Safe DOM writes (textContent only)
 * ✅ Streams SSE from Enlace
 * ✅ Mirrors transcript to main + side panels
 * ✅ EN/ES toggle + Dark/Light toggle
 *
 * Optional:
 * - OPS_ASSET_ID / OPS_ASSET_SHA256 (if Enlace enforces allowlist)
 */

(() => {
  "use strict";

  // ---- Endpoint ----
  const ENLACE_API = "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat";

  // ---- Asset identity (OPTIONAL) ----
  // If Enlace has OPS_ASSET_ALLOWLIST set, fill these or requests will be blocked.
  const OPS_ASSET_ID = "";       // e.g. "CHATTIA_WEB_01"
  const OPS_ASSET_SHA256 = "";   // e.g. "9f2c...(hex sha256)"

  // ---- Limits ----
  const MAX_INPUT_CHARS = 1500;
  const MAX_HISTORY = 20;

  // ---- DOM ----
  const elFrame = document.getElementById("app");
  const elMainList = document.getElementById("mainList");
  const elSideList = document.getElementById("sideList");

  const elForm = document.getElementById("chatForm");
  const elTextarea = document.getElementById("input");       // composer textarea
  const elQuickInput = document.getElementById("chatInput"); // bottom quick input
  const elBtnSend = document.getElementById("btnSend");
  const elBtnClear = document.getElementById("btnClear");

  const elBtnMenu = document.getElementById("btnMenu");
  const elBtnMiniMenu = document.getElementById("btnMiniMenu");

  const elBtnLangTop = document.getElementById("btnLangTop");
  const elBtnLangLower = document.getElementById("btnLangLower");
  const elBtnThemeTop = document.getElementById("btnThemeTop");
  const elBtnThemeLower = document.getElementById("btnThemeLower");
  const elSideLang = document.getElementById("sideLang");
  const elSideMode = document.getElementById("sideMode");

  const elStatusDot = document.getElementById("statusDot");
  const elStatusText = document.getElementById("statusText");
  const elCharCount = document.getElementById("charCount");

  const elBtnMic = document.getElementById("btnMic");
  const elBtnWave = document.getElementById("btnWave");
  const elWaveSvg = document.getElementById("waveSvg");

  // Footer links (optional)
  const elLinkTc = document.getElementById("lnkTc");
  const elLinkCookies = document.getElementById("lnkCookies");
  const elLinkContact = document.getElementById("lnkContact");
  const elLinkSupport = document.getElementById("lnkSupport");
  const elLinkAbout = document.getElementById("lnkAbout");

  // ---- State ----
  let history = []; // { role: "user"|"assistant", content: string }[]
  let abortCtrl = null;
  let lang = "en";   // "en" | "es"
  let isDark = true; // default matches your HTML turnstile dark theme
  let msgSeq = 0;
  const msgEls = new Map(); // id -> { mainEl, sideEl }

  // ---- Copy / labels ----
  const I18N = {
    en: {
      ready: "Ready",
      thinking: "Thinking…",
      blocked: "Blocked upstream.",
      placeholderQuick: "Type Your Message",
      placeholderComposer: "Type your message… (Enter to send, Shift+Enter for newline)",
      you: "You",
      bot: "Chattia",
      cleared: "Transcript cleared. I’m ready.",
      voiceNotReady: "Voice is not enabled yet.",
      dark: "Dark",
      light: "Light",
      transcript: "Transcript",
    },
    es: {
      ready: "Listo",
      thinking: "Pensando…",
      blocked: "Bloqueado upstream.",
      placeholderQuick: "Escribe tu mensaje",
      placeholderComposer: "Escribe tu mensaje… (Enter para enviar, Shift+Enter para nueva línea)",
      you: "Tú",
      bot: "Chattia",
      cleared: "Transcripción limpia. Estoy listo.",
      voiceNotReady: "Voz aún no está habilitada.",
      dark: "Oscuro",
      light: "Claro",
      transcript: "Transcripción",
    },
  };

  function t(key) {
    return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  }

  // ---- UI helpers ----
  function setStatus(text, busy) {
    if (elStatusText) elStatusText.textContent = text;
    if (elStatusDot) elStatusDot.classList.toggle("busy", !!busy);
  }

  function setListening(on) {
    if (!elWaveSvg) return;
    elWaveSvg.classList.toggle("listening", !!on);
  }

  function safeTextOnly(s) {
    if (!s) return "";
    return String(s).replace(/\u0000/g, "").trim().slice(0, MAX_INPUT_CHARS);
  }

  function updateCharCount() {
    if (!elCharCount || !elTextarea) return;
    const n = (elTextarea.value || "").length;
    elCharCount.textContent = `${Math.min(n, MAX_INPUT_CHARS)} / ${MAX_INPUT_CHARS}`;
  }

  function setTheme(nextDark) {
    isDark = !!nextDark;
    document.body.classList.toggle("dark", isDark);

    // Update labels
    const label = isDark ? t("dark") : t("light");
    if (elBtnThemeTop) elBtnThemeTop.textContent = label;
    if (elBtnThemeLower) elBtnThemeLower.textContent = label;
    if (elSideMode) elSideMode.textContent = isDark ? "DARK" : "LIGHT";
  }

  function setLanguage(nextLang) {
    lang = nextLang === "es" ? "es" : "en";
    if (elBtnLangTop) elBtnLangTop.textContent = lang.toUpperCase();
    if (elBtnLangLower) elBtnLangLower.textContent = lang.toUpperCase();
    if (elSideLang) elSideLang.textContent = lang.toUpperCase();

    if (elQuickInput) elQuickInput.placeholder = t("placeholderQuick");
    if (elTextarea) elTextarea.placeholder = t("placeholderComposer");

    // Keep status coherent
    setStatus(t("ready"), false);
  }

  function toggleSidePanel() {
    if (!elFrame) return;
    elFrame.classList.toggle("side-collapsed");
  }

  function clearTranscript() {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = null;

    history = [];
    msgSeq = 0;
    msgEls.clear();

    if (elMainList) elMainList.textContent = "";
    if (elSideList) elSideList.textContent = "";

    addLine("assistant", t("cleared"));
    setStatus(t("ready"), false);
    setListening(false);
  }

  function addLine(role, text) {
    const id = ++msgSeq;
    const label = role === "user" ? t("you") : t("bot");
    const lineText = `${label}: ${text || ""}`;

    const mainEl = document.createElement("div");
    mainEl.className = "line";
    mainEl.textContent = lineText;

    const sideEl = document.createElement("div");
    sideEl.className = "line";
    sideEl.textContent = lineText;

    if (elMainList) elMainList.appendChild(mainEl);
    if (elSideList) elSideList.appendChild(sideEl);

    msgEls.set(id, { mainEl, sideEl, role });

    // Scroll main transcript area
    const area = document.getElementById("mainTranscript");
    if (area) area.scrollTop = area.scrollHeight;
    if (elSideList) elSideList.scrollTop = elSideList.scrollHeight;

    return id;
  }

  function updateLine(id, text) {
    const rec = msgEls.get(id);
    if (!rec) return;

    const label = rec.role === "user" ? t("you") : t("bot");
    const lineText = `${label}: ${text || ""}`;

    if (rec.mainEl) rec.mainEl.textContent = lineText;
    if (rec.sideEl) rec.sideEl.textContent = lineText;

    const area = document.getElementById("mainTranscript");
    if (area) area.scrollTop = area.scrollHeight;
    if (elSideList) elSideList.scrollTop = elSideList.scrollHeight;
  }

  function syncInputs(value, source) {
    // source: "composer" | "quick"
    if (source !== "composer" && elTextarea) elTextarea.value = value;
    if (source !== "quick" && elQuickInput) elQuickInput.value = value;
    updateCharCount();
  }

  function getTurnstileToken() {
    // Optional: Enlace can ignore if not used
    try {
      if (window.turnstile && typeof window.turnstile.getResponse === "function") {
        return window.turnstile.getResponse() || "";
      }
    } catch {}
    return "";
  }

  // ---- Token extraction (supports multiple SSE JSON shapes) ----
  function extractTokenFromAnyShape(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;

    if (typeof obj.response === "string") return obj.response;
    if (typeof obj.text === "string") return obj.text;

    if (obj.result && typeof obj.result === "object") {
      if (typeof obj.result.response === "string") return obj.result.response;
      if (typeof obj.result.text === "string") return obj.result.text;
    }

    if (obj.response && typeof obj.response === "object") {
      if (typeof obj.response.content === "string") return obj.response.content;
      if (typeof obj.response.response === "string") return obj.response.response;
    }

    if (Array.isArray(obj.choices) && obj.choices[0]) {
      const c = obj.choices[0];
      const delta = c.delta || c.message || c;
      if (delta && typeof delta.content === "string") return delta.content;
      if (typeof c.text === "string") return c.text;
    }

    return "";
  }

  function processSseEventData(data, onToken) {
    const trimmed = String(data || "").trim();
    if (!trimmed) return { done: false };
    if (trimmed === "[DONE]") return { done: true };

    let token = "";
    try {
      const obj = JSON.parse(trimmed);
      token = extractTokenFromAnyShape(obj);
    } catch {
      token = trimmed;
    }

    if (token) onToken(token);
    return { done: false };
  }

  async function streamFromEnlace(payload, onToken) {
    abortCtrl = new AbortController();

    const headers = {
      "content-type": "application/json",
      "accept": "text/event-stream",
    };

    if (OPS_ASSET_ID) headers["x-ops-asset-id"] = OPS_ASSET_ID;
    if (OPS_ASSET_SHA256) headers["x-ops-asset-sha256"] = OPS_ASSET_SHA256;

    const resp = await fetch(ENLACE_API, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers,
      body: JSON.stringify(payload),
      signal: abortCtrl.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${text}`);
    }

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const obj = await resp.json().catch(() => null);
      const token = extractTokenFromAnyShape(obj) || JSON.stringify(obj || {});
      if (token) onToken(token);
      return;
    }

    if (!resp.body) throw new Error("No response body (stream missing).");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let eventData = "";
    let doneSeen = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        if (line === "") {
          const res = processSseEventData(eventData, onToken);
          eventData = "";
          if (res.done) {
            doneSeen = true;
            break;
          }
          continue;
        }

        if (line.startsWith("data:")) {
          let chunk = line.slice(5);
          if (chunk.startsWith(" ")) chunk = chunk.slice(1);
          eventData += (eventData ? "\n" : "") + chunk;
        }
      }

      if (doneSeen) break;
    }

    if (!doneSeen && eventData) processSseEventData(eventData, onToken);
  }

  async function sendMessage(rawText) {
    const userText = safeTextOnly(rawText);
    if (!userText) return;

    // Cancel any in-flight stream (so the UX never “double streams”)
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = null;

    setListening(false);
    setStatus(t("thinking"), true);

    // Transcript: user line
    addLine("user", userText);
    history.push({ role: "user", content: userText });
    history = history.slice(-MAX_HISTORY);

    // Transcript: assistant line (stream updates into it)
    const botLineId = addLine("assistant", "");

    // Disable send button while streaming
    if (elBtnSend) elBtnSend.disabled = true;

    let botText = "";
    let rafId = null;

    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateLine(botLineId, botText);
      });
    };

    try {
      const turnstileToken = getTurnstileToken();

      const payload = {
        messages: history,
        // optional metadata (Enlace can ignore)
        meta: { lang, theme: isDark ? "dark" : "light" },
        turnstile: turnstileToken || undefined,
      };

      await streamFromEnlace(payload, (token) => {
        botText += token;
        scheduleUpdate();
      });

      if (rafId) cancelAnimationFrame(rafId);
      if (!botText.trim()) botText = "(no output)";
      updateLine(botLineId, botText);

      history.push({ role: "assistant", content: botText });
      history = history.slice(-MAX_HISTORY);

      setStatus(t("ready"), false);
    } catch (err) {
      const msg = err && err.name === "AbortError"
        ? "Stopped."
        : `Error:\n${String(err?.message || err)}`;

      updateLine(botLineId, msg);
      setStatus(t("ready"), false);
    } finally {
      if (elBtnSend) elBtnSend.disabled = false;
      abortCtrl = null;
      setListening(false);
    }
  }

  // ---- Events ----
  if (elForm) {
    elForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = (elTextarea && elTextarea.value) ? elTextarea.value : "";
      syncInputs("", "composer");
      sendMessage(text);
      if (elTextarea) elTextarea.focus();
    });
  }

  if (elTextarea) {
    elTextarea.addEventListener("input", () => {
      updateCharCount();
      syncInputs(elTextarea.value || "", "composer");
    });
    elTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (elForm) elForm.requestSubmit();
      }
      // ESC cancels streaming
      if (e.key === "Escape" && abortCtrl) abortCtrl.abort();
    });
  }

  if (elQuickInput) {
    elQuickInput.addEventListener("input", () => {
      syncInputs(elQuickInput.value || "", "quick");
    });
    elQuickInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = elQuickInput.value || "";
        syncInputs("", "quick");
        sendMessage(text);
      }
      if (e.key === "Escape" && abortCtrl) abortCtrl.abort();
    });
  }

  function toggleLang() {
    setLanguage(lang === "en" ? "es" : "en");
  }
  function toggleTheme() {
    setTheme(!isDark);
  }

  if (elBtnLangTop) elBtnLangTop.addEventListener("click", toggleLang);
  if (elBtnLangLower) elBtnLangLower.addEventListener("click", toggleLang);

  if (elBtnThemeTop) elBtnThemeTop.addEventListener("click", toggleTheme);
  if (elBtnThemeLower) elBtnThemeLower.addEventListener("click", toggleTheme);

  if (elBtnMenu) elBtnMenu.addEventListener("click", toggleSidePanel);
  if (elBtnMiniMenu) elBtnMiniMenu.addEventListener("click", toggleSidePanel);

  if (elBtnClear) elBtnClear.addEventListener("click", clearTranscript);

  if (elBtnMic) {
    elBtnMic.addEventListener("click", () => {
      // Stub for now (CX-friendly response)
      addLine("assistant", t("voiceNotReady"));
    });
  }
  if (elBtnWave) {
    elBtnWave.addEventListener("click", () => {
      // Visual-only toggle for now
      setListening(!elWaveSvg?.classList.contains("listening"));
    });
  }

  // Optional: set links (safe defaults)
  function setLink(el, href) {
    if (!el) return;
    el.href = href || "#";
  }
  setLink(elLinkTc, "#");
  setLink(elLinkCookies, "#");
  setLink(elLinkContact, "#");
  setLink(elLinkSupport, "#");
  setLink(elLinkAbout, "#");

  // ---- Boot ----
  setTheme(true);
  setLanguage("en");
  updateCharCount();
  setStatus(t("ready"), false);
  addLine("assistant", "Hi — I’m ready. Ask me anything (plain text).");
})();
