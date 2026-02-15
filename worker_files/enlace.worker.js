/* ================================
   FILE: worker_files/enlace.worker.js
   PURPOSE:
   - Repo-side client module that app.js uses via window.EnlaceRepo
   - Loads worker_files/worker.config.json
   - Enforces OPS asset identity + optional repo source integrity id
   - Adds “tiny ML” integrity double-check (post-sanitizer) before sending to CF Worker
   - Provides: init(), getConfig(), postChat(), postVoiceSTT(), postTTS()
================================== */

(() => {
  "use strict";

  const CONFIG_PATH_DEFAULT = "worker_files/worker.config.json";

  // -------------------------
  // Local state
  // -------------------------
  let _config = null;
  let _originAssetMap = new Map();

  // -------------------------
  // Small helpers
  // -------------------------
  const safeText = (v) => {
    const s = String(v ?? "");
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160;
      if (ok) out += s[i];
    }
    return out.trim();
  };

  const normalizeOrigin = (value) => {
    if (!value) return "";
    try {
      return new URL(String(value), window.location.origin).origin.toLowerCase();
    } catch {
      return String(value).trim().replace(/\/$/, "").toLowerCase();
    }
  };

  const isHttpsUrl = (value) => {
    try {
      const u = new URL(String(value));
      return u.protocol === "https:";
    } catch {
      return false;
    }
  };

  const looksLikeAssetId = (value) => /^asset_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(value || ""));

  // base64-ish (URL-safe not required) and allow no padding
  const looksLikeSha512B64 = (value) => /^[A-Za-z0-9+/=]{32,256}$/.test(String(value || ""));

  // -------------------------
  // Basic sanitizer (client-side)
  // -------------------------
  const stripDangerousMarkup = (text) => {
    let t = String(text ?? "");
    t = t.replace(/\u0000/g, "");
    t = t.replace(/\r\n?/g, "\n");

    // strip script/style blocks
    t = t.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");

    // strip high-risk tags (best-effort)
    t = t.replace(/<\s*(iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, "");
    t = t.replace(/<\s*\/\s*(iframe|object|embed|link|meta|base|form)\s*>/gi, "");

    // strip dangerous schemes
    t = t.replace(/\bjavascript\s*:/gi, "");
    t = t.replace(/\bvbscript\s*:/gi, "");
    t = t.replace(/\bdata\s*:\s*text\/html\b/gi, "");

    // inline handlers (best-effort)
    t = t.replace(/\bon\w+\s*=\s*["'][\s\S]*?["']/gi, "");
    t = t.replace(/\bon\w+\s*=\s*[^\s>]+/gi, "");

    return t.trim();
  };

  const sanitizeForSend = (text) => safeText(stripDangerousMarkup(text));

  // -------------------------
  // Tiny ML integrity check (lightweight heuristic model)
  // - “double check after sanitizer”
  // - Not a remote model; deterministic scoring
  // -------------------------
  function tinyMlIntegrityScore(text) {
    const t = String(text || "").toLowerCase();

    // features (binary)
    const f = {
      has_script: t.includes("<script"),
      has_eval: t.includes("eval(") || t.includes("new function"),
      has_js_scheme: t.includes("javascript:") || t.includes("vbscript:"),
      has_html_data: t.includes("data:text/html"),
      has_cookie: t.includes("document.cookie"),
      has_storage: t.includes("localstorage.") || t.includes("sessionstorage."),
      has_onhandler: t.includes("onerror=") || t.includes("onload="),
      has_base64: t.includes("base64,"),
      long_text: t.length > 1200,
      many_angles: (t.match(/[<>]/g) || []).length > 12,
    };

    // logistic-ish weighting (hand-tuned)
    let z = -2.2;
    z += f.has_script ? 2.2 : 0;
    z += f.has_eval ? 1.7 : 0;
    z += f.has_js_scheme ? 1.4 : 0;
    z += f.has_html_data ? 1.4 : 0;
    z += f.has_cookie ? 1.2 : 0;
    z += f.has_storage ? 0.9 : 0;
    z += f.has_onhandler ? 1.0 : 0;
    z += f.has_base64 ? 0.7 : 0;
    z += f.long_text ? 0.4 : 0;
    z += f.many_angles ? 0.6 : 0;

    const score = 1 / (1 + Math.exp(-z)); // 0..1
    return { score, features: f };
  }

  function assertTinyMlSafe(text, where = "payload") {
    const { score } = tinyMlIntegrityScore(text);
    // threshold chosen to block only strong signals
    if (score >= 0.75) {
      throw new Error(`Blocked by client integrity check (${where}).`);
    }
  }

  // -------------------------
  // Config loading + validation
  // -------------------------
  function buildOriginAssetMap(cfg) {
    const map = new Map();
    const origins = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : [];
    const ids = Array.isArray(cfg.allowedOriginAssetIds) ? cfg.allowedOriginAssetIds : [];
    for (let i = 0; i < origins.length; i++) {
      const o = normalizeOrigin(origins[i]);
      const id = String(ids[i] || "").trim();
      if (o && looksLikeAssetId(id)) map.set(o, id);
    }
    return map;
  }

  function validateConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return { ok: false, error: "Config is not an object." };

    // endpoints
    const endpoints = [
      cfg.workerEndpoint,
      cfg.assistantEndpoint,
      cfg.voiceEndpoint,
      cfg.ttsEndpoint,
      cfg.gatewayEndpoint,
    ].filter(Boolean);

    for (const ep of endpoints) {
      if (!isHttpsUrl(ep)) return { ok: false, error: `Endpoint is not https: ${ep}` };
    }

    // required headers contract
    const required = Array.isArray(cfg.requiredHeaders) ? cfg.requiredHeaders : [];
    const requiredLower = required.map((h) => String(h).toLowerCase());
    if (!requiredLower.includes("x-ops-asset-id")) {
      return { ok: false, error: "requiredHeaders must include X-Ops-Asset-Id." };
    }

    // repo identity (optional but expected by your flow)
    const repoId = cfg.repoIdentity?.sha512_b64;
    if (repoId && !looksLikeSha512B64(repoId)) {
      return { ok: false, error: "repoIdentity.sha512_b64 does not look like base64." };
    }

    // mapping
    const map = buildOriginAssetMap(cfg);
    if (map.size === 0) return { ok: false, error: "No allowedOrigins/allowedOriginAssetIds mapping." };

    return { ok: true, error: "" };
  }

  async function loadJson(url) {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      mode: "cors",
    });
    if (!res.ok) throw new Error(`Config fetch failed (${res.status}).`);
    return res.json();
  }

  async function init(options = {}) {
    const cfgPath = safeText(options.configPath || CONFIG_PATH_DEFAULT) || CONFIG_PATH_DEFAULT;
    const cfgUrl = new URL(cfgPath, window.location.href).toString();

    const cfg = await loadJson(cfgUrl);
    const verdict = validateConfig(cfg);
    if (!verdict.ok) throw new Error(verdict.error);

    _config = cfg;
    _originAssetMap = buildOriginAssetMap(cfg);

    // warn (don’t hard-fail) if current origin not in allowlist
    const curOrigin = normalizeOrigin(window.location.origin);
    if (!_originAssetMap.has(curOrigin)) {
      console.warn(`Origin not in allowedOrigins: ${curOrigin}`);
    }

    return true;
  }

  function getConfig() {
    return _config || {};
  }

  // -------------------------
  // Header builder (matches CF Worker contract)
  // -------------------------
  function buildOpsHeaders({ accept, contentType, extraHeaders } = {}) {
    if (!_config) throw new Error("EnlaceRepo not initialized. Call EnlaceRepo.init().");

    const origin = normalizeOrigin(window.location.origin);
    const assetId =
      _originAssetMap.get(origin) ||
      // fallback to globals (if app.js already set them)
      safeText(window.OPS_ASSET_ID || "");

    if (!looksLikeAssetId(assetId)) {
      throw new Error("Missing/invalid OPS asset id for this origin.");
    }

    const h = new Headers();

    // required
    h.set("Accept", accept || "application/json");
    h.set("X-Ops-Asset-Id", assetId);

    if (contentType) h.set("Content-Type", contentType);

    // optional repo identity header (your ID)
    const repoHeaderName = safeText(_config.repoIdentity?.header || "X-Ops-Src-Sha512-B64");
    const repoId = safeText(_config.repoIdentity?.sha512_b64 || "");
    if (repoId) h.set(repoHeaderName, repoId);

    // caller-provided extra headers (language hints, turnstile, etc.)
    if (extraHeaders && typeof extraHeaders === "object") {
      for (const [k, v] of Object.entries(extraHeaders)) {
        const key = safeText(k);
        if (!key) continue;
        const val = safeText(v);
        if (val) h.set(key, val);
      }
    }

    return h;
  }

  function activeEndpoint() {
    if (!_config) return "";
    return safeText(_config.gatewayEndpoint || "") || safeText(_config.workerEndpoint || "");
  }

  function endpointFor(path) {
    const base = activeEndpoint();
    if (!base) return "";
    try {
      const u = new URL(base);
      u.pathname = `${u.pathname.replace(/\/$/, "")}/${String(path || "").replace(/^\//, "")}`;
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch {
      return "";
    }
  }

  // -------------------------
  // Network methods used by app.js
  // -------------------------
  async function postChat(body, options = {}) {
    const endpoint =
      safeText(_config?.gatewayEndpoint || "") ||
      safeText(_config?.assistantEndpoint || "") ||
      endpointFor("/api/chat");

    if (!endpoint) throw new Error("Chat endpoint not configured.");

    // client-side sanitize + integrity double-check
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const last = messages.length ? String(messages[messages.length - 1]?.content || "") : "";
    const cleaned = sanitizeForSend(last);
    assertTinyMlSafe(cleaned, "chat.message");

    // NOTE: Do NOT mutate the entire messages array aggressively here;
    // the CF Worker already sanitizes/guards. We only gate obvious malicious input.
    const payload = {
      ...(body && typeof body === "object" ? body : {}),
    };

    const headers = buildOpsHeaders({
      accept: "text/event-stream",
      contentType: "application/json; charset=utf-8",
      extraHeaders: options.extraHeaders,
    });

    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  }

  async function postTTS(body, options = {}) {
    const endpoint = safeText(_config?.ttsEndpoint || "") || endpointFor("/api/tts");
    if (!endpoint) throw new Error("TTS endpoint not configured.");

    const text = sanitizeForSend(body?.text || "");
    if (!text) throw new Error("TTS text is required.");
    assertTinyMlSafe(text, "tts.text");

    const payload = {
      text,
      lang_iso2: safeText(body?.language || body?.lang_iso2 || "en").slice(0, 8),
    };

    const headers = buildOpsHeaders({
      accept: "audio/*",
      contentType: "application/json; charset=utf-8",
      extraHeaders: options.extraHeaders,
    });

    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  }

  async function postVoiceSTT(audioBlob, options = {}) {
    const base = safeText(_config?.voiceEndpoint || "") || endpointFor("/api/voice");
    if (!base) throw new Error("Voice endpoint not configured.");

    const u = new URL(base);
    // STT mode (matches CF Worker /api/voice?mode=stt)
    u.searchParams.set("mode", "stt");

    const contentType = safeText(audioBlob?.type || "audio/webm");

    const headers = buildOpsHeaders({
      accept: "application/json",
      contentType,
      extraHeaders: options.extraHeaders,
    });

    return fetch(u.toString(), {
      method: "POST",
      headers,
      body: audioBlob,
      signal: options.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  }

  // -------------------------
  // Expose module
  // -------------------------
  window.EnlaceRepo = Object.freeze({
    init,
    getConfig,
    postChat,
    postVoiceSTT,
    postTTS,
  });
})();
