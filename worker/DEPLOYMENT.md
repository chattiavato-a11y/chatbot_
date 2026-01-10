# Worker deployment + customization checklist

Use this checklist when deploying and customizing the gateway + brain workers. It maps directly to what the source code enforces today.

## Desired flow (at a glance)

1. **Client → Gateway (public)**: allowlist + origin checks only.
2. **Gateway → Brain (private)**: HMAC (SHA-256) + timestamp + nonce + body hash.
3. **Brain**: replay protection via Durable Object (with KV fallback).

## 1) Deploy `worker/ops-gateway.js` as the **public edge** worker

**Required bindings**
- `BRAIN` service binding (points to the private brain worker)
- `HAND_SHAKE` secret (shared with brain)

**Optional bindings**
- `FIREWALL` Workers AI binding (llama-guard; if missing, it is skipped)
- `OPS_EVENTS` KV namespace (audit events)
- `OPS_RL` KV namespace (rate limiting)

**Required variables**
- `OPS_ASSET_IDS` (comma-separated) **or** `ASSET_ID` (single value)

## 2) Deploy `worker/ops-brain.js` as the **private** worker

**Required bindings**
- `HAND_SHAKE` secret (same value as gateway)

**Optional bindings**
- `AI` Workers AI binding (brain model usage)
- `OPS_EVENTS` KV namespace (audit events)
- `OPS_NONCES` KV namespace (nonce replay best-effort fallback)
- `NONCE_GUARD` Durable Object namespace (strong replay protection)

## 3) Client request requirements (public API)

The Gateway expects:
- `POST /api/ops-online-chat`
- `Content-Type: application/json`
- `X-Ops-Asset-Id: <asset-id>`
- Allowed `Origin` (must exist in `ALLOWED_ORIGINS`)

No client HMAC is required by the Gateway today.

## 4) Internal HMAC (Gateway → Brain)

The Gateway signs requests to the Brain with SHA-256:

```
toSign = ts + "." + nonce + ".POST." + pathname + "." + bodySha
```

Headers sent to the Brain:
- `X-Ops-Ts`
- `X-Ops-Nonce`
- `X-Ops-Body-Sha256`
- `X-Ops-Sig`

If you change this, update both `ops-gateway.js` and `ops-brain.js`.

## 5) Replay protection checklist

1. Ensure `NONCE_GUARD` is bound for strong replay detection.
2. Keep `OPS_NONCES` KV bound for best-effort fallback.
3. To verify replay protection:
   - Send two requests with the same nonce.
   - The second should return a replay error.

## 6) Required customization steps

1. **Allowlist your production origins**
   - Edit `ALLOWED_ORIGINS` in `worker/ops-gateway.js`.
2. **Set the asset allowlist**
   - Add `OPS_ASSET_IDS` or `ASSET_ID` in the gateway environment.
3. **Keep the shared secret in sync**
   - `HAND_SHAKE` must match between gateway and brain.
4. **Deploy order**
   - Deploy `ops-brain` first, then deploy `ops-gateway`.
