/* File: worker_files/enlace.worker.js
 *
 * Repo Gateway Module (Browser-side) — EnlaceRepo
 * - Loads worker config from repo
 * - Enforces Origin -> AssetID header (x-ops-asset-id)
 * - Adds repo/source integrity fingerprint header (x-ops-src-sha512-b64)
 * - Provides: init(), getConfig(), postChat(), postVoiceSTT(), postTTS()
 *
 * NOTE on ASSET_ID_REPO secret:
 * - Browser JS cannot safely read GitHub “secrets” at runtime (it would leak publicly).
 * - This module uses the public fingerprint header: x-ops-src-sha512-b64.
 * - If you want a true secret-backed repo identity, that must be produced server-side
 *   (e.g., via GitHub Actions writing a signed token file) — we’ll do that in the YAML later.
 */

(() => {
  "use strict";

  // ---- Public repo/source fingerprint (matches Worker allowlist)
  const OPS_SRC_SHA512_B64 =
    "0ktRDMTkZ5fTzYCBvfX2cc7XM6N/6DZTmsFwRS0dfc9/ZV8GlSrdGGrqoX35oedn";

  // ---- Fallback mapping (will be overridden by worker.config.json if present)
  const FALLBACK_ORIGIN_ASSET_ID = {
    "https://www.chattia.io": "asset_01J7Y2D4XABCD3EFGHJKMNPRTB",
    "https://chattia.io": "asset_01J7Y2D4XABCD3EFGHJKMNPRTC",
    "https://chattiavato-a11y.github.io": "asset_01J7Y2D4XABCD3EFGHJKMNPRTD",
    "https://enlace.grabem-holdem-nuts-right.workers.dev":
      "asset_01J7Y2D4XABCD3EFGHJKMNPRTA",
  };

  // ---- Defaults (safe fallback)
  const DEFAULT_CONFIG = {
    assetRegistry: "worker_files/worker.assets.json",
    workerEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev",
    assistantEndpoint:
      "https://enlace.grabem-holdem-nuts-right.workers.dev/api/chat",
    voiceEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev/api/voice",
    ttsEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev/api/tts",
    gatewayEndpoint: "",
    workerEndpointAssetId: "asset_01J7Y2D4XABCD3EFGHJKMNPRTA",
    gatewayEndpointAssetId: "",
    allowedOrigins: [
      "https://www.chattia.io",
      "https://chattia.io",
      "https://chattiavato-a11y.github.io",
      "https://enlace.grabem-holdem-nuts-right.workers.dev",
    ],
    allowedOriginAssetIds: [
      "asset_01J7Y2D4XABCD3EFGHJKMNPRTB",
      "asset_01J7Y2D4XABCD3EFGHJKMNPRTC",
      "asset_01J7Y2D4XABCD3EFGHJKMNPRTD",
      "asset_01J7Y2D4XABCD3EFGHJKMNPRTA",
    ],
    requiredHeaders: ["Content-Type", "Accept", "X-Ops-Asset-Id"],
  };

  // ---- Internal state
  let _config = { ...DEFAULT_CONFIG };
  let _originAssetId = { ...FALLBACK_ORIGIN_ASSET_ID };
  let _loaded = false;

  // -------------------------
  // Utilities
  // -------------------------
  const safeString = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

  const normalizeOrigin = (value) => {
    const s = safeString(value).trim();
    if (!s) return "";
    try {
      return new URL(s).origin.toLowerCase();
    } catch {
      return s.replace(/\/$/, "").toLowerCase();
    }
  };

  const normalizeIso2 = (value) => {
    const s = safeString(value).toLowerCase().trim();
    if (!s) return "";
    const base = s.includes("-") ? s.split("-")[0] : s;
    return base.slice(0, 2);
  };

  const coalesceEndpoint = (config, key, fallback) => {
    const v = safeString(config?.[key]).trim();
    return v ? v.replace(/\/$/, "") : fallback;
  };

  const buildOriginAssetMapFromConfig = (cfg) => {
    const out = {};
    const origins = Array.isArray(cfg?.allowedOrigins) ? cfg.allowedOrigins : [];
    const ids = Array.isArray(cfg?.allowedOriginAssetIds) ? cfg.allowedOriginAssetIds : [];

    for (let i = 0; i < origins.length; i++) {
      const o = normalizeOrigin(origins[i]);
      const id = safeString(ids[i]).trim();
      if (o && id) out[o] = id;
    }

    // keep fallback entries if config is partial
    for (const [o, id] of Object.entries(FALLBACK_ORIGIN_ASSET_ID)) {
      const no = normalizeOrigin(o);
      if (!out[no] && id) out[no] = id;
    }

    return out;
  };

  const getAssetIdForCurrentOrigin = () => {
    // Prefer any asset id already computed by app.js (if present)
    const existing = safeString(window.OPS_ASSET_ID).trim();
    if (existing) return existing;

    const origin = normalizeOrigin(window.location.origin);
    return safeString(_originAssetId[origin]).trim();
  };

  const mergeHeaders = (base, extra) => {
    const h = new Headers();
    // base first
    if (base && typeof base === "object") {
      if (base instanceof Headers) {
        base.forEach((v, k) => h.set(k, v));
      } else {
        Object.entries(base).forEach(([k, v]) => {
          const val = safeString(v);
          if (k && val) h.set(k, val);
        });
      }
    }
    // then extra overrides
    if (extra && typeof extra === "object") {
      if (extra instanceof Headers) {
        extra.forEach((v, k) => h.set(k, v));
      } else {
        Object.entries(extra).forEach(([k, v]) => {
          const val = safeString(v);
          if (k && val) h.set(k, val);
        });
      }
    }
    return h;
  };

  const buildCommonHeaders = (overrides) => {
    const assetId = getAssetIdForCurrentOrigin();
    const base = {
      "x-ops-asset-id": assetId,
      "x-ops-src-sha512-b64": OPS_SRC_SHA512_B64,
    };
    return mergeHeaders(base, overrides);
  };

  const sanitizeOutgoingText = (text) => {
    // Client-side lightweight safety — Worker still enforces real sanitizer.
    const t = safeString(text).replace(/\u0000/g, "").trim();
    if (!t) return { ok: false, value: "", reason: "empty" };
    const lower = t.toLowerCase();
    const bad = [
      "<script",
      "javascript:",
      "vbscript:",
      "data:text/html",
      "document.cookie",
      "localstorage.",
      "sessionstorage.",
      "onerror=",
      "onload=",
      "eval(",
      "new function",
    ];
    if (bad.some((p) => lower.includes(p))) {
      return { ok: false, value: "", reason: "blocked_pattern" };
    }
    return { ok: true, value: t, reason: "" };
  };

  // -------------------------
  // Config loader
  // -------------------------
  async function init() {
    if (_loaded) return;

    // try both repo config locations (module lives in /worker_files/)
    const baseUrl = new URL(import.meta.url);
    const candidates = [
      new URL("./worker.config.json", baseUrl).toString(),   // /worker_files/worker.config.json
      new URL("../worker.config.json", baseUrl).toString(),  // /worker.config.json
      new URL("./worker_files/worker.config.json", window.location.href).toString(),
      new URL("./worker.config.json", window.location.href).toString(),
    ];

    let cfg = null;

    for (const url of candidates) {
      try {
        const res = await fetch(url, { method: "GET", cache: "no-store" });
        if (!res.ok) continue;
        const json = await res.json().catch(() => null);
        if (json && typeof json === "object") {
          cfg = json;
          break;
        }
      } catch {
        // keep trying
      }
    }

    if (cfg) {
      // Merge config safely
      _config = {
        ...DEFAULT_CONFIG,
        ...cfg,
        allowedOrigins: Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : DEFAULT_CONFIG.allowedOrigins,
        allowedOriginAssetIds: Array.isArray(cfg.allowedOriginAssetIds)
          ? cfg.allowedOriginAssetIds
          : DEFAULT_CONFIG.allowedOriginAssetIds,
        requiredHeaders: Array.isArray(cfg.requiredHeaders) ? cfg.requiredHeaders : DEFAULT_CONFIG.requiredHeaders,
      };
      _originAssetId = buildOriginAssetMapFromConfig(_config);

      // Normalize endpoints
      _config.workerEndpoint = coalesceEndpoint(_config, "workerEndpoint", DEFAULT_CONFIG.workerEndpoint);
      _config.assistantEndpoint = safeString(_config.assistantEndpoint).trim()
        ? safeString(_config.assistantEndpoint).trim()
        : `${_config.workerEndpoint}/api/chat`;
      _config.voiceEndpoint = safeString(_config.voiceEndpoint).trim()
        ? safeString(_config.voiceEndpoint).trim()
        : `${_config.workerEndpoint}/api/voice`;
      _config.ttsEndpoint = safeString(_config.ttsEndpoint).trim()
        ? safeString(_config.ttsEndpoint).trim()
        : `${_config.workerEndpoint}/api/tts`;
    }

    _loaded = true;
  }

  function getConfig() {
    return { ..._config };
  }

  // -------------------------
  // Gateway calls
  // -------------------------
  async function postChat(payload, options = {}) {
    await init();

    const endpoint = safeString(_config.assistantEndpoint).trim();
    if (!endpoint) throw new Error("assistantEndpoint missing in config.");

    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    // lightly sanitize last user message (Worker still does real sanitize)
    const last = messages.length ? messages[messages.length - 1] : null;
    if (last && safeString(last.role).toLowerCase() === "user") {
      const s = sanitizeOutgoingText(last.content);
      if (!s.ok) throw new Error("Blocked suspicious content (client-side).");
      last.content = s.value;
    }

    const headers = buildCommonHeaders(
      mergeHeaders(
        {
          "content-type": "application/json; charset=utf-8",
          accept: "text/event-stream",
        },
        options.extraHeaders
      )
    );

    return fetch(endpoint, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers,
      body: JSON.stringify(payload ?? {}),
      signal: options.signal,
    });
  }

  async function postTTS(body, options = {}) {
    await init();

    const endpoint = safeString(_config.ttsEndpoint).trim();
    if (!endpoint) throw new Error("ttsEndpoint missing in config.");

    const text = safeString(body?.text);
    const s = sanitizeOutgoingText(text);
    if (!s.ok) throw new Error("TTS text blocked or empty (client-side).");

    // app.js may send { text, language } — Worker expects { text, lang_iso2 }
    const langIso2 =
      normalizeIso2(body?.lang_iso2) ||
      normalizeIso2(body?.language) ||
      normalizeIso2(body?.lang) ||
      "en";

    const payload = { text: s.value, lang_iso2: langIso2 };

    const headers = buildCommonHeaders(
      mergeHeaders(
        {
          "content-type": "application/json; charset=utf-8",
          accept: "audio/mpeg,application/octet-stream;q=0.9,*/*;q=0.8",
        },
        options.extraHeaders
      )
    );

    return fetch(endpoint, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  }

  async function postVoiceSTT(audioBlob, options = {}) {
    await init();

    const base = safeString(_config.voiceEndpoint).trim();
    if (!base) throw new Error("voiceEndpoint missing in config.");

    const url = new URL(base, window.location.origin);
    if (!url.searchParams.get("mode")) url.searchParams.set("mode", "stt");

    // Blob required
    if (!(audioBlob instanceof Blob)) {
      throw new Error("postVoiceSTT expects a Blob.");
    }

    const ct = safeString(audioBlob.type).trim() || "audio/webm";

    const headers = buildCommonHeaders(
      mergeHeaders(
        {
          accept: "application/json",
          "content-type": ct,
        },
        options.extraHeaders
      )
    );

    return fetch(url.toString(), {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers,
      body: audioBlob,
      signal: options.signal,
    });
  }

  // ---- Expose on window for app.js
  window.EnlaceRepo = {
    init,
    getConfig,
    postChat,
    postTTS,
    postVoiceSTT,
  };
})();
