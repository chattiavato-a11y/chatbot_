const gatewayMod = await import(new URL("../ops-gateway.js", import.meta.url));
const brainMod = await import(new URL("../ops-brain.js", import.meta.url));

function createCtx() {
  return { waitUntil: () => {} };
}

function createKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    }
  };
}

function createNonceGuard() {
  const seen = new Map();
  return {
    idFromName() {
      return "ops_nonce_guard";
    },
    get() {
      return {
        async fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          const body = await request.json();
          const nonce = String(body?.nonce || "");
          const ttlSec = Math.max(60, Math.floor(Number(body?.ttlSec || 600)));
          if (!nonce) return new Response(JSON.stringify({ ok: false, reason: "missing_nonce" }), { status: 400 });
          if (seen.has(nonce)) return new Response(JSON.stringify({ ok: false, reason: "replay" }), { status: 409 });
          seen.set(nonce, Date.now() + ttlSec * 1000);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      };
    }
  };
}

const baseBody = JSON.stringify({ lang: "en", message: "Hello from gateway test", history: [] });
const origin = "https://opsonlinesupport.com";

async function runGatewayToBrain(secretForGateway, secretForBrain) {
  const brainEnv = {
    HAND_SHAKE: secretForBrain,
    AI: { run: async () => ({ response: "ok" }) },
    OPS_EVENTS: createKv(),
    NONCE_GUARD: createNonceGuard()
  };

  const gatewayEnv = {
    HAND_SHAKE: secretForGateway,
    OPS_ASSET_IDS: "asset-123",
    BRAIN: { fetch: (req) => brainMod.default.fetch(req, brainEnv, createCtx()) },
    OPS_EVENTS: createKv(),
    OPS_RL: createKv()
  };

  const req = new Request("https://gateway.local/api/ops-online-chat", {
    method: "POST",
    headers: {
      "Origin": origin,
      "Content-Type": "application/json",
      "X-Ops-Asset-Id": "asset-123"
    },
    body: baseBody
  });

  return gatewayMod.default.fetch(req, gatewayEnv, createCtx());
}

const okResp = await runGatewayToBrain("secret-123", "secret-123");
if (okResp.status !== 200) {
  throw new Error(`Expected 200 OK, got ${okResp.status}`);
}

const badResp = await runGatewayToBrain("secret-123", "wrong-secret");
if (badResp.status !== 401) {
  throw new Error(`Expected 401 for bad signature, got ${badResp.status}`);
}

console.log("Gateway→Brain header validation test passed.");
