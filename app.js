/**
 * Cloudflare Worker: enlace (v0)
 * UI (GitHub Pages) -> Enlace -> Brain (/api/chat) -> stream back to UI
 *
 * No KV. No secrets. No env variables.
 * (Requires Workers AI binding named "AI" for the Llama Guard call.)
 */

const ALLOWED_ORIGINS = new Set([
  "https://chattiavato-a11y.github.io",
]);

const BRAIN_CHAT_URL = "https://brain.grabem-holdem-nuts-right.workers.dev/api/chat";
const GUARD_MODEL_ID = "@cf/meta/llama-guard-3-8b";

// Limits (keep v0 stable)
const MAX_BODY_CHARS = 24_000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 2_000;

function corsHeaders(origin) {
  const h = new Headers();
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "content-type");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

function securityHeaders() {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  h.set("Cache-Control", "no-store");
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
  h.set("cache-control", "no-cache");
  h.set("connection", "keep-alive");
  securityHeaders().forEach((v, k) => h.set(k, v));
  return new Response(stream, { status: 200, headers: h });
}

function safeTextOnly(s) {
  // remove null bytes + keep printable chars; preserve \n \r \t
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

  // block code fences and HTML-ish tags
  if (text.includes("```")) return true;
  if (/<\/?[a-z][\s\S]*>/i.test(text)) return true;
  if (t.includes("<script") || t.includes("javascript:")) return true;

  // common code tokens (keep simple)
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
    // only allow user/assistant from the browser
    if (role !== "user" && role !== "assistant") continue;

    let content = typeof m.content === "string" ? m.content : "";
    content = safeTextOnly(content);
    if (!content) continue;

    if (content.length > MAX_MESSAGE_CHARS) {
      content = content.slice(0, MAX_MESSAGE_CHARS);
    }

    out.push({ role, content });
  }
  return out;
}

function parseGuardResult(res) {
  // Fail-closed parsing (different models can return slightly different shapes)
  const r = res && res.response;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // health
    if (url.pathname === "/" || url.pathname === "/health") {
      const h = corsHeaders(origin);
      securityHeaders().forEach((v, k) => h.set(k, v));
      return new Response("enlace: ok", { status: 200, headers: h });
    }

    // only route in v0
    if (url.pathname !== "/api/chat") {
      return json(404, { error: "Not found" }, corsHeaders(origin));
    }

    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" }, corsHeaders(origin));
    }

    // enforce allowed origin (v0)
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return json(403, { error: "Origin not allowed" }, corsHeaders(origin));
    }

    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      return json(415, { error: "content-type must be application/json" }, corsHeaders(origin));
    }

    // read + size guard
    let raw = "";
    try {
      raw = await request.text();
    } catch {
      return json(400, { error: "Failed to read body" }, corsHeaders(origin));
    }
    if (!raw || raw.length > MAX_BODY_CHARS) {
      return json(413, { error: "Request too large" }, corsHeaders(origin));
    }

    // parse
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "Invalid JSON" }, corsHeaders(origin));
    }

    const messages = normalizeMessages(body.messages);
    if (!messages.length) {
      return json(400, { error: "messages[] required" }, corsHeaders(origin));
    }

    // quick local block: last user message
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    if (!lastUser) {
      return json(400, { error: "Missing user message" }, corsHeaders(origin));
    }
    if (looksLikeCodeOrMarkup(lastUser)) {
      return json(403, { error: "Blocked: code/markup detected" }, corsHeaders(origin));
    }

    // Llama Guard check BEFORE Brain
    let guardRes;
    try {
      guardRes = await env.AI.run(GUARD_MODEL_ID, { messages });
    } catch {
      return json(502, { error: "Safety check unavailable" }, corsHeaders(origin));
    }

    const verdict = parseGuardResult(guardRes);
    if (!verdict.safe) {
      return json(
        403,
        { error: "Blocked by safety filter", categories: verdict.categories || [] },
        corsHeaders(origin)
      );
    }

    // forward to Brain, stream back
    let brainResp;
    try {
      brainResp = await fetch(BRAIN_CHAT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream",
        },
        body: JSON.stringify({ messages }),
      });
    } catch {
      return json(502, { error: "Brain unreachable" }, corsHeaders(origin));
    }

    if (!brainResp.ok) {
      const t = await brainResp.text().catch(() => "");
      return json(
        502,
        { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) },
        corsHeaders(origin)
      );
    }

    // pass-through SSE stream
    return sse(brainResp.body, corsHeaders(origin));
  },
};
