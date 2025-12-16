/**
 * Cloudflare Workers AI template for the Ops Online Assistant brain.
 *
 * Adds a speech-to-text endpoint using @cf/openai/whisper alongside
 * the existing chat endpoints that rely on @cf/meta/llama-3.3-70b-instruct-fp8-fast.
 */

const CHAT_MODEL_ID = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const WHISPER_MODEL_ID = '@cf/openai/whisper';

const SYSTEM_PROMPT = `
You are OPS Online Assistant, the friendly and professional helper for the OPS Remote Professional Network.
I’m here to assist you with everything related to OPS services, our business operations, contact center solutions, IT support, and professionals-on-demand.
always answer in short, clear sentences and small paragraphs so the information is easy to read and pleasant to listen to with text-to-speech.
use simple plain text without bullet lists, bold, headings, emojis, or extra symbols.
`.trim();

// Allow Ops Online Assistant UI / gateway to call this Worker
const ALLOWED_ORIGIN = '*';

function base64ToBytes(b64) {
  const clean = b64.replace(/^data:audio\/[\\w.+-]+;base64,/, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Ops-Hand-Shake'
  };
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Verifies that the request really came from the ops-gateway Worker. */
async function verifyGatewaySignature(request, env, bodyText) {
  void bodyText;

  const expected = env.HAND_SHAKE || '';
  if (!expected) {
    return {
      ok: false,
      code: 'NO_HAND_SHAKE',
      status: 500,
      publicMsg: 'Assistant configuration error.',
      opsMsg: 'Missing HAND_SHAKE in brain env.'
    };
  }

  const got = request.headers.get('X-Ops-Hand-Shake') || '';
  if (!got) {
    return {
      ok: false,
      code: 'MISSING_HAND_SHAKE',
      status: 401,
      publicMsg: 'Unauthorized request.',
      opsMsg: 'Missing X-Ops-Hand-Shake header.'
    };
  }

  if (got !== expected) {
    return {
      ok: false,
      code: 'BAD_HAND_SHAKE',
      status: 401,
      publicMsg: 'Unauthorized request.',
      opsMsg: 'Handshake mismatch.'
    };
  }

  return { ok: true };
}

async function handleChatRequest(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const messagesIn = body.messages || [];
    const messages = Array.isArray(messagesIn) ? [...messagesIn] : [];

    if (!messages.some((msg) => msg.role === 'system')) {
      messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
    }

    const response = await env.AI.run(
      CHAT_MODEL_ID,
      {
        messages,
        max_tokens: 1024
      },
      { returnRawResponse: true }
    );
    return response;
  } catch (error) {
    console.error('Error processing /api/chat request:', error);
    return new Response(JSON.stringify({ error: 'Failed to process request' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}

async function handleOpsOnlineChat(request, env) {
  try {
    const bodyText = await request.text();
    let payload = {};
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      payload = {};
    }

    const verify = await verifyGatewaySignature(request, env, bodyText);
    if (!verify.ok) {
      console.error('Gateway verification failed:', verify.opsMsg);
      return new Response(
        JSON.stringify({
          public_error: verify.publicMsg,
          error_layer: 'L7',
          error_code: verify.code
        }),
        {
          status: verify.status,
          headers: {
            ...corsHeaders(),
            'content-type': 'application/json'
          }
        }
      );
    }

    const message = typeof payload.message === 'string' ? payload.message : '';
    const history = Array.isArray(payload.history) ? payload.history : [];

    const messages = [];
    messages.push({ role: 'system', content: SYSTEM_PROMPT });

    for (const item of history) {
      if (!item || !item.content) continue;
      messages.push({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: String(item.content)
      });
    }

    if (message.trim()) {
      messages.push({ role: 'user', content: message.trim() });
    }

    if (!messages.length) {
      return new Response(JSON.stringify({ error: 'No message provided' }), {
        status: 400,
        headers: { ...corsHeaders(), 'content-type': 'application/json' }
      });
    }

    const aiResult = await env.AI.run(CHAT_MODEL_ID, {
      messages,
      max_tokens: 512
    });

    const replyText =
      aiResult && aiResult.response
        ? aiResult.response
        : 'I’m not sure how to answer that yet.';

    return new Response(JSON.stringify({ reply: replyText }), {
      status: 200,
      headers: { ...corsHeaders(), 'content-type': 'application/json' }
    });
  } catch (err) {
    console.error('Error in /api/ops-online-chat:', err);
    return new Response(JSON.stringify({ error: 'Failed to process Ops Online Assistant request' }), {
      status: 500,
      headers: { ...corsHeaders(), 'content-type': 'application/json' }
    });
  }
}

async function handleWhisperTranscription(request, env) {
  try {
    const bodyText = await request.text();
    let payload = {};
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      payload = {};
    }

    const verify = await verifyGatewaySignature(request, env, bodyText);
    if (!verify.ok) {
      console.error('Gateway verification failed:', verify.opsMsg);
      return new Response(
        JSON.stringify({
          public_error: verify.publicMsg,
          error_layer: 'L7',
          error_code: verify.code
        }),
        {
          status: verify.status,
          headers: {
            ...corsHeaders(),
            'content-type': 'application/json'
          }
        }
      );
    }

    const audioBase64 = typeof payload.audio === 'string' ? payload.audio : '';
    if (!audioBase64) {
      return new Response(JSON.stringify({ error: 'No audio provided' }), {
        status: 400,
        headers: { ...corsHeaders(), 'content-type': 'application/json' }
      });
    }

    let audioBytes;
    try {
      audioBytes = base64ToBytes(audioBase64);
    } catch (e) {
      console.error('Invalid base64 audio:', e);
      return new Response(JSON.stringify({ error: 'Invalid audio payload' }), {
        status: 400,
        headers: { ...corsHeaders(), 'content-type': 'application/json' }
      });
    }

    const aiResult = await env.AI.run(WHISPER_MODEL_ID, {
      audio: audioBytes
    });

    const transcript =
      aiResult?.text ||
      aiResult?.transcript ||
      aiResult?.transcription ||
      aiResult?.response ||
      '';

    return new Response(JSON.stringify({ transcript: transcript || '' }), {
      status: 200,
      headers: { ...corsHeaders(), 'content-type': 'application/json' }
    });
  } catch (err) {
    console.error('Error in /api/transcribe:', err);
    return new Response(JSON.stringify({ error: 'Failed to transcribe audio' }), {
      status: 500,
      headers: { ...corsHeaders(), 'content-type': 'application/json' }
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/api/chat') {
      if (request.method === 'POST') {
        return handleChatRequest(request, env);
      }
      return new Response('Method not allowed', { status: 405 });
    }

    if (pathname === '/api/ops-online-chat') {
      if (request.method === 'POST') {
        return handleOpsOnlineChat(request, env);
      }
      return new Response('Method not allowed', { status: 405 });
    }

    if (pathname === '/api/transcribe') {
      if (request.method === 'POST') {
        return handleWhisperTranscription(request, env);
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // Serve static assets (LLM Chat App frontend)
    if (pathname === '/' || !pathname.startsWith('/api/')) {
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return env.ASSETS.fetch(request);
      }
      return new Response('ops-online-assistant: ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
