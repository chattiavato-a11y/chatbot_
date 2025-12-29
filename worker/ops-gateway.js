/**
 * Cloudflare Worker for ops-gateway.grabem-holdem-nuts-right.workers.dev
 *
 * Flow: GH Pages (UI) -> Gateway (this Worker) -> Brain (service binding: BRAIN)
 *
 * Responsibilities:
 * - Allow CORS only from the GitHub Pages origin.
 * - Accept POST /api/ops-online-chat with X-Ops-Asset-Id header.
 * - Verify Turnstile (TURNSTILE_SECRET).
 * - Honeypot reject (hp_email / hp_website).
 * - Explicitly reject uploads (multipart / form-data / data: / base64-ish blobs).
 * - Validate and sanitize inputs (size, content, suspicious patterns).
 * - Stronger allowlist sanitization: plain text only; reject if mutations occur.
 * - Optionally run AI guard (MY_BRAIN) to reject unsafe text.
 * - Proxy to the assistant service binding (BRAIN) using shared secret handshake.
 * - Return structured JSON with strong security headers and clean 4xx/5xx handling.
 *
 * Required env:
 * - OPS_ASSET_IDS (comma-separated) OR ASSET_ID
 * - HAND_SHAKE
 * - TURNSTILE_SECRET
 * - BRAIN (Service Binding)
 *
 * Optional env:
 * - MY_BRAIN (Workers AI binding for llama-guard)
 */

const ALLOWED_ORIGIN = "https://chattiavato-a11y.github.io";
const MAX_BODY_BYTES = 2048;
const MAX_MSG_CHARS = 256;

const REPO_URL = "https://github.com/chattiavato-a11y/ops-online-support";
const BRAIN_URL =
  "https://ops-online-assistant.grabem-holdem-nuts-right.workers.dev/api/ops-online-chat";

function securityHeaders() {
  return {
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none';",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Permissions-Policy":
      "geolocation=(), microphone=(), camera=(), payment=(), usb=(), bluetooth=(), gyroscope=(), magnetometer=(), accelerometer=()",
    "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex"
  };
}

function corsHeaders(origin) {
  const headers = { Vary: "Origin" };
  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, X-Ops-Asset-Id";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

function json(origin, status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      ...securityHeaders(),
      ...corsHeaders(origin),
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function localizedError(lang, enText, esText) {
  return lang === "es" ? esText : enText;
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
  const badPatterns = [
    "<script", "</script", "javascript:",
    "<img", "onerror", "onload",
    "<iframe", "<object", "<embed",
    "<svg", "<link", "<meta", "<style",
    "document.cookie",
    "onmouseover", "onmouseenter",
    "<form", "<input", "<textarea"
  ];
  return badPatterns.some((p) => t.includes(p));
}

async function readBodyLimited(request) {
  const ab = await request.arrayBuffer();
  if (ab.byteLength === 0 || ab.byteLength > MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(ab);
}

function isUnsupportedIncomingContentType(ct) {
  const t = String(ct || "").toLowerCase();
  if (!t) return false;
  if (t.includes("multipart/form-data")) return true;
  if (t.includes("application/x-www-form-urlencoded")) return true;
  if (!t.includes("application/json")) return true; // enforce JSON-only
  return false;
}

function bodyLooksLikeUploadOrBlob(bodyText) {
  const t = String(bodyText || "");

  // data: URIs
  if (/data:\s*[^,\s]+,/i.test(t)) return true;
  if (/data:\s*[^;,\s]+;base64,/i.test(t)) return true;

  // long base64-ish blobs (threshold tuned for MAX_BODY_BYTES=2048)
  if (/[A-Za-z0-9+/]{200,}={0,2}/.test(t)) return true;

  return false;
}

function honeypotTripped(payload) {
  const a = typeof payload?.hp_email === "string" ? payload.hp_email : "";
  const b = typeof payload?.hp_website === "string" ? payload.hp_website : "";
  return (a && a.trim().length > 0) || (b && b.trim().length > 0);
}

/**
 * Stronger allowlist sanitizer: plain text only.
 * - Strips tags and rejects if any mutation happens.
 * - Rejects if encoded angle brackets detected.
 */
function sanitizeAllowlistPlainTextOnly(s, maxLen) {
  const raw = String(s || "");
  const hasEncodedAngles = /(&lt;|&gt;|&#60;|&#62;|%3c|%3e)/i.test(raw);

  let stripped = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/[<>]/g, "");

  stripped = stripped.replace(/\s+/g, " ").trim();
  if (stripped.length > maxLen) stripped = stripped.slice(0, maxLen);

  const mutated = hasEncodedAngles || stripped !== raw;
  return { ok: !mutated, text: stripped };
}

// Optional: extra content guard using Workers AI (binding name: MY_BRAIN)
async function aiGuardIfAvailable(env, textToCheck) {
  const ai = env.MY_BRAIN;
  if (!ai || typeof ai.run !== "function") return { ok: true };

  try {
    const out = await ai.run("@cf/meta/llama-guard-3-8b", { prompt: textToCheck });
    const resp = String(out?.response || out?.result || "").trim().toLowerCase();
    if (!resp) return { ok: true };
    if (resp.includes("unsafe")) return { ok: false };
    if (resp === "safe") return { ok: true };
    return { ok: true };
  } catch (e) {
    console.error("AI guard failed (ignored):", e);
    return { ok: true };
  }
}

async function verifyTurnstile({ token, secret, remoteip }) {
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      secret,
      response: token,
      remoteip
    })
  });
  return res.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname || "/";
    const origin = request.headers.get("Origin") || "";
    const clientIp = request.headers.get("CF-Connecting-IP") || "";

    const isChatPath = pathname === "/api/ops-online-chat";
    const isRoot = pathname === "/";
    const isPing = pathname === "/ping";

    // Health / info
    if (isPing || isRoot) {
      return json(origin, 200, {
        ok: true,
        service: "ops-gateway",
        endpoints: ["POST /api/ops-online-chat"],
        usage: "POST /api/ops-online-chat with X-Ops-Asset-Id header + JSON { message, lang, v, turnstileToken, hp_* }",
        repo: REPO_URL
      });
    }

    // CORS preflight
    if (isChatPath && request.method === "OPTIONS") {
      if (origin && origin !== ALLOWED_ORIGIN) {
        return json(origin, 403, { error: "Origin not allowed." });
      }
      return new Response(null, {
        status: 204,
        headers: { ...securityHeaders(), ...corsHeaders(origin) }
      });
    }

    if (!isChatPath) {
      return json(origin, 404, {
        error: "Not found.",
        hint: "Use POST /api/ops-online-chat"
      });
    }

    // Only POST
    if (request.method !== "POST") {
      return json(origin, 405, { error: "POST only." });
    }

    // 1) Enforce origin
    if (!origin || origin !== ALLOWED_ORIGIN) {
      return json(origin, 403, { error: "Origin not allowed." });
    }

    // 2) Verify repo Asset ID (public)
    const allowedAssets = (env.OPS_ASSET_IDS || env.ASSET_ID || "")
      .toString()
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    if (!allowedAssets.length) {
      return json(origin, 500, { error: "Gateway config error (missing OPS_ASSET_IDS/ASSET_ID)." });
    }

    const clientAssetId = request.headers.get("X-Ops-Asset-Id") || "";
    if (!clientAssetId || !allowedAssets.some((v) => v === clientAssetId)) {
      return json(origin, 401, { error: "Unauthorized client." });
    }

    // 3) Read + parse body (limited)
    const bodyText = await readBodyLimited(request);
    if (!bodyText) {
      return json(origin, 413, { error: "Request too large or empty." });
    }

    // 3a) Reject data/blob/base64 payloads (defense-in-depth)
    if (bodyLooksLikeUploadOrBlob(bodyText)) {
      return json(origin, 400, {
        error: localizedError("en", "Uploads / encoded blobs are not allowed.", "No se permiten cargas ni blobs codificados."),
        lang: "en"
      });
    }

    let payload = {};
    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = {};
    }

    const langRaw = typeof payload.lang === "string" ? payload.lang : "en";
    const lang = langRaw === "es" ? "es" : "en";

    // 3b) Explicitly reject uploads / non-JSON by Content-Type (defense-in-depth)
    const ct = request.headers.get("Content-Type") || "";
    if (isUnsupportedIncomingContentType(ct)) {
      return json(origin, 415, {
        error: localizedError(lang, "Unsupported content type.", "Tipo de contenido no compatible."),
        lang
      });
    }

    // 3c) Honeypot trap: reject bots fast
    if (honeypotTripped(payload)) {
      return json(origin, 400, {
        error: localizedError(lang, "Request rejected.", "Solicitud rechazada."),
        lang
      });
    }

    const msgRaw = typeof payload.message === "string" ? payload.message : "";
    const message = normalizeUserText(msgRaw);

    const v = Number.isInteger(payload.v) ? payload.v : 1;

    // Turnstile
    const turnstileToken = typeof payload.turnstileToken === "string" ? payload.turnstileToken : "";
    const turnstileSecret = (env.TURNSTILE_SECRET || "").toString();

    if (!turnstileSecret) {
      return json(origin, 500, {
        error: localizedError(lang, "Gateway config error (missing TURNSTILE_SECRET).", "Error de configuración del gateway (falta TURNSTILE_SECRET)."),
        lang
      });
    }

    if (!turnstileToken) {
      return json(origin, 400, {
        error: localizedError(lang, "Turnstile verification failed.", "La verificación de Turnstile falló."),
        lang
      });
    }

    let turnstileResult;
    try {
      turnstileResult = await verifyTurnstile({
        token: turnstileToken,
        secret: turnstileSecret,
        remoteip: clientIp
      });
    } catch (err) {
      console.error("Turnstile verification error:", err);
      return json(origin, 502, {
        error: localizedError(lang, "Turnstile verification failed.", "La verificación de Turnstile falló."),
        lang
      });
    }

    if (!turnstileResult?.success) {
      console.warn("Turnstile verification rejected", turnstileResult?.["error-codes"] || "unknown");
      return json(origin, 403, {
        error: localizedError(lang, "Turnstile verification failed.", "La verificación de Turnstile falló."),
        lang
      });
    }

    if (!message) {
      return json(origin, 400, {
        error: localizedError(lang, "No message provided.", "No se proporcionó ningún mensaje."),
        lang
      });
    }

    // 4) Fast prefilter blacklist
    if (looksSuspicious(bodyText) || looksSuspicious(message)) {
      return json(origin, 400, {
        error: localizedError(lang, "Request blocked by OPS security gateway.", "Solicitud bloqueada por el gateway de seguridad OPS."),
        lang
      });
    }

    // 4a) Allowlist sanitizer (plain text only) — reject if it mutates
    const allow = sanitizeAllowlistPlainTextOnly(message, MAX_MSG_CHARS);
    if (!allow.ok) {
      return json(origin, 400, {
        error: localizedError(
          lang,
          "Request blocked: only plain text is allowed.",
          "Solicitud bloqueada: solo se permite texto plano."
        ),
        lang
      });
    }
    const safeMessage = allow.text;

    // 4b) Optional AI guard
    const guard = await aiGuardIfAvailable(env, safeMessage);
    if (!guard.ok) {
      return json(origin, 400, {
        error: localizedError(lang, "Request blocked by OPS safety gateway.", "Solicitud bloqueada por el gateway de seguridad OPS."),
        lang
      });
    }

    // 5) Gateway -> Brain secret handshake
    const handShake = env.HAND_SHAKE || "";
    if (!handShake) {
      return json(origin, 500, {
        error: localizedError(lang, "Gateway config error (missing HAND_SHAKE).", "Error de configuración del gateway (falta HAND_SHAKE)."),
        lang
      });
    }

    // 6) Must have service binding to brain
    if (!env.BRAIN || typeof env.BRAIN.fetch !== "function") {
      return json(origin, 500, {
        error: localizedError(lang, "Gateway config error (missing BRAIN binding).", "Error de configuración del gateway (falta la vinculación BRAIN)."),
        lang
      });
    }

    // 7) Forward to brain (service binding)
    let brainRes;
    try {
      brainRes = await env.BRAIN.fetch(BRAIN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ops-Hand-Shake": handShake
        },
        body: JSON.stringify({ message: safeMessage, lang, v })
      });
    } catch (err) {
      console.error("Gateway -> Brain error:", err);
      return json(origin, 502, {
        error: localizedError(lang, "Gateway could not reach brain.", "El gateway no pudo conectarse con el cerebro."),
        lang
      });
    }

    const responseText = await brainRes.text();

    let out = null;
    try {
      out = JSON.parse(responseText);
    } catch {
      out = null;
    }

    if (!out || typeof out !== "object") {
      return json(origin, 502, {
        error: localizedError(lang, "Brain returned invalid JSON.", "El cerebro devolvió JSON no válido."),
        lang
      });
    }

    return json(origin, brainRes.status, { ...out, lang });
  }
};
