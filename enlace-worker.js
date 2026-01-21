/**
 * src/index.js — Cloudflare Worker: enlace (v0.5 FINAL)
 * UI -> Enlace -> (Service Binding: brain -> nettunian-io) -> SSE stream back to UI
 *
 * Required bindings:
 * - env.AI     (Workers AI) for Llama Guard + Whisper STT
 * - env.brain  (Service Binding) -> nettunian-io
 *
 * Only uses these env vars (plus the two JWKs you added):
 * - TURNSTILE_SECRET_KEY
 * - NET_ID
 * - ASSET_ID_SHA256
 * - NET_ID_SHA512
 * - TRAFFIC_PUB_JWK
 * - HANDSHAKE_ID
 * - OPS_ASSET_ALLOWLIST
 * - ENLACE_BRAIN_Public_JWK
 * - BRAIN_ENLACE_Public_JWK
 *
 * Routes:
 * - POST /api/chat   (JSON)  -> streams Brain SSE
 * - POST /api/voice  (audio) -> ?mode=stt returns JSON transcript
 *
 * CORS: only allows headers:
 * - content-type
 * - x-ops-asset-id
 * - x-ops-asset-sha256
 * - cf-turnstile-response
 *
 * Exposed response headers:
 * - x-chattia-text-iso2
 * - x-chattia-stt-iso2
 * - x-chattia-stt-lang
 * - x-chattia-voice-timeout-sec
 */

const ALLOWED_ORIGINS = new Set([
  "https://chattiavato-a11y.github.io",
  "https://www.chattia.io",
  "https://chattia.io",
]);

const GUARD_MODEL_ID = "@cf/meta/llama-guard-3-8b";
const WHISPER_MODEL_ID = "@cf/openai/whisper-large-v3-turbo";

// Limits (keep stable)
const MAX_BODY_CHARS = 24_000;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024; // 12MB

// ---- Allowed request headers for CORS ----
const BASE_ALLOWED_HEADERS = new Set([
  "content-type",
  "x-ops-asset-id",
  "x-ops-asset-sha256",
  "cf-turnstile-response",
]);

// -------------------------
// Helpers: allowlist + headers
// -------------------------
function parseAllowlist(raw) {
  // Map(assetId -> hashOrEmptyString)
  const map = new Map();
  const s = String(raw || "").trim();
  if (!s) return map;

  for (const part of s.split(",")) {
    const item = part.trim();
    if (!item) continue;

    const eq = item.indexOf("=");
    if (eq === -1) {
      map.set(item, "");
    } else {
      const id = item.slice(0, eq).trim();
      const hash = item.slice(eq + 1).trim();
      if (id) map.set(id, hash || "");
    }
  }
  return map;
}

function enforceAssetIdentity(request, env) {
  const allowMap = parseAllowlist(env?.OPS_ASSET_ALLOWLIST || "");
  if (!allowMap.size) return { ok: true, reason: "Allowlist disabled" };

  const assetId = String(request.headers.get("x-ops-asset-id") || "").trim();
  const assetHash = String(request.headers.get("x-ops-asset-sha256") || "").trim();

  if (!assetId) return { ok: false, reason: "Missing x-ops-asset-id" };
  if (!allowMap.has(assetId)) return { ok: false, reason: "Asset ID not allowlisted" };

  const expectedFromMap = String(allowMap.get(assetId) || "").trim();
  const expectedGlobal = String(env?.ASSET_ID_SHA256 || "").trim();

  // If allowlist provides a hash for that ID, enforce it.
  if (expectedFromMap) {
    if (!assetHash) return { ok: false, reason: "Missing x-ops-asset-sha256" };
    if (assetHash.toLowerCase() !== expectedFromMap.toLowerCase()) return { ok: false, reason: "Asset hash mismatch" };
    return { ok: true, reason: "Asset verified (map)" };
  }

  // Otherwise, if ASSET_ID_SHA256 is set globally, enforce it.
  if (expectedGlobal) {
    if (!assetHash) return { ok: false, reason: "Missing x-ops-asset-sha256" };
    if (assetHash.toLowerCase() !== expectedGlobal.toLowerCase()) return { ok: false, reason: "Asset hash mismatch (global)" };
    return { ok: true, reason: "Asset verified (global)" };
  }

  // ID-only allowlist entry
  return { ok: true, reason: "Asset verified (id-only)" };
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

  // Always include our minimal set
  safe.push("content-type", "x-ops-asset-id", "x-ops-asset-sha256", "cf-turnstile-response");

  h.set("Access-Control-Allow-Headers", Array.from(new Set(safe)).join(", "));
  h.set("Access-Control-Max-Age", "86400");

  // Let UI read these response headers
  h.set(
    "Access-Control-Expose-Headers",
    [
      "x-chattia-text-iso2",
      "x-chattia-stt-iso2",
      "x-chattia-stt-lang",
      "x-chattia-voice-timeout-sec",
    ].join(", ")
  );

  return h;
}

function securityHeaders() {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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

function safeTextOnly(s) {
  let out = "";
  s = String(s || "");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160;
    if (ok) out += s[i];
  }
  out = out.replace(/[ \t]{3,}/g, "  ").replace(/\n{5,}/g, "\n\n\n\n");
  return out.trim();
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

// -------------------------
// Language helpers (for response headers)
// -------------------------
function iso2FromBcp47(tagRaw) {
  const raw = String(tagRaw || "").trim();
  if (!raw) return "";
  const m = raw.match(/^([a-zA-Z]{2,3})([-_].+)?$/);
  return m ? String(m[1] || "").toLowerCase() : "";
}

function normalizeMetaLang(metaLangRaw) {
  const raw = String(metaLangRaw || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();
  if (upper === "ES") return "es";
  if (upper === "EN") return "en";
  return iso2FromBcp47(raw);
}

function resolveLangIso2FromMeta(meta) {
  if (!meta || typeof meta !== "object") return "";
  const a = String(meta.lang_iso2 || "").trim().toLowerCase();
  if (a) return a;
  const b = iso2FromBcp47(meta.lang_bcp47);
  if (b) return b;
  const c = normalizeMetaLang(meta.lang);
  if (c) return c;
  return "";
}

function detectIso2FastENES(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "en";
  if (/[ñáéíóúü¿¡]/i.test(t)) return "es";
  const esHits = [
    "hola","gracias","por favor","buenos","buenas","como","qué","que ",
    "dónde","donde","cuánto","cuanto","necesito","ayuda","quiero",
    "tengo","puedo","hacer","porque","también","pagar","factura","pedido",
  ].filter((w) => t.includes(w)).length;
  return esHits >= 2 ? "es" : "en";
}

function iso2ToLegacyLang(iso2) {
  const x = String(iso2 || "").toLowerCase();
  if (x === "es") return "ES";
  if (x === "en") return "EN";
  return x ? x : "EN";
}

// -------------------------
// Turnstile
// -------------------------
async function verifyTurnstile(request, env) {
  if (!env?.TURNSTILE_SECRET_KEY) return { ok: true, reason: "Turnstile disabled" };

  const token = String(request.headers.get("cf-turnstile-response") || "").trim();
  if (!token) return { ok: false, reason: "Missing Turnstile token" };

  const ip = request.headers.get("CF-Connecting-IP") || "";
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

// -------------------------
// Llama Guard parsing
// -------------------------
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

// -------------------------
// Brain call (SSE pass-through)
// -------------------------
async function callBrainSse(env, request, messages, meta) {
  if (!env?.brain || typeof env.brain.fetch !== "function") {
    throw new Error("Missing Service Binding: env.brain");
  }

  // Pass through asset headers so Brain can enforce its own allowlist
  const h = new Headers();
  h.set("content-type", "application/json");
  h.set("accept", "text/event-stream");

  const assetId = request.headers.get("x-ops-asset-id");
  const assetHash = request.headers.get("x-ops-asset-sha256");
  if (assetId) h.set("x-ops-asset-id", assetId);
  if (assetHash) h.set("x-ops-asset-sha256", assetHash);

  // Enlace <-> Brain identification headers (Brain may ignore until you add checks there)
  if (env.NET_ID) h.set("x-net-id", String(env.NET_ID));
  if (env.NET_ID_SHA512) h.set("x-net-id-sha512", String(env.NET_ID_SHA512));
  if (env.HANDSHAKE_ID) h.set("x-handshake-id", String(env.HANDSHAKE_ID));

  // These are the exact names you requested to exist in Enlace
  if (env.ENLACE_BRAIN_Public_JWK) h.set("x-enlace-brain-public-jwk", String(env.ENLACE_BRAIN_Public_JWK));
  if (env.BRAIN_ENLACE_Public_JWK) h.set("x-brain-enlace-public-jwk", String(env.BRAIN_ENLACE_Public_JWK));

  // TRAFFIC_PUB_JWK is reserved for your next step (verification), kept unused here on purpose.

  const body = JSON.stringify({ messages, meta });

  return env.brain.fetch("https://service/api/chat", {
    method: "POST",
    headers: h,
    body,
  });
}

// -------------------------
// Voice STT (Whisper)
// -------------------------
async function whisperStt(env, audioBytes) {
  const bytes = Array.from(new Uint8Array(audioBytes));
  const out = await env.AI.run(WHISPER_MODEL_ID, { audio: bytes });
  const text = safeTextOnly(out?.text || out?.result?.text || out?.response?.text || out?.response || out || "");
  return text;
}

// -------------------------
// Handlers
// -------------------------
async function handleChat(request, env, origin) {
  // CORS origin allowlist
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return json(403, { error: "Origin not allowed" }, corsHeaders(origin, request));
  }

  // Turnstile
  const ts = await verifyTurnstile(request, env);
  if (!ts.ok) return json(403, { error: "Blocked: turnstile", detail: ts.reason }, corsHeaders(origin, request));

  // Asset allowlist
  const assetCheck = enforceAssetIdentity(request, env);
  if (!assetCheck.ok) {
    return json(403, { error: "Blocked: asset identity", detail: assetCheck.reason }, corsHeaders(origin, request));
  }

  // Content-Type strict
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    return json(415, { error: "content-type must be application/json" }, corsHeaders(origin, request));
  }

  // Read + size limit
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return json(400, { error: "Failed to read body" }, corsHeaders(origin, request));
  }
  if (!raw || raw.length > MAX_BODY_CHARS) {
    return json(413, { error: "Request too large" }, corsHeaders(origin, request));
  }

  // Parse JSON
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Invalid JSON" }, corsHeaders(origin, request));
  }

  // Honeypot
  const honeypot = typeof body.honeypot === "string" ? body.honeypot.trim() : "";
  if (honeypot) return json(403, { error: "Blocked: honeypot" }, corsHeaders(origin, request));

  // Normalize messages
  const messages = normalizeMessages(body.messages);
  if (!messages.length) return json(400, { error: "messages[] required" }, corsHeaders(origin, request));

  // Workers AI binding check
  if (!env?.AI || typeof env.AI.run !== "function") {
    return json(500, { error: "Missing AI binding (env.AI)" }, corsHeaders(origin, request));
  }

  // Determine language for response header (from meta or fast heuristic)
  const metaIn = body?.meta && typeof body.meta === "object" ? body.meta : {};
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const iso2 = resolveLangIso2FromMeta(metaIn) || detectIso2FastENES(lastUser) || "en";

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

  // Call Brain and pass through SSE
  let brainResp;
  try {
    brainResp = await callBrainSse(env, request, messages, metaIn);
  } catch (e) {
    return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, corsHeaders(origin, request));
  }

  if (!brainResp.ok) {
    const t = await brainResp.text().catch(() => "");
    return json(
      502,
      { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) },
      corsHeaders(origin, request)
    );
  }

  // Pass-through stream + set our UI-readable header
  const h = corsHeaders(origin, request);
  h.set("x-chattia-text-iso2", iso2);

  // Keep Brain's content-type if it’s SSE; otherwise wrap as JSON once.
  const brainCt = (brainResp.headers.get("content-type") || "").toLowerCase();
  if (!brainCt.includes("text/event-stream")) {
    const txt = await brainResp.text().catch(() => "");
    return json(200, { response: txt }, h);
  }

  return sse(brainResp.body, h);
}

async function handleVoice(request, env, origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return json(403, { error: "Origin not allowed" }, corsHeaders(origin, request));
  }

  // Turnstile
  const ts = await verifyTurnstile(request, env);
  if (!ts.ok) return json(403, { error: "Blocked: turnstile", detail: ts.reason }, corsHeaders(origin, request));

  // Asset allowlist
  const assetCheck = enforceAssetIdentity(request, env);
  if (!assetCheck.ok) {
    return json(403, { error: "Blocked: asset identity", detail: assetCheck.reason }, corsHeaders(origin, request));
  }

  if (!env?.AI || typeof env.AI.run !== "function") {
    return json(500, { error: "Missing AI binding (env.AI)" }, corsHeaders(origin, request));
  }

  // Read audio
  const len = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(len) && len > MAX_AUDIO_BYTES) {
    return json(413, { error: "Audio too large" }, corsHeaders(origin, request));
  }

  let audio;
  try {
    audio = await request.arrayBuffer();
  } catch {
    return json(400, { error: "Failed to read audio" }, corsHeaders(origin, request));
  }
  if (!audio || audio.byteLength < 200) {
    return json(400, { error: "No audio captured" }, corsHeaders(origin, request));
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return json(413, { error: "Audio too large" }, corsHeaders(origin, request));
  }

  const url = new URL(request.url);
  const mode = String(url.searchParams.get("mode") || "").toLowerCase();

  let transcript = "";
  try {
    transcript = await whisperStt(env, audio);
  } catch (e) {
    return json(502, { error: "STT unavailable", detail: String(e?.message || e) }, corsHeaders(origin, request));
  }

  const iso2 = detectIso2FastENES(transcript || "");

  // Always return JSON for mode=stt (your UI uses this)
  if (mode !== "stt") {
    // If someone calls without mode=stt, still return JSON (safe default)
  }

  const h = corsHeaders(origin, request);
  h.set("x-chattia-voice-timeout-sec", "120");
  h.set("x-chattia-stt-iso2", iso2);
  h.set("x-chattia-stt-lang", iso2ToLegacyLang(iso2));

  return json(200, { transcript, lang_iso2: iso2, lang: iso2ToLegacyLang(iso2) }, h);
}

// -------------------------
// Entry
// -------------------------
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

    // Routes
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json(405, { error: "Method not allowed" }, corsHeaders(origin, request));
      try {
        return await handleChat(request, env, origin);
      } catch (e) {
        console.log("enlace chat error:", e);
        return json(500, { error: "Internal error" }, corsHeaders(origin, request));
      }
    }

    if (url.pathname === "/api/voice") {
      if (request.method !== "POST") return json(405, { error: "Method not allowed" }, corsHeaders(origin, request));
      try {
        return await handleVoice(request, env, origin);
      } catch (e) {
        console.log("enlace voice error:", e);
        return json(500, { error: "Internal error" }, corsHeaders(origin, request));
      }
    }

    return json(404, { error: "Not found" }, corsHeaders(origin, request));
  },
};
