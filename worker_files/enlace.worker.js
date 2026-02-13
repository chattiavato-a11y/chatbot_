/**
 * enlace — FIXED (aligned to Brain) (no vars, no secrets)
 * + ASSET-ID ENFORCED (Origin -> AssetID)
 * + Clean/scan/sanitize BEFORE Guard + Brain
 * + Guard at Enlace
 * + Forward Brain headers
 * + Convert Brain streaming (raw JSON OR SSE) -> SSE text deltas (UI-friendly)
 *
 * IMPORTANT FIX:
 * - SSE framing uses "data:" (NO space) and preserves leading spaces in deltas.
 * - Also applies a zero-width non-whitespace prefix when a delta line starts with a space,
 *   so even if UI mistakenly .trim()'s per chunk, the space won't be eaten.
 *
 * UPDATE:
 * - Multi-language detection now matches Brain (heuristics + optional model fallback).
 * - Whisper STT (runWhisper) unchanged, shared pattern.
 *
 * UPDATE (EDGE ENFORCEMENT):
 * - If Brain ever outputs "Author: Gabriel Anangono" or "Gabriel Anangono",
 *   Enlace will STRIP it unless the user explicitly asked who created/authored/built it.
 */

// -------------------------
// Allowed Origins + Asset IDs (Origin -> AssetID)
// -------------------------
const ORIGIN_ASSET_ID = new Map([
  ["https://www.chattia.io", "asset_01J7Y2D4XABCD3EFGHJKMNPRTB"],
  ["https://chattia.io", "asset_01J7Y2D4XABCD3EFGHJKMNPRTC"],
  ["https://chattiavato-a11y.github.io", "asset_01J7Y2D4XABCD3EFGHJKMNPRTD"],
]);
const ALLOWED_ORIGINS = new Set(Array.from(ORIGIN_ASSET_ID.keys()));

// Internal hop header (NOT a secret; just a guardrail)
const HOP_HDR = "x-chattia-hop";
const HOP_VAL = "enlace";

// -------------------------
// Models (ENLACE)
// -------------------------
const MODEL_GUARD = "@cf/meta/llama-guard-3-8b";
const MODEL_STT   = "@cf/openai/whisper-large-v3-turbo";
const TTS_EN      = "@cf/deepgram/aura-2-en";
const TTS_ES      = "@cf/deepgram/aura-2-es";
const TTS_FALLBACK= "@cf/myshell-ai/melotts";

const MODEL_CHAT_FAST = "@cf/meta/llama-3.2-3b-instruct"; // used only for language-classifier fallback
const MODEL_CHAT_FALLBACK = "@cf/google/gemma-3-12b-it";
const MODEL_CHAT_SPANISH_QUALITY = "@cf/meta/llama-3.1-70b-instruct";

// optional (only used if you call them via meta flags)
const MODEL_TRANSLATE = "@cf/meta/m2m100-1.2b";
const MODEL_EMBED = "@cf/baai/bge-m3";

// -------------------------
// Limits (ENLACE)
// -------------------------
const MAX_BODY_CHARS = 8_000;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

// -------------------------
// Security headers
// -------------------------
function securityHeaders() {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Cache-Control", "no-store, no-transform");
  h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  h.set("X-Permitted-Cross-Domain-Policies", "none");
  h.set("X-DNS-Prefetch-Control", "off");
  return h;
}

// -------------------------
// CORS
// -------------------------
function isAllowedOrigin(origin) {
  return !!origin && origin !== "null" && ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(origin) {
  const h = new Headers();

  if (isAllowedOrigin(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }

  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
    [
      "x-chattia-stt-iso2",
      "x-chattia-voice-timeout-sec",
      "x-chattia-tts-iso2",
      "x-chattia-lang-iso2",
      "x-chattia-model",
      "x-chattia-translated",
      "x-chattia-embeddings",
      "x-chattia-asset-verified",
    ].join(", ")
  );

  h.set("Access-Control-Max-Age", "86400");
  return h;
}

// -------------------------
// Response helpers
// -------------------------
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

// -------------------------
// Clean / scan / sanitize
// -------------------------
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

function stripDangerousMarkup(text) {
  let t = String(text || "");
  t = t.replace(/\u0000/g, "");
  t = t.replace(/\r\n?/g, "\n");

  // Remove script/style blocks
  t = t.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");

  // Remove high-risk tags
  t = t.replace(/<\s*(iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, "");
  t = t.replace(/<\s*\/\s*(iframe|object|embed|link|meta|base|form)\s*>/gi, "");

  // Remove dangerous schemes
  t = t.replace(/\bjavascript\s*:/gi, "");
  t = t.replace(/\bvbscript\s*:/gi, "");
  t = t.replace(/\bdata\s*:\s*text\/html\b/gi, "");

  // Remove inline handlers (best-effort)
  t = t.replace(/\bon\w+\s*=\s*["'][\s\S]*?["']/gi, "");
  t = t.replace(/\bon\w+\s*=\s*[^\s>]+/gi, "");

  if (t.length > MAX_MESSAGE_CHARS) t = t.slice(0, MAX_MESSAGE_CHARS);
  return t.trim();
}

function looksMalicious(text) {
  const t = String(text || "").toLowerCase();
  const bad = [
    "<script",
    "document.cookie",
    "localstorage.",
    "sessionstorage.",
    "onerror=",
    "onload=",
    "eval(",
    "new function",
    "javascript:",
    "vbscript:",
    "data:text/html",
    "base64,",
  ];
  for (const p of bad) if (t.includes(p)) return true;
  return false;
}

function sanitizeContent(text) {
  const cleaned = stripDangerousMarkup(safeTextOnly(text));
  return safeTextOnly(cleaned);
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;

    let content = typeof m.content === "string" ? m.content : "";
    content = sanitizeContent(content);
    if (!content) continue;

    if (content.length > MAX_MESSAGE_CHARS) content = content.slice(0, MAX_MESSAGE_CHARS);

    if (looksMalicious(content)) {
      out.push({ role, content: "[REDACTED: blocked suspicious content]" });
      continue;
    }

    out.push({ role, content });
  }
  return out;
}

function lastUserText(messages) {
  return [...messages].reverse().find((m) => m.role === "user")?.content || "";
}

// -------------------------
// EDGE ENFORCEMENT: Author mention gating
// -------------------------
function userExplicitlyAskedAuthor(messages) {
  const q = (Array.isArray(messages) ? messages : [])
    .filter((m) => String(m?.role || "").toLowerCase() === "user")
    .map((m) => String(m?.content || ""))
    .join("\n")
    .toLowerCase();

  if (!q) return false;

  // Explicit author/creator intent (multi-language, light)
  const intent =
    /\b(author|creator|created by|built by|made by|who made|who created|who built|who authored)\b/.test(q) ||
    /\b(autor|creador|creado por|hecho por|quien hizo|quién hizo|quien creo|quién creó|quien creó)\b/.test(q) ||
    /\b(auteur|créateur|cree par|créé par|qui a créé)\b/.test(q) ||
    /\b(autore|creatore|creato da|chi ha creato)\b/.test(q) ||
    /\b(autor|criador|criado por|feito por|quem criou)\b/.test(q) ||
    /\b(autor|erstellt von|wer hat|entwickelt von)\b/.test(q);

  // Or explicitly referencing the name + a question vibe
  const namePlusQuestion =
    /\bgabriel\s+anangono\b/.test(q) && /\b(who|quien|quién|autor|author|creator|creador|created|built|hizo|creó|creo)\b/.test(q);

  return intent || namePlusQuestion;
}

function stripAuthorIfNotAsked(text, allow) {
  if (allow) return String(text ?? "");
  let t = String(text ?? "");

  // Remove ONLY this attribution (do not rewrite other content)
  t = t.replace(/\bAuthor:\s*Gabriel\s+Anangono\.?\b/gi, "");
  t = t.replace(/\bGabriel\s+Anangono\b/gi, "");

  return t;
}

// -------------------------
// Language (multi-language) — aligned to Brain
// -------------------------
function normalizeIso2(code) {
  const s = safeTextOnly(code || "").toLowerCase();
  if (!s) return "";
  const two = s.includes("-") ? s.split("-")[0] : s;
  return (two || "").slice(0, 2);
}

function hasRange(text, a, b) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= a && c <= b) return true;
  }
  return false;
}

function detectLangIso2Heuristic(text) {
  const t0 = String(text || "");
  if (!t0) return "";

  // Script-based quick wins
  if (hasRange(t0, 0x3040, 0x30ff)) return "ja"; // Hiragana/Katakana
  if (hasRange(t0, 0xac00, 0xd7af)) return "ko"; // Hangul
  if (hasRange(t0, 0x4e00, 0x9fff)) return "zh"; // CJK
  if (hasRange(t0, 0x0400, 0x04ff)) return "ru"; // Cyrillic
  if (hasRange(t0, 0x0600, 0x06ff)) return "ar"; // Arabic
  if (hasRange(t0, 0x0590, 0x05ff)) return "he"; // Hebrew
  if (hasRange(t0, 0x0370, 0x03ff)) return "el"; // Greek
  if (hasRange(t0, 0x0900, 0x097f)) return "hi"; // Devanagari
  if (hasRange(t0, 0x0e00, 0x0e7f)) return "th"; // Thai

  const t = t0.toLowerCase();

  // Spanish
  if (/[ñáéíóúü¿¡]/i.test(t)) return "es";
  const esHits = [
    "hola","gracias","por favor","buenos","buenas","necesito","ayuda","quiero","donde","qué","cuánto","porque"
  ].filter((w) => t.includes(w)).length;
  if (esHits >= 2) return "es";

  // Portuguese
  if (/[ãõç]/i.test(t)) return "pt";
  const ptHits = ["olá","ola","obrigado","obrigada","por favor","você","vocês","não","nao","tudo bem"].filter((w) => t.includes(w)).length;
  if (ptHits >= 2) return "pt";

  // French
  const frHits = ["bonjour","salut","merci","s'il","s’il","vous","au revoir","ça va","comment","aujourd"].filter((w) => t.includes(w)).length;
  if (frHits >= 2 || /[àâçéèêëîïôûùüÿœ]/i.test(t)) return "fr";

  // German
  if (/[äöüß]/i.test(t)) return "de";
  const deHits = ["hallo","danke","bitte","und","ich","nicht","wie geht","heute"].filter((w) => t.includes(w)).length;
  if (deHits >= 2) return "de";

  // Italian
  const itHits = ["ciao","grazie","per favore","come va","oggi","buongiorno","buonasera"].filter((w) => t.includes(w)).length;
  if (itHits >= 2) return "it";

  // Indonesian
  const idHits = ["halo","terima kasih","tolong","selamat","bagaimana","hari ini"].filter((w) => t.includes(w)).length;
  if (idHits >= 2) return "id";

  return "";
}

async function detectLangIso2ViaModel(env, text) {
  // Uses MODEL_CHAT_FAST to classify language when heuristics fail.
  const sample = sanitizeContent(String(text || "")).slice(0, 240);
  if (sample.length < 8) return "und";

  try {
    const out = await env.AI.run(MODEL_CHAT_FAST, {
      stream: false,
      max_tokens: 6,
      messages: [
        { role: "system", content: "Return ONLY the ISO 639-1 language code (two letters). If unsure, return 'und'. No extra text." },
        { role: "user", content: `Text:\n${sample}` },
      ],
    });

    const raw = String(out?.response || out?.result?.response || out?.text || out || "").trim().toLowerCase();
    const m = raw.match(/\b([a-z]{2}|und)\b/);
    return m ? m[1] : "und";
  } catch {
    return "und";
  }
}

async function detectLangIso2(env, messages, metaSafe) {
  // 1) explicit meta wins (if provided)
  const metaLang = normalizeIso2(metaSafe?.lang_iso2 || "");
  if (metaLang && metaLang !== "und" && metaLang !== "auto") return metaLang;

  // 2) heuristic
  const lastUser = lastUserText(messages);
  const heur = detectLangIso2Heuristic(lastUser);
  if (heur) return heur;

  // 3) model classifier fallback
  const modelGuess = await detectLangIso2ViaModel(env, lastUser);
  if (modelGuess && modelGuess !== "und") return modelGuess;

  return "und";
}

// -------------------------
// Guard parsing + meta sanitize
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

function sanitizeMeta(metaIn) {
  const meta = (metaIn && typeof metaIn === "object") ? metaIn : {};
  const out = {};

  const lang = normalizeIso2(meta.lang_iso2 || "");
  const spanishQuality = safeTextOnly(meta.spanish_quality || "");
  const model = safeTextOnly(meta.model || "");
  const translateTo = normalizeIso2(meta.translate_to || "");

  if (lang) out.lang_iso2 = lang;
  if (spanishQuality) out.spanish_quality = spanishQuality;
  if (model) out.model = model;
  if (translateTo) out.translate_to = translateTo;

  if (typeof meta.want_embeddings === "boolean") out.want_embeddings = meta.want_embeddings;

  return out;
}

// -------------------------
// Asset identity enforcement
// -------------------------
function expectedAssetIdForOrigin(origin) {
  return ORIGIN_ASSET_ID.get(origin) || "";
}

function verifyAssetIdentity(origin, request) {
  const got = safeTextOnly(request.headers.get("x-ops-asset-id") || "");
  const expected = expectedAssetIdForOrigin(origin);
  return { ok: !!expected && got === expected, got, expected };
}

// -------------------------
// Voice helpers (Whisper STT) — shared pattern
// -------------------------
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

// -------------------------
// Brain call
// -------------------------
async function callBrain(env, payload) {
  if (!env?.brain || typeof env.brain.fetch !== "function") throw new Error("Missing Service Binding: env.brain");
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

function forwardBrainHeaders(outHeaders, brainResp) {
  const pass = ["x-chattia-lang-iso2", "x-chattia-model", "x-chattia-translated", "x-chattia-embeddings"];
  for (const k of pass) {
    const v = brainResp.headers.get(k);
    if (v) outHeaders.set(k, v);
  }
}

// -------------------------
// FIX: Brain stream -> SSE text deltas
// -------------------------
function protectLeadingSpace(s) {
  // If UI incorrectly does .trim() per chunk, this prevents loss of leading spaces.
  // \u200B is NOT whitespace for trim(), but is invisible.
  if (!s) return s;
  const c0 = s[0];
  if (c0 === " " || c0 === "\t") return "\u200B" + s;
  return s;
}

function sseDataFrame(text) {
  // IMPORTANT: "data:" (NO trailing space) to preserve leading spaces from model deltas.
  const s = String(text ?? "");
  const lines = s.split("\n");
  let out = "";
  for (const line of lines) out += "data:" + protectLeadingSpace(line) + "\n";
  out += "\n";
  return out;
}

function extractJsonObjectsFromBuffer(buffer) {
  // Balanced-brace extractor (handles strings + escapes) for raw concatenated JSON objects.
  const out = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];

    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
        inStr = false;
        esc = false;
      }
      continue;
    }

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
      esc = true;
    } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      const jsonStr = buffer.slice(start, i + 1);
      out.push(jsonStr);
      start = -1;
    }
  }

  const rest = (start === -1) ? "" : buffer.slice(start);
  return { chunks: out, rest };
}

function extractSSEBlocks(buffer) {
  // Pull complete SSE event blocks separated by \n\n
  const blocks = [];
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    blocks.push(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 2);
  }
  return { blocks, rest: buffer };
}

function parseSSEBlockToData(block) {
  // Returns {event, data} where data is joined multi-line data.
  const lines = String(block || "").split("\n");
  let evt = "";
  const dataLines = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("event:")) {
      evt = line.slice(6); // keep possible leading spaces after "event:"
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5)); // DO NOT trim
      continue;
    }
  }

  return { event: evt, data: dataLines.join("\n") };
}

function getDeltaFromObj(obj) {
  // Workers AI token chunks commonly: { response: "..." } (sometimes nested)
  if (!obj) return "";
  if (typeof obj.response === "string") return obj.response;

  // some shapes can be nested
  if (obj.result && typeof obj.result.response === "string") return obj.result.response;
  if (obj.response && obj.response.response && typeof obj.response.response === "string") return obj.response.response;

  return "";
}

// UPDATED SIGNATURE: allowAuthor
function bridgeBrainToSSE(brainBody, allowAuthor) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  if (!brainBody) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseDataFrame("")));
        controller.close();
      },
    });
  }

  return new ReadableStream({
    async start(controller) {
      const reader = brainBody.getReader();
      let buf = "";

      try {
        // hello comment (keeps some proxies happy)
        controller.enqueue(encoder.encode(": ok\n\n"));

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });

          // 1) If it looks like SSE from Brain, parse SSE blocks first
          const looksLikeSSE = /(^|\n)data:/.test(buf) && buf.includes("\n\n");
          if (looksLikeSSE) {
            const { blocks, rest } = extractSSEBlocks(buf);
            buf = rest;

            for (const block of blocks) {
              const { data } = parseSSEBlockToData(block);
              if (!data) continue;

              const dataTrim = data.trim();
              if (dataTrim === "[DONE]") {
                controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
                controller.close();
                return;
              }

              // data may be JSON or plain text
              const d0 = dataTrim[0];
              if (d0 === "{" || d0 === "[") {
                try {
                  const obj = JSON.parse(dataTrim);
                  const delta = getDeltaFromObj(obj);
                  const safeDelta = stripAuthorIfNotAsked(delta, allowAuthor);
                  if (safeDelta) controller.enqueue(encoder.encode(sseDataFrame(safeDelta)));
                } catch {
                  const safeData = stripAuthorIfNotAsked(data, allowAuthor);
                  if (safeData) controller.enqueue(encoder.encode(sseDataFrame(safeData)));
                }
              } else {
                const safeData = stripAuthorIfNotAsked(data, allowAuthor);
                if (safeData) controller.enqueue(encoder.encode(sseDataFrame(safeData)));
              }
            }

            continue;
          }

          // 2) Otherwise parse raw concatenated JSON objects
          if (buf.length > 1_000_000 && !buf.includes("{")) buf = buf.slice(-100_000);

          const { chunks, rest } = extractJsonObjectsFromBuffer(buf);
          buf = rest;

          for (const s of chunks) {
            let obj;
            try { obj = JSON.parse(s); } catch { continue; }

            const delta = getDeltaFromObj(obj);
            const safeDelta = stripAuthorIfNotAsked(delta, allowAuthor);
            if (safeDelta) controller.enqueue(encoder.encode(sseDataFrame(safeDelta)));
          }
        }

        // flush any remaining decode tail
        const tail = decoder.decode();
        if (tail) buf += tail;

        controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
      } catch {
        controller.enqueue(encoder.encode("event: error\ndata: stream_error\n\n"));
      } finally {
        try { reader.releaseLock(); } catch {}
        try { controller.close(); } catch {}
      }
    },
  });
}

// -------------------------
// TTS
// -------------------------
async function ttsAny(env, text, langIso2) {
  const iso2 = normalizeIso2(langIso2 || "en") || "en";
  const preferred = iso2 === "es" ? TTS_ES : TTS_EN;

  try {
    const raw = await env.AI.run(
      preferred,
      { text, encoding: "mp3", container: "none" },
      { returnRawResponse: true }
    );
    const ct = raw?.headers?.get?.("content-type") || "";
    if (raw?.body && ct.toLowerCase().includes("audio")) return { body: raw.body, ct };
  } catch {}

  try {
    const out = await env.AI.run(preferred, { text, encoding: "mp3", container: "none" });
    const b64 = out?.audio || out?.result?.audio || out?.response?.audio || "";
    if (typeof b64 === "string" && b64.length > 16) return { body: base64ToBytes(b64), ct: "audio/mpeg" };
  } catch {}

  const out2 = await env.AI.run(TTS_FALLBACK, { prompt: text, lang: iso2 });
  const b64 = out2?.audio || out2?.result?.audio || "";
  if (typeof b64 === "string" && b64.length > 16) return { body: base64ToBytes(b64), ct: "audio/mpeg" };

  throw new Error("TTS failed");
}

// -------------------------
// Usage JSON for GET
// -------------------------
function usage(path) {
  if (path === "/api/chat") {
    return {
      ok: true,
      route: "/api/chat",
      method: "POST",
      required_headers: ["content-type", "accept", "x-ops-asset-id"],
      body_json: { messages: [{ role: "user", content: "Hello" }], meta: {} },
      allowed_origins: Array.from(ALLOWED_ORIGINS),
    };
  }
  if (path === "/api/tts") {
    return {
      ok: true,
      route: "/api/tts",
      method: "POST",
      required_headers: ["content-type", "accept", "x-ops-asset-id"],
      body_json: { text: "Hello", lang_iso2: "en" },
      allowed_origins: Array.from(ALLOWED_ORIGINS),
    };
  }
  if (path === "/api/voice") {
    return {
      ok: true,
      route: "/api/voice?mode=stt | /api/voice?mode=chat",
      method: "POST",
      required_headers: ["accept", "x-ops-asset-id"],
      body_binary: "audio/webm (or wav/mp3/etc)",
      allowed_origins: Array.from(ALLOWED_ORIGINS),
    };
  }
  return { ok: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    const isChat  = url.pathname === "/api/chat";
    const isVoice = url.pathname === "/api/voice";
    const isTts   = url.pathname === "/api/tts";

    // Preflight
    if (request.method === "OPTIONS") {
      const h = corsHeaders(origin);
      securityHeaders().forEach((v, k) => h.set(k, v));
      return new Response(null, { status: 204, headers: h });
    }

    // Health
    if (url.pathname === "/" || url.pathname === "/health") {
      const h = corsHeaders(origin);
      securityHeaders().forEach((v, k) => h.set(k, v));
      return new Response("enlace: ok", { status: 200, headers: h });
    }

    // Helpful GET usage
    if (request.method === "GET" && (isChat || isVoice || isTts)) {
      const extra = corsHeaders(origin);
      return json(200, usage(url.pathname), extra);
    }

    // Only these routes exist
    if (!isChat && !isVoice && !isTts) {
      return json(404, { error: "Not found" }, corsHeaders(origin));
    }

    // POST only for real work
    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" }, corsHeaders(origin));
    }

    // Strict CORS for POST
    if (!isAllowedOrigin(origin)) {
      return json(
        403,
        { error: "Origin not allowed", saw_origin: origin || "(none)", allowed: Array.from(ALLOWED_ORIGINS) },
        corsHeaders(origin)
      );
    }

    // Must have AI
    if (!env?.AI || typeof env.AI.run !== "function") {
      return json(500, { error: "Missing AI binding (env.AI)" }, corsHeaders(origin));
    }

    // Enforce asset identity (Origin -> expected asset id)
    const assetCheck = verifyAssetIdentity(origin, request);
    if (!assetCheck.ok) {
      return json(
        403,
        {
          error: "Invalid asset identity",
          detail: "x-ops-asset-id must match the calling Origin.",
          origin,
          got_asset_id: assetCheck.got || "(none)",
          expected_asset_id: assetCheck.expected || "(missing mapping)",
        },
        corsHeaders(origin)
      );
    }

    // Base response headers for successful paths
    const baseExtra = corsHeaders(origin);
    baseExtra.set("x-chattia-asset-verified", "1");

    // -----------------------
    // /api/chat -> Guard -> Brain -> SSE (TEXT DELTAS)
    // -----------------------
    if (isChat) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) return json(415, { error: "content-type must be application/json" }, baseExtra);

      const raw = await request.text().catch(() => "");
      if (!raw || raw.length > MAX_BODY_CHARS) return json(413, { error: "Request too large" }, baseExtra);

      let body;
      try { body = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }, baseExtra); }

      const messages = normalizeMessages(body.messages);
      if (!messages.length) return json(400, { error: "messages[] required" }, baseExtra);

      // EDGE: allow author only if explicitly asked
      const allowAuthor = userExplicitlyAskedAuthor(messages);

      const metaSafe = sanitizeMeta(body.meta);

      // Detect language (multi-language) — aligned to Brain
      const langIso2 = await detectLangIso2(env, messages, metaSafe);
      if (!metaSafe.lang_iso2 || metaSafe.lang_iso2 === "auto" || metaSafe.lang_iso2 === "und") {
        metaSafe.lang_iso2 = langIso2;
      }

      // Guard at edge
      let guardRes;
      try { guardRes = await env.AI.run(MODEL_GUARD, { messages }); }
      catch { return json(502, { error: "Safety check unavailable" }, baseExtra); }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return json(403, { error: "Blocked by safety filter", categories: verdict.categories }, baseExtra);

      // Call Brain
      let brainResp;
      try { brainResp = await callBrain(env, { messages, meta: metaSafe }); }
      catch (e) { return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, baseExtra); }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, baseExtra);
      }

      const extra = new Headers(baseExtra);
      forwardBrainHeaders(extra, brainResp);

      return sse(bridgeBrainToSSE(brainResp.body, allowAuthor), extra);
    }

    // -----------------------
    // /api/tts -> audio
    // -----------------------
    if (isTts) {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) return json(415, { error: "content-type must be application/json" }, baseExtra);

      const raw = await request.text().catch(() => "");
      if (!raw || raw.length > MAX_BODY_CHARS) return json(413, { error: "Request too large" }, baseExtra);

      let body;
      try { body = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }, baseExtra); }

      const text = sanitizeContent(body?.text || "");
      if (!text) return json(400, { error: "text required" }, baseExtra);
      if (looksMalicious(text)) return json(403, { error: "Blocked by security sanitizer" }, baseExtra);

      const langIso2 = normalizeIso2(body?.lang_iso2 || "en") || "en";

      const extra = new Headers(baseExtra);
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
    // /api/voice -> STT JSON (mode=stt) OR Guard -> Brain -> SSE (TEXT DELTAS)
    // -----------------------
    if (isVoice) {
      const mode = String(url.searchParams.get("mode") || "stt").toLowerCase();
      const ct = (request.headers.get("content-type") || "").toLowerCase();

      let audioU8 = null;
      let priorMessages = [];
      let metaSafe = {};

      if (ct.includes("application/json")) {
        const raw = await request.text().catch(() => "");
        if (!raw || raw.length > MAX_BODY_CHARS) return json(413, { error: "Request too large" }, baseExtra);

        let body;
        try { body = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }, baseExtra); }

        priorMessages = normalizeMessages(body.messages);
        metaSafe = sanitizeMeta(body.meta);

        if (typeof body.audio_b64 === "string" && body.audio_b64.length) {
          const bytes = base64ToBytes(body.audio_b64);
          if (bytes.byteLength > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, baseExtra);
          audioU8 = bytes;
        } else if (Array.isArray(body.audio) && body.audio.length) {
          if (body.audio.length > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, baseExtra);
          const u8 = new Uint8Array(body.audio.length);
          for (let i = 0; i < body.audio.length; i++) u8[i] = Number(body.audio[i]) & 255;
          audioU8 = u8;
        } else {
          return json(400, { error: "Missing audio (audio_b64 or audio[])" }, baseExtra);
        }
      } else {
        const buf = await request.arrayBuffer().catch(() => null);
        if (!buf || buf.byteLength < 16) return json(400, { error: "Empty audio" }, baseExtra);
        if (buf.byteLength > MAX_AUDIO_BYTES) return json(413, { error: "Audio too large" }, baseExtra);
        audioU8 = new Uint8Array(buf);
      }

      // Whisper STT
      let sttOut;
      try { sttOut = await runWhisper(env, audioU8); }
      catch (e) { return json(502, { error: "Whisper unavailable", detail: String(e?.message || e) }, baseExtra); }

      const transcriptRaw = sttOut?.text || sttOut?.result?.text || sttOut?.response?.text || "";
      const transcript = sanitizeContent(transcriptRaw);
      if (!transcript) return json(400, { error: "No transcription produced" }, baseExtra);
      if (looksMalicious(transcript)) return json(403, { error: "Blocked by security sanitizer" }, baseExtra);

      // Detect STT language (multi-language) — aligned to Brain
      const langIso2 = await detectLangIso2(env, [{ role: "user", content: transcript }], metaSafe);

      const extra = new Headers(baseExtra);
      extra.set("x-chattia-stt-iso2", langIso2 || "und");
      extra.set("x-chattia-voice-timeout-sec", "120");

      if (mode === "stt") {
        return json(200, { transcript, lang_iso2: langIso2 || "und", voice_timeout_sec: 120 }, extra);
      }

      const messages = priorMessages.length
        ? [...priorMessages, { role: "user", content: transcript }]
        : [{ role: "user", content: transcript }];

      // EDGE: allow author only if explicitly asked (includes transcript now)
      const allowAuthor = userExplicitlyAskedAuthor(messages);

      if (!metaSafe.lang_iso2 || metaSafe.lang_iso2 === "auto" || metaSafe.lang_iso2 === "und") {
        metaSafe.lang_iso2 = langIso2 || "und";
      }

      // Guard at edge
      let guardRes;
      try { guardRes = await env.AI.run(MODEL_GUARD, { messages }); }
      catch { return json(502, { error: "Safety check unavailable" }, extra); }

      const verdict = parseGuardResult(guardRes);
      if (!verdict.safe) return json(403, { error: "Blocked by safety filter", categories: verdict.categories }, extra);

      // Call Brain
      let brainResp;
      try { brainResp = await callBrain(env, { messages, meta: metaSafe }); }
      catch (e) { return json(502, { error: "Brain unreachable", detail: String(e?.message || e) }, extra); }

      if (!brainResp.ok) {
        const t = await brainResp.text().catch(() => "");
        return json(502, { error: "Brain error", status: brainResp.status, detail: t.slice(0, 2000) }, extra);
      }

      forwardBrainHeaders(extra, brainResp);
      return sse(bridgeBrainToSSE(brainResp.body, allowAuthor), extra);
    }

    return json(500, { error: "Unhandled route" }, baseExtra);
  },
};
