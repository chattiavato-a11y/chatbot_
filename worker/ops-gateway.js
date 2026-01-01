/**
 * OPS GATEWAY (v2)
 * GH Pages / www.chattia.io (UI) -> Gateway -> Brain (service binding)
 *
 * Upgrades vs v1:
 * - Strict CORS allowlist (GH Pages + www.chattia.io)
 * - Stronger OWASP header set (HTTP headers, always-on for errors too)
 * - HMAC request signing to Brain (anti-replay window) instead of plain shared header
 * - Cleaner CSP for API responses (no fake nonces on JSON APIs)
 * - Preflight validation + safer reporting endpoints handling
 */

const ALLOWED_ORIGINS = [
  "https://chattiavato-a11y.github.io",
  "https://www.chattia.io",
  "https://chattia.io"
];

const MAX_BODY_BYTES = 4096; // room for Turnstile token + hp fields
const MAX_MSG_CHARS = 256;

const REPO_URL = "https://github.com/chattiavato-a11y/ops-online-support";
const BRAIN_URL = "https://ops-online-assistant.grabem-holdem-nuts-right.workers.dev/api/ops-online-chat";
const GATEWAY_ORIGIN = "https://ops-gateway.grabem-holdem-nuts-right.workers.dev";

const CSP_REPORT_PATH = "/reports/csp";
const TELEMETRY_REPORT_PATH = "/reports/telemetry";

/* -------------------- Reporting config (CSP/Telemetry) -------------------- */

const REPORTING_ENDPOINTS = {
  csp: {
    group: "csp-endpoint",
    max_age: 86400,
    endpoints: [{ url: `${GATEWAY_ORIGIN}${CSP_REPORT_PATH}` }]
  },
  telemetry: {
    group: "telemetry",
    max_age: 86400,
    endpoints: [{ url: `${GATEWAY_ORIGIN}${TELEMETRY_REPORT_PATH}` }]
  }
};

/* -------------------- Security headers (API-safe, OWASP-aligned) -------------------- */

const API_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'"
].join("; ");

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "usb=()",
  "bluetooth=()",
  "clipboard-read=()",
  "clipboard-write=()",
  "gamepad=()",
  "hid=()",
  "idle-detection=()",
  "serial=()",
  "web-share=()",
  "xr-spatial-tracking=()"
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
    "Report-To": JSON.stringify([REPORTING_ENDPOINTS.csp, REPORTING_ENDPOINTS.telemetry]),
    "Reporting-Endpoints": [
      `${REPORTING_ENDPOINTS.csp.group}="${REPORTING_ENDPOINTS.csp.endpoints[0].url}"`,
      `${REPORTING_ENDPOINTS.telemetry.group}="${REPORTING_ENDPOINTS.telemetry.endpoints[0].url}"`
    ].join(", ")
  };
}

/* -------------------- CORS -------------------- */

function originAllowed(origin) {
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(origin) {
  const h = {
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
  };

  if (!originAllowed(origin)) return h;

  h["Access-Control-Allow-Origin"] = origin;
  h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  h["Access-Control-Allow-Headers"] = "Content-Type, X-Ops-Asset-Id";
  h["Access-Control-Max-Age"] = "600";
  return h;
}

/* -------------------- Responses -------------------- */

function json(origin, status, obj, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      ...securityHeaders(),
      ...corsHeaders(origin),
      "content-type": "application/json; charset=utf-8",
      ...extra
    }
  });
}

function text(status, msg) {
  return new Response(msg, {
    status,
    headers: { ...securityHeaders(), "content-type": "text/plain; charset=utf-8" }
  });
}

function localizedError(lang, enText, esText) {
  return lang === "es" ? esText : enText;
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
  return badPatterns.some((p) => t.includes(p));
}

function hasDataUriBase64(s) {
  return /data:\s*[^;]+;\s*base64\s*,/i.test(String(s || ""));
}

async function readBodyLimited(request) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len && len > MAX_BODY_BYTES) return null;

  const ab = await request.arrayBuffer();
  if (ab.byteLength === 0 || ab.byteLength > MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(ab);
}

function randId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Privacy: do NOT store raw message or tokens. Minimal metadata only.
 * Optional KV sink: bind KV as OPS_EVENTS (optional).
 */
async function logEvent(ctx, env, event) {
  const safe = { ts: new Date().toISOString(), ...event };
  console.warn("[OPS_EVENT]", JSON.stringify(safe));

  if (env.OPS_EVENTS && typeof env.OPS_EVENTS.put === "function") {
    const key = `ops_evt:${Date.now()}:${randId()}`;
    ctx.waitUntil(
      env.OPS_EVENTS.put(key, JSON.stringify(safe), { expirationTtl: 60 * 60 * 24 * 7 })
    );
  }
}

/* -------------------- Optional AI guard -------------------- */

async function aiGuardIfAvailable(env, textToCheck) {
  const ai = env.MY_BRAIN;
  if (!ai || typeof ai.run !== "function") return { ok: true };

  try {
    const out = await ai.run("@cf/meta/llama-guard-3-8b", { prompt: textToCheck });
    const resp = String(out?.response || out?.result || "").trim().toLowerCase();
    if (!resp) return { ok: true };
    if (resp.includes("unsafe")) return { ok: false };
    if (resp === "safe") return { ok: true };
    return { ok: true };
  } catch (e) {
    console.error("AI guard failed (ignored):", e);
    return { ok: true };
  }
}

/* -------------------- Rate Limiting (Durable Object) -------------------- */

async function rateLimitCheck(request, env) {
  if (!env.OPS_RL) return { ok: true }; // fail-open if not bound

  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const id = env.OPS_RL.idFromName(`ip:${ip}`);
  const stub = env.OPS_RL.get(id);

  const res = await stub.fetch("https://rl/check", { method: "POST" });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!data || typeof data.ok !== "boolean") return { ok: true };
  return data;
}

/* -------------------- HMAC signing Gateway -> Brain -------------------- */

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return out === 0;
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

/* -------------------- Main Worker -------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname || "/";
    const origin = request.headers.get("Origin") || "";
    const clientIp = request.headers.get("CF-Connecting-IP") || "";

    const isChatPath = pathname === "/api/ops-online-chat";
    const isRoot = pathname === "/" || pathname === "/ping";
    const isCspReport = pathname === CSP_REPORT_PATH;
    const isTelemetryReport = pathname === TELEMETRY_REPORT_PATH;

    // Root/ping
    if (isRoot) {
      return json(origin, 200, {
        ok: true,
        service: "ops-gateway",
        usage: "POST /api/ops-online-chat with X-Ops-Asset-Id header",
        allowed_origins: ALLOWED_ORIGINS,
        repo: REPO_URL
      });
    }

    // Reports preflight
    if ((isCspReport || isTelemetryReport) && request.method === "OPTIONS") {
      if (!originAllowed(origin)) return json(origin, 403, { error: "Origin not allowed." });
      return new Response(null, {
        status: 204,
        headers: { ...securityHeaders(), ...corsHeaders(origin) }
      });
    }

    // Reports ingestion
    if (isCspReport || isTelemetryReport) {
      if (!originAllowed(origin)) {
        await logEvent(ctx, env, { type: "REPORT_ORIGIN_BLOCK", ip: clientIp });
        return json(origin, 403, { error: "Origin not allowed." });
      }

      if (request.method !== "POST") return json(origin, 405, { error: "POST only." });

      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) return json(origin, 415, { error: "JSON only." });

      const bodyText = await readBodyLimited(request);
      if (!bodyText) return json(origin, 400, { error: "Empty report." });

      let data = {};
      try { data = JSON.parse(bodyText); } catch {}

      const event = {
        type: isCspReport ? "CSP_REPORT" : "TELEMETRY",
        ip: clientIp,
        ua: request.headers.get("User-Agent") || "",
        sample: Math.random(),
        report: data
      };

      // sampling
      if (event.sample <= 0.9) await logEvent(ctx, env, event);
      return json(origin, 202, { ok: true });
    }

    // CORS preflight for chat
    if (isChatPath && request.method === "OPTIONS") {
      if (!originAllowed(origin)) return json(origin, 403, { error: "Origin not allowed." });

      // Validate preflight method/header hints (fail closed)
      const acrm = (request.headers.get("Access-Control-Request-Method") || "").toUpperCase();
      const acrh = (request.headers.get("Access-Control-Request-Headers") || "").toLowerCase();

      if (acrm && acrm !== "POST") return json(origin, 403, { error: "Preflight rejected." });
      if (acrh && !acrh.split(",").map(s => s.trim()).every(h => ["content-type", "x-ops-asset-id"].includes(h))) {
        return json(origin, 403, { error: "Preflight rejected." });
      }

      return new Response(null, {
        status: 204,
        headers: { ...securityHeaders(), ...corsHeaders(origin) }
      });
    }

    if (!isChatPath) return json(origin, 404, { error: "Not found.", hint: "Use POST /api/ops-online-chat" });
    if (request.method !== "POST") return json(origin, 405, { error: "POST only." });

    // 1) Enforce origin
    if (!originAllowed(origin)) {
      await logEvent(ctx, env, { type: "ORIGIN_BLOCK", ip: clientIp, origin });
      return json(origin, 403, { error: "Origin not allowed." });
    }

    // 2) Rate limit early
    const rl = await rateLimitCheck(request, env);
    if (!rl.ok) {
      await logEvent(ctx, env, { type: "RATE_LIMIT", ip: clientIp });
      return json(origin, 429, { error: "Too many requests. Please wait and try again." }, {
        "Retry-After": String(Math.max(1, Number(rl.retryAfter || 10)))
      });
    }

    // 3) JSON-only, reject uploads
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
      await logEvent(ctx, env, { type: "UPLOAD_BLOCK", ip: clientIp, reason: "content-type" });
      return json(origin, 415, { error: "Unsupported content type." });
    }
    if (!ct.includes("application/json")) {
      await logEvent(ctx, env, { type: "UPLOAD_BLOCK", ip: clientIp, reason: "not-json" });
      return json(origin, 415, { error: "JSON only." });
    }

    // 4) Verify Asset ID
    const allowedAssets = (env.OPS_ASSET_IDS || env.ASSET_ID || "")
      .toString()
      .split(",")
      .map(v => v.trim())
      .filter(Boolean);

    if (!allowedAssets.length) {
      return json(origin, 500, { error: "Gateway config error (missing OPS_ASSET_IDS/ASSET_ID)." });
    }

    const clientAssetId = request.headers.get("X-Ops-Asset-Id") || "";
    if (!clientAssetId || !allowedAssets.some(v => v === clientAssetId)) {
      await logEvent(ctx, env, { type: "ASSET_BLOCK", ip: clientIp });
      return json(origin, 401, { error: "Unauthorized client." });
    }

    // 5) Read + parse body (limited)
    const bodyText = await readBodyLimited(request);
    if (!bodyText) return json(origin, 413, { error: "Request too large or empty." });

    if (hasDataUriBase64(bodyText)) {
      await logEvent(ctx, env, { type: "UPLOAD_BLOCK", ip: clientIp, reason: "data-uri-base64" });
      return json(origin, 400, { error: "Uploads are not allowed." });
    }

    let payload = {};
    try { payload = JSON.parse(bodyText); } catch { payload = {}; }

    const langRaw = typeof payload.lang === "string" ? payload.lang.toLowerCase() : "en";
    const lang = langRaw === "es" ? "es" : "en";

    // Honeypots
    const hpEmail = typeof payload.hp_email === "string" ? payload.hp_email.trim() : "";
    const hpWebsite = typeof payload.hp_website === "string" ? payload.hp_website.trim() : "";
    if (hpEmail || hpWebsite) {
      await logEvent(ctx, env, { type: "HONEYPOT_TRIP", ip: clientIp });
      return json(origin, 400, { error: localizedError(lang, "Request blocked.", "Solicitud bloqueada."), lang });
    }

    // Turnstile
    const turnstileToken = typeof payload.turnstileToken === "string" ? payload.turnstileToken : "";
    const turnstileSecret = (env.TURNSTILE_SECRET || "").toString();
    if (!turnstileSecret) {
      return json(origin, 500, { error: localizedError(lang, "Gateway config error (missing TURNSTILE_SECRET).", "Error de configuración del gateway (falta TURNSTILE_SECRET)."), lang });
    }
    if (!turnstileToken) {
      await logEvent(ctx, env, { type: "TURNSTILE_FAIL", ip: clientIp, reason: "missing" });
      return json(origin, 400, { error: localizedError(lang, "Turnstile verification failed.", "La verificación de Turnstile falló."), lang });
    }

    let turnstileResult;
    try {
      const verificationRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: turnstileSecret,
          response: turnstileToken,
          remoteip: clientIp
        })
      });
      turnstileResult = await verificationRes.json();
    } catch (err) {
      console.error("Turnstile verification error:", err);
      await logEvent(ctx, env, { type: "TURNSTILE_FAIL", ip: clientIp, reason: "verify-error" });
      return json(origin, 502, { error: localizedError(lang, "Turnstile verification failed.", "La verificación de Turnstile falló."), lang });
    }

    if (!turnstileResult?.success) {
      await logEvent(ctx, env, { type: "TURNSTILE_FAIL", ip: clientIp, reason: "rejected" });
      return json(origin, 403, { error: localizedError(lang, "Turnstile verification failed.", "La verificación de Turnstile falló."), lang });
    }

    // Message
    const msgRaw = typeof payload.message === "string" ? payload.message : "";
    const v = Number.isInteger(payload.v) ? payload.v : 1;
    const message = normalizeUserText(msgRaw);

    if (!message) {
      return json(origin, 400, { error: localizedError(lang, "No message provided.", "No se proporcionó ningún mensaje."), lang });
    }

    // Sanitization
    if (looksSuspicious(bodyText) || looksSuspicious(message)) {
      await logEvent(ctx, env, { type: "SANITIZE_BLOCK", ip: clientIp, reason: "pattern" });
      return json(origin, 400, { error: localizedError(lang, "Request blocked by OPS security gateway.", "Solicitud bloqueada por el gateway de seguridad OPS."), lang });
    }

    // Optional AI guard
    const guard = await aiGuardIfAvailable(env, message);
    if (!guard.ok) {
      await logEvent(ctx, env, { type: "SANITIZE_BLOCK", ip: clientIp, reason: "ai-guard" });
      return json(origin, 400, { error: localizedError(lang, "Request blocked by OPS safety gateway.", "Solicitud bloqueada por el gateway de seguridad OPS."), lang });
    }

    // Gateway -> Brain secret
    const handShake = (env.HAND_SHAKE || "").toString();
    if (!handShake) {
      return json(origin, 500, { error: localizedError(lang, "Gateway config error (missing HAND_SHAKE).", "Error de configuración del gateway (falta HAND_SHAKE)."), lang });
    }

    // Must have service binding
    if (!env.BRAIN || typeof env.BRAIN.fetch !== "function") {
      return json(origin, 500, { error: localizedError(lang, "Gateway config error (missing BRAIN binding).", "Error de configuración del gateway (falta la vinculación BRAIN)."), lang });
    }

    // Forward to brain (HMAC signed, anti-replay)
    const brainBody = JSON.stringify({ message, lang, v });
    const ts = Date.now().toString();
    const sig = await hmacSha256Hex(handShake, `${ts}.${brainBody}`);

    let brainRes;
    try {
      brainRes = await env.BRAIN.fetch(BRAIN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ops-Ts": ts,
          "X-Ops-Sig": sig
        },
        body: brainBody
      });
    } catch (err) {
      console.error("Gateway -> Brain error:", err);
      await logEvent(ctx, env, { type: "BRAIN_UNREACHABLE", ip: clientIp });
      return json(origin, 502, { error: localizedError(lang, "Gateway could not reach brain.", "El gateway no pudo conectarse con el cerebro."), lang });
    }

    const responseText = await brainRes.text();
    let out = null;
    try { out = JSON.parse(responseText); } catch { out = null; }

    if (!out || typeof out !== "object") {
      await logEvent(ctx, env, { type: "BRAIN_BAD_JSON", ip: clientIp });
      return json(origin, 502, { error: localizedError(lang, "Brain returned invalid JSON.", "El cerebro devolvió JSON no válido."), lang });
    }

    // Always return JSON with gateway headers
    return json(origin, brainRes.status, { ...out, lang });
  }
};

/* -------------------- Durable Object: Rate Limiter -------------------- */
/**
 * Limits:
 *  - Burst: 5 requests / 10 seconds
 *  - Sustained: 60 requests / 5 minutes
 *
 * Bind this DO in the Gateway Worker:
 *   Binding name: OPS_RL
 *   Class name:   OpsRateLimiter
 */
export class OpsRateLimiter {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }

    const now = Date.now();

    const burstLimit = 5;
    const burstWindowMs = 10_000;

    const sustainedLimit = 60;
    const minuteMs = 60_000;
    const windowMinutes = 5;

    const burstBucket = Math.floor(now / burstWindowMs);
    const minuteBucket = Math.floor(now / minuteMs);

    const kBurst = `b:${burstBucket}`;
    const kMinute = (i) => `m:${minuteBucket - i}`;

    const burstCount = Number(await this.storage.get(kBurst) || 0);

    const keys = [];
    for (let i = 0; i < windowMinutes; i++) keys.push(kMinute(i));
    const got = await this.storage.get(keys);

    let sum = 0;
    for (const k of keys) sum += Number(got?.get?.(k) || 0);

    const currentMinute = Number(got?.get?.(kMinute(0)) || 0);

    const nextBurst = burstCount + 1;
    const nextMinute = currentMinute + 1;
    const nextSum = (sum - currentMinute) + nextMinute;

    if (nextBurst > burstLimit) {
      return new Response(JSON.stringify({ ok: false, retryAfter: 10 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (nextSum > sustainedLimit) {
      return new Response(JSON.stringify({ ok: false, retryAfter: 30 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    await this.storage.put(kBurst, nextBurst);
    await this.storage.put(kMinute(0), nextMinute);

    // Cleanup old buckets (best effort)
    await this.storage.delete([
      `b:${burstBucket - 4}`,
      `b:${burstBucket - 5}`,
      `m:${minuteBucket - 11}`,
      `m:${minuteBucket - 12}`
    ]);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
}
