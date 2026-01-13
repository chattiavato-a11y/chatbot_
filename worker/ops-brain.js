/* worker/ops-brain.js
   OPS BRAIN (v3.2) — PRIVATE AI ROUTER (called by ops-gateway via Service Binding)

   Goal:
   - Accept clean JSON from ops-gateway
   - Generate a helpful answer about OPS Online Support (EN/ES)
   - Return JSON (non-stream) so gateway can proxy cleanly

   IMPORTANT (simple + safe):
   - No KV, no secrets required
   - "Private-by-default": only responds when called via service-binding URL host "brain.local"
     (gateway calls: new Request("https://brain.local/api/ops-online-chat", ...))

   Required binding:
   - env.AI (Workers AI)

   Inputs (from gateway):
   {
     lang: "en" | "es",
     message: string,
     history?: [{ role:"user"|"assistant", content:string }],
     v?: number
   }

   Output:
   {
     ok: true,
     lang: "en"|"es",
     reply: string,
     request_id: string
   }
*/

import { OPS_SITE, OPS_SITE_RULES_EN, OPS_SITE_RULES_ES } from "./ops-site-content.js";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct"; // safe default
const MAX_MSG_CHARS = 256;
const MAX_HISTORY_ITEMS = 12;
const MAX_OUTPUT_TOKENS = 600;

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function securityHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Robots-Tag": "noindex, nofollow"
  };
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: securityHeaders() });
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
    "<form", "<input", "<textarea",
    "data:" // uploads-ish
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

function buildSiteFacts(lang) {
  const isEs = lang === "es";
  const facts = [];

  facts.push(`Brand: ${OPS_SITE.brand}. Website: ${OPS_SITE.base_url}.`);

  if (isEs) {
    facts.push(`Posicionamiento: ${OPS_SITE.positioning_es}`);
    facts.push(`Servicios: ${OPS_SITE.services_es.join(" ")}`);
    facts.push(`CTA Contacto: ${OPS_SITE.contact_cta_es}`);
    facts.push(`CTA Carreras: ${OPS_SITE.careers_cta_es}`);
    facts.push(`Navegación: ${JSON.stringify(OPS_SITE.where_to_find_es)}`);
  } else {
    facts.push(`Positioning: ${OPS_SITE.positioning_en}`);
    facts.push(`Services: ${OPS_SITE.services_en.join(" ")}`);
    facts.push(`Contact CTA: ${OPS_SITE.contact_cta_en}`);
    facts.push(`Careers CTA: ${OPS_SITE.careers_cta_en}`);
    facts.push(`Navigation: ${JSON.stringify(OPS_SITE.where_to_find_en)}`);
  }

  // Keep it short to avoid prompt bloat
  return facts.join("\n");
}

function buildSystemPrompt(lang) {
  const isEs = lang === "es";
  const rules = isEs ? OPS_SITE_RULES_ES : OPS_SITE_RULES_EN;
  const facts = buildSiteFacts(lang);

  return [
    rules,
    "",
    "Site facts (authoritative):",
    facts,
    "",
    isEs
      ? "Responde SOLO en Español. Mantén el texto corto, útil y orientado a acción. Termina con un CTA si aplica."
      : "Answer ONLY in English. Keep it short, helpful, and action-oriented. End with a CTA when appropriate."
  ].join("\n");
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function sha256HexFromString(s) {
  const ab = new TextEncoder().encode(String(s || ""));
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return bytesToHex(new Uint8Array(digest));
}

// Ultra-light “request id” if gateway didn't pass one (still fine)
async function ensureRequestId(req) {
  const existing = req.headers.get("X-Ops-Request-Id");
  if (existing) return existing;
  const seed = `${Date.now()}|${Math.random()}|${req.headers.get("CF-Connecting-IP") || ""}`;
  const hex = await sha256HexFromString(seed);
  return `req_${Date.now()}_${hex.slice(0, 12)}`;
}

async function runModel(env, lang, message, history) {
  if (!env.AI || typeof env.AI.run !== "function") {
    // Fail closed-ish: return a deterministic fallback without AI
    const fallback = (lang === "es")
      ? "Ahora mismo no puedo generar una respuesta automática. Por favor usa la página de Contacto para que el equipo te ayude."
      : "I can’t generate an automatic response right now. Please use the Contact page so the team can help you.";
    return fallback;
  }

  const system = buildSystemPrompt(lang);

  const messages = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: message }
  ];

  const out = await env.AI.run(MODEL_ID, {
    messages,
    max_tokens: MAX_OUTPUT_TOKENS
  });

  // Workers AI responses vary by model/runtime; handle common shapes
  const text =
    (typeof out === "string" && out) ||
    out?.response ||
    out?.result ||
    out?.output ||
    "";

  return String(text || "").trim();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Private-by-default: only accept service-binding host "brain.local"
    if (url.hostname !== "brain.local") {
      // Hide existence publicly
      return new Response("Not found", { status: 404 });
    }

    // Route
    if (url.pathname !== "/api/ops-online-chat") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "POST only." });
    }

    const reqId = await ensureRequestId(request);

    // Enforce JSON
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      return json(415, { ok: false, error: "JSON only.", request_id: reqId });
    }

    // Read body once
    let bodyText = "";
    try {
      bodyText = await request.text();
    } catch {
      return json(400, { ok: false, error: "Bad request.", request_id: reqId });
    }

    const payload = safeParseJson(bodyText);
    if (!payload || typeof payload !== "object") {
      return json(400, { ok: false, error: "Invalid JSON.", request_id: reqId });
    }

    const lang = (payload.lang === "es") ? "es" : "en";
    const message = normalizeUserText(typeof payload.message === "string" ? payload.message : "");
    const history = sanitizeHistory(payload.history);

    if (!message) {
      return json(400, { ok: false, error: "No message provided.", lang, request_id: reqId });
    }

    // Defense-in-depth: block obvious injection even though gateway already does
    if (looksSuspicious(message) || looksSuspicious(bodyText)) {
      return json(400, { ok: false, error: "Request blocked.", error_code: "SANITIZE_BLOCK", lang, request_id: reqId });
    }

    // Generate reply
    let reply = "";
    try {
      reply = await runModel(env, lang, message, history);
    } catch (e) {
      console.error("ops-brain AI error:", e);
      reply = (lang === "es")
        ? "Hubo un error al generar la respuesta. Por favor usa la página de Contacto."
        : "There was an error generating a reply. Please use the Contact page.";
    }

    // Keep it clean
    reply = String(reply || "").trim();
    if (!reply) {
      reply = (lang === "es")
        ? "¿Me dices un poco más de lo que necesitas? También puedes usar la página de Contacto."
        : "Can you share a bit more about what you need? You can also use the Contact page.";
    }

    return json(200, { ok: true, lang, reply, request_id: reqId });
  }
};
