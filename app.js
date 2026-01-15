/**
 * app.js — Chattia UI -> Enlace (/api/chat) with SSE streaming over fetch()
 *
 * ✅ Matches your HTML IDs:
 *   - main transcript:  #mainList (inside #mainTranscript)
 *   - side transcript:  #sideList
 *   - quick input:      #chatInput
 *   - composer form:    #chatForm + #input + #btnSend + #charCount
 *   - status:           #statusDot + #statusText
 *   - toggles:          #btnLangTop/#btnLangLower, #btnThemeTop/#btnThemeLower, #sideLang/#sideMode
 *   - transcript open:  #btnMenu + #btnMiniMenu + (click "Transcript" title)
 *
 * ✅ Safe DOM writes (textContent only)
 * ✅ Robust SSE parsing (multi-line events)
 * ✅ Works with Enlace streaming raw SSE back from Brain
 * ✅ No extra headers (keeps CORS happy) + optional asset headers (ONLY if you set them)
 */

(() => {
  "use strict";

  // =========================
  // 1) CONFIG
  // =========================
  const ENLACE_API = "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat";

  // Optional asset identity headers (ONLY enable if Enlace enforces OPS_ASSET_ALLOWLIST)
  // Leave empty to send nothing.
  const OPS_ASSET_ID = "";       // e.g. "CHATTIA_WEB_01"
  const OPS_ASSET_SHA256 = "";   // e.g. "9f2c... (hex sha256)"

  const MAX_INPUT_CHARS = 1500;

  // =========================
  // 2) DOM
  // =========================
  const elFrame = document.querySelector(".frame");
  const elMainTranscript = document.getElementById("mainTranscript");
  const elMainList = document.getElementById("mainList");
  const elSideList = document.getElementById("sideList");
  const elSideBody = document.querySelector(".sideBody");

  const elForm = document.getElementById("chatForm");
  const elInput = document.getElementById("input");         // textarea composer
  const elChatInput = document.getElementById("chatInput"); // quick input
  const elBtnSend = document.getElementById("btnSend");
  const elCharCount = document.getElementById("charCount");

  const elBtnClear = document.getElementById("btnClear");
  const elBtnMenu = document.getElementById("btnMenu");
  const elBtnMiniMenu = document.getElementById("btnMiniMenu");

  const elBtnMic = document.getElementById("btnMic");     // optional; UX hook only
  const elBtnWave = document.getElementById("btnWave");   // used as Stop while streaming (nice HCI)

  const elBtnLangTop = document.getElementById("btnLangTop");
  const elBtnLangLower = document.getElementById("btnLangLower");
  const elBtnThemeTop = document.getElementById("btnThemeTop");
  const elBtnThemeLower = document.getElementById("btnThemeLower");
  const elSideLang = document.getElementById("sideLang");
  const elSideMode = document.getElementById("sideMode");

  const elStatusDot = document.getElementById("statusDot");
  const elStatusTxt = document.getElementById("statusText");

  // Make key areas accessible (HCI 2026 baseline)
  if (elStatusTxt) elStatusTxt.setAttribute("aria-live", "polite");
  if (elMainTranscript) {
    elMainTranscript.setAttribute("role", "log");
    elMainTranscript.setAttribute("aria-live", "polite");
    elMainTranscript.setAttribute("aria-relevant", "additions text");
  }
  if (elSideList) {
    elSideList.setAttribute("role", "log");
    elSideList.setAttribute("aria-live", "polite");
    elSideList.setAttribute("aria-relevant", "additions text");
  }

  // The "Transcript" label in lowerHeader: make it a toggle button
  const elTranscriptTitle = document.querySelector(".lowerHeader .title");
  if (elTranscriptTitle) {
    elTranscriptTitle.setAttribute("role", "button");
    elTranscriptTitle.setAttribute("tabindex", "0");
    elTranscriptTitle.setAttribute("aria-label", "Toggle transcript panel");
    elTranscriptTitle.style.cursor = "pointer";
  }

  // =========================
  // 3) STATE
  // =========================
  const state = {
    history: [], // { role:"user"|"assistant", content:string }[]
    streaming: false,
    abortCtrl: null,
    assistantText: "",
    assistantNodes: null, // { mainEl, sideEl }
    lang: "EN",
    theme: "dark",
    transcriptOpen: false,
  };

  // =========================
  // 4) UTIL
  // =========================
  function safeTextOnly(s) {
    if (!s) return "";
    return String(s)
      .replace(/\u0000/g, "")
      .trim()
      .slice(0, MAX_INPUT_CHARS);
  }

  function setStatus(text, busy) {
    if (elStatusTxt) elStatusTxt.textContent = text || "";
    if (elStatusDot) elStatusDot.classList.toggle("busy", !!busy);
  }

  function scrollToBottom() {
    // main transcript container
    if (elMainTranscript) elMainTranscript.scrollTop = elMainTranscript.scrollHeight;
    // side transcript container
    if (elSideBody) elSideBody.scrollTop = elSideBody.scrollHeight;
  }

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

    // OpenAI-like / "choices" shapes
    if (Array.isArray(obj.choices) && obj.choices[0]) {
      const c = obj.choices[0];
      const delta = c.delta || c.message || c;
      if (delta && typeof delta.content === "string") return delta.content;
      if (typeof c.text === "string") return c.text;
    }

    return "";
  }

  // =========================
  // 5) TRANSCRIPT RENDERING (matches your CSS: .line in #mainList/#sideList)
  // =========================
  function linePrefix(role) {
    if (role === "user") return state.lang === "ES" ? "Tú: " : "You: ";
    return state.lang === "ES" ? "Chattia: " : "Chattia: ";
  }

  function addLine(role, text) {
    const prefix = linePrefix(role);
    const content = prefix + (text || "");

    const mainEl = document.createElement("div");
    mainEl.className = "line";
    mainEl.textContent = content;

    const sideEl = document.createElement("div");
    sideEl.className = "line";
    sideEl.textContent = content;

    if (elMainList) elMainList.appendChild(mainEl);
    if (elSideList) elSideList.appendChild(sideEl);

    scrollToBottom();
    return { mainEl, sideEl };
  }

  function updateLine(nodes, role, text) {
    if (!nodes) return;
    const prefix = linePrefix(role);
    const content = prefix + (text || "");
    if (nodes.mainEl) nodes.mainEl.textContent = content;
    if (nodes.sideEl) nodes.sideEl.textContent = content;
    scrollToBottom();
  }

  function clearTranscript() {
    if (elMainList) elMainList.innerHTML = "";
    if (elSideList) elSideList.innerHTML = "";
    state.history = [];
    state.assistantText = "";
    state.assistantNodes = null;
    setStatus(state.lang === "ES" ? "Listo" : "Ready", false);
    welcome();
  }

  function welcome() {
    addLine("assistant", state.lang === "ES"
      ? "Hola — estoy listo. Pregúntame lo que quieras (solo texto)."
      : "Hi — I’m ready. Ask me anything (plain text only)."
    );
  }

  // =========================
  // 6) THEME + LANGUAGE (HCI: consistent labels + persistence)
  // =========================
  function applyTheme(mode) {
    state.theme = mode === "light" ? "light" : "dark";
    document.body.classList.toggle("dark", state.theme === "dark");

    const themeLabel = state.theme === "dark" ? "Dark" : "Light";
    if (elBtnThemeTop) elBtnThemeTop.textContent = themeLabel;
    if (elBtnThemeLower) elBtnThemeLower.textContent = themeLabel;
    if (elSideMode) elSideMode.textContent = themeLabel.toUpperCase();

    // Turnstile theme attribute (best effort)
    const turnstileEl = document.querySelector(".cf-turnstile");
    if (turnstileEl) turnstileEl.setAttribute("data-theme", state.theme === "dark" ? "dark" : "light");

    try { localStorage.setItem("chattia_theme", state.theme); } catch {}
  }

  function toggleTheme() {
    applyTheme(state.theme === "dark" ? "light" : "dark");
  }

  function applyLang(lang) {
    state.lang = (lang === "ES") ? "ES" : "EN";
    if (elBtnLangTop) elBtnLangTop.textContent = state.lang;
    if (elBtnLangLower) elBtnLangLower.textContent = state.lang;
    if (elSideLang) elSideLang.textContent = state.lang;

    // Placeholders & microcopy
    if (elChatInput) elChatInput.placeholder = state.lang === "ES" ? "Escribe tu mensaje" : "Type Your Message";
    if (elInput) elInput.placeholder = state.lang === "ES"
      ? "Escribe tu mensaje… (Enter para enviar, Shift+Enter para nueva línea)"
      : "Type your message… (Enter to send, Shift+Enter for newline)";

    // Status text if idle
    if (!state.streaming) setStatus(state.lang === "ES" ? "Listo" : "Ready", false);

    // IMPORTANT: we don’t rewrite old transcript lines (keeps auditability)
    try { localStorage.setItem("chattia_lang", state.lang); } catch {}
  }

  function toggleLang() {
    applyLang(state.lang === "EN" ? "ES" : "EN");
  }

  // =========================
  // 7) TRANSCRIPT PANEL OPEN/CLOSE (matches your CSS .frame.side-collapsed)
  // =========================
  function setTranscriptOpen(open) {
    state.transcriptOpen = !!open;
    if (elFrame) elFrame.classList.toggle("side-collapsed", !state.transcriptOpen);

    // A11y: reflect state
    const expanded = String(state.transcriptOpen);
    if (elBtnMenu) elBtnMenu.setAttribute("aria-expanded", expanded);
    if (elBtnMiniMenu) elBtnMiniMenu.setAttribute("aria-expanded", expanded);
    if (elTranscriptTitle) elTranscriptTitle.setAttribute("aria-expanded", expanded);

    try { localStorage.setItem("chattia_transcript_open", state.transcriptOpen ? "1" : "0"); } catch {}
  }

  function toggleTranscript() {
    setTranscriptOpen(!state.transcriptOpen);
  }

  // =========================
  // 8) INPUT SYNC + CHAR COUNT
  // =========================
  function updateCharCount() {
    if (!elCharCount || !elInput) return;
    const len = (elInput.value || "").length;
    const clamped = Math.min(len, MAX_INPUT_CHARS);
    elCharCount.textContent = `${clamped} / ${MAX_INPUT_CHARS}`;
  }

  function syncInputs(value, from) {
    const v = typeof value === "string" ? value : "";
    if (from !== "composer" && elInput && elInput.value !== v) elInput.value = v;
    if (from !== "quick" && elChatInput && elChatInput.value !== v) elChatInput.value = v;
    updateCharCount();
  }

  // =========================
  // 9) SSE STREAMING (UI <- Enlace SSE)
  // =========================
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
    state.abortCtrl = new AbortController();

    const headers = {
      "content-type": "application/json",
      "accept": "text/event-stream",
    };

    // Optional asset identity headers (ONLY if configured)
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
      signal: state.abortCtrl.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${text}`);
    }

    const ct = (resp.headers.get("content-type") || "").toLowerCase();

    // Non-stream fallback
    if (ct.includes("application/json")) {
      const obj = await resp.json().catch(() => null);
      const token = extractTokenFromAnyShape(obj) || (obj ? JSON.stringify(obj) : "");
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

        // blank line => dispatch event
        if (line === "") {
          const res = processSseEventData(eventData, onToken);
          eventData = "";
          if (res.done) {
            doneSeen = true;
            break;
          }
          continue;
        }

        // ignore fields except data:
        if (line.startsWith("data:")) {
          let chunk = line.slice(5);
          if (chunk.startsWith(" ")) chunk = chunk.slice(1);
          eventData += (eventData ? "\n" : "") + chunk;
        }
      }

      if (doneSeen) break;
    }

    // flush trailing
    if (!doneSeen && eventData) processSseEventData(eventData, onToken);
  }

  // =========================
  // 10) SEND / STOP FLOW (HCI: one obvious control, consistent behavior)
  // =========================
  function setStreamingUI(on) {
    state.streaming = !!on;

    // Send button doubles as Stop while streaming
    if (elBtnSend) {
      elBtnSend.textContent = state.streaming ? (state.lang === "ES" ? "Detener" : "Stop") : (state.lang === "ES" ? "Enviar" : "Send");
      elBtnSend.setAttribute("aria-label", state.streaming ? "Stop response" : "Send message");
    }

    // Wave icon animates while streaming (nice feedback)
    if (elBtnWave) elBtnWave.classList.toggle("listening", state.streaming);

    setStatus(
      state.streaming ? (state.lang === "ES" ? "Pensando…" : "Thinking…") : (state.lang === "ES" ? "Listo" : "Ready"),
      state.streaming
    );
  }

  function stopStreaming() {
    if (state.abortCtrl) {
      try { state.abortCtrl.abort(); } catch {}
    }
  }

  function readTurnstileTokenBestEffort() {
    // Turnstile typically injects: <input type="hidden" name="cf-turnstile-response" ...>
    const inp = document.querySelector('input[name="cf-turnstile-response"]');
    const token = (inp && typeof inp.value === "string") ? inp.value.trim() : "";
    return token;
  }

  async function sendMessage(rawText) {
    const userText = safeTextOnly(rawText);
    if (!userText) return;

    // If currently streaming, clicking Send/Submit stops instead (HCI: predictable)
    if (state.streaming) {
      stopStreaming();
      return;
    }

    // Add user line to transcript
    addLine("user", userText);
    state.history.push({ role: "user", content: userText });

    // Create assistant line and stream into it
    state.assistantText = "";
    state.assistantNodes = addLine("assistant", "");

    setStreamingUI(true);

    // Optional: include Turnstile token in body (no extra headers)
    const turnstileToken = readTurnstileTokenBestEffort();

    const payload = {
      messages: state.history,
      // harmless if Enlace ignores it; helpful if you later validate it
      turnstile: turnstileToken || undefined,
      client: {
        lang: state.lang,
        theme: state.theme,
      },
    };

    let rafId = null;
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateLine(state.assistantNodes, "assistant", state.assistantText);
      });
    };

    try {
      await streamFromEnlace(payload, (token) => {
        state.assistantText += token;
        scheduleUpdate();
      });

      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }

      const finalText = state.assistantText.trim() ? state.assistantText : (state.lang === "ES" ? "(sin respuesta)" : "(no output)");
      state.assistantText = finalText;
      updateLine(state.assistantNodes, "assistant", finalText);

      state.history.push({ role: "assistant", content: finalText });
    } catch (err) {
      const msg =
        err && err.name === "AbortError"
          ? (state.lang === "ES" ? "Detenido." : "Stopped.")
          : `${state.lang === "ES" ? "Error" : "Error"}:\n${String(err?.message || err)}`;

      updateLine(state.assistantNodes, "assistant", msg);
    } finally {
      state.abortCtrl = null;
      setStreamingUI(false);
    }
  }

  // =========================
  // 11) EVENTS
  // =========================
  if (elForm) {
    elForm.addEventListener("submit", (e) => {
      e.preventDefault();
      // Use textarea as primary source for submission
      const text = elInput ? elInput.value || "" : "";
      syncInputs("", "composer");
      sendMessage(text);
      if (elInput) elInput.focus();
    });
  }

  // Composer: Enter sends, Shift+Enter newline
  if (elInput) {
    elInput.addEventListener("input", () => syncInputs(elInput.value || "", "composer"));
    elInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (elForm) elForm.requestSubmit();
      }
      // Escape stops streaming
      if (e.key === "Escape") stopStreaming();
    });
  }

  // Quick input: Enter sends
  if (elChatInput) {
    elChatInput.addEventListener("input", () => syncInputs(elChatInput.value || "", "quick"));
    elChatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const current = elChatInput.value || "";
        syncInputs("", "quick");
        sendMessage(current);
      }
      if (e.key === "Escape") stopStreaming();
    });
  }

  // Send button click: if streaming, Stop; else send form submit
  if (elBtnSend) {
    elBtnSend.addEventListener("click", (e) => {
      if (state.streaming) {
        e.preventDefault();
        stopStreaming();
      }
    });
  }

  // Wave button acts as Stop while streaming (no new UI required)
  if (elBtnWave) {
    elBtnWave.addEventListener("click", () => {
      if (state.streaming) stopStreaming();
    });
    elBtnWave.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && state.streaming) {
        e.preventDefault();
        stopStreaming();
      }
    });
  }

  // Menu toggles transcript panel
  if (elBtnMenu) {
    elBtnMenu.addEventListener("click", toggleTranscript);
    elBtnMenu.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTranscript();
      }
    });
  }
  if (elBtnMiniMenu) {
    elBtnMiniMenu.addEventListener("click", toggleTranscript);
    elBtnMiniMenu.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTranscript();
      }
    });
  }
  if (elTranscriptTitle) {
    elTranscriptTitle.addEventListener("click", toggleTranscript);
    elTranscriptTitle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTranscript();
      }
    });
  }

  // Clear transcript
  if (elBtnClear) {
    elBtnClear.addEventListener("click", () => {
      stopStreaming();
      clearTranscript();
    });
  }

  // Language toggles
  if (elBtnLangTop) {
    elBtnLangTop.addEventListener("click", toggleLang);
    elBtnLangTop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleLang();
      }
    });
  }
  if (elBtnLangLower) {
    elBtnLangLower.addEventListener("click", toggleLang);
    elBtnLangLower.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleLang();
      }
    });
  }

  // Theme toggles
  if (elBtnThemeTop) {
    elBtnThemeTop.addEventListener("click", toggleTheme);
    elBtnThemeTop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTheme();
      }
    });
  }
  if (elBtnThemeLower) {
    elBtnThemeLower.addEventListener("click", toggleTheme);
    elBtnThemeLower.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTheme();
      }
    });
  }

  // Mic button (placeholder UX hook)
  if (elBtnMic) {
    elBtnMic.addEventListener("click", () => {
      // intentionally no voice logic yet (keeps CSP + security clean)
      // You can wire Web Speech API later if you want.
      setStatus(state.lang === "ES" ? "Voz: próximamente" : "Voice: coming soon", false);
      setTimeout(() => setStatus(state.lang === "ES" ? "Listo" : "Ready", false), 900);
    });
  }

  // Global: Escape stops streaming anywhere
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") stopStreaming();
  });

  // =========================
  // 12) BOOT
  // =========================
  // Restore persisted prefs (best effort)
  try {
    const savedTheme = localStorage.getItem("chattia_theme");
    const savedLang = localStorage.getItem("chattia_lang");
    const savedOpen = localStorage.getItem("chattia_transcript_open");
    if (savedLang) state.lang = savedLang === "ES" ? "ES" : "EN";
    if (savedTheme) state.theme = savedTheme === "light" ? "light" : "dark";
    if (savedOpen) state.transcriptOpen = savedOpen === "1";
  } catch {}

  applyLang(state.lang);
  applyTheme(state.theme);

  // Default behavior: transcript panel CLOSED (matches your “Transcript button → popup” expectation)
  // If you prefer it open by default, change `false` to `true`.
  setTranscriptOpen(state.transcriptOpen);

  clearTranscript(); // also calls welcome()
  updateCharCount();
  if (elInput) elInput.focus();
})();
