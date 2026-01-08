/* worker/ops-brain.js
   OPS BRAIN (v3.2) — PRIVATE CORE (Service Binding target)

   Gateway -> Brain (Service Binding)

   REQUIRED bindings:
   - Workers AI:       AI         (model inference)
   - Secret:           HAND_SHAKE (same as Gateway)

   OPTIONAL:
   - KV namespace:     OPS_EVENTS   (minimal audit events)
   - KV namespace:     OPS_NONCES   (best-effort nonce cache)
   - Durable Object:   NONCE_GUARD  (strong nonce replay protection)
     durable_objects.bindings: [{ name: "NONCE_GUARD", class_name: "OpsNonceGuard" }]

   REQUIRED headers from Gateway:
   - X-Ops-Request-Id
   - X-Ops-Ts
   - X-Ops-Nonce
   - X-Ops-Body-Sha256
   - X-Ops-Sig

   Signature scheme:
     bodySha = SHA256_HEX(rawBodyBytes)
     toSign  = `${ts}.${nonce}.${method}.${path}.${bodySha}`
     sig     = HMAC_SHA256_HEX(HAND_SHAKE, toSign)
*/

import { OPS_SITE, OPS_SITE_RULES_EN, OPS_SITE_RULES_ES } from "./ops-site-content";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

const MAX_CHAT_BYTES = 8_192;
const MAX_MSG_CHARS = 256;
const MAX_HISTORY_ITEMS = 12;

const TS_SKEW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_NONCE_TTL_SEC = 10 * 60; // 10 minutes (for gateway->brain replay)

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
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-DNS-Prefetch-Control": "off",
    "X-XSS-Protection": "0",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Robots-Tag": "noindex, nofollow"
  };
}

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...securityHeaders(),
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

async function readBodyArrayBufferLimited(request, limitBytes) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len && len > limitBytes) return null;

  const ab = await request.arrayBuffer();
  if (!ab || ab.byteLength === 0) return null;
  if (ab.byteLength > limitBytes) return null;
  return ab;
}

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

/* -------------------- Minimal audit (no raw messages) -------------------- */

function randHex(byteLen = 16) {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

async function ipTag(ip) {
  const h = await sha256Hex(ip || "");
  return h.slice(0, 16);
}

async function logEvent(ctx, env, event) {
  try {
    const safe = {
      ts: new Date().toISOString(),
      type: String(event?.type || ""),
      ip_tag: event?.ip_tag,
      path: event?.path,
      request_id: event?.request_id,
      lang: event?.lang,
      history_len: event?.history_len,
      msg_len: event?.msg_len,
      reason: event?.reason
    };
    console.warn("[OPS_EVENT]", JSON.stringify(safe));

    const kv = env.OPS_EVENTS;
    if (kv && typeof kv.put === "function") {
      const key = `ops_evt:${Date.now()}:${randHex(8)}`;
      ctx.waitUntil(kv.put(key, JSON.stringify(safe), { expirationTtl: 60 * 60 * 24 * 7 }));
    }
  } catch (e) {
    console.error("logEvent failed:", e);
  }
}

/* -------------------- HMAC verify (Gateway -> Brain) -------------------- */

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

function timingSafeEqualHex(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return out === 0;
}

function clampNonceTtlSec(env) {
  const raw = Number(env.NONCE_TTL_SECONDS || DEFAULT_NONCE_TTL_SEC);
  const ttl = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_NONCE_TTL_SEC;
  return Math.max(60, ttl); // Cloudflare KV TTL must be >= 60
}

/* -------------------- Nonce replay protection -------------------- */

async function nonceReplayCheck(env, nonce, ttlSec) {
  if (!nonce) return { ok: false, reason: "missing_nonce" };

  // Strong path: Durable Object
  if (env.NONCE_GUARD && typeof env.NONCE_GUARD.idFromName === "function") {
    const id = env.NONCE_GUARD.idFromName("ops_nonce_guard");
    const stub = env.NONCE_GUARD.get(id);
    const r = await stub.fetch("https://nonce.local/check", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ nonce, ttlSec })
    });
    const out = await r.json().catch(() => null);
    return out && out.ok ? { ok: true } : { ok: false, reason: out?.reason || "replay" };
  }

  // Best-effort path: KV (eventual consistency)
  const kv = env.OPS_NONCES;
  if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
    const key = `nonce:${nonce}`;
    const existing = await kv.get(key);
    if (existing) return { ok: false, reason: "replay" };
    await kv.put(key, "1", { expirationTtl: ttlSec });
    return { ok: true };
  }

  // Fail-open if no storage
  return { ok: true, skipped: true };
}

/* -------------------- Optional firewall (defense-in-depth) -------------------- */

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

/* -------------------- Output sanitizer -------------------- */

function sanitizeAssistantOutput(text) {
  let t = String(text || "");
  // kill control chars
  t = t.replace(/[\u0000-\u001F\u007F]/g, " ");
  // block any HTML-ish tags (keep plain text)
  t = t.replace(/</g, "‹").replace(/>/g, "›");
  // collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  // hard cap
  if (t.length > 1600) t = t.slice(0, 1600);
  return t;
}

function buildSiteContext(lang) {
  const routes = OPS_SITE.routes;
  const services = lang === "es" ? OPS_SITE.services_es : OPS_SITE.services_en;
  const positioning = lang === "es" ? OPS_SITE.positioning_es : OPS_SITE.positioning_en;
  const contactCta = lang === "es" ? OPS_SITE.contact_cta_es : OPS_SITE.contact_cta_en;
  const careersCta = lang === "es" ? OPS_SITE.careers_cta_es : OPS_SITE.careers_cta_en;
  const whereToFind = lang === "es" ? OPS_SITE.where_to_find_es : OPS_SITE.where_to_find_en;

  return [
    `Site: ${OPS_SITE.brand} (${OPS_SITE.base_url}).`,
    `Positioning: ${positioning}`,
    `Services: ${services.join(" ")}`,
    `Routes: home ${routes.home}, about ${routes.about}, contact ${routes.contact}, policies ${routes.policies}, careers ${routes.careers}.`,
    `CTAs: ${contactCta} ${careersCta}`,
    `Finders: services=${whereToFind.services} policies=${whereToFind.policies} contact=${whereToFind.contact} careers=${whereToFind.careers}`
  ].join(" ");
}

/* -------------------- Durable Object (strong nonce guard) -------------------- */

export class OpsNonceGuard {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/check" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const nonce = String(body?.nonce || "");
    const ttlSec = Math.max(60, Math.floor(Number(body?.ttlSec || DEFAULT_NONCE_TTL_SEC)));
    if (!nonce) return json(400, { ok: false, reason: "missing_nonce" });

    const now = Date.now();
    const rec = await this.state.storage.get(nonce);

    if (rec && typeof rec === "object" && Number(rec.exp) > now) {
      return json(409, { ok: false, reason: "replay" });
    }

    await this.state.storage.put(nonce, { exp: now + ttlSec * 1000 });

    // Lightweight opportunistic cleanup (rare)
    if ((now % 997) === 0) {
      try {
        const list = await this.state.storage.list({ limit: 64 });
        for (const [k, v] of list.entries()) {
          if (v && typeof v === "object" && Number(v.exp) <= now) {
            await this.state.storage.delete(k);
          }
        }
      } catch {}
    }

    return json(200, { ok: true });
  }
}

/* -------------------- Main Brain Worker -------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname || "/";
    const reqId = request.headers.get("X-Ops-Request-Id") || `req_${Date.now()}_${randHex(6)}`;
    const clientIp = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

    // Health
    if (request.method === "GET" && (pathname === "/" || pathname === "/health" || pathname === "/ping")) {
      return json(200, {
        ok: true,
        service: "ops-brain",
        has_ai: !!(env.AI && typeof env.AI.run === "function"),
        has_nonce_guard_do: !!(env.NONCE_GUARD && typeof env.NONCE_GUARD.idFromName === "function"),
        has_nonce_kv: !!(env.OPS_NONCES && typeof env.OPS_NONCES.get === "function"),
        request_id: reqId
      }, { "X-Ops-Request-Id": reqId });
    }

    // Only API
    if (pathname !== "/api/ops-online-chat") {
      return json(404, { ok: false, error: "Not found.", error_code: "NOT_FOUND", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }
    if (request.method !== "POST") {
      return json(405, { ok: false, error: "POST only.", error_code: "METHOD", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    // JSON-only
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      return json(415, { ok: false, error: "JSON only.", error_code: "JSON_ONLY", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    // Read body
    const raw = await readBodyArrayBufferLimited(request, MAX_CHAT_BYTES);
    if (!raw) {
      return json(413, { ok: false, error: "Request too large or empty.", error_code: "TOO_LARGE", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    // Verify required headers
    const ts = String(request.headers.get("X-Ops-Ts") || "");
    const nonce = String(request.headers.get("X-Ops-Nonce") || "");
    const bodyShaHdr = String(request.headers.get("X-Ops-Body-Sha256") || "");
    const sigHdr = String(request.headers.get("X-Ops-Sig") || "");

    if (!ts || !nonce || !bodyShaHdr || !sigHdr) {
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "AUTH_MISSING_HEADERS", ip_tag: tag, path: pathname, request_id: reqId });
      return json(401, { ok: false, error: "Unauthorized.", error_code: "AUTH_HEADERS", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    // Timestamp skew check
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > TS_SKEW_MS) {
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "AUTH_TS_SKEW", ip_tag: tag, request_id: reqId });
      return json(401, { ok: false, error: "Unauthorized.", error_code: "TS_SKEW", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    // Body SHA check
    const bodySha = await sha256HexFromArrayBuffer(raw);
    if (!timingSafeEqualHex(bodySha, bodyShaHdr)) {
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "AUTH_BODY_SHA_MISMATCH", ip_tag: tag, request_id: reqId });
      return json(401, { ok: false, error: "Unauthorized.", error_code: "BODY_SHA", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    // HMAC signature verify
    const secret = String(env.HAND_SHAKE || "");
    if (!secret) {
      return json(500, { ok: false, error: "Brain misconfigured (missing HAND_SHAKE).", error_code: "NO_HAND_SHAKE", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    const toSign = [ts, nonce, "POST", pathname, bodySha].join(".");
    const expected = await hmacSha256Hex(secret, toSign);

    if (!timingSafeEqualHex(expected, sigHdr)) {
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "AUTH_SIG_INVALID", ip_tag: tag, request_id: reqId });
      return json(401, { ok: false, error: "Unauthorized.", error_code: "BAD_SIG", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    // Nonce replay check (DO strong, KV best-effort)
    const ttlSec = clampNonceTtlSec(env);
    const nr = await nonceReplayCheck(env, nonce, ttlSec);
    if (!nr.ok) {
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "AUTH_REPLAY_BLOCK", ip_tag: tag, request_id: reqId });
      return json(409, { ok: false, error: "Replay blocked.", error_code: "REPLAY", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    // Parse payload
    const bodyText = new TextDecoder().decode(raw);

    if (hasDataUriBase64(bodyText) || looksSuspicious(bodyText)) {
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "SANITIZE_BLOCK", ip_tag: tag, reason: "body", request_id: reqId });
      return json(400, { ok: false, error: "Request blocked.", error_code: "SANITIZE", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    const payload = safeJsonParse(bodyText);
    if (!payload || typeof payload !== "object") {
      return json(400, { ok: false, error: "Invalid JSON.", error_code: "BAD_JSON", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    const lang = (payload.lang === "es") ? "es" : "en";
    const message = normalizeUserText(typeof payload.message === "string" ? payload.message : "");
    const history = sanitizeHistory(payload.history);

    if (!message) {
      return json(400, { ok: false, error: "No message provided.", error_code: "NO_MESSAGE", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }
    if (looksSuspicious(message)) {
      return json(400, { ok: false, error: "Request blocked.", error_code: "SUSPECT_TEXT", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }
    if (containsLikelyCardNumber(message) || containsLikelyCardNumber(bodyText)) {
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "DLP_BLOCK_CARD", ip_tag: tag, request_id: reqId });
      return json(400, {
        ok: false,
        request_id: reqId,
        error_code: "DLP_CARD",
        error: lang === "es"
          ? "Por seguridad, no compartas datos de tarjeta en el chat."
          : "For security, do not share card details in chat."
      }, { "X-Ops-Request-Id": reqId });
    }

    // Optional firewall (defense-in-depth)
    const fwIn = await firewallCheck(env, message);
    if (!fwIn.ok) {
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "FIREWALL_BLOCK_IN", ip_tag: tag, request_id: reqId });
      return json(400, { ok: false, error: "Request blocked.", error_code: "FIREWALL_IN", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    // AI run
    if (!env.AI || typeof env.AI.run !== "function") {
      return json(500, { ok: false, error: "Brain misconfigured (missing AI binding).", error_code: "NO_AI", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    const rules = lang === "es" ? OPS_SITE_RULES_ES : OPS_SITE_RULES_EN;
    const siteContext = buildSiteContext(lang);
    const system = `${rules}\n\n${siteContext}`;

    const messages = [{ role: "system", content: system }];
    for (const h of history) messages.push(h);
    messages.push({ role: "user", content: message });

    let out;
    try {
      out = await env.AI.run(MODEL_ID, { messages, max_tokens: 700 });
    } catch (e) {
      console.error("AI.run failed:", e);
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "AI_ERROR", ip_tag: tag, request_id: reqId });
      return json(502, { ok: false, error: "Upstream error.", error_code: "AI_ERROR", request_id: reqId }, { "X-Ops-Request-Id": reqId });
    }

    const rawReply = String(out?.response || out?.result || out?.text || "");
    let reply = sanitizeAssistantOutput(rawReply || "");

    // Optional firewall on output
    const fwOut = await firewallCheck(env, reply);
    if (!fwOut.ok) {
      reply = lang === "es"
        ? "Lo siento, no puedo ayudar con eso."
        : "Sorry, I can’t help with that.";
      const tag = await ipTag(clientIp);
      await logEvent(ctx, env, { type: "FIREWALL_BLOCK_OUT", ip_tag: tag, request_id: reqId });
    }

    // Minimal audit (no raw message)
    const tag = await ipTag(clientIp);
    await logEvent(ctx, env, {
      type: "CHAT_OK",
      ip_tag: tag,
      lang,
      request_id: reqId,
      history_len: history.length,
      msg_len: message.length
    });

    return json(200, { ok: true, lang, request_id: reqId, reply }, { "X-Ops-Request-Id": reqId });
  }
};
