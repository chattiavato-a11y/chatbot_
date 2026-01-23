/**
 * enlace-worker.js — REPO “MIDDLEMAN” (GitHub Pages) (v0.3 ENLACE_REPO)
 * UI -> EnlaceRepo (this file) -> Cloudflare Enlace Worker
 *
 * Fixes:
 * - Reads BOTH key styles from ops-keys.json:
 *    - OPS_ASSET_ID OR ASSET_ID_ZULU_Pu  -> x-ops-asset-id
 *    - SRC_PUBLIC_SHA512_B64 OR src_PUBLIC_SHA512_B64 -> x-ops-src-sha512-b64
 * - Applies ops-keys.json flags:
 *    - SEND_TURNSTILE_HEADER
 *    - REQUIRE_IDENTITY_HEADERS
 * - If REQUIRE_IDENTITY_HEADERS=true and keys are missing, it fails fast with a clear error.
 */

(() => {
  "use strict";

  // -------------------------
  // 0) Repo config (meta tags + defaults)
  // -------------------------
  function readEnlaceBaseFromMeta() {
    const m1 = document.querySelector('meta[name="chattia-enlace-base"]');
    const m2 = document.querySelector('meta[name="chattia-enlace"]');
    const raw = (m1 && m1.content ? String(m1.content) : (m2 && m2.content ? String(m2.content) : "")).trim();
    return raw.replace(/\/+$/, "");
  }

  const DEFAULTS = Object.freeze({
    ENLACE_BASE_FALLBACK: "https://enlace.grabem-holdem-nuts-right.workers.dev",
    OPS_KEYS_URL: "ops-keys.json",

    // Read from ops-keys.json if present
    SEND_TURNSTILE_HEADER: true,
    REQUIRE_IDENTITY_HEADERS: false,

    // Client-side input gates (helpful, not security)
    CLIENT_BLOCK_CODE_OR_MARKUP: true,
    CLIENT_MAX_JSON_BODY_CHARS: 24_000,
    CLIENT_MAX_MESSAGES: 20,
    CLIENT_MAX_MESSAGE_CHARS: 2_000,

    // Voice caps (mirror your worker limits)
    CLIENT_MAX_AUDIO_BYTES: 12_000_000,

    // Optional legacy header (only if keys include ASSET_ID_SHA256)
    SEND_LEGACY_ASSET_SHA256_HEADER: false,
  });

  let cfg = {
    ...DEFAULTS,
    ENLACE_BASE: readEnlaceBaseFromMeta() || DEFAULTS.ENLACE_BASE_FALLBACK,
  };

  function getEndpoints() {
    const base = String(cfg.ENLACE_BASE || "").replace(/\/+$/, "") || DEFAULTS.ENLACE_BASE_FALLBACK;
    return {
      base,
      chat: `${base}/api/chat`,
      voice: `${base}/api/voice`,
    };
  }

  // -------------------------
  // 1) ops-keys.json loader
  // -------------------------
  let OPS_KEYS_CACHE = null;
  let OPS_KEYS_PROMISE = null;

  async function loadOpsKeys() {
    if (OPS_KEYS_CACHE) return OPS_KEYS_CACHE;
    if (OPS_KEYS_PROMISE) return OPS_KEYS_PROMISE;

    OPS_KEYS_PROMISE = (async () => {
      try {
        const url = String(cfg.OPS_KEYS_URL || "ops-keys.json");
        const resp = await fetch(url, { cache: "no-store" });
        if (!resp.ok) throw new Error(`ops-keys.json HTTP ${resp.status}`);
        const obj = await resp.json();
        OPS_KEYS_CACHE = (obj && typeof obj === "object") ? obj : {};
        return OPS_KEYS_CACHE;
      } catch {
        OPS_KEYS_CACHE = {};
        return OPS_KEYS_CACHE;
      } finally {
        OPS_KEYS_PROMISE = null;
      }
    })();

    return OPS_KEYS_PROMISE;
  }

  function pickFirstString(obj, keys) {
    for (const k of keys) {
      const v = obj && obj[k];
      if (v !== undefined && v !== null) {
        const s = String(v).trim();
        if (s) return s;
      }
    }
    return "";
  }

  function pickFirstBool(obj, keys, fallback) {
    for (const k of keys) {
      const v = obj && obj[k];
      if (typeof v === "boolean") return v;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true") return true;
        if (s === "false") return false;
      }
    }
    return !!fallback;
  }

  async function getUiIdentity() {
    const k = await loadOpsKeys();

    // Accept BOTH naming styles
    const assetIdZuluPu = pickFirstString(k, [
      "OPS_ASSET_ID",
      "ASSET_ID_ZULU_Pu",
      "ASSET_ID_ZULU_PU",
      "asset_id_zulu_pu",
    ]);

    const srcSha512B64 = pickFirstString(k, [
      "SRC_PUBLIC_SHA512_B64",
      "src_PUBLIC_SHA512_B64",
      "SRC_SHA512_B64",
      "src_SHA512_B64",
    ]);

    // Optional legacy
    const assetSha256Hex = pickFirstString(k, [
      "ASSET_ID_SHA256",
      "ASSET_ID_SHA256_HEX",
    ]);

    return { assetIdZuluPu, srcSha512B64, assetSha256Hex, _raw: k };
  }

  // -------------------------
  // 2) Turnstile token (public)
  // -------------------------
  function getTurnstileToken() {
    if (!cfg.SEND_TURNSTILE_HEADER) return "";
    try {
      if (window.turnstile && typeof window.turnstile.getResponse === "function") {
        // If you store widgetId somewhere, you can pass it; otherwise this returns the first widget response.
        return window.turnstile.getResponse() || "";
      }
    } catch {
      return "";
    }
    return "";
  }

  // -------------------------
  // 3) Client-side sanitizers / gates
  // -------------------------
  function safeTextOnly(s) {
    if (s == null) return "";
    let out = "";
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c === 0) continue;
      const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160;
      if (ok) out += str[i];
    }
    out = out.replace(/[ \t]{3,}/g, "  ").replace(/\n{4,}/g, "\n\n\n");
    return out.trim();
  }

  function looksLikeCodeOrMarkup(text) {
    const t = String(text || "");
    const lower = t.toLowerCase();

    if (t.includes("```")) return true;
    if (/<\/?[a-z][\s\S]*>/i.test(t)) return true;
    if (lower.includes("<script") || lower.includes("javascript:")) return true;

    const patterns = [
      /\bfunction\b/i,
      /\bclass\b/i,
      /\bimport\b/i,
      /\bexport\b/i,
      /\brequire\s*\(/i,
      /\bconst\b/i,
      /\blet\b/i,
      /\bvar\b/i,
      /=>/i,
      /\bdocument\./i,
      /\bwindow\./i,
      /\beval\s*\(/i,
    ];
    return patterns.some((re) => re.test(t));
  }

  function normalizeMessages(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const slice = input.slice(-cfg.CLIENT_MAX_MESSAGES);

    for (const m of slice) {
      if (!m || typeof m !== "object") continue;
      const role = String(m.role || "").toLowerCase();
      if (role !== "user" && role !== "assistant") continue;

      let content = (typeof m.content === "string") ? m.content : "";
      content = safeTextOnly(content);
      if (!content) continue;

      if (content.length > cfg.CLIENT_MAX_MESSAGE_CHARS) {
        content = content.slice(0, cfg.CLIENT_MAX_MESSAGE_CHARS);
      }

      out.push({ role, content });
    }

    return out;
  }

  function extractLastUser(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === "user") return String(messages[i].content || "");
    }
    return "";
  }

  function validateAndBuildChatPayload(payload) {
    const body = (payload && typeof payload === "object") ? payload : {};
    const honeypot = (typeof body.honeypot === "string") ? body.honeypot.trim() : "";
    if (honeypot) {
      return { blocked: true, reason: "Blocked: honeypot (spam)" };
    }

    const messages = normalizeMessages(body.messages);
    if (!messages.length) {
      return { blocked: true, reason: "Blocked: messages[] required" };
    }

    if (cfg.CLIENT_BLOCK_CODE_OR_MARKUP) {
      const lastUser = extractLastUser(messages);
      if (!lastUser) return { blocked: true, reason: "Blocked: missing user message" };
      if (looksLikeCodeOrMarkup(lastUser)) {
        return { blocked: true, reason: "Blocked: code/markup detected (client gate)" };
      }
    }

    const meta = (body.meta && typeof body.meta === "object") ? body.meta : {};

    const safeMeta = {};
    for (const [k, v] of Object.entries(meta)) {
      if (v == null) continue;
      const s = String(v).trim();
      if (s) safeMeta[k] = s;
    }

    const finalPayload = { messages, honeypot: "", meta: safeMeta };

    const jsonText = JSON.stringify(finalPayload);
    if (jsonText.length > cfg.CLIENT_MAX_JSON_BODY_CHARS) {
      return { blocked: true, reason: "Blocked: request too large (client cap)" };
    }

    return { blocked: false, payload: finalPayload, jsonText };
  }

  // -------------------------
  // 4) Header builder
  // -------------------------
  async function buildCommonHeaders(acceptValue, contentType) {
    const headers = { "accept": acceptValue || "text/event-stream" };
    if (contentType) headers["content-type"] = contentType;

    const ident = await getUiIdentity();

    // Apply ops-keys.json flags (if present)
    cfg.SEND_TURNSTILE_HEADER = pickFirstBool(ident._raw, ["SEND_TURNSTILE_HEADER"], cfg.SEND_TURNSTILE_HEADER);
    cfg.REQUIRE_IDENTITY_HEADERS = pickFirstBool(ident._raw, ["REQUIRE_IDENTITY_HEADERS"], cfg.REQUIRE_IDENTITY_HEADERS);

    // Identity headers
    if (ident.assetIdZuluPu) headers["x-ops-asset-id"] = ident.assetIdZuluPu;
    if (ident.srcSha512B64) headers["x-ops-src-sha512-b64"] = ident.srcSha512B64;

    // Fail fast if required
    if (cfg.REQUIRE_IDENTITY_HEADERS) {
      if (!ident.assetIdZuluPu) throw new Error("Repo identity misconfigured: missing OPS_ASSET_ID (or ASSET_ID_ZULU_Pu) in ops-keys.json");
      if (!ident.srcSha512B64) throw new Error("Repo identity misconfigured: missing SRC_PUBLIC_SHA512_B64 (or src_PUBLIC_SHA512_B64) in ops-keys.json");
    }

    // Optional legacy (only if enabled)
    if (cfg.SEND_LEGACY_ASSET_SHA256_HEADER && ident.assetSha256Hex) {
      headers["x-ops-asset-sha256"] = ident.assetSha256Hex;
    }

    // Turnstile
    const ts = getTurnstileToken();
    if (ts) headers["cf-turnstile-response"] = ts;

    return headers;
  }

  // -------------------------
  // 5) SSE parsing
  // -------------------------
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

    if (token && typeof onToken === "function") onToken(token);
    return { done: false };
  }

  async function readSseStream(resp, onToken) {
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

  // -------------------------
  // 6) Public API: EnlaceRepo
  // -------------------------
  async function ready() {
    const metaBase = readEnlaceBaseFromMeta();
    if (metaBase) cfg.ENLACE_BASE = metaBase;

    await loadOpsKeys();

    // Apply flags once on ready (so errors show early)
    const ident = await getUiIdentity();
    cfg.SEND_TURNSTILE_HEADER = pickFirstBool(ident._raw, ["SEND_TURNSTILE_HEADER"], cfg.SEND_TURNSTILE_HEADER);
    cfg.REQUIRE_IDENTITY_HEADERS = pickFirstBool(ident._raw, ["REQUIRE_IDENTITY_HEADERS"], cfg.REQUIRE_IDENTITY_HEADERS);

    if (cfg.REQUIRE_IDENTITY_HEADERS) {
      if (!ident.assetIdZuluPu) throw new Error("Repo identity misconfigured: missing OPS_ASSET_ID (or ASSET_ID_ZULU_Pu) in ops-keys.json");
      if (!ident.srcSha512B64) throw new Error("Repo identity misconfigured: missing SRC_PUBLIC_SHA512_B64 (or src_PUBLIC_SHA512_B64) in ops-keys.json");
    }

    return true;
  }

  function getConfig() {
    return { ...cfg, endpoints: getEndpoints() };
  }

  function setConfig(partial) {
    if (!partial || typeof partial !== "object") return getConfig();
    cfg = { ...cfg, ...partial };
    if (typeof cfg.ENLACE_BASE === "string") cfg.ENLACE_BASE = cfg.ENLACE_BASE.replace(/\/+$/, "");
    return getConfig();
  }

  async function chatSSE(payload, opts) {
    const { blocked, reason, payload: safePayload, jsonText } = validateAndBuildChatPayload(payload);
    if (blocked) {
      const err = new Error(reason || "Blocked by client gate");
      err.name = "ClientGateError";
      throw err;
    }

    const { chat } = getEndpoints();
    const headers = await buildCommonHeaders("text/event-stream", "application/json");

    const resp = await fetch(chat, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers,
      body: jsonText || JSON.stringify(safePayload),
      signal: opts && opts.signal ? opts.signal : undefined,
    });

    if (opts && typeof opts.onHeaders === "function") {
      try { opts.onHeaders(resp.headers); } catch {}
    }

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${t}`);
    }

    const ct = String(resp.headers.get("content-type") || "").toLowerCase();

    if (ct.includes("application/json")) {
      const obj = await resp.json().catch(() => null);
      const token = extractTokenFromAnyShape(obj) || (obj ? JSON.stringify(obj) : "");
      if (token && opts && typeof opts.onToken === "function") opts.onToken(token);
      return;
    }

    await readSseStream(resp, opts && typeof opts.onToken === "function" ? opts.onToken : null);
  }

  async function voiceSTT(blob, opts) {
    const b = blob instanceof Blob ? blob : null;
    if (!b) return { transcript: "", blocked: true, reason: "Invalid audio blob" };

    if (b.size <= 0) return { transcript: "", blocked: true, reason: "Empty audio" };
    if (b.size > cfg.CLIENT_MAX_AUDIO_BYTES) {
      return { transcript: "", blocked: true, reason: "Audio too large (client cap)" };
    }

    const { voice } = getEndpoints();
    const headers = await buildCommonHeaders("application/json", b.type || "application/octet-stream");

    const resp = await fetch(`${voice}?mode=stt`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers,
      body: b,
      signal: opts && opts.signal ? opts.signal : undefined,
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { transcript: "", blocked: true, reason: `Voice STT failed: HTTP ${resp.status}\n${t}` };
    }

    const obj = await resp.json().catch(() => null);
    const transcript = safeTextOnly(obj?.transcript || obj?.text || obj?.result?.text || "");
    const lang_iso2 = String(obj?.lang_iso2 || obj?.langIso2 || "").trim().toLowerCase();
    const lang_bcp47 = String(obj?.lang_bcp47 || obj?.langBcp47 || "").trim();

    if (cfg.CLIENT_BLOCK_CODE_OR_MARKUP && looksLikeCodeOrMarkup(transcript)) {
      return { transcript: "", blocked: true, reason: "Blocked: transcript looked like code/markup (client gate)" };
    }

    return { transcript, lang_iso2, lang_bcp47, blocked: false, reason: "", _raw: obj };
  }

  window.EnlaceRepo = Object.freeze({
    ready,
    getConfig,
    setConfig,
    chatSSE,
    voiceSTT,
    _reloadKeys: async () => { OPS_KEYS_CACHE = null; return loadOpsKeys(); },
  });

  ready().catch(() => {});
})();
