/**
 * Cloudflare Worker: enlace (v0)
 * UI -> Enlace -> (Service Binding: brain) -> response back to UI
 *
 * Required bindings:
 * - env.AI     (Workers AI) for Llama Guard
 * - env.brain  (Service Binding) -> nettunian-io
 */

const ALLOWED_ORIGINS = new Set([
  "https://chattiavato-a11y.github.io",
  "https://www.chattia.io",
  "https://chattia.io",
]);

const GUARD_MODEL_ID = "@cf/meta/llama-guard-3-8b";

// Limits (keep stable)
const MAX_BODY_CHARS = 24_000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 2_000;

// ---- Header allowlist for CORS ----
const BASE_ALLOWED_HEADERS = new Set([
  "content-type",
  "x-ops-asset-id",
  "x-ops-asset-sha256",
  "cf-turnstile-response",
]);

function parseAllowlist(raw) {
  // Returns Map(assetId -> hashOrEmptyString)
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
  const allowlist = parseAllowlist(env?.OPS_ASSET_ALLOWLIST);
  if (!allowlist.size) {
    return { ok: true, reason: "Allowlist disabled" };
  }

  const assetId = (request.headers.get("x-ops-asset-id") || "").trim();
  const assetHash = (request.headers.get("x-ops-asset-sha256") || "").trim();

  if (!assetId) {
    return { ok: false, reason: "Missing x-ops-asset-id" };
  }

  if (!allowlist.has(assetId)) {
    return { ok: false, reason: "Asset ID not allowlisted" };
  }

  const expectedHash = allowlist.get(assetId);
  if (expectedHash) {
    if (!assetHash) {
      return { ok: false, reason: "Missing x-ops-asset-sha256" };
    }
    if (assetHash.toLowerCase() !== expectedHash.toLowerCase()) {
      return { ok: false, reason: "Asset hash mismatch" };
    }
  }

  return { ok: true, reason: "Asset verified" };
}

function corsHeaders(origin, request) {
  const h = new Headers();

  // CORS origin
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }

  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");

  // CORS requested headers: only allow known-safe headers
  const reqHdrs = (request?.headers?.get("Access-Control-Request-Headers") || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const safe = [];
  for (const name of reqHdrs) {
    if (BASE_ALLOWED_HEADERS.has(name)) safe.push(name);
  }
  // Always include minimal set (so client can send these)
  safe.push("content-type");
  safe.push("x-ops-asset-id");
  safe.push("x-ops-asset-sha256");
  safe.push("cf-turnstile-response");

  // De-dupe
  const unique = Array.from(new Set(safe));
  h.set("Access-Control-Allow-Headers", unique.join(", "));
  h.set("Access-Control-Max-Age", "86400");

  return h;
}

function securityHeaders() {
  const h = new Headers();

  // Anti-sniff / framing / leakage
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");

  // HSTS (API side; Cloudflare already terminates TLS, still safe to set)
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  // Conservative CSP for an API response (helps scanners; does not break fetch)
  h.set(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
  );

  // Don’t cache sensitive responses
  h.set("Cache-Control", "no-store");

  // Reduce inadvertent transformations/buffering on intermediaries
  h.set("Cache-Control", "no-store, no-transform");

  return h;
}

function json(status, obj, extraHeaders) {
  const h = new Headers(extraHeaders || {});
  h.set("content-type", "application/json; charset=utf-8");
  securityHeaders().forEach((v, k) => h.set(k, v));
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function safeTextOnly(s) {
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
  const t = text.toLowerCase();
  if (text.includes("```")) return true;
  if (/<\/?[a-z][\s\S]*>/i.test(text)) return true;
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
  return patterns.some((re) => re.test(text));
}

async function verifyTurnstile(request, env) {
  if (!env?.TURNSTILE_SECRET_KEY) {
    return { ok: false, reason: "Missing TURNSTILE_SECRET_KEY" };
  }

  const token = request.headers.get("cf-turnstile-response") || "";
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
  if (!data || data.success !== true) {
    return { ok: false, reason: "Turnstile failed" };
  }

  return { ok: true };
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

async function callBrain(env, messages) {
  if (!env?.brain || typeof env.brain.fetch !== "function") {
    throw new Error("Missing Service Binding: env.brain");
  }

  return env.brain.fetch("https://service/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({ messages }),
  });
}

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

    // Route guard
    if (url.pathname !== "/api/chat") {
      return json(404, { error: "Not found" }, corsHeaders(origin, request));
    }

    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" }, corsHeaders(origin, request));
    }

    // Strict CORS origin allowlist
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return json(403, { error: "Origin not allowed" }, corsHeaders(origin, request));
    }

    // Asset identity (anti-clone / identification) — optional but recommended
    const assetCheck = enforceAssetIdentity(request, env);
    if (!assetCheck.ok) {
      return json(403, { error: "Blocked: asset identity", detail: assetCheck.reason }, corsHeaders(origin, request));
    }

    const ts = await verifyTurnstile(request, env);
    if (!ts.ok) {
      return json(403, { error: "Blocked: turnstile", detail: ts.reason }, corsHeaders(origin, request));
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

    // Normalize messages
    const messages = normalizeMessages(body.messages);
    if (!messages.length) {
      return json(400, { error: "messages[] required" }, corsHeaders(origin, request));
    }

    // Minimal injection hardening (plain-text only)
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    if (!lastUser) return json(400, { error: "Missing user message" }, corsHeaders(origin, request));
    if (looksLikeCodeOrMarkup(lastUser)) {
      return json(403, { error: "Blocked: code/markup detected" }, corsHeaders(origin, request));
    }

    // Workers AI binding check
    if (!env?.AI || typeof env.AI.run !== "function") {
      return json(500, { error: "Missing AI binding (env.AI)" }, corsHeaders(origin, request));
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

    let brainResp;
    try {
      brainResp = await callBrain(env, messages);
    } catch (e) {
      return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, corsHeaders(origin));
    }

    if (!brainResp.ok) {
      const t = await brainResp.text().catch(() => "");
      return json(502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, corsHeaders(origin));
    }

    const brainCt = (brainResp.headers.get("content-type") || "").toLowerCase();
    if (brainCt.includes("application/json")) {
      const payload = await brainResp.json().catch(() => ({}));
      return json(200, payload, corsHeaders(origin));
    }

    const text = await brainResp.text().catch(() => "");
    return json(200, { response: text }, corsHeaders(origin));
  },
};
