# Worker deployment checklist

Use this checklist when deploying the gateway + brain workers. The bindings below reflect the required and optional pieces in the source.

## 1) Deploy `worker/ops-gateway.js` as the **public edge** worker

**Required bindings**
- `BRAIN` service binding (points to the private brain worker)
- `FIREWALL` Workers AI binding
- `HAND_SHAKE` secret

**Optional bindings**
- `OPS_EVENTS` KV namespace (audit events)
- `OPS_RL` KV namespace (rate limiting)

**Required variables**
- `OPS_ASSET_IDS` (comma-separated) **or** `ASSET_ID` (single value)

## 2) Deploy `worker/ops-brain.js` as the **private** worker

**Required bindings**
- `AI` Workers AI binding
- `HAND_SHAKE` secret (same value as gateway)

**Optional bindings**
- `OPS_EVENTS` KV namespace
- `OPS_NONCES` KV namespace
- `NONCE_GUARD` Durable Object namespace

**Replay protection notes**
- `NONCE_GUARD` Durable Object is required for **strong** replay protection.
- `OPS_NONCES` KV is a best-effort fallback (eventual consistency).
- `NONCE_TTL_SECONDS` defaults to 600 seconds and is clamped to a minimum of 60 seconds
  by `clampNonceTtlSec(...)` in `worker/ops-brain.js` (KV TTL requirement).
- `OpsNonceGuard` uses the provided `ttlSec` and also enforces a minimum of 60 seconds,
  defaulting to 600 seconds if unset.

## 3) Ensure the UI sends the asset ID header

- Set `OPS_ASSET_IDS` (or `ASSET_ID`) in the gateway environment.
- Confirm the UI includes the header: `X-Ops-Asset-Id` on requests.

## 4) Validate the origin allowlist

- Update `ALLOWED_ORIGINS` in `worker/ops-gateway.js` to match production domains.

## 5) How to test replay protection (short check)

- Send the exact same request twice using the same `nonce` (and identical signature).
- The second request should return a 409 with `error_code: "REPLAY"`.
