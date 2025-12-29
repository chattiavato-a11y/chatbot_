/**
 * Cloudflare Worker for ops-gateway.grabem-holdem-nuts-right.workers.dev
 *
 * Flow: GH Pages (UI) -> Gateway (this Worker) -> Brain (service binding: BRAIN)
 *
 * Responsibilities:
 * - Allow CORS only from the GitHub Pages origin.
 * - Accept POST /api/ops-online-chat with X-Ops-Asset-Id and a shared X-Ops-Hand-Shake to the brain.
 * - Validate and sanitize inputs (size, content, suspicious patterns).
 * - Optionally run an AI guard (MY_BRAIN binding) to reject unsafe text.
 * - Proxy to the assistant service binding (BRAIN) using the shared secret.
 * - Return structured JSON with strong security headers and clean 4xx/5xx handling.
 */

const ALLOWED_ORIGIN = 'https://chattiavato-a11y.github.io';
const MAX_BODY_BYTES = 3096;
const MAX_MSG_CHARS = 256;

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none';",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Permissions-Policy': "geolocation=(), microphone=(), camera=(), payment=(), usb=(), bluetooth=(), gyroscope=(), magnetometer=(), accelerometer=()",
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY'
  };
}

function corsHeaders(origin) {
  const headers = { Vary: 'Origin' };
  if (origin === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Ops-Asset-Id';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

function json(origin, status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      ...securityHeaders(),
      ...corsHeaders(origin),
      'content-type': 'application/json'
    }
  });
}

function localizedError(lang, enText, esText) {
  return lang === 'es' ? esText : enText;
}

function text(status, msg) {
  return new Response(msg, {
    status,
    headers: { ...securityHeaders(), 'content-type': 'text/plain' }
  });
}

function normalizeUserText(s) {
  let out = String(s || '');
  out = out.replace(/[\u0000-\u001F\u007F]/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > MAX_MSG_CHARS) out = out.slice(0, MAX_MSG_CHARS);
  return out;
}

function looksSuspicious(s) {
  const t = String(s || '').toLowerCase();
  const badPatterns = [
    '<script', '</script', 'javascript:',
    '<img', 'onerror', 'onload',
    '<iframe', '<object', '<embed',
    '<svg', '<link', '<meta', '<style',
    'document.cookie',
    'onmouseover', 'onmouseenter',
    '<form', '<input', '<textarea'
  ];
  return badPatterns.some((p) => t.includes(p));
}

async function readBodyLimited(request) {
  const ab = await request.arrayBuffer();
  if (ab.byteLength === 0 || ab.byteLength > MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(ab);
}

// Optional: extra content guard using Workers AI (binding name: MY_BRAIN)
async function aiGuardIfAvailable(env, textToCheck) {
  const ai = env.MY_BRAIN;
  if (!ai || typeof ai.run !== 'function') return { ok: true };

  try {
    const out = await ai.run('@cf/meta/llama-guard-3-8b', { prompt: textToCheck });
    const resp = String(out?.response || out?.result || '').trim().toLowerCase();
    if (!resp) return { ok: true };
    if (resp.includes('unsafe')) return { ok: false };
    if (resp === 'safe') return { ok: true };
    return { ok: true };
  } catch (e) {
    console.error('AI guard failed (ignored):', e);
    return { ok: true };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rawPath = url.pathname || '/';
    const pathname =
      rawPath !== '/' && rawPath.endsWith('/') ? rawPath.replace(/\/+$/, '') : rawPath;
    const isChatPath = pathname === '/api/ops-online-chat';
    const isRoot = pathname === '/';
    const origin = request.headers.get('Origin') || '';

    if (pathname === '/ping' || isRoot) {
      return json(origin, 200, {
        ok: true,
        service: 'ops-gateway',
        usage: 'POST /api/ops-online-chat with X-Ops-Asset-Id header'
      });
    }

    // CORS preflight
    if (isChatPath && request.method === 'OPTIONS') {
      if (origin && origin !== ALLOWED_ORIGIN) {
        return json(origin, 403, { error: 'Origin not allowed.' });
      }
      return new Response(null, {
        status: 204,
        headers: { ...securityHeaders(), ...corsHeaders(origin) }
      });
    }

    if (!isChatPath) {
      return json(origin, 404, {
        error: 'Not found.',
        hint: 'Use POST /api/ops-online-chat'
      });
    }

    // Only POST
    if (request.method !== 'POST') {
      return json(origin, 405, { error: 'POST only.' });
    }

    // 1) Enforce origin
    if (!origin || origin !== ALLOWED_ORIGIN) {
      return json(origin, 403, { error: 'Origin not allowed.' });
    }

    // 2) Verify repo Asset ID (public)
    const allowedAssets = (env.OPS_ASSET_IDS || env.ASSET_ID || '').toString().split(',').map((v) => v.trim()).filter(Boolean);
    if (!allowedAssets.length) {
      return json(origin, 500, { error: 'Gateway config error (missing OPS_ASSET_IDS/ASSET_ID).' });
    }

    const clientAssetId = request.headers.get('X-Ops-Asset-Id') || '';
    if (!clientAssetId || !allowedAssets.some((v) => v === clientAssetId)) {
      return json(origin, 401, { error: 'Unauthorized client.' });
    }

    // 3) Read + parse body (limited)
    const bodyText = await readBodyLimited(request);
    if (!bodyText) {
      return json(origin, 413, { error: 'Request too large or empty.' });
    }

    let payload = {};
    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = {};
    }

    const msgRaw = typeof payload.message === 'string' ? payload.message : '';
    const langRaw = typeof payload.lang === 'string' ? payload.lang : 'en';
    const versionRaw = Number.isInteger(payload.v) ? payload.v : 1;

    const message = normalizeUserText(msgRaw);
    const lang = langRaw === 'es' ? 'es' : 'en';
    const v = versionRaw;

    if (!message) {
      return json(origin, 400, {
        error: localizedError(lang, 'No message provided.', 'No se proporcionó ningún mensaje.'),
        lang
      });
    }

    // 4) Sanitization (gateway-level)
    if (looksSuspicious(bodyText) || looksSuspicious(message)) {
      return json(origin, 400, {
        error: localizedError(lang, 'Request blocked by OPS security gateway.', 'Solicitud bloqueada por el gateway de seguridad OPS.'),
        lang
      });
    }

    // 4b) Optional AI guard (if MY_BRAIN binding exists)
    const guard = await aiGuardIfAvailable(env, message);
    if (!guard.ok) {
      return json(origin, 400, {
        error: localizedError(lang, 'Request blocked by OPS safety gateway.', 'Solicitud bloqueada por el gateway de seguridad OPS.'),
        lang
      });
    }

    // 5) Gateway -> Brain secret handshake
    const handShake = env.HAND_SHAKE || '';
    if (!handShake) {
      return json(origin, 500, {
        error: localizedError(lang, 'Gateway config error (missing HAND_SHAKE).', 'Error de configuración del gateway (falta HAND_SHAKE).'),
        lang
      });
    }

    // 6) Must have service binding to brain
    if (!env.BRAIN || typeof env.BRAIN.fetch !== 'function') {
      return json(origin, 500, {
        error: localizedError(lang, 'Gateway config error (missing BRAIN binding).', 'Error de configuración del gateway (falta la vinculación BRAIN).'),
        lang
      });
    }

    // 7) Forward to brain (service binding)
    let brainRes;
    try {
      brainRes = await env.BRAIN.fetch('https://ops-online-assistant.grabem-holdem-nuts-right.workers.dev/api/ops-online-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ops-Hand-Shake': handShake
        },
        body: JSON.stringify({ message, lang, v })
      });
    } catch (err) {
      console.error('Gateway -> Brain error:', err);
      return json(origin, 502, {
        error: localizedError(lang, 'Gateway could not reach brain.', 'El gateway no pudo conectarse con el cerebro.'),
        lang
      });
    }

    const responseText = await brainRes.text();

    // Always return JSON to the browser
    let out = null;
    try {
      out = JSON.parse(responseText);
    } catch {
      out = null;
    }

    if (!out || typeof out !== 'object') {
      return json(origin, 502, {
        error: localizedError(lang, 'Brain returned invalid JSON.', 'El cerebro devolvió JSON no válido.'),
        lang
      });
    }

    return json(origin, brainRes.status, { ...out, lang });
  }
};
