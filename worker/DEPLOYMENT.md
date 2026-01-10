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

## 3) Ensure the UI sends the asset ID header

- Set `OPS_ASSET_IDS` (or `ASSET_ID`) in the gateway environment.
- Confirm the UI includes the header: `X-Ops-Asset-Id` on requests.

## 4) Validate the origin allowlist

- Update `ALLOWED_ORIGINS` in `worker/ops-gateway.js` to match production domains.

## 5) Client request requirements (minimum)

The public gateway requires **only** these client-side items:
- `Origin` header is present and allowed (see `originAllowed(...)` in `worker/ops-gateway.js`).
- `POST` JSON payload to `/api/ops-online-chat`.
- `X-Ops-Asset-Id` header matches `OPS_ASSET_IDS`/`ASSET_ID` (see `getAllowedAssetIds(...)` and the `X-Ops-Asset-Id` enforcement block in `worker/ops-gateway.js`).

Example request:
```bash
curl -X POST "https://YOUR-GATEWAY.example/api/ops-online-chat" \
  -H "Origin: https://your-site.example" \
  -H "Content-Type: application/json" \
  -H "X-Ops-Asset-Id: YOUR_ASSET_ID_VALUE" \
  --data '{"lang":"en","message":"Hello","history":[]}'
```
