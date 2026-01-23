/**
 * enlace — FIXED (no vars, no secrets)
 *
 * What this fixes:
 * 1) If you OPEN /api/chat /api/voice /api/tts in the browser (GET),
 *    you now get a helpful JSON (instead of Method not allowed / Origin not allowed).
 * 2) POST requests are still protected by CORS allowlist (your real app use-case).
 *
 * Required bindings:
 * - env.AI
 * - env.brain (Service Binding -> nettunian-io)
 *
 * Routes:
 * - GET  /api/chat   -> usage JSON
 * - POST /api/chat   -> SSE to browser
 * - GET  /api/voice  -> usage JSON
 * - POST /api/voice  -> STT JSON (mode=stt) OR SSE to brain
 * - GET  /api/tts    -> usage JSON
 * - POST /api/tts    -> audio
 */

const ALLOWED_ORIGINS = new Set([
  "https://chattiavato-a11y.github.io",
  "https://www.chattia.io",
  "https://chattia.io",
]);

// Internal hop header (NOT a secret; just a guardrail)
const HOP_HDR = "x-chattia-hop";
const HOP_VAL = "enlace";

// Models
const MODEL_GUARD = "@cf/meta/llama-guard-3-8b";
const MODEL_STT = "@cf/openai/whisper-large-v3-turbo";
const TTS_EN = "@cf/deepgram/aura-2-en";
const TTS_ES = "@cf/deepgram/aura-2-es";
const TTS_FALLBACK = "@cf/myshell-ai/melotts";

// Limits
const MAX_BODY_CHARS = 24_000;
const MAX_MESSAGES = 25;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

function securityHeaders() {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Cache-Control", "no-store, no-transform");
  return h;
}

function isAllowedOrigin(origin) {
  return !!origin && origin !== "null" && ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(origin, request) {
  const h = new Headers();

  if (isAllowedOrigin(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }

  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set(
    "Access-Control-Allow-Headers",
    [
      "content-type",
      "accept",
      "x-ops-asset-id",
      "x-ops-src-sha512-b64",
      "cf-turnstile-response",
    ].join(", ")
  );
  h.set(
    "Access-Control-Expose-Headers",
    ["x-chattia-stt-iso2", "x-chattia-voice-timeout-sec", "x-chattia-tts-iso2"].join(", ")
  );
  h.set("Access-Control-Max-Age", "86400");

  return h;
}

function json(status, obj, extra) {
  const h = new Headers(extra || {});
  h.set("content-type", "application/json; charset=utf-8");
  securityHeaders().forEach((v, k) => h.set(k, v));
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function sse(stream, extra) {
  const h = new Headers(extra || {});
  h.set("content-type", "text/event-stream; charset=utf-8");
  h.set("cache-control", "no-cache, no-transform");
  securityHeaders().forEach((v, k) => h.set(k, v));
  return new Response(stream, { status: 200, headers: h });
}

function safeTextOnly(s) {
  s = String(s || "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    const ok = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160;
    if (ok) out += s[i];
  }
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

function lastUserText(messages) {
  return [...messages].reverse().find((m) => m.role === "user")?.content || "";
}

function detectLangIso2_EN_ES(text) {
  const t = String(text || "").toLowerCase();
  if (/[ñáéíóúü¿¡]/i.test(t)) return "es";
  const esHits = [
    "hola",
    "gracias",
    "por favor",
    "buenos",
    "buenas",
    "necesito",
    "ayuda",
    "quiero",
    "donde",
    "qué",
    "cuánto",
    "porque",
  ].filter((w) => t.includes(w)).length;
  return esHits >= 2 ? "es" : "en";
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

async function runWhisper(env, audioU8) {
  try {
    return await env.AI.run(MODEL_STT, { audio: audioU8.buffer });
  } catch {
    return await env.AI.run(MODEL_STT, { audio: Array.from(audioU8) });
  }
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 255;
  return u8;
}

async function callBrain(env, payload) {
  if (!env?.brain || typeof env.brain.fetch !== "function") {
    throw new Error("Missing Service Binding: env.brain");
  }
  return env.brain.fetch("https://service/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      [HOP_HDR]: HOP_VAL,
    },
    body: JSON.stringify(payload),
  });
}

async function ttsAny(env, text, langIso2) {
  const iso2 = (langIso2 || "en").toLowerCase();
  const preferred = iso2 === "es" ? TTS_ES : TTS_EN;

  // 1) try raw audio response
  try {
    const raw = await env.AI.run(
      preferred,
      { text, encoding: "mp3", container: "none" },
      { returnRawResponse: true }
    );
    const ct = raw?.headers?.get?.("content-type") || "";
    if (raw?.body && ct.toLowerCase().includes("audio")) return { body: raw.body, ct };
  } catch {}

  // 2) try base64 audio
  try {
    const out = await env.AI.run(preferred, { text, encoding: "mp3", container: "none" });
    const b64 = out?.audio || out?.result?.audio || out?.response?.audio || "";
    if (typeof b64 === "string" && b64.length > 16) {
      return { body: base64ToBytes(b64), ct: "audio/mpeg" };
    }
  } catch {}

  // 3) fallback melo
  const out2 = await env.AI.run(TTS_FALLBACK, { prompt: text, lang: iso2 });
  const b64 = out2?.audio || out2?.result?.audio || "";
  if (typeof b64 === "string" && b64.length > 16) {
    return { body: base64ToBytes(b64), ct: "audio/mpeg" };
  }

  throw new Error("TTS failed");
}

function usage(path) {
  if (path === "/api/chat") {
    return {
      ok: true,
      route: "/api/chat",
      method: "POST",
      body_json: { messages: [{ role: "user", content: "Hello" }], meta: {} },
      note: "Open this URL in a browser tab uses GET (not supported). Use POST from your GitHub Pages UI.",
    };
  }
  if (path === "/api/tts") {
    return {
      ok: true,
      route: "/api/tts",
      method: "POST",
      body_json: { text: "Hello", lang_iso2: "en" },
      note: "Returns audio/mpeg. Use POST from your GitHub Pages UI.",
    };
  }
  if (path === "/api/voice") {
    return {
      ok: true,
      route: "/api/voice?mode=stt",
      method: "POST",
      body_binary: "audio/webm (or wav/mp3/etc)",
      body_json_alt: { audio_b64: "<base64>", messages: [], meta: {} },
      note: "Use POST from your GitHub Pages UI (browser sends Origin header).",
    };
  }
  return { ok: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    const isChat = url.pathname === "/api/chat";
    const isVoice = url.pathname === "/api/voice";
    const isTts = url.pathname === "/api/tts";

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

    // Helpful GET usage (THIS is what fixes your “Method not allowed” when opening in browser)
    if (request.method === "GET" && (isChat || isVoice || isTts)) {
      return json(200, usage(url.pathname), new Headers());
    }

    // Only these routes exist
    if (!isChat && !isVoice && !isTts) {
      return json(404, { error: "Not found" }, corsHeaders(origin, request));
    }

    // POST only for real work
    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed", hint: "Use POST (open in tab = GET)" }, corsHeaders(origin, request));
    }

    // Strict CORS for POST (THIS is what blocks “Origin not allowed” for direct calls without Origin)
    if (!isAllowedOrigin(origin)) {
      return json(
        403,
        {
          error: "Origin not allowed",
          detail: "This endpoint must be called from your allowed GitHub Pages / chattia.io origin (browser fetch).",
          saw_origin: origin || "(none)",
          allowed: Array.from(ALLOWED_ORIGINS),
        },
        corsHeaders(origin, request)
      );
    }

    // bindings
    if (!env?.AI || typeof env.AI.run !== "function") {
      return json(500, { error: "Missing AI binding (env.AI)" }, corsHeaders(origin, request));
    }

    // -----------------------
    // /api/chat -> SSE
    // -----------------------
    if (isChat) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        return json(415, { error: "content-type must be application/json" }, corsHeaders(origin, request));
      }

      const raw = await request.text().catch(() => "");
      if (!raw || raw.length > MAX_BODY_CHARS) {
        return json(413, { error: "Request too large" }, corsHeaders(origin, request));
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "Invalid JSON" }, corsHeaders(origin, request));
      }

      const messages = normalizeMessages(body.messages);
      if (!messages.length) {
        return json(400, { error: "messages[] required" }, corsHeaders(origin, request));
      }

      const lastUser = lastUserText(messages);
      const langIso2 = detectLangIso2_EN_ES(lastUser);

      // Llama Guard
      let guardRes;
      try {
        guardRes = await env.AI.run(MODEL_GUARD, { messages });
      } catch {
        return json(502, { error: "Safety check unavailable" }, corsHeaders(origin, request));
      }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) {
        return json(403, { error: "Blocked by safety filter", categories: verdict.categories }, corsHeaders(origin, request));
      }

      const meta = body.meta && typeof body.meta === "object" ? { ...body.meta } : {};
      meta.lang_iso2 = langIso2;

      const extra = corsHeaders(origin, request);

      let brainResp;
      try {
        brainResp = await callBrain(env, { messages, meta });
      } catch (e) {
        return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, extra);
      }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, extra);
      }

      return sse(brainResp.body, extra);
    }

    // -----------------------
    // /api/tts -> audio
    // -----------------------
    if (isTts) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        return json(415, { error: "content-type must be application/json" }, corsHeaders(origin, request));
      }

      const raw = await request.text().catch(() => "");
      if (!raw || raw.length > MAX_BODY_CHARS) {
        return json(413, { error: "Request too large" }, corsHeaders(origin, request));
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "Invalid JSON" }, corsHeaders(origin, request));
      }

      const text = safeTextOnly(body?.text || "");
      if (!text) {
        return json(400, { error: "text required" }, corsHeaders(origin, request));
      }

      const langIso2 = String(body?.lang_iso2 || "en").toLowerCase();

      const extra = corsHeaders(origin, request);
      extra.set("x-chattia-tts-iso2", langIso2);

      try {
        const out = await ttsAny(env, text, langIso2);
        const h = new Headers(extra);
        h.set("content-type", out.ct || "audio/mpeg");
        securityHeaders().forEach((v, k) => h.set(k, v));
        return new Response(out.body, { status: 200, headers: h });
      } catch (e) {
        return json(502, { error: "TTS unavailable", detail: String(e?.message || e) }, extra);
      }
    }

    // -----------------------
    // /api/voice -> STT JSON (mode=stt) OR SSE to brain
    // -----------------------
    if (isVoice) {
      const mode = String(url.searchParams.get("mode") || "stt").toLowerCase();
      const ct = (request.headers.get("content-type") || "").toLowerCase();

      let audioU8 = null;
      let priorMessages = [];
      let meta = {};

      if (ct.includes("application/json")) {
        const raw = await request.text().catch(() => "");
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
        meta = body.meta && typeof body.meta === "object" ? { ...body.meta } : {};

        if (typeof body.audio_b64 === "string" && body.audio_b64.length) {
          const bytes = base64ToBytes(body.audio_b64);
          if (bytes.byteLength > MAX_AUDIO_BYTES) {
            return json(413, { error: "Audio too large" }, corsHeaders(origin, request));
          }
          audioU8 = bytes;
        } else if (Array.isArray(body.audio) && body.audio.length) {
          if (body.audio.length > MAX_AUDIO_BYTES) {
            return json(413, { error: "Audio too large" }, corsHeaders(origin, request));
          }
          const u8 = new Uint8Array(body.audio.length);
          for (let i = 0; i < body.audio.length; i++) u8[i] = Number(body.audio[i]) & 255;
          audioU8 = u8;
        } else {
          return json(400, { error: "Missing audio (audio_b64 or audio[])" }, corsHeaders(origin, request));
        }
      } else {
        const buf = await request.arrayBuffer().catch(() => null);
        if (!buf || buf.byteLength < 16) return json(400, { error: "Empty audio" }, corsHeaders(origin, request));
        if (buf.byteLength > MAX_AUDIO_BYTES) {
          return json(413, { error: "Audio too large" }, corsHeaders(origin, request));
        }
        audioU8 = new Uint8Array(buf);
      }

      let sttOut;
      try {
        sttOut = await runWhisper(env, audioU8);
      } catch (e) {
        return json(502, { error: "Whisper unavailable", detail: String(e?.message || e) }, corsHeaders(origin, request));
      }

      const transcript = safeTextOnly(sttOut?.text || sttOut?.result?.text || sttOut?.response?.text || "");
      if (!transcript) {
        return json(400, { error: "No transcription produced" }, corsHeaders(origin, request));
      }

      const langIso2 = detectLangIso2_EN_ES(transcript);

      const extra = corsHeaders(origin, request);
      extra.set("x-chattia-stt-iso2", langIso2);
      extra.set("x-chattia-voice-timeout-sec", "120");

      if (mode === "stt") {
        return json(200, { transcript, lang_iso2: langIso2, voice_timeout_sec: 120 }, extra);
      }

      const messages = priorMessages.length
        ? [...priorMessages, { role: "user", content: transcript }]
        : [{ role: "user", content: transcript }];

      // Guard before sending to Brain
      let guardRes;
      try {
        guardRes = await env.AI.run(MODEL_GUARD, { messages });
      } catch {
        return json(502, { error: "Safety check unavailable" }, extra);
      }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) {
        return json(403, { error: "Blocked by safety filter", categories: verdict.categories }, extra);
      }

      meta.lang_iso2 = langIso2;

      let brainResp;
      try {
        brainResp = await callBrain(env, { messages, meta });
      } catch (e) {
        return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, extra);
      }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, extra);
      }

      return sse(brainResp.body, extra);
    }
  },
};
