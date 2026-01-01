/**
 * OPS ONLINE ASSISTANT — BRAIN (v2)
 *
 * Called ONLY by ops-gateway via Service Binding (env.BRAIN.fetch).
 *
 * Upgrades vs v1:
 * - Verifies Gateway HMAC signature: X-Ops-Ts + X-Ops-Sig
 * - Anti-replay window (timestamp freshness)
 * - No public CORS (browser cannot call this directly)
 * - JSON-only for /api/ops-online-chat and /api/transcribe (simple + secure)
 *
 * Signature rule (must match Gateway v2):
 *   sig = HMAC_SHA256_HEX(HAND_SHAKE, `${ts}.${bodyText}`)
 */

const CHAT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WHISPER_MODEL_ID = "@cf/openai/whisper";

const MAX_BODY_BYTES = 16_384; // brain can allow a bit more than gateway
const MAX_MSG_CHARS = 256;

// +/- 2 minutes time window for anti-replay
const SIG_MAX_SKEW_MS = 120_000;

const SYSTEM_PROMPT_EN = `
You are OPS Online Assistant, the friendly and professional helper for the OPS Remote Professional Network.
I’m here to assist you with everything related to OPS services, our business operations, contact center solutions, IT support, and professionals-on-demand.
always answer in short, clear sentences and small paragraphs so the information is easy to read and pleasant to listen to with text-to-speech.
keep replies concise and under roughly 1300 tokens; trim any extra detail that is not essential to the user’s request.
use simple plain text without bullet lists, bold, headings, emojis, or extra symbols.
`.trim();

const SYSTEM_PROMPT_ES = `
Eres OPS Online Assistant, un asistente amable y profesional para la Red de Profesionales Remotos de OPS.
Te ayudo con todo lo relacionado con los servicios de OPS, nuestras operaciones de negocio, soluciones de contact center, soporte de TI y profesionales bajo demanda.
responde siempre en español con frases cortas y párrafos pequeños para que sean fáciles de leer y agradables de escuchar con texto a voz.
mantén las respuestas concisas y por debajo de unas 1300 tokens; elimina detalles que no sean esenciales para la petición del usuario.
usa texto simple sin listas con viñetas, negritas, encabezados, emojis ni símbolos extra.
`.trim();

function systemPromptForLang(lang) {
  return lang === "es" ? SYSTEM_PROMPT_ES : SYSTEM_PROMPT_EN;
}

/* -------------------- Response helpers -------------------- */

function securityHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "strict-transport-security": "max-age=31536000; includeSubDomains"
  };
}

function json(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: securityHeaders()
  });
}

/* -------------------- Body helpers -------------------- */

async function readBodyLimitedText(request) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len && len > MAX_BODY_BYTES) return null;

  const ab = await request.arrayBuffer();
  if (ab.byteLength === 0 || ab.byteLength > MAX_BODY_BYTES) return null;

  return new TextDecoder().decode(ab);
}

function normalizeUserText(s) {
  let out = String(s || "");
  out = out.replace(/[\u0000-\u001F\u007F]/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_MSG_CHARS) out = out.slice(0, MAX_MSG_CHARS);
  return out;
}

function base64ToBytes(b64) {
  const clean = String(b64 || "").replace(/^data:audio\/[\w.+-]+;base64,/, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* -------------------- HMAC verify (Gateway -> Brain) -------------------- */

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return out === 0;
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

async function verifyGatewayHmac(request, env, bodyText) {
  const secret = (env.HAND_SHAKE || "").toString();
  if (!secret) {
    return {
      ok: false,
      status: 500,
      code: "NO_HAND_SHAKE",
      publicMsg: "Assistant configuration error.",
      opsMsg: "Missing HAND_SHAKE in brain env."
    };
  }

  const ts = request.headers.get("X-Ops-Ts") || "";
  const sig = request.headers.get("X-Ops-Sig") || "";

  if (!ts || !sig) {
    return {
      ok: false,
      status: 401,
      code: "MISSING_SIG",
      publicMsg: "Unauthorized request.",
      opsMsg: "Missing X-Ops-Ts or X-Ops-Sig."
    };
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return {
      ok: false,
      status: 401,
      code: "BAD_TS",
      publicMsg: "Unauthorized request.",
      opsMsg: "Invalid timestamp."
    };
  }

  const now = Date.now();
  const skew = Math.abs(now - tsNum);
  if (skew > SIG_MAX_SKEW_MS) {
    return {
      ok: false,
      status: 401,
      code: "STALE_TS",
      publicMsg: "Unauthorized request.",
      opsMsg: `Timestamp outside allowed window. skew_ms=${skew}`
    };
  }

  const msg = `${ts}.${bodyText || ""}`;
  const expected = await hmacSha256Hex(secret, msg);

  if (!timingSafeEqualHex(sig, expected)) {
    return {
      ok: false,
      status: 401,
      code: "BAD_SIG",
      publicMsg: "Unauthorized request.",
      opsMsg: "Signature mismatch."
    };
  }

  return { ok: true };
}

/* -------------------- Handlers -------------------- */

async function handleOpsOnlineChat(request, env) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    return json(415, { error: "JSON only." });
  }

  const bodyText = await readBodyLimitedText(request);
  if (!bodyText) {
    return json(413, { error: "Request too large or empty." });
  }

  const verify = await verifyGatewayHmac(request, env, bodyText);
  if (!verify.ok) {
    console.error("Gateway verification failed:", verify.opsMsg);
    return json(verify.status, {
      public_error: verify.publicMsg,
      error_layer: "L7",
      error_code: verify.code
    });
  }

  let payload = {};
  try { payload = JSON.parse(bodyText); } catch { payload = {}; }

  const lang = payload.lang === "es" ? "es" : "en";
  const message = normalizeUserText(typeof payload.message === "string" ? payload.message : "");
  const history = Array.isArray(payload.history) ? payload.history : [];

  if (!message) {
    return json(400, {
      error: lang === "es" ? "No se proporcionó ningún mensaje." : "No message provided.",
      lang
    });
  }

  const messages = [{ role: "system", content: systemPromptForLang(lang) }];

  for (const item of history) {
    if (!item || !item.content) continue;
    messages.push({
      role: item.role === "assistant" ? "assistant" : "user",
      content: normalizeUserText(String(item.content))
    });
  }

  messages.push({ role: "user", content: message });

  try {
    const aiResult = await env.AI.run(CHAT_MODEL_ID, {
      messages,
      max_tokens: 1548
    });

    const reply =
      aiResult?.response
        ? String(aiResult.response)
        : (lang === "es" ? "Aún no tengo una respuesta para eso." : "I’m not sure how to answer that yet.");

    return json(200, { reply, lang });
  } catch (err) {
    console.error("Error in /api/ops-online-chat:", err);
    return json(500, { error: "Failed to process Ops Online Assistant request" });
  }
}

async function handleWhisperTranscription(request, env) {
  // Secure + simple: JSON only (audio_base64 or audio array)
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    return json(415, { error: "JSON only." });
  }

  const bodyText = await readBodyLimitedText(request);
  if (!bodyText) {
    return json(413, { error: "Request too large or empty." });
  }

  const verify = await verifyGatewayHmac(request, env, bodyText);
  if (!verify.ok) {
    console.error("Gateway verification failed:", verify.opsMsg);
    return json(verify.status, {
      public_error: verify.publicMsg,
      error_layer: "L7",
      error_code: verify.code
    });
  }

  let payload = {};
  try { payload = JSON.parse(bodyText); } catch { payload = {}; }

  let audioBytes = null;

  const audioBase64 =
    typeof payload.audio_base64 === "string"
      ? payload.audio_base64
      : typeof payload.audio === "string"
        ? payload.audio
        : "";

  const audioArray = Array.isArray(payload.audio) ? payload.audio : null;

  if (audioBase64) {
    try {
      audioBytes = base64ToBytes(audioBase64);
    } catch (e) {
      console.error("Invalid base64 audio:", e);
      return json(400, { error: "Invalid audio payload" });
    }
  } else if (audioArray) {
    audioBytes = new Uint8Array(audioArray);
  }

  if (!audioBytes || !audioBytes.length) {
    return json(400, { error: "No audio provided" });
  }

  try {
    const aiResult = await env.AI.run(WHISPER_MODEL_ID, { audio: audioBytes });

    const transcript =
      aiResult?.text ||
      aiResult?.transcript ||
      aiResult?.transcription ||
      aiResult?.response ||
      "";

    const responsePayload = { transcript: transcript || "" };
    if (aiResult?.text !== undefined) responsePayload.text = aiResult.text;
    if (aiResult?.word_count !== undefined) responsePayload.word_count = aiResult.word_count;
    if (aiResult?.vtt !== undefined) responsePayload.vtt = aiResult.vtt;

    return json(200, responsePayload);
  } catch (err) {
    console.error("Error in /api/transcribe:", err);
    return json(500, { error: "Failed to transcribe audio" });
  }
}

/* -------------------- Router -------------------- */

export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    const pathname = url.pathname || "/";

    // Health check
    if (pathname === "/ping" || pathname === "/") {
      // If you’re serving ASSETS, prefer those. Otherwise, return a small JSON ping.
      if (env.ASSETS && typeof env.ASSETS.fetch === "function" && pathname !== "/ping") {
        return env.ASSETS.fetch(request);
      }
      return json(200, { ok: true, service: "ops-online-assistant-brain" });
    }

    // NOTE: No CORS preflights here. Browser should NOT call brain directly.
    if (request.method !== "POST") {
      return json(405, { error: "POST only." });
    }

    if (pathname === "/api/ops-online-chat") {
      return handleOpsOnlineChat(request, env);
    }

    if (pathname === "/api/transcribe") {
      return handleWhisperTranscription(request, env);
    }

    return json(404, { error: "Not found." });
  }
};
