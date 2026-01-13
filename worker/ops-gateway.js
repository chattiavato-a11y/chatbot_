/* worker/ops-gateway.js
   OPS GATEWAY (v3.2) — PUBLIC EDGE
*/

const ALLOWED_ORIGINS = new Set([
  "https://chattiavato-a11y.github.io",
  "https://chattia.io",
  "https://www.chattia.io",
  "https://opsonlinesupport.com",
  "https://www.opsonlinesupport.com"
]);

const MAX_CHAT_BYTES = 8_192;
const MAX_AUDIO_BYTES = 1 * 1024 * 1024;
const MAX_REPORT_BYTES = 8_192;

const MAX_MSG_CHARS = 256;
const MAX_HISTORY_ITEMS = 12;

/* ------------ “Compliance-aligned” security headers (OWASP-friendly) ------------ */

const API_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'none'"
].join("; ");

const PERMISSIONS_POLICY = [
  "accelerometer=()","autoplay=()","camera=()","display-capture=()","encrypted-media=()","fullscreen=()",
  "geolocation=()","gyroscope=()","magnetometer=()","microphone=()","midi=()","payment=()",
  "picture-in-picture=()","publickey-credentials-get=()","screen-wake-lock=()","usb=()","bluetooth=()",
  "clipboard-read=()","clipboard-write=()","gamepad=()","hid=()","idle-detection=()","serial=()",
  "web-share=()","xr-spatial-tracking=()"
].join(", ");

function securityHeaders() {
  return {
    "Content-Security-Policy": API_CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-DNS-Prefetch-Control": "off",
    "X-XSS-Protection": "0",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Robots-Tag": "noindex, nofollow"
  };
}

/* -------------------- CORS -------------------- */

function originAllowed(origin) {
  return !!origin && ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(origin, requestedHeadersRaw = "") {
  const h = {
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
  };

  if (!originAllowed(origin)) return h;

  const requestedHeaders = (requestedHeadersRaw || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .join(", ");

  h["Access-Control-Allow-Origin"] = origin;
  h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  h["Access-Control-Allow-Headers"] = requestedHeaders || "Content-Type, X-Ops-Asset-Id";
  h["Access-Control-Max-Age"] = "600";
  h["Access-Control-Expose-Headers"] = "X-Ops-Request-Id";
  return h;
}

/* -------------------- Responses -------------------- */

function json(origin, status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...securityHeaders(),
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      ...extra
    }
  });
}

/* -------------------- Helpers -------------------- */

function normalizeUserText(s) {
  let out = String(s || "");
  out = out.replace(/[\u0000-\u001F\u007F]/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_MSG_CHARS) out = out.slice(0, MAX_MSG_CHARS);
  return out;
}

function looksSuspicious(s) {
  const t = String(s || "").toLowerCase();
  const badPatterns = [
    "<script", "</script", "javascript:",
    "<img", "onerror", "onload",
    "<iframe", "<object", "<embed",
    "<svg", "<link", "<meta", "<style",
    "document.cookie",
    "onmouseover", "onmouseenter",
    "<form", "<input", "<textarea"
  ];
  return badPatterns.some(p => t.includes(p));
}

function hasDataUriBase64(s) {
  return /data:\s*[^;]+;\s*base64\s*,/i.test(String(s || ""));
}

async function readBodyArrayBufferLimited(request, limitBytes) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len && len > limitBytes) return null;

  const ab = await request.arrayBuffer();
  if (!ab || ab.byteLength === 0) return null;
  if (ab.byteLength > limitBytes) return null;
  return ab;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sanitizeHistory(historyIn) {
  const out = [];
  if (!Array.isArray(historyIn)) return out;

  for (const item of historyIn) {
    if (!item || typeof item !== "object") continue;
    if (out.length >= MAX_HISTORY_ITEMS) break;

    const role = (item.role === "assistant") ? "assistant" : "user";
    const content = normalizeUserText(String(item.content || ""));
    if (!content) continue;
    if (looksSuspicious(content)) continue;

    out.push({ role, content });
  }
  return out;
}

/* -------------------- PCI-ish DLP: block payment cards (never collect) -------------------- */

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function luhnValid(numStr) {
  let sum = 0;
  let alt = false;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let n = numStr.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function containsLikelyCardNumber(text) {
  const raw = String(text || "");
  const candidates = raw.match(/(?:\d[ -]*?){13,19}/g) || [];
  for (const c of candidates) {
    const d = digitsOnly(c);
    if (d.length >= 13 && d.length <= 19 && luhnValid(d)) return true;
  }
  return false;
}

/* -------------------- Privacy: IP tagging (hash) -------------------- */

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexFromString(s) {
  const ab = new TextEncoder().encode(String(s || "")).buffer;
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return bytesToHex(new Uint8Array(digest));
}

async function ipTagOf(ip) {
  // 16 hex chars is enough to correlate events without storing raw IP
  const hex = await sha256HexFromString(ip);
  return hex.slice(0, 16);
}

/* -------------------- Minimal audit logging (no raw messages, no raw IP) -------------------- */

function randHex(byteLen = 16) {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}

async function logEvent(ctx, env, event) {
  const safe = { ts: new Date().toISOString(), ...event };
  console.warn("[OPS_EVENT]", JSON.stringify(safe));

  const kv = env.OPS_EVENTS;
  if (kv && typeof kv.put === "function") {
    const key = `ops_evt:${Date.now()}:${randHex(8)}`;
    ctx.waitUntil(
      kv.put(key, JSON.stringify(safe), { expirationTtl: 60 * 60 * 24 * 7 }).catch(() => {})
    );
  }
}

/* -------------------- Rate limiting (KV-based) — tightened limits -------------------- */
/**
 * Uses KV namespace OPS_RL (optional). Fail-open if not bound OR if KV errors occur.
 * Limits:
 * - Burst:     4 requests / 10 seconds
 * - Sustained: 30 requests / 5 minutes
 *
 * NOTE: Cloudflare KV expirationTtl must be >= 60 seconds.
 */
async function rateLimitCheck(env, ipKey) {
  const kv = env.OPS_RL;
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") return { ok: true, skipped: true };

  try {
    const now = Date.now();
    const burstWindowMs = 10_000;
    const minuteMs = 60_000;
    const windowMinutes = 5;

    const burstLimit = 4;
    const sustainedLimit = 30;

    const burstBucket = Math.floor(now / burstWindowMs);
    const minuteBucket = Math.floor(now / minuteMs);

    const kBurst = `rl:b:${ipKey}:${burstBucket}`;
    const burstCount = Number((await kv.get(kBurst)) || 0);
    if (burstCount + 1 > burstLimit) return { ok: false, retryAfter: 10 };

    // small sequential reads (KV has no multi-get)
    let sum = 0;
    let curMin = 0;

    for (let i = 0; i < windowMinutes; i++) {
      const k = `rl:m:${ipKey}:${minuteBucket - i}`;
      const v = Number((await kv.get(k)) || 0);
      if (i === 0) curMin = v;
      sum += v;
    }

    const nextSum = (sum - curMin) + (curMin + 1);
    if (nextSum > sustainedLimit) return { ok: false, retryAfter: 30 };

    // KV TTL must be >= 60
    await kv.put(kBurst, String(burstCount + 1), { expirationTtl: 60 });
    await kv.put(`rl:m:${ipKey}:${minuteBucket}`, String(curMin + 1), { expirationTtl: 60 * 10 });

    return { ok: true };
  } catch (e) {
    // Fail-open: never crash the request due to KV limits/config
    console.error("rateLimitCheck KV error (ignored):", e);
    return { ok: true, skipped: true };
  }
}

/* -------------------- FIREWALL llama-guard (required) -------------------- */

async function firewallCheck(env, textToCheck) {
  const fw = env.FIREWALL;
  if (!fw || typeof fw.run !== "function") return { ok: true, skipped: true };

  try {
    const out = await fw.run("@cf/meta/llama-guard-3-8b", { prompt: String(textToCheck || "") });
    const resp = String(out?.response || out?.result || "").trim().toLowerCase();
    if (!resp) return { ok: true, skipped: true };
    if (resp.includes("unsafe")) return { ok: false };
    if (resp === "safe") return { ok: true };
    return { ok: true };
  } catch (e) {
    console.error("FIREWALL llama-guard failed (ignored):", e);
    return { ok: true, skipped: true };
  }
}

/* -------------------- HMAC signing Gateway -> Brain (strong) -------------------- */

async function sha256HexFromArrayBuffer(ab) {
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function randomNonceHex(byteLen = 16) {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/**
 * bodySha = SHA256_HEX(rawBodyBytes)
 * toSign  = `${ts}.${nonce}.${method}.${path}.${bodySha}`
 * sig     = HMAC_SHA256_HEX(HAND_SHAKE, toSign)
 */
async function signForBrain(env, method, path, rawBodyArrayBuffer) {
  const secret = String(env.HAND_SHAKE || "");
  if (!secret) return null;

  const ts = String(Date.now());
  const nonce = randomNonceHex(16);
  const bodySha = await sha256HexFromArrayBuffer(rawBodyArrayBuffer);
  const toSign = [ts, nonce, method.toUpperCase(), path, bodySha].join(".");
  const sig = await hmacSha256Hex(secret, toSign);

  return {
    "X-Ops-Ts": ts,
    "X-Ops-Nonce": nonce,
    "X-Ops-Body-Sha256": bodySha,
    "X-Ops-Sig": sig
  };
}

function getAllowedAssetIds(env) {
  const raw = String(env.OPS_ASSET_IDS || env.ASSET_ID || "");
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

/* -------------------- Proxy to Brain (Service Binding) -------------------- */

async function proxyJsonToBrain(origin, request, env, ctx, brainPath, rawClientBodyAb, reqId, ip_tag) {
  if (!env.BRAIN || typeof env.BRAIN.fetch !== "function") {
    return json(origin, 500, {
      ok: false,
      error: "Gateway misconfigured (missing BRAIN service binding).",
      error_code: "NO_BRAIN_BINDING",
      request_id: reqId
    });
  }

  const signHeaders = await signForBrain(env, "POST", brainPath, rawClientBodyAb);
  if (!signHeaders) {
    return json(origin, 500, {
      ok: false,
      error: "Gateway misconfigured (missing HAND_SHAKE secret).",
      error_code: "NO_HAND_SHAKE",
      request_id: reqId
    });
  }

  const brainReq = new Request("https://brain.local" + brainPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Ops-Request-Id": reqId,
      ...signHeaders
    },
    body: rawClientBodyAb
  });

  let brainResp;
  try {
    brainResp = await env.BRAIN.fetch(brainReq);
  } catch (e) {
    console.error("BRAIN fetch failed:", e);
    await logEvent(ctx, env, { type: "BRAIN_UNREACHABLE", ip_tag, path: brainPath, request_id: reqId });
    return json(origin, 502, { ok: false, error: "Upstream error.", error_code: "UPSTREAM_ERROR", request_id: reqId });
  }

  const ab = await brainResp.arrayBuffer();
  const headers = new Headers({
    ...securityHeaders(),
    ...corsHeaders(origin),
    "Content-Type": brainResp.headers.get("content-type") || "application/json; charset=utf-8",
    "X-Ops-Request-Id": reqId
  });

  return new Response(ab, { status: brainResp.status, headers });
}

/* -------------------- Main Worker -------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname || "/";
    const origin = request.headers.get("Origin") || "";
    const clientIp = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const ip_tag = await ipTagOf(clientIp);
    const reqId = `req_${Date.now()}_${randHex(6)}`;

    const isChatPath = pathname === "/api/ops-online-chat";
    const isRoot = pathname === "/" || pathname === "/ping" || pathname === "/health";

    // Root/ping/health
    if (request.method === "GET" && isRoot) {
      return json(origin, 200, {
        ok: true,
        service: "ops-gateway",
        allowed_origins: Array.from(ALLOWED_ORIGINS),
        has_rate_limit_kv: !!(env.OPS_RL && typeof env.OPS_RL.get === "function"),
        has_firewall: !!(env.FIREWALL && typeof env.FIREWALL.run === "function"),
        request_id: reqId
      });
    }

    // Preflight (strict)
    if (request.method === "OPTIONS") {
      if (!originAllowed(origin)) {
        await logEvent(ctx, env, { type: "ORIGIN_BLOCK", ip_tag, origin_seen: origin, path: pathname, request_id: reqId });
        return json(origin, 403, { ok: false, error: "Origin not allowed.", error_code: "ORIGIN_BLOCK", origin_seen: origin, path: pathname, request_id: reqId });
      }

      const acrm = (request.headers.get("Access-Control-Request-Method") || "").toUpperCase();
      const acrhRaw = request.headers.get("Access-Control-Request-Headers") || "";
      const requested = (acrhRaw || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);

      const allowedHeaders = ["content-type", "x-ops-asset-id"];
      if (acrm && acrm !== "POST") return json(origin, 403, { ok: false, error: "Preflight rejected.", error_code: "PREFLIGHT_REJECT", request_id: reqId });

      const disallowed = requested.filter(h => !allowedHeaders.includes(h));
      if (disallowed.length) {
        await logEvent(ctx, env, { type: "PREFLIGHT_REJECT", ip_tag, origin_seen: origin, path: pathname, request_id: reqId, disallowed });
        return json(origin, 403, { ok: false, error: "Preflight rejected.", error_code: "PREFLIGHT_REJECT", request_id: reqId });
      }

      return new Response(null, {
        status: 204,
        headers: { ...securityHeaders(), ...corsHeaders(origin, acrhRaw) }
      });
    }

    // Helpful 404 for common wrong path
    if (pathname === "/api/chat") {
      return json(origin, 404, {
        ok: false,
        error: "Not found.",
        error_code: "WRONG_PATH",
        hint: "Use /api/ops-online-chat.",
        request_id: reqId
      });
    }

    if (!isChatPath) {
      return json(origin, 404, { ok: false, error: "Not found.", error_code: "NOT_FOUND", request_id: reqId });
    }
    if (request.method !== "POST") {
      return json(origin, 405, { ok: false, error: "POST only.", error_code: "METHOD_NOT_ALLOWED", request_id: reqId });
    }

    // 1) Enforce origin
    if (!originAllowed(origin)) {
      await logEvent(ctx, env, { type: "ORIGIN_BLOCK", ip_tag, origin_seen: origin, path: pathname, request_id: reqId });
      return json(origin, 403, {
        ok: false,
        error: "Origin not allowed.",
        error_code: "ORIGIN_BLOCK",
        origin_seen: origin,
        path: pathname,
        request_id: reqId
      });
    }

    // 2) Rate limit early (tight) — keyed by ip_tag (privacy)
    const rl = await rateLimitCheck(env, ip_tag);
    if (!rl.ok) {
      await logEvent(ctx, env, { type: "RATE_LIMIT", ip_tag, origin_seen: origin, path: pathname, request_id: reqId });
      return json(origin, 429, {
        ok: false,
        error: "Too many requests. Please wait and try again.",
        error_code: "RATE_LIMIT",
        request_id: reqId
      }, {
        "Retry-After": String(Math.max(1, Number(rl.retryAfter || 10)))
      });
    }

    // 3) Verify Asset ID allowlist (STRICT) — clearer errors
    const allowedAssets = getAllowedAssetIds(env);
    if (!allowedAssets.length) {
      return json(origin, 500, {
        ok: false,
        error: "Gateway config error (missing OPS_ASSET_IDS/ASSET_ID).",
        error_code: "NO_ASSET_ALLOWLIST",
        request_id: reqId
      });
    }

    const clientAssetId = request.headers.get("X-Ops-Asset-Id") || "";
    if (!clientAssetId) {
      await logEvent(ctx, env, { type: "ASSET_BLOCK", ip_tag, origin_seen: origin, path: pathname, request_id: reqId, reason: "missing" });
      return json(origin, 401, {
        ok: false,
        error: "Unauthorized client.",
        error_code: "MISSING_ASSET_ID",
        hint: "Send the X-Ops-Asset-Id header from the website/app.",
        request_id: reqId
      });
    }

    if (!allowedAssets.some(v => v === clientAssetId)) {
      await logEvent(ctx, env, { type: "ASSET_BLOCK", ip_tag, origin_seen: origin, path: pathname, request_id: reqId, reason: "invalid" });
      return json(origin, 401, {
        ok: false,
        error: "Unauthorized client.",
        error_code: "INVALID_ASSET_ID",
        hint: "X-Ops-Asset-Id must match the gateway allowlist.",
        request_id: reqId
      });
    }

    // 4) JSON-only
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      return json(origin, 415, { ok: false, error: "JSON only.", error_code: "UNSUPPORTED_MEDIA_TYPE", request_id: reqId });
    }

    const raw = await readBodyArrayBufferLimited(request, MAX_CHAT_BYTES);
    if (!raw) {
      return json(origin, 413, { ok: false, error: "Request too large or empty.", error_code: "PAYLOAD_TOO_LARGE", request_id: reqId });
    }

    const bodyText = new TextDecoder().decode(raw);

    // 5) Block uploads & obvious injection
    if (hasDataUriBase64(bodyText) || looksSuspicious(bodyText)) {
      await logEvent(ctx, env, { type: "SANITIZE_BLOCK", ip_tag, origin_seen: origin, path: pathname, request_id: reqId, reason: "body" });
      return json(origin, 400, { ok: false, error: "Request blocked.", error_code: "SANITIZE_BLOCK", request_id: reqId });
    }

    // 6) Parse + enforce schema
    const payload = safeJsonParse(bodyText);
    if (!payload || typeof payload !== "object") {
      return json(origin, 400, { ok: false, error: "Invalid JSON.", error_code: "BAD_JSON", request_id: reqId });
    }

    // Honeypots
    const hpEmail = String(payload.hp_email || "").trim();
    const hpWebsite = String(payload.hp_website || "").trim();
    if (hpEmail || hpWebsite) {
      await logEvent(ctx, env, { type: "HONEYPOT_TRIP", ip_tag, origin_seen: origin, path: pathname, request_id: reqId });
      return json(origin, 400, { ok: false, error: "Request blocked.", error_code: "HONEYPOT", request_id: reqId });
    }

    const lang = (payload.lang === "es") ? "es" : "en";
    const message = normalizeUserText(typeof payload.message === "string" ? payload.message : "");
    const history = sanitizeHistory(payload.history);

    if (!message) {
      return json(origin, 400, { ok: false, error: "No message provided.", error_code: "NO_MESSAGE", lang, request_id: reqId });
    }
    if (looksSuspicious(message)) {
      return json(origin, 400, { ok: false, error: "Request blocked.", error_code: "SANITIZE_BLOCK", lang, request_id: reqId });
    }

    // 7) PCI-ish DLP: never accept card numbers
    if (containsLikelyCardNumber(message) || containsLikelyCardNumber(bodyText)) {
      await logEvent(ctx, env, { type: "DLP_BLOCK_CARD", ip_tag, origin_seen: origin, path: pathname, request_id: reqId });
      return json(origin, 400, {
        ok: false,
        lang,
        request_id: reqId,
        error_code: "DLP_BLOCK_CARD",
        error: lang === "es"
          ? "Por seguridad, no compartas datos de tarjeta en el chat. Usa la página de contacto del sitio."
          : "For security, do not share card details in chat. Please use the site contact page."
      });
    }

    // 8) FIREWALL llama-guard on the user message (required)
    const fw = await firewallCheck(env, message);
    if (!fw.ok) {
      await logEvent(ctx, env, { type: "FIREWALL_BLOCK", ip_tag, origin_seen: origin, path: pathname, request_id: reqId });
      return json(origin, 400, { ok: false, error: "Request blocked.", error_code: "FIREWALL_BLOCK", lang, request_id: reqId });
    }

    // 9) Forward upstream (turnstile removed)
    const cleanPayload = { lang, message, history, v: 3 };
    const rawUpstream = new TextEncoder().encode(JSON.stringify(cleanPayload)).buffer;

    return proxyJsonToBrain(origin, request, env, ctx, "/api/ops-online-chat", rawUpstream, reqId, ip_tag);
  }
};
