/**
 * Cloudflare Worker: enlace (v1)
 * UI -> Enlace -> (Service Binding: brain) -> SSE stream back to UI
 *
 * Required bindings:
 * - env.AI     (Workers AI) for Llama Guard + Whisper
 * - env.brain  (Service Binding) -> nettunian-io
 *
 * Identity / gates (your current env set):
 * - TURNSTILE_SECRET_KEY   (Secret) optional gate
 * - OPS_ASSET_ALLOWLIST    (Variable) array or comma string
 * - ASSET_ID_SHA256        (Variable) expected sha256 for x-ops-asset-sha256
 *
 * Enlace -> Brain identity forwarding:
 * - NET_ID, NET_ID_SHA512
 * - HANDSHAKE_ID (Secret)  used to sign a small request proof (optional)
 * - ENLACE_BRAIN_Public_JWK / BRAIN_ENLACE_Public_JWK (if present)
 */

const ALLOWED_ORIGINS = new Set([
  "https://chattiavato-a11y.github.io",
  "https://www.chattia.io",
  "https://chattia.io",
]);

const GUARD_MODEL_ID = "@cf/meta/llama-guard-3-8b";
const STT_MODEL_ID = "@cf/openai/whisper-large-v3-turbo";

// Limits (keep stable)
const MAX_JSON_BODY_CHARS = 24_000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_AUDIO_BYTES = 12_000_000; // ~12MB cap

// ---- CORS header allowlist ----
const BASE_ALLOWED_HEADERS = new Set([
  "content-type",
  "x-ops-asset-id",
  "x-ops-asset-sha256",
  "cf-turnstile-response",
]);

const EXPOSE_HEADERS = [
  "x-chattia-text-iso2",
  "x-chattia-text-bcp47",
  "x-chattia-stt-iso2",
  "x-chattia-stt-bcp47",
  "x-chattia-voice-timeout-sec",
  "x-chattia-stt-lang", // legacy EN|ES convenience
].join(", ");

function securityHeaders() {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Cache-Control", "no-store, no-transform");
  return h;
}

function corsHeaders(origin, request) {
  const h = new Headers();

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }

  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  const reqHdrs = (request?.headers?.get("Access-Control-Request-Headers") || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const safe = [];
  for (const name of reqHdrs) {
    if (BASE_ALLOWED_HEADERS.has(name)) safe.push(name);
  }

  // Always include the base set
  for (const x of BASE_ALLOWED_HEADERS) safe.push(x);

  h.set("Access-Control-Allow-Headers", Array.from(new Set(safe)).join(", "));
  h.set("Access-Control-Max-Age", "86400");

  // Let UI read our custom response headers
  h.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);

  return h;
}

function withBaseHeaders(origin, request, extra) {
  const h = corsHeaders(origin, request);
  securityHeaders().forEach((v, k) => h.set(k, v));
  if (extra) {
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
  }
  return h;
}

function json(origin, request, status, obj, extra) {
  const h = withBaseHeaders(origin, request, extra);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function parseOpsAssetAllowlist(raw) {
  // Accepts:
  // - JSON array (string) like '["a","b"]'
  // - actual array (if Workers ever passes it as array)
  // - comma string: "a,b,c"
  const set = new Set();

  if (Array.isArray(raw)) {
    for (const v of raw) {
      const s = String(v || "").trim();
      if (s) set.add(s);
    }
    return set;
  }

  const s = String(raw || "").trim();
  if (!s) return set;

  // Try JSON array
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        for (const v of arr) {
          const t = String(v || "").trim();
          if (t) set.add(t);
        }
        return set;
      }
    } catch {
      // fall through
    }
  }

  // Comma-separated
  for (const part of s.split(",")) {
    const t = part.trim();
    if (t) set.add(t);
  }
  return set;
}

function enforceAssetIdentity(request, env) {
  const allow = parseOpsAssetAllowlist(env?.OPS_ASSET_ALLOWLIST);
  if (!allow.size) {
    // If you want this ALWAYS enforced, keep OPS_ASSET_ALLOWLIST non-empty.
    return { ok: true, reason: "Allowlist disabled" };
  }

  const assetId = (request.headers.get("x-ops-asset-id") || "").trim();
  const assetSha = (request.headers.get("x-ops-asset-sha256") || "").trim();

  if (!assetId) return { ok: false, reason: "Missing x-ops-asset-id" };
  if (!allow.has(assetId)) return { ok: false, reason: "Asset ID not allowlisted" };

  const expectedSha = String(env?.ASSET_ID_SHA256 || "").trim();
  if (expectedSha) {
    if (!assetSha) return { ok: false, reason: "Missing x-ops-asset-sha256" };
    if (assetSha.toLowerCase() !== expectedSha.toLowerCase()) {
      return { ok: false, reason: "Asset sha256 mismatch" };
    }
  }

  return { ok: true, reason: "Asset verified" };
}

async function verifyTurnstile(request, env) {
  if (!env?.TURNSTILE_SECRET_KEY) {
    return { ok: true, reason: "Turnstile disabled" };
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
    return {
      ok: false,
      reason:
        "Turnstile failed (double-check TURNSTILE_SECRET_KEY is the SECRET key, not the site key)",
    };
  }

  return { ok: true };
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
  const t = String(text || "").toLowerCase();
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

function normalizeIso2(x) {
  const s = String(x || "").trim();
  if (!s) return "";
  if (s.toUpperCase() === "EN") return "en";
  if (s.toUpperCase() === "ES") return "es";
  return s.slice(0, 2).toLowerCase();
}

function iso2ToBcp47(iso2) {
  if (iso2 === "es") return "es-ES";
  if (iso2 === "en") return "en-US";
  return "";
}

function pickLangFromBody(body) {
  const meta = body?.meta && typeof body.meta === "object" ? body.meta : {};
  const iso2 =
    normalizeIso2(meta.lang_iso2) ||
    normalizeIso2(meta.iso2) ||
    normalizeIso2(meta.lang) ||
    "";

  const bcp47 = String(meta.lang_bcp47 || meta.bcp47 || "").trim() || iso2ToBcp47(iso2);
  return { iso2: iso2 || "en", bcp47: bcp47 || "en-US" };
}

function b64url(bytes) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function extractHandshakePrivateJwk(env) {
  // Expect HANDSHAKE_ID to be a JSON string.
  // We accept:
  // - {"d": "...", "n":"...", ...} (private JWK)
  // - {"private": {...}} or {"jwk":{"private":{...}}}
  const raw = env?.HANDSHAKE_ID;
  if (!raw) return null;

  let obj;
  try {
    obj = JSON.parse(String(raw));
  } catch {
    return null;
  }

  let jwk =
    obj?.private ||
    obj?.jwk?.private ||
    (obj?.d && obj?.n ? obj : null);

  if (!jwk) return null;

  jwk = { ...jwk };
  jwk.alg = "RS512";
  jwk.key_ops = ["sign"];
  return jwk;
}

async function buildBrainIdentityHeaders(env, bodyText) {
  const h = {};

  if (env?.NET_ID) h["x-net-id"] = String(env.NET_ID);
  if (env?.NET_ID_SHA512) h["x-net-id-sha512"] = String(env.NET_ID_SHA512);

  // These two env names are kept as-is in your dashboard; we just forward as metadata.
  if (env?.ENLACE_BRAIN_Public_JWK) {
    h["x-enlace-brain-public-jwk"] = typeof env.ENLACE_BRAIN_Public_JWK === "string"
      ? env.ENLACE_BRAIN_Public_JWK
      : JSON.stringify(env.ENLACE_BRAIN_Public_JWK);
  }
  if (env?.BRAIN_ENLACE_Public_JWK) {
    h["x-brain-enlace-public-jwk"] = typeof env.BRAIN_ENLACE_Public_JWK === "string"
      ? env.BRAIN_ENLACE_Public_JWK
      : JSON.stringify(env.BRAIN_ENLACE_Public_JWK);
  }

  // Optional: sign a proof so Brain can verify calls really come from Enlace
  const jwk = extractHandshakePrivateJwk(env);
  if (jwk) {
    const ts = Date.now().toString();
    const nonce = crypto.randomUUID();
    const bodyHash = await sha256Hex(bodyText);
    const netId = String(env?.NET_ID || "ENLACE");

    const payload = `${netId}.${ts}.${nonce}.${bodyHash}`;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(payload)
    );

    h["x-handshake-ts"] = ts;
    h["x-handshake-nonce"] = nonce;
    h["x-handshake-sig"] = b64url(sig);
    h["x-handshake-payload-hash"] = bodyHash;
  }

  return h;
}

async function callBrainSSE(env, payloadObj, identityHeaders) {
  if (!env?.brain || typeof env.brain.fetch !== "function") {
    throw new Error("Missing Service Binding: env.brain");
  }

  return env.brain.fetch("https://service/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "text/event-stream",
      ...identityHeaders,
    },
    body: JSON.stringify(payloadObj),
  });
}

async function runWhisper(env, audioBytes) {
  if (!env?.AI || typeof env.AI.run !== "function") {
    throw new Error("Missing AI binding (env.AI)");
  }
  // Workers AI Whisper expects raw bytes in `audio`
  const r = await env.AI.run(STT_MODEL_ID, { audio: audioBytes });
  const text = r?.text || r?.result?.text || "";
  return { text: String(text || "").trim(), raw: r };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // Preflight
    if (request.method === "OPTIONS") {
      const h = withBaseHeaders(origin, request);
      return new Response(null, { status: 204, headers: h });
    }

    // Health
    if (url.pathname === "/" || url.pathname === "/health") {
      const h = withBaseHeaders(origin, request);
      return new Response("enlace: ok", { status: 200, headers: h });
    }

    // Only allow browser origins we trust
    const isBrowserCall = !!origin;
    if (isBrowserCall && !ALLOWED_ORIGINS.has(origin)) {
      return json(origin, request, 403, { error: "Origin not allowed" });
    }

    // Routes
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return json(origin, request, 405, { error: "Method not allowed" });
      }

      const assetCheck = enforceAssetIdentity(request, env);
      if (!assetCheck.ok) {
        return json(origin, request, 403, { error: "Blocked: asset identity", detail: assetCheck.reason });
      }

      const ts = await verifyTurnstile(request, env);
      if (!ts.ok) {
        return json(origin, request, 403, { error: "Blocked: turnstile", detail: ts.reason });
      }

      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        return json(origin, request, 415, { error: "content-type must be application/json" });
      }

      let raw = "";
      try {
        raw = await request.text();
      } catch {
        return json(origin, request, 400, { error: "Failed to read body" });
      }
      if (!raw || raw.length > MAX_JSON_BODY_CHARS) {
        return json(origin, request, 413, { error: "Request too large" });
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(origin, request, 400, { error: "Invalid JSON" });
      }

      const honeypot = typeof body.honeypot === "string" ? body.honeypot.trim() : "";
      if (honeypot) return json(origin, request, 403, { error: "Blocked: honeypot" });

      const messages = normalizeMessages(body.messages);
      if (!messages.length) {
        return json(origin, request, 400, { error: "messages[] required" });
      }

      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
      if (!lastUser) return json(origin, request, 400, { error: "Missing user message" });
      if (looksLikeCodeOrMarkup(lastUser)) {
        return json(origin, request, 403, { error: "Blocked: code/markup detected" });
      }

      // Llama Guard safety gate
      if (!env?.AI || typeof env.AI.run !== "function") {
        return json(origin, request, 500, { error: "Missing AI binding (env.AI)" });
      }

      let guardRes;
      try {
        guardRes = await env.AI.run(GUARD_MODEL_ID, { messages });
      } catch {
        return json(origin, request, 502, { error: "Safety check unavailable" });
      }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) {
        return json(origin, request, 403, {
          error: "Blocked by safety filter",
          categories: verdict.categories || [],
        });
      }

      // Language hints (for UI convenience headers)
      const { iso2, bcp47 } = pickLangFromBody(body);

      // Build identity headers for Brain
      const identityHeaders = await buildBrainIdentityHeaders(env, raw);

      // Call Brain as SSE
      let brainResp;
      try {
        brainResp = await callBrainSSE(env, { messages, meta: body.meta || {} }, identityHeaders);
      } catch (e) {
        return json(origin, request, 502, {
          error: "Brain unreachable",
          detail: String(e?.message || e),
        });
      }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(origin, request, 502, {
          error: "Brain error",
          status: brainResp.status,
          detail: t.slice(0, 2000),
        });
      }

      const h = withBaseHeaders(origin, request, {
        "x-chattia-text-iso2": iso2,
        "x-chattia-text-bcp47": bcp47,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
      });

      // Proxy streaming body
      return new Response(brainResp.body, { status: 200, headers: h });
    }

    if (url.pathname === "/api/voice") {
      if (request.method !== "POST") {
        return json(origin, request, 405, { error: "Method not allowed" });
      }

      const assetCheck = enforceAssetIdentity(request, env);
      if (!assetCheck.ok) {
        return json(origin, request, 403, { error: "Blocked: asset identity", detail: assetCheck.reason });
      }

      const ts = await verifyTurnstile(request, env);
      if (!ts.ok) {
        return json(origin, request, 403, { error: "Blocked: turnstile", detail: ts.reason });
      }

      const audioBuf = await request.arrayBuffer().catch(() => null);
      if (!audioBuf) return json(origin, request, 400, { error: "Failed to read audio" });

      if (audioBuf.byteLength <= 0) return json(origin, request, 400, { error: "Empty audio" });
      if (audioBuf.byteLength > MAX_AUDIO_BYTES) return json(origin, request, 413, { error: "Audio too large" });

      let stt;
      try {
        stt = await runWhisper(env, audioBuf);
      } catch (e) {
        return json(origin, request, 502, { error: "STT unavailable", detail: String(e?.message || e) });
      }

      const transcript = stt.text || "";
      if (!transcript) {
        return json(origin, request, 200, { transcript: "", note: "No speech detected" }, {
          "x-chattia-voice-timeout-sec": "120",
          "x-chattia-stt-iso2": "en",
          "x-chattia-stt-bcp47": "en-US",
          "x-chattia-stt-lang": "EN",
        });
      }

      // Simple iso2 guess (good enough for headers; Brain can do deeper logic)
      const maybeEs = /[¿¡]|(\b(hola|gracias|por favor|buenas|necesito|factura|pago)\b)/i.test(transcript);
      const iso2 = maybeEs ? "es" : "en";
      const bcp47 = iso2ToBcp47(iso2);
      const legacy = iso2 === "es" ? "ES" : "EN";

      const mode = (url.searchParams.get("mode") || "stt").toLowerCase();
      if (mode === "stt") {
        return json(origin, request, 200, {
          transcript,
          lang_iso2: iso2,
          lang_bcp47: bcp47,
        }, {
          "x-chattia-voice-timeout-sec": "120",
          "x-chattia-stt-iso2": iso2,
          "x-chattia-stt-bcp47": bcp47,
          "x-chattia-stt-lang": legacy,
        });
      }

      // Optional: if mode != stt, forward transcript to Brain and stream SSE
      const payload = {
        messages: [{ role: "user", content: transcript }],
        meta: { lang_iso2: iso2, lang_bcp47: bcp47 },
      };

      const identityHeaders = await buildBrainIdentityHeaders(env, JSON.stringify(payload));

      let brainResp;
      try {
        brainResp = await callBrainSSE(env, payload, identityHeaders);
      } catch (e) {
        return json(origin, request, 502, { error: "Brain unreachable", detail: String(e?.message || e) });
      }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(origin, request, 502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) });
      }

      const h = withBaseHeaders(origin, request, {
        "x-chattia-voice-timeout-sec": "120",
        "x-chattia-stt-iso2": iso2,
        "x-chattia-stt-bcp47": bcp47,
        "x-chattia-stt-lang": legacy,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
      });

      return new Response(brainResp.body, { status: 200, headers: h });
    }

    return json(origin, request, 404, { error: "Not found" });
  },
};
