/**
 * enlace-worker.js — REPO (GitHub Pages) “middleman helper” (v1.0)
 *
 * Purpose:
 * - Load repo config (ops-keys.json + meta tag)
 * - Client-side sanitize + block obvious code/markup/payloads
 * - Call Cloudflare Enlace Worker (/api/chat SSE, /api/voice STT)
 * - Attach identity headers expected by Cloudflare Enlace Worker
 *
 * NOT a security boundary (attackers can bypass). Still useful for:
 * - Reducing junk
 * - Preventing accidental code/payload pastes
 * - Consistent header building & config loading
 *
 * Exposes:
 *   window.EnlaceRepo = {
 *     ready(), getConfig(),
 *     sanitizeText(), looksBad(),
 *     chatSSE({messages, meta, honeypot}, {onToken, onHeaders, signal}),
 *     voiceSTT(blob, {signal})
 *   }
 */

(function () {
  "use strict";

  // -------------------------
  // 0) Defaults (safe public fallbacks)
  // -------------------------
  const DEFAULTS = {
    // If you add <meta name="chattia-enlace-base" content="https://...workers.dev" />
    // it overrides this.
    ENLACE_BASE: "https://enlace.grabem-holdem-nuts-right.workers.dev",

    // Your NEW repo public identity (recommended)
    // Put these in ops-keys.json if you prefer (supported).
    OPS_ASSET_ID: "ASSET_ID_ZULU_WtXzFzHtzkLri6m_1SrNNQ",
    SRC_PUBLIC_SHA512_B64: "de2V8678AuqGwTIp2SdtxWsistBzPHq318X4xNKPp39M44EML8po61xSAP//t4hZM8nBgkOVCMnbV4dGSE20RA==",

    // Legacy optional (only if your Cloudflare worker still checks it)
    ASSET_ID_SHA256: "",

    // Turnstile: client can only provide token if Turnstile widget is present on page
    SEND_TURNSTILE_HEADER: true,

    // Repo config file path (same folder is simplest)
    OPS_KEYS_PATH: "ops-keys.json",
  };

  // Limits
  const LIMITS = {
    MAX_TEXT_CHARS: 1500,
    MAX_META_CHARS: 2000,
    MAX_BLOB_BYTES: 12_000_000,
    MAX_MESSAGES: 20,
    MAX_MESSAGE_CHARS: 2000,
  };

  // Cached config
  let _config = null;
  let _readyPromise = null;

  // -------------------------
  // 1) Repo config loading
  // -------------------------
  function readMeta(name) {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el && el.content ? String(el.content).trim() : "";
  }

  function readEnlaceBaseFromMeta() {
    // supports:
    // <meta name="chattia-enlace-base" content="https://...workers.dev">
    // legacy:
    // <meta name="chattia-enlace" content="https://...workers.dev">
    const raw =
      readMeta("chattia-enlace-base") ||
      readMeta("chattia-enlace") ||
      "";
    return raw.replace(/\/+$/, "");
  }

  async function fetchJsonSafe(url) {
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return null;
      return await resp.json().catch(() => null);
    } catch {
      return null;
    }
  }

  async function loadOpsKeysJson() {
    const u = new URL(DEFAULTS.OPS_KEYS_PATH, location.href);
    // cache-bust to prevent stale GH pages caching
    u.searchParams.set("v", String(Date.now()));
    return await fetchJsonSafe(u.toString());
  }

  function pickString(obj, ...keys) {
    for (const k of keys) {
      const v = obj && obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  function pickBool(obj, key, fallback) {
    const v = obj && obj[key];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true") return true;
      if (s === "false") return false;
    }
    return fallback;
  }

  async function ready() {
    if (_readyPromise) return _readyPromise;

    _readyPromise = (async () => {
      const ops = await loadOpsKeysJson();

      const metaBase = readEnlaceBaseFromMeta();
      const base = metaBase || pickString(ops, "ENLACE_BASE", "ENLACE", "ENLACE_API_BASE") || DEFAULTS.ENLACE_BASE;

      // Support your existing ops-keys.json shape:
      // {
      //   "TURNSTILE": "site-key",
      //   "OPS_ASSET_ALLOWLIST": [...]
      // }
      //
      // And new shape (recommended):
      // {
      //   "OPS_ASSET_ID": "ASSET_ID_ZULU_...",
      //   "SRC_PUBLIC_SHA512_B64": "...",
      //   "ASSET_ID_SHA256": "optional legacy",
      //   "SEND_TURNSTILE_HEADER": true
      // }
      const cfg = {
        ENLACE_BASE: base.replace(/\/+$/, ""),
        ENLACE_CHAT: base.replace(/\/+$/, "") + "/api/chat",
        ENLACE_VOICE: base.replace(/\/+$/, "") + "/api/voice",

        OPS_ASSET_ID: pickString(ops, "OPS_ASSET_ID", "ASSET_ID_ZULU_Pu", "ASSET_ID") || DEFAULTS.OPS_ASSET_ID,
        SRC_PUBLIC_SHA512_B64: pickString(ops, "SRC_PUBLIC_SHA512_B64", "src_PUBLIC_SHA512_B64") || DEFAULTS.SRC_PUBLIC_SHA512_B64,
        ASSET_ID_SHA256: pickString(ops, "ASSET_ID_SHA256", "ASSET_SHA256") || DEFAULTS.ASSET_ID_SHA256,

        SEND_TURNSTILE_HEADER: pickBool(ops, "SEND_TURNSTILE_HEADER", DEFAULTS.SEND_TURNSTILE_HEADER),

        // Keep original Turnstile site key around if you render widget yourself
        TURNSTILE_SITE_KEY: pickString(ops, "TURNSTILE_SITE_KEY", "TURNSTILE") || "",

        // Just stored (not enforced client-side). Server enforces allowlist.
        OPS_ASSET_ALLOWLIST: Array.isArray(ops && ops.OPS_ASSET_ALLOWLIST) ? ops.OPS_ASSET_ALLOWLIST.slice() : [],
      };

      _config = cfg;
      return cfg;
    })();

    return _readyPromise;
  }

  function getConfig() {
    return _config ? { ..._config } : null;
  }

  // -------------------------
  // 2) Sanitization + “block programming/markup/payload”
  // -------------------------
  function sanitizeText(input, maxChars) {
    const s = String(input || "");
    let out = "";
    const lim = Math.max(0, Number(maxChars || LIMITS.MAX_TEXT_CHARS));

    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0) continue;
      const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160;
      if (ok) out += s[i];
      if (lim && out.length >= lim) break;
    }

    out = out.replace(/[ \t]{3,}/g, "  ").replace(/\n{4,}/g, "\n\n\n").trim();
    return out;
  }

  function looksBad(text) {
    const t = String(text || "");
    const lower = t.toLowerCase();
    if (!t.trim()) return false;

    // Markup / scripts
    if (t.includes("```")) return true;
    if (/<\/?[a-z][\s\S]*>/i.test(t)) return true;
    if (lower.includes("<script") || lower.includes("javascript:")) return true;
    if (/\bon\w+\s*=\s*["']?/i.test(t)) return true; // onclick=, onerror= ...

    // Code-ish
    const patterns = [
      /\bfunction\b/i, /\bclass\b/i, /\bimport\b/i, /\bexport\b/i, /\brequire\s*\(/i,
      /\bconst\b/i, /\blet\b/i, /\bvar\b/i, /\breturn\b/i, /\btry\b/i, /\bcatch\b/i,
      /=>/i, /\bdocument\./i, /\bwindow\./i, /\beval\s*\(/i,
      /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i,
    ];
    if (patterns.some((re) => re.test(t))) return true;

    // Big encoded blobs / payloady text
    if (/[A-Za-z0-9+/=]{180,}/.test(t)) return true;  // base64-ish
    if (/\b[0-9a-f]{160,}\b/i.test(t)) return true;   // huge hex
    if (/%3c|%3e|%3d|%2f|%5c/i.test(t)) return true;  // heavy urlencoding

    return false;
  }

  function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];

    for (const m of messages.slice(-LIMITS.MAX_MESSAGES)) {
      if (!m || typeof m !== "object") continue;
      const role = String(m.role || "").toLowerCase();
      if (role !== "user" && role !== "assistant") continue;

      let content = typeof m.content === "string" ? m.content : "";
      content = sanitizeText(content, LIMITS.MAX_MESSAGE_CHARS);
      if (!content) continue;

      // Client-side block any “bad” user content
      if (role === "user" && looksBad(content)) {
        // Replace with a safe message instead of forwarding payload
        out.push({
          role: "user",
          content: "Blocked by client-side gate: please send plain language only (no code/markup/payloads).",
        });
        continue;
      }

      out.push({ role, content });
    }

    return out;
  }

  // -------------------------
  // 3) Turnstile token (optional)
  // -------------------------
  function getTurnstileToken() {
    if (!_config || !_config.SEND_TURNSTILE_HEADER) return "";
    try {
      if (window.turnstile && typeof window.turnstile.getResponse === "function") {
        return window.turnstile.getResponse() || "";
      }
    } catch {}
    return "";
  }

  // -------------------------
  // 4) Header builder (identity -> Cloudflare Enlace Worker)
  // -------------------------
  async function buildHeaders(acceptValue, contentType) {
    await ready();

    const h = {};
    if (acceptValue) h["accept"] = acceptValue;
    if (contentType) h["content-type"] = contentType;

    // Required identity headers
    if (_config.OPS_ASSET_ID) h["x-ops-asset-id"] = _config.OPS_ASSET_ID;
    if (_config.SRC_PUBLIC_SHA512_B64) h["x-ops-src-sha512-b64"] = _config.SRC_PUBLIC_SHA512_B64;

    // Legacy optional
    if (_config.ASSET_ID_SHA256) h["x-ops-asset-sha256"] = _config.ASSET_ID_SHA256;

    // Turnstile optional
    const ts = getTurnstileToken();
    if (ts) h["cf-turnstile-response"] = ts;

    return h;
  }

  // -------------------------
  // 5) SSE chat client -> /api/chat
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

  async function chatSSE(payload, opts) {
    await ready();

    const onToken = opts && typeof opts.onToken === "function" ? opts.onToken : null;
    const onHeaders = opts && typeof opts.onHeaders === "function" ? opts.onHeaders : null;
    const signal = opts && opts.signal ? opts.signal : undefined;

    // sanitize payload
    const safe = {
      messages: normalizeMessages(payload && payload.messages ? payload.messages : []),
      honeypot: sanitizeText(payload && payload.honeypot ? payload.honeypot : "", 200),
      meta: payload && payload.meta && typeof payload.meta === "object" ? payload.meta : {},
    };

    // If user tried to send only “bad content”, safe.messages may contain the blocked message.
    if (!safe.messages.length) {
      throw new Error("No valid messages to send.");
    }

    const headers = await buildHeaders("text/event-stream", "application/json");
    const bodyText = JSON.stringify(safe);

    const resp = await fetch(_config.ENLACE_CHAT, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers,
      body: bodyText,
      signal,
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${resp.statusText}\n${t}`);
    }

    if (onHeaders) onHeaders(resp.headers);

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const obj = await resp.json().catch(() => null);
      const token = extractTokenFromAnyShape(obj) || JSON.stringify(obj || {});
      if (token && onToken) onToken(token);
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

  // -------------------------
  // 6) Voice STT -> /api/voice?mode=stt
  // -------------------------
  async function voiceSTT(blob, opts) {
    await ready();
    const signal = opts && opts.signal ? opts.signal : undefined;

    if (!blob) throw new Error("Missing audio blob.");
    if (blob.size > LIMITS.MAX_BLOB_BYTES) throw new Error("Audio too large.");

    const headers = await buildHeaders("application/json", blob.type || "audio/webm");

    const resp = await fetch(_config.ENLACE_VOICE + "?mode=stt", {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers,
      body: blob,
      signal,
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Voice STT failed: HTTP ${resp.status}\n${t}`);
    }

    const obj = await resp.json().catch(() => null);
    const transcript = sanitizeText(obj && (obj.transcript || obj.text || (obj.result && obj.result.text)) ? (obj.transcript || obj.text || obj.result.text) : "", LIMITS.MAX_TEXT_CHARS);

    // client-side block if transcript looks like code/markup
    if (looksBad(transcript)) {
      return { transcript: "", blocked: true, reason: "Blocked by client-side gate (voice transcript looked like code/markup/payload)" };
    }

    const lang_iso2 = String((obj && (obj.lang_iso2 || obj.langIso2)) || "").trim().toLowerCase() || "";
    const lang_bcp47 = String((obj && (obj.lang_bcp47 || obj.langBcp47)) || "").trim() || "";

    return { transcript, lang_iso2, lang_bcp47, blocked: false };
  }

  // -------------------------
  // 7) Export global
  // -------------------------
  window.EnlaceRepo = {
    ready,
    getConfig,
    sanitizeText,
    looksBad,
    chatSSE,
    voiceSTT,
  };
})();
