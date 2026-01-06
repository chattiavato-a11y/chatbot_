/* worker/assistant-template.js
   OPS ONLINE ASSISTANT — BRAIN (v3.1)
   Called ONLY by ops-gateway via Service Binding (env.BRAIN.fetch)

   Changes per your request:
   - Replies are shorter (tokens cut ~50%)
   - Focused ONLY on opsonlinesupport.com CX + lead generation + careers path
   - Turnstile: not used
   - Strong HMAC verification (ts + nonce + method + path + bodySha)
   - Optional nonce replay cache (KV, if you bind OPS_NONCE or reuse OPS_RL)

   REQUIRED:
   - Secret: HAND_SHAKE (same value as Gateway)
   - Workers AI binding on Brain: AI (for chat model)  [optional but recommended]

   OPTIONAL:
   - KV namespace: OPS_NONCE (preferred) OR OPS_RL (fallback) for replay cache
*/

import { OPS_SITE, OPS_SITE_RULES_EN, OPS_SITE_RULES_ES } from "./ops-site-content.js";

const CHAT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_BODY_BYTES = 16_384;
const MAX_MSG_CHARS = 256;
const MAX_HISTORY_ITEMS = 12;

// anti-replay window
const SIG_MAX_SKEW_MS = 5 * 60 * 1000;

// tokens cut ~50% (previous was ~1548)
const MAX_OUTPUT_TOKENS = 774;

function systemPrompt(lang) {
  const rules = (lang === "es") ? OPS_SITE_RULES_ES : OPS_SITE_RULES_EN;

  const positioning = (lang === "es") ? OPS_SITE.positioning_es : OPS_SITE.positioning_en;
  const services = (lang === "es") ? OPS_SITE.services_es : OPS_SITE.services_en;
  const leadFlow = (lang === "es") ? OPS_SITE.lead_flow_es : OPS_SITE.lead_flow_en;
  const contact = (lang === "es") ? OPS_SITE.contact_cta_es : OPS_SITE.contact_cta_en;
  const careers = (lang === "es") ? OPS_SITE.careers_cta_es : OPS_SITE.careers_cta_en;

  const servicesText = services.map(s => `- ${s}`).join("\n");

  // Keep it compact: rules + minimal KB
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

/* -------------------- Response helpers -------------------- */

function securityHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
  };
}

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...securityHeaders(), ...extra }
  });
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

async function verifyGatewaySignature(request, env, rawBodyAb) {
  const secret = String(env.HAND_SHAKE || "");
  if (!secret) {
    return { ok: false, status: 500, code: "NO_HAND_SHAKE", publicMsg: "Assistant configuration error." };
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

  const path = new URL(request.url).pathname || "/";
  const method = request.method.toUpperCase();

  const bodySha = await sha256HexFromArrayBuffer(rawBodyAb);
  if (!timingSafeEqualHex(bodySha, bodyShaHdr)) {
    return { ok: false, status: 401, code: "BODY_SHA_MISMATCH", publicMsg: "Unauthorized request." };
  }

  const toSign = [ts, nonce, method, path, bodySha].join(".");
  const expectedSig = await hmacSha256Hex(secret, toSign);

  if (!timingSafeEqualHex(sigHdr, expectedSig)) {
    return { ok: false, status: 401, code: "BAD_SIG", publicMsg: "Unauthorized request." };
  }

  // Optional replay cache (bind OPS_NONCE preferred; OPS_RL fallback)
  const kv = env.OPS_NONCE || env.OPS_RL;
  if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
    const k = `nonce:${ts}:${nonce}`;
    const seen = await kv.get(k);
    if (seen) return { ok: false, status: 401, code: "REPLAY", publicMsg: "Unauthorized request." };
    await kv.put(k, "1", { expirationTtl: 600 });
  }

  return { ok: true };
}

/* -------------------- AI response (concise) -------------------- */

function fallbackReply(lang, message) {
  if (lang === "es") {
    return "Puedo ayudarte con información general sobre OPS Online Support y guiarte a Contacto o Carreras/Únete en opsonlinesupport.com. ¿Buscas servicios para tu negocio o quieres postular a un puesto?";
  }
  return "I can help with OPS Online Support website info and guide you to Contact or Careers/Join Us on opsonlinesupport.com. Are you looking for services for your business, or applying for a role?";
}

async function runChat(env, lang, history, message) {
  const ai = env.AI;
  if (!ai || typeof ai.run !== "function") return fallbackReply(lang, message);

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

    return reply || fallbackReply(lang, message);
  } catch (e) {
    console.error("Brain AI run failed:", e);
    return fallbackReply(lang, message);
  }
}

/* -------------------- Handler -------------------- */

async function handleOpsOnlineChat(request, env) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return json(415, { ok: false, error: "JSON only." });

  const raw = await readBodyLimitedArrayBuffer(request);
  if (!raw) return json(413, { ok: false, error: "Request too large or empty." });

  const verify = await verifyGatewaySignature(request, env, raw);
  if (!verify.ok) return json(verify.status, { ok: false, error: verify.publicMsg, error_code: verify.code });

  const bodyText = new TextDecoder().decode(raw);

  // DLP hard-stop (PCI-ish)
  if (containsLikelyCardNumber(bodyText)) {
    return json(400, {
      ok: false,
      error: "For security, do not share card details in chat. Please use the site contact page."
    });
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

  if (looksSuspicious(message) || looksSuspicious(bodyText)) {
    return json(400, { ok: false, lang, error: lang === "es" ? "Solicitud bloqueada." : "Request blocked." });
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
