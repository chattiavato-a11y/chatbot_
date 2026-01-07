/* worker/assistant-template.js
   OPS ONLINE ASSISTANT — BRAIN (v3.2)
   Called by ops-gateway via Service Binding (env.BRAIN.fetch)

   Goals:
   - Short replies (token-cut)
   - Scope locked to opsonlinesupport.com CX + lead gen + careers path
   - Strong HMAC verification (ts + nonce + method + path + bodySha)
   - Optional replay cache (KV) if OPS_NONCE or OPS_RL is bound
   - Basic DLP: block payment cards (never collect)
*/

import { OPS_SITE, OPS_SITE_RULES_EN, OPS_SITE_RULES_ES } from "./ops-site-content.js";

const CHAT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_BODY_BYTES = 16_384;
const MAX_MSG_CHARS = 256;
const MAX_HISTORY_ITEMS = 12;

// Anti-replay / signature window
const SIG_MAX_SKEW_MS = 5 * 60 * 1000;

// Keep responses shorter
const MAX_OUTPUT_TOKENS = 774;

// Defensive caps
const MAX_REPLY_CHARS = 900;

// API headers (OWASP-friendly)
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
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
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
    "X-Robots-Tag": "noindex, nofollow"
  };
}

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...securityHeaders(), ...extra }
  });
}

function systemPrompt(lang) {
  const rules = (lang === "es") ? OPS_SITE_RULES_ES : OPS_SITE_RULES_EN;

  const positioning = (lang === "es") ? OPS_SITE.positioning_es : OPS_SITE.positioning_en;
  const services = (lang === "es") ? OPS_SITE.services_es : OPS_SITE.services_en;
  const leadFlow = (lang === "es") ? OPS_SITE.lead_flow_es : OPS_SITE.lead_flow_en;
  const contact = (lang === "es") ? OPS_SITE.contact_cta_es : OPS_SITE.contact_cta_en;
  const careers = (lang === "es") ? OPS_SITE.careers_cta_es : OPS_SITE.careers_cta_en;

  const servicesText = services.map(s => `- ${s}`).join("\n");

  return `
${rules}

Website:
- Domain: ${OPS_SITE.domain}
- Brand: ${OPS_SITE.brand}

Positioning:
${positioning}

Services (high level):
${servicesText}

Lead flow guidance:
${leadFlow}

Calls to action:
- Contact: ${contact}
- Careers: ${careers}
`.trim();
}

/* -------------------- Body helpers -------------------- */

async function readBodyLimitedArrayBuffer(request) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len && len > MAX_BODY_BYTES) return null;

  const ab = await request.arrayBuffer();
  if (!ab || ab.byteLength === 0) return null;
  if (ab.byteLength > MAX_BODY_BYTES) return null;
  return ab;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function normalizeUserText(s) {
  let out = String(s || "");
  out = out.replace(/[\u0000-\u001F\u007F]/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_MSG_CHARS) out = out.slice(0, MAX_MSG_CHARS);
  return out;
}

function looksSuspicious(s) {
  const t = String(s || "").toLowerCase();
  const bad = [
    "<script", "</script", "javascript:",
    "<img", "onerror", "onload",
    "<iframe", "<object", "<embed",
    "<svg", "<link", "<meta", "<style",
    "document.cookie",
    "onmouseover", "onmouseenter",
    "<form", "<input", "<textarea"
  ];
  return bad.some(p => t.includes(p));
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

/* -------------------- Strong HMAC verify (Gateway -> Brain) -------------------- */

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

function isHexLower(s, len) {
  const v = String(s || "");
  if (v.length !== len) return false;
  return /^[0-9a-f]+$/.test(v);
}

function isNonceHex(s) {
  const v = String(s || "");
  // Gateway uses 16 bytes => 32 hex chars; allow 32..64 to be tolerant
  return /^[0-9a-f]{32,64}$/.test(v);
}

async function verifyGatewaySignature(request, env, rawBodyAb, expectedMethod, expectedPath) {
  const secret = String(env.HAND_SHAKE || "");
  if (!secret) {
    return { ok: false, status: 500, code: "NO_HAND_SHAKE", publicMsg: "Assistant configuration error." };
  }

  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname || "/";

  if (method !== expectedMethod) {
    return { ok: false, status: 401, code: "BAD_METHOD", publicMsg: "Unauthorized request." };
  }
  if (path !== expectedPath) {
    return { ok: false, status: 401, code: "BAD_PATH", publicMsg: "Unauthorized request." };
  }

  const ts = String(request.headers.get("X-Ops-Ts") || "");
  const nonce = String(request.headers.get("X-Ops-Nonce") || "");
  const bodyShaHdr = String(request.headers.get("X-Ops-Body-Sha256") || "");
  const sigHdr = String(request.headers.get("X-Ops-Sig") || "");

  if (!ts || !nonce || !bodyShaHdr || !sigHdr) {
    return { ok: false, status: 401, code: "MISSING_SIG", publicMsg: "Unauthorized request." };
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { ok: false, status: 401, code: "BAD_TS", publicMsg: "Unauthorized request." };
  }

  const skew = Math.abs(Date.now() - tsNum);
  if (skew > SIG_MAX_SKEW_MS) {
    return { ok: false, status: 401, code: "STALE_TS", publicMsg: "Unauthorized request." };
  }

  // Strict formatting checks (avoid weird inputs)
  if (!isNonceHex(nonce)) return { ok: false, status: 401, code: "BAD_NONCE", publicMsg: "Unauthorized request." };
  if (!isHexLower(bodyShaHdr, 64)) return { ok: false, status: 401, code: "BAD_BODY_SHA", publicMsg: "Unauthorized request." };
  if (!/^[0-9a-f]{64}$/.test(sigHdr)) return { ok: false, status: 401, code: "BAD_SIG_FMT", publicMsg: "Unauthorized request." };

  const bodySha = await sha256HexFromArrayBuffer(rawBodyAb);
  if (!timingSafeEqualHex(bodySha, bodyShaHdr)) {
    return { ok: false, status: 401, code: "BODY_SHA_MISMATCH", publicMsg: "Unauthorized request." };
  }

  const toSign = [ts, nonce, method, path, bodySha].join(".");
  const expectedSig = await hmacSha256Hex(secret, toSign);

  if (!timingSafeEqualHex(sigHdr, expectedSig)) {
    return { ok: false, status: 401, code: "BAD_SIG", publicMsg: "Unauthorized request." };
  }

  // Optional replay cache: key by nonce (ts already bound into sig)
  // TTL should cover skew window (5m) + buffer
  const kv = env.OPS_NONCE || env.OPS_RL;
  if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
    const k = `nonce:${nonce}`;
    const seen = await kv.get(k);
    if (seen) return { ok: false, status: 401, code: "REPLAY", publicMsg: "Unauthorized request." };
    // KV requires expirationTtl >= 60
    await kv.put(k, "1", { expirationTtl: 10 * 60 });
  }

  return { ok: true };
}

/* -------------------- AI response (concise) -------------------- */

function fallbackReply(lang) {
  if (lang === "es") {
    return "Puedo ayudarte con información general de OPS Online Support y guiarte a Contacto o Carreras/Únete en opsonlinesupport.com. ¿Buscas servicios para tu negocio o deseas postular?";
  }
  return "I can help with OPS Online Support info and guide you to Contact or Careers/Join Us on opsonlinesupport.com. Are you looking for business services or applying for a role?";
}

function normalizeReply(reply, lang) {
  let out = String(reply || "").replace(/\s+/g, " ").trim();

  // Strip code fences if a model ignores instructions
  out = out.replace(/```[\s\S]*?```/g, "").trim();

  // Soft remove common bullet markers (model should avoid them)
  out = out.replace(/\s(?:•|\-|\*)\s/g, " ").replace(/\s+/g, " ").trim();

  if (out.length > MAX_REPLY_CHARS) out = out.slice(0, MAX_REPLY_CHARS).trim();

  // Ensure a clear next step if missing
  const hasSite = out.toLowerCase().includes("opsonlinesupport.com");
  const hasContact = /contact|contacto/i.test(out);
  const hasCareers = /careers|join us|carreras|únete/i.test(out);

  if (!hasSite && !(hasContact || hasCareers)) {
    out += (lang === "es")
      ? " Para continuar, usa la página de Contacto o Carreras/Únete en opsonlinesupport.com."
      : " Next step: please use the Contact page or Careers/Join Us on opsonlinesupport.com.";
  }

  return out || fallbackReply(lang);
}

async function runChat(env, lang, history, message) {
  const ai = env.AI;
  if (!ai || typeof ai.run !== "function") return fallbackReply(lang);

  const msgs = [{ role: "system", content: systemPrompt(lang) }];

  for (const h of history) {
    msgs.push({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content
    });
  }

  msgs.push({ role: "user", content: message });

  try {
    const out = await ai.run(CHAT_MODEL_ID, {
      messages: msgs,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3
    });

    const reply =
      (typeof out?.response === "string" && out.response.trim()) ? out.response.trim() :
      (typeof out?.result === "string" && out.result.trim()) ? out.result.trim() :
      "";

    return normalizeReply(reply || fallbackReply(lang), lang);
  } catch (e) {
    console.error("Brain AI run failed:", e);
    return fallbackReply(lang);
  }
}

/* -------------------- Handler -------------------- */

async function handleOpsOnlineChat(request, env) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return json(415, { ok: false, error: "JSON only." });

  const raw = await readBodyLimitedArrayBuffer(request);
  if (!raw) return json(413, { ok: false, error: "Request too large or empty." });

  const verify = await verifyGatewaySignature(request, env, raw, "POST", "/api/ops-online-chat");
  if (!verify.ok) return json(verify.status, { ok: false, error: verify.publicMsg, error_code: verify.code });

  const bodyText = new TextDecoder().decode(raw);

  // DLP hard-stop (PCI-ish)
  if (containsLikelyCardNumber(bodyText)) {
    return json(400, {
      ok: false,
      error: "For security, do not share card details in chat. Please use the site Contact page."
    });
  }

  if (looksSuspicious(bodyText)) {
    return json(400, { ok: false, error: "Request blocked.", error_code: "SUSPECT_BODY" });
  }

  const payload = safeJsonParse(bodyText);
  if (!payload || typeof payload !== "object") return json(400, { ok: false, error: "Invalid JSON." });

  const lang = (payload.lang === "es") ? "es" : "en";
  const message = normalizeUserText(typeof payload.message === "string" ? payload.message : "");
  const history = sanitizeHistory(payload.history);

  if (!message) {
    return json(400, {
      ok: false,
      lang,
      error: lang === "es" ? "No se proporcionó ningún mensaje." : "No message provided."
    });
  }

  if (looksSuspicious(message)) {
    return json(400, { ok: false, lang, error: lang === "es" ? "Solicitud bloqueada." : "Request blocked.", error_code: "SUSPECT_TEXT" });
  }

  const reply = await runChat(env, lang, history, message);

  return json(200, { ok: true, reply, lang, site: OPS_SITE.domain });
}

/* -------------------- Router -------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname || "/";

    if (request.method === "GET" && (pathname === "/health" || pathname === "/ping")) {
      return json(200, { ok: true, service: "ops-online-assistant-brain", site: OPS_SITE.domain });
    }

    if (pathname === "/api/ops-online-chat") {
      if (request.method !== "POST") return json(405, { ok: false, error: "POST only." });
      return handleOpsOnlineChat(request, env);
    }

    return json(404, { ok: false, error: "Not found." });
  }
};
