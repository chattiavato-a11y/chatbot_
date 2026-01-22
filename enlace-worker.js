/**
 * src/index.js — Cloudflare Worker: enlace (v0.4.2 FINAL + SHA512-only + Enlace<->Brain ID)
 *
 * ✅ SHA256 REMOVED بالكامل:
 * - Removed: x-ops-asset-sha256 header
 * - Removed: ASSET_ID_SHA256 env
 * - Removed: all SHA256 checks / CORS allow for SHA256
 *
 * ✅ Repo scheme (ops-keys.json) ONLY:
 * - Requires + forwards:
 *    - x-ops-asset-id
 *    - x-ops-src-sha512-b64
 *
 * Required bindings:
 * - env.AI     (Workers AI) for Llama Guard + Whisper + optional language detect/translate
 * - env.brain  (Service Binding) -> nettunian-io
 *
 * Runtime variables/secrets used:
 * - TURNSTILE_SECRET_KEY (Secret) optional
 * - OPS_ASSET_ALLOWLIST  (JSON array string OR comma string)
 * - SRC_PUBLIC_SHA512_B64 (Plaintext) expected for x-ops-src-sha512-b64   <-- REQUIRED when allowlist enabled
 *
 * Enlace <-> Brain identity (optional but recommended):
 * - NET_ID               (Plaintext)
 * - NET_ID_SHA512        (Plaintext)
 * - TRAFFIC_PUB_JWK      (JSON, optional) RSA public key for encrypted seal
 * - HANDSHAKE_ID         (Secret; private JWK material) RS512 signature proof Enlace->Brain
 * - ENLACE_BRAIN_Public_JWK (Plaintext JSON) forwarded to Brain
 * - BRAIN_ENLACE_Public_JWK  (Secret JSON) expected Brain identity (if Brain echoes it)
 *
 * Routes:
 * - POST /api/chat   (text)  -> streams Brain SSE
 * - POST /api/voice  (audio) -> Whisper STT -> detect lang -> mode=stt JSON OR streams Brain SSE
 */

const ALLOWED_ORIGINS = new Set([
  "https://chattiavato-a11y.github.io",
  "https://www.chattia.io",
  "https://chattia.io",
]);

const GUARD_MODEL_ID = "@cf/meta/llama-guard-3-8b";
const WHISPER_MODEL_ID = "@cf/openai/whisper-large-v3-turbo";
const TRANSLATE_MODEL_ID = "@cf/meta/m2m100-1.2b";
const LANG_DETECT_MODEL_ID = "@cf/meta/llama-3.2-3b-instruct";

const VOICE_TIMEOUT_SEC = 120;

const MAX_BODY_CHARS = 24_000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024; // 12MB hard cap

// Browser->Worker CORS request headers allowed (SHA256 removed)
const BASE_ALLOWED_HEADERS = new Set([
  "content-type",
  "accept",
  "x-ops-asset-id",
  "x-ops-src-sha512-b64",
  "cf-turnstile-response",
]);

// -------------------- helpers --------------------
function safeTextOnly(s) {
  s = String(s || "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160;
    if (ok) out += s[i];
  }
  out = out.replace(/[ \t]{3,}/g, "  ").replace(/\n{4,}/g, "\n\n\n");
  return out.trim();
}

function looksLikeCodeOrMarkup(text) {
  const raw = String(text || "");
  const t = raw.toLowerCase();
  if (raw.includes("```")) return true;
  if (/<\/?[a-z][\s\S]*>/i.test(raw)) return true;
  if (t.includes("<script") || t.includes("javascript:")) return true;

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
  return patterns.some((re) => re.test(raw));
}

function corsHeaders(origin, request) {
  const h = new Headers();

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }

  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");

  const reqHdrs = (request?.headers?.get("Access-Control-Request-Headers") || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const safe = [];
  for (const name of reqHdrs) {
    if (BASE_ALLOWED_HEADERS.has(name)) safe.push(name);
  }

  // Always include essentials
  safe.push("content-type", "accept", "x-ops-asset-id", "x-ops-src-sha512-b64", "cf-turnstile-response");

  h.set("Access-Control-Allow-Headers", Array.from(new Set(safe)).join(", "));
  h.set("Access-Control-Max-Age", "86400");

  // UI-readable response headers
  h.set(
    "Access-Control-Expose-Headers",
    [
      "x-chattia-voice-timeout-sec",
      "x-chattia-stt-lang",
      "x-chattia-stt-iso2",
      "x-chattia-stt-bcp47",
      "x-chattia-text-iso2",
      "x-chattia-text-bcp47",
      "x-chattia-brain-id-seen",
    ].join(",")
  );

  return h;
}

function securityHeaders() {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");

  const micAllow = `microphone=(self ${Array.from(ALLOWED_ORIGINS).map((o) => `"${o}"`).join(" ")})`;
  h.set("Permissions-Policy", `geolocation=(), ${micAllow}, camera=(), payment=()`);

  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
  );
  h.set("Cache-Control", "no-store, no-transform");
  return h;
}

function json(status, obj, extraHeaders) {
  const h = new Headers(extraHeaders || {});
  h.set("content-type", "application/json; charset=utf-8");
  securityHeaders().forEach((v, k) => h.set(k, v));
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function sse(stream, extraHeaders) {
  const h = new Headers(extraHeaders || {});
  h.set("content-type", "text/event-stream; charset=utf-8");
  h.set("cache-control", "no-cache, no-transform");
  securityHeaders().forEach((v, k) => h.set(k, v));
  return new Response(stream, { status: 200, headers: h });
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;

    let content = typeof m.content === "string" ? m.content : "";
    content = safeTextOnly(content);
    if (!content) continue;

    if (content.length > MAX_MESSAGE_CHARS) content = content.slice(0, MAX_MESSAGE_CHARS);
    out.push({ role, content });
  }
  return out;
}

function parseGuardResult(res) {
  const r = res?.response ?? res?.result?.response ?? res?.result ?? res;

  if (r && typeof r === "object" && typeof r.safe === "boolean") {
    return { safe: r.safe, categories: Array.isArray(r.categories) ? r.categories : [] };
  }

  if (typeof r === "string") {
    const lower = r.toLowerCase();
    if (lower.includes("unsafe")) return { safe: false, categories: [] };
    if (lower.includes("safe")) return { safe: true, categories: [] };
  }

  return { safe: false, categories: ["GUARD_UNPARSEABLE"] };
}

// -------------------- OPS_ASSET_ALLOWLIST + SHA512(B64) enforcement --------------------
function normalizeId(s) {
  return String(s || "").trim().replace(/\/+$/g, "");
}

function parseOpsAssetAllowlist(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normalizeId).filter(Boolean);

  const s = String(raw || "").trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map(normalizeId).filter(Boolean);
  } catch {
    // ignore
  }
  return s.split(",").map((x) => normalizeId(x)).filter(Boolean);
}

function timingSafeEqualStr(a, b) {
  // constant-time-ish compare to reduce timing leak
  a = String(a || "");
  b = String(b || "");
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i) || 0;
    const cb = b.charCodeAt(i) || 0;
    diff |= (ca ^ cb);
  }
  return diff === 0;
}

/**
 * SHA512-only gate:
 * - If OPS_ASSET_ALLOWLIST is non-empty => require:
 *    - x-ops-asset-id exists and is in allowlist
 *    - env.SRC_PUBLIC_SHA512_B64 exists
 *    - x-ops-src-sha512-b64 exists and matches env.SRC_PUBLIC_SHA512_B64
 */
function enforceAssetIdentity(request, env) {
  const allow = parseOpsAssetAllowlist(env?.OPS_ASSET_ALLOWLIST);
  if (!allow.length) return { ok: true }; // disabled if empty

  const assetId = normalizeId(request.headers.get("x-ops-asset-id"));
  if (!assetId) return { ok: false, reason: "Missing x-ops-asset-id" };
  if (!allow.includes(assetId)) return { ok: false, reason: "Asset not allowlisted" };

  const expectedSrc = normalizeId(env?.SRC_PUBLIC_SHA512_B64 || env?.SRC_SHA512_B64).trim();
  if (!expectedSrc) return { ok: false, reason: "Missing env SRC_PUBLIC_SHA512_B64" };

  const gotSrc = normalizeId(request.headers.get("x-ops-src-sha512-b64")).trim();
  if (!gotSrc) return { ok: false, reason: "Missing x-ops-src-sha512-b64" };

  if (!timingSafeEqualStr(gotSrc, expectedSrc)) return { ok: false, reason: "Bad src sha512 (b64) token" };

  return { ok: true };
}

// -------------------- Turnstile --------------------
async function verifyTurnstile(request, env) {
  if (!env?.TURNSTILE_SECRET_KEY) return { ok: true, reason: "Turnstile disabled" };

  const token = String(request.headers.get("cf-turnstile-response") || "").trim();
  if (!token) return { ok: false, reason: "Missing Turnstile token" };

  const ip = String(request.headers.get("CF-Connecting-IP") || "").trim();

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });

  const data = await resp.json().catch(() => null);
  if (!data || data.success !== true) return { ok: false, reason: "Turnstile failed" };
  return { ok: true };
}

// -------------------- Language helpers --------------------
function normalizeMetaLangToIso2(metaLangRaw) {
  const raw = String(metaLangRaw || "").trim();
  if (!raw) return "";

  const upper = raw.toUpperCase();
  if (upper === "ES") return "es";
  if (upper === "EN") return "en";

  const m = raw.match(/^([a-zA-Z]{2,3})([-_][a-zA-Z]{2,3})?$/);
  if (!m) return "";
  return String(m[1] || "").toLowerCase();
}

function detectENESHeuristic(text) {
  const t = String(text || "").toLowerCase();
  if (/[ñáéíóúü¿¡]/i.test(t)) return "es";

  const esHits = [
    "hola","gracias","por favor","buenos","buenas","como","qué","que ",
    "dónde","donde","cuánto","cuanto","necesito","ayuda","quiero",
    "tengo","puedo","hacer","porque","también",
  ].filter((w) => t.includes(w)).length;

  return esHits >= 2 ? "es" : "en";
}

async function detectLangIso2Universal(env, text) {
  const sample = safeTextOnly(String(text || "")).slice(0, 700);
  if (!sample) return "en";

  const enes = detectENESHeuristic(sample);
  if (enes === "es") return "es";

  const enSignals = [" the ", " and ", " is ", " are ", " you ", " what ", " why ", " how "]
    .filter((w) => sample.toLowerCase().includes(w)).length;
  if (enSignals >= 2) return "en";

  const detectorMsgs = [
    {
      role: "system",
      content:
        "You are a language detector. Return ONLY the ISO 639-1 two-letter language code for the text. " +
        "If uncertain, return 'und'. No punctuation, no extra words.",
    },
    { role: "user", content: `TEXT:\n<<<${sample}>>>` },
  ];

  try {
    const out = await env.AI.run(LANG_DETECT_MODEL_ID, { messages: detectorMsgs, stream: false, max_tokens: 8 });
    const raw = safeTextOnly(out?.response || out?.result?.response || out?.text || out || "").toLowerCase();
    const token = (raw.match(/\b([a-z]{2}|und)\b/) || [])[1] || "";
    if (token && token !== "und") return token;
  } catch {
    // ignore
  }

  return "en";
}

function bcp47FromIso2(iso2) {
  const x = String(iso2 || "").toLowerCase();
  if (x === "es") return "es-ES";
  if (x === "en") return "en-US";
  return x || "en-US";
}

function legacyENESFromIso2(iso2) {
  const x = String(iso2 || "").toLowerCase();
  return x === "es" ? "ES" : "EN";
}

function metaLangForBrain(iso2) {
  const x = String(iso2 || "").toLowerCase();
  if (x === "es") return "ES";
  if (x === "en") return "EN";
  return x || "EN";
}

// -------------------- Models --------------------
async function runWhisper(env, audioU8) {
  try {
    return await env.AI.run(WHISPER_MODEL_ID, { audio: audioU8.buffer });
  } catch {
    return await env.AI.run(WHISPER_MODEL_ID, { audio: Array.from(audioU8) });
  }
}

async function maybeTranslate(env, text, fromIso2, toIso2) {
  if (!text) return text;
  if (fromIso2 === toIso2) return text;

  try {
    const out = await env.AI.run(TRANSLATE_MODEL_ID, {
      text,
      source_lang: fromIso2,
      target_lang: toIso2,
    });
    const translated = safeTextOnly(out?.translated_text || out?.result?.translated_text || "");
    return translated || text;
  } catch {
    return text;
  }
}

// -------------------- Enlace <-> Brain ID / Handshake --------------------
function base64UrlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomNonce(len = 16) {
  const u8 = new Uint8Array(len);
  crypto.getRandomValues(u8);
  return base64UrlEncode(u8);
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input || ""));
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function parseJsonEnvMaybe(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  const s = String(value || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function extractHandshakePrivateJwk(env) {
  const obj = parseJsonEnvMaybe(env?.HANDSHAKE_ID);
  if (!obj) return null;

  if (obj?.jwk?.private && obj.jwk.private.d) return obj.jwk.private;
  if (obj?.private && obj.private.d) return obj.private;
  if (obj?.d && obj?.kty) return obj;
  return null;
}

async function signHandshake_RS512(env, bodyText) {
  const privJwk = extractHandshakePrivateJwk(env);
  if (!privJwk) return null;

  const ts = Date.now();
  const nonce = randomNonce(18);
  const bodyHash = await sha256Hex(bodyText);

  const netId = String(env?.NET_ID || "");
  const netId512 = String(env?.NET_ID_SHA512 || "");
  const payload = `${netId}.${netId512}.${ts}.${nonce}.${bodyHash}`;

  const key = await crypto.subtle.importKey(
    "jwk",
    privJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
    false,
    ["sign"]
  );

  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(payload)
  );

  return {
    ts: String(ts),
    nonce,
    sig: base64UrlEncode(new Uint8Array(sigBuf)),
    payload_hint: "NET_ID.NET_ID_SHA512.ts.nonce.sha256(body)",
  };
}

async function trafficSeal_OAEP256(env, plaintext) {
  const jwk = parseJsonEnvMaybe(env?.TRAFFIC_PUB_JWK);
  if (!jwk || jwk.kty !== "RSA") return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );

  const ct = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    new TextEncoder().encode(String(plaintext || ""))
  );

  return base64UrlEncode(new Uint8Array(ct));
}

function envJsonString(envValue) {
  if (!envValue) return "";
  if (typeof envValue === "string") return envValue.trim();
  try { return JSON.stringify(envValue); } catch { return ""; }
}

function normalizeJwkStringForCompare(s) {
  return String(s || "").trim().replace(/\s+/g, "");
}

async function callBrain(env, messages, meta, clientRequest, rawBodyForHandshake) {
  if (!env?.brain || typeof env.brain.fetch !== "function") {
    throw new Error("Missing Service Binding: env.brain");
  }

  const headers = {
    "content-type": "application/json",
    "accept": "text/event-stream",
  };

  // Pass-through identity from browser -> Brain (SHA512-only)
  const assetId = clientRequest.headers.get("x-ops-asset-id");
  const srcB64 = clientRequest.headers.get("x-ops-src-sha512-b64");
  if (assetId) headers["x-ops-asset-id"] = assetId;
  if (srcB64) headers["x-ops-src-sha512-b64"] = srcB64;

  // Enlace public JWK (lets Brain know which Enlace key to expect)
  const enlacePub = envJsonString(env?.ENLACE_BRAIN_Public_JWK);
  if (enlacePub) headers["x-enlace-brain-public-jwk"] = enlacePub;

  // Network identity hints (safe)
  if (env?.NET_ID) headers["x-net-id"] = String(env.NET_ID);
  if (env?.NET_ID_SHA512) headers["x-net-id-sha512"] = String(env.NET_ID_SHA512);

  // Optional signed handshake proof
  if (rawBodyForHandshake) {
    const hs = await signHandshake_RS512(env, rawBodyForHandshake).catch(() => null);
    if (hs) {
      headers["x-enlace-handshake-ts"] = hs.ts;
      headers["x-enlace-handshake-nonce"] = hs.nonce;
      headers["x-enlace-handshake-sig"] = hs.sig;
      headers["x-enlace-handshake-format"] = hs.payload_hint;
    }
  }

  // Optional encrypted traffic seal
  const seal = await trafficSeal_OAEP256(env, `${env?.NET_ID || ""}.${Date.now()}.${randomNonce(12)}`).catch(() => null);
  if (seal) headers["x-traffic-seal"] = seal;

  return env.brain.fetch("https://service/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ messages, meta }),
    signal: clientRequest.signal,
  });
}

function brainKeySeenHeader(brainResp) {
  return String(brainResp.headers.get("x-brain-enlace-public-jwk") || "").trim();
}

// -------------------- Worker --------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // Preflight
    if (request.method === "OPTIONS") {
      const h = corsHeaders(origin, request);
      securityHeaders().forEach((v, k) => h.set(k, v));
      return new Response(null, { status: 204, headers: h });
    }

    // Health
    if (url.pathname === "/" || url.pathname === "/health") {
      const h = corsHeaders(origin, request);
      securityHeaders().forEach((v, k) => h.set(k, v));
      return new Response("enlace: ok", { status: 200, headers: h });
    }

    const isChat = url.pathname === "/api/chat";
    const isVoice = url.pathname === "/api/voice";
    if (!isChat && !isVoice) {
      return json(404, { error: "Not found" }, corsHeaders(origin, request));
    }

    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" }, corsHeaders(origin, request));
    }

    // Strict CORS allowlist
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return json(403, { error: "Origin not allowed" }, corsHeaders(origin, request));
    }

    // Identity gate (SHA512-only)
    const assetCheck = enforceAssetIdentity(request, env);
    if (!assetCheck.ok) {
      return json(403, { error: "Blocked: asset identity", detail: assetCheck.reason }, corsHeaders(origin, request));
    }

    // Turnstile (optional)
    const ts = await verifyTurnstile(request, env);
    if (!ts.ok) {
      return json(403, { error: "Blocked: turnstile", detail: ts.reason }, corsHeaders(origin, request));
    }

    // AI binding required
    if (!env?.AI || typeof env.AI.run !== "function") {
      return json(500, { error: "Missing AI binding (env.AI)" }, corsHeaders(origin, request));
    }

    // -------------------------
    // /api/chat
    // -------------------------
    if (isChat) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        return json(415, { error: "content-type must be application/json" }, corsHeaders(origin, request));
      }

      let raw = "";
      try {
        raw = await request.text();
      } catch {
        return json(400, { error: "Failed to read body" }, corsHeaders(origin, request));
      }
      if (!raw || raw.length > MAX_BODY_CHARS) {
        return json(413, { error: "Request too large" }, corsHeaders(origin, request));
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "Invalid JSON" }, corsHeaders(origin, request));
      }

      const honeypot = typeof body.honeypot === "string" ? body.honeypot.trim() : "";
      if (honeypot) return json(403, { error: "Blocked: honeypot" }, corsHeaders(origin, request));

      const messages = normalizeMessages(body.messages);
      if (!messages.length) {
        return json(400, { error: "messages[] required" }, corsHeaders(origin, request));
      }

      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
      if (!lastUser) return json(400, { error: "Missing user message" }, corsHeaders(origin, request));
      if (looksLikeCodeOrMarkup(lastUser)) {
        return json(403, { error: "Blocked: code/markup detected" }, corsHeaders(origin, request));
      }

      // Safety gate (Llama Guard)
      let guardRes;
      try {
        guardRes = await env.AI.run(GUARD_MODEL_ID, { messages });
      } catch {
        return json(502, { error: "Safety check unavailable" }, corsHeaders(origin, request));
      }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) {
        return json(
          403,
          { error: "Blocked by safety filter", categories: verdict.categories || [] },
          corsHeaders(origin, request)
        );
      }

      // Meta language
      let meta = body?.meta && typeof body.meta === "object" ? { ...body.meta } : {};
      let langIso2 = normalizeMetaLangToIso2(meta.lang);
      if (!langIso2) langIso2 = await detectLangIso2Universal(env, lastUser);

      meta.lang = metaLangForBrain(langIso2);
      meta.lang_iso2 = langIso2;
      meta.lang_bcp47 = bcp47FromIso2(langIso2);

      const extra = corsHeaders(origin, request);
      extra.set("x-chattia-text-iso2", langIso2);
      extra.set("x-chattia-text-bcp47", bcp47FromIso2(langIso2));

      let brainResp;
      try {
        brainResp = await callBrain(env, messages, meta, request, raw);
      } catch (e) {
        return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, extra);
      }

      // Optional Brain ID compare
      const seen = brainKeySeenHeader(brainResp);
      const expectedBrainKey = envJsonString(env?.BRAIN_ENLACE_Public_JWK);
      if (seen && expectedBrainKey) {
        const ok = normalizeJwkStringForCompare(seen) === normalizeJwkStringForCompare(expectedBrainKey);
        if (!ok) return json(502, { error: "Brain ID mismatch (public key)" }, extra);
        extra.set("x-chattia-brain-id-seen", "1");
      } else {
        extra.set("x-chattia-brain-id-seen", "0");
      }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, extra);
      }

      return sse(brainResp.body, extra);
    }

    // -------------------------
    // /api/voice
    // -------------------------
    if (isVoice) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      const mode = String(url.searchParams.get("mode") || "").toLowerCase();

      let audioU8 = null;
      let priorMessages = [];
      let meta = {};

      // JSON wrapper support (optional)
      if (ct.includes("application/json")) {
        let raw = "";
        try {
          raw = await request.text();
        } catch {
          return json(400, { error: "Failed to read body" }, corsHeaders(origin, request));
        }
        if (!raw || raw.length > MAX_BODY_CHARS) {
          return json(413, { error: "Request too large" }, corsHeaders(origin, request));
        }

        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(400, { error: "Invalid JSON" }, corsHeaders(origin, request));
        }

        priorMessages = normalizeMessages(body.messages);
        meta = body?.meta && typeof body.meta === "object" ? { ...body.meta } : {};

        if (typeof body.audio_b64 === "string" && body.audio_b64.length) {
          const b64 = body.audio_b64;
          if (b64.length > MAX_AUDIO_BYTES * 2) return json(413, { error: "Audio too large" }, corsHeaders(origin, request));

          let bin = "";
          try {
            bin = atob(b64);
          } catch {
            return json(400, { error: "Invalid audio_b64" }, corsHeaders(origin, request));
          }
          if (bin.length > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, corsHeaders(origin, request));

          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 255;
          audioU8 = u8;
        } else if (Array.isArray(body.audio) && body.audio.length) {
          if (body.audio.length > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, corsHeaders(origin, request));
          const u8 = new Uint8Array(body.audio.length);
          for (let i = 0; i < body.audio.length; i++) u8[i] = Number(body.audio[i]) & 255;
          audioU8 = u8;
        } else {
          return json(400, { error: "Missing audio (audio_b64 or audio[])" }, corsHeaders(origin, request));
        }
      } else {
        // Binary audio
        let buf;
        try {
          buf = await request.arrayBuffer();
        } catch {
          return json(400, { error: "Failed to read audio" }, corsHeaders(origin, request));
        }
        if (!buf || buf.byteLength < 16) return json(400, { error: "Empty audio" }, corsHeaders(origin, request));
        if (buf.byteLength > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, corsHeaders(origin, request));
        audioU8 = new Uint8Array(buf);
      }

      // STT
      let sttOut;
      try {
        sttOut = await runWhisper(env, audioU8);
      } catch (e) {
        return json(502, { error: "Whisper unavailable", detail: String(e?.message || e) }, corsHeaders(origin, request));
      }

      let transcript = safeTextOnly(
        sttOut?.text ||
          sttOut?.result?.text ||
          sttOut?.response?.text ||
          sttOut?.result?.response?.text ||
          ""
      );

      if (!transcript) return json(400, { error: "No transcription produced" }, corsHeaders(origin, request));
      if (looksLikeCodeOrMarkup(transcript)) return json(403, { error: "Blocked: code/markup detected" }, corsHeaders(origin, request));

      // Language
      let langIso2 = normalizeMetaLangToIso2(meta.lang);
      if (!langIso2) langIso2 = await detectLangIso2Universal(env, transcript);

      // Optional translate target (EN/ES only)
      const translateTo = String(meta?.translate_to || "").toLowerCase().trim();
      if (translateTo === "en" || translateTo === "es") {
        transcript = await maybeTranslate(env, transcript, langIso2, translateTo);
        langIso2 = translateTo;
      }

      const extra = corsHeaders(origin, request);
      extra.set("x-chattia-voice-timeout-sec", String(VOICE_TIMEOUT_SEC));
      extra.set("x-chattia-stt-lang", legacyENESFromIso2(langIso2));
      extra.set("x-chattia-stt-iso2", langIso2);
      extra.set("x-chattia-stt-bcp47", bcp47FromIso2(langIso2));

      if (mode === "stt") {
        return json(
          200,
          {
            transcript,
            lang: legacyENESFromIso2(langIso2),
            lang_iso2: langIso2,
            lang_bcp47: bcp47FromIso2(langIso2),
            voice_timeout_sec: VOICE_TIMEOUT_SEC,
          },
          extra
        );
      }

      const messages = priorMessages.length
        ? [...priorMessages, { role: "user", content: transcript }]
        : [{ role: "user", content: transcript }];

      // Safety gate
      let guardRes;
      try {
        guardRes = await env.AI.run(GUARD_MODEL_ID, { messages });
      } catch {
        return json(502, { error: "Safety check unavailable" }, corsHeaders(origin, request));
      }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return json(403, { error: "Blocked by safety filter", categories: verdict.categories || [] }, extra);

      meta.lang = metaLangForBrain(langIso2);
      meta.lang_iso2 = langIso2;
      meta.lang_bcp47 = bcp47FromIso2(langIso2);

      let brainResp;
      try {
        const bodyForHs = JSON.stringify({ messages, meta });
        brainResp = await callBrain(env, messages, meta, request, bodyForHs);
      } catch (e) {
        return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, extra);
      }

      const seen = brainKeySeenHeader(brainResp);
      const expectedBrainKey = envJsonString(env?.BRAIN_ENLACE_Public_JWK);
      if (seen && expectedBrainKey) {
        const ok = normalizeJwkStringForCompare(seen) === normalizeJwkStringForCompare(expectedBrainKey);
        if (!ok) return json(502, { error: "Brain ID mismatch (public key)" }, extra);
        extra.set("x-chattia-brain-id-seen", "1");
      } else {
        extra.set("x-chattia-brain-id-seen", "0");
      }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, extra);
      }

      return sse(brainResp.body, extra);
    }
  },
};
