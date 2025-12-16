# ops-gateway Cloudflare Worker

This Worker fronts the OPS assistant and lives at `ops-gateway.grabem-holdem-nuts-right.workers.dev`. It validates the asset header, enforces CORS, and forwards chat requests to the assistant service binding with a shared handshake.

## Behavior

* Only responds on `POST /api/ops-online-chat` (other methods → `405`, other paths → `404`); `/ping` returns plain “ok”.
* CORS is locked to `https://chattiavato-a11y.github.io`; preflight uses `OPTIONS` with `204`.
* Requires `X-Ops-Asset-Id` to match configured allow-list and `Origin` to match the allowed origin; otherwise `401/403`.
* Validates JSON `{ message, lang, v }`, trims/normalizes message to 256 chars, blocks suspicious content and oversize bodies (4 KB).
* Optionally runs an AI guard via `MY_BRAIN` (`@cf/meta/llama-guard-3-8b`); blocks if marked unsafe.
* Forwards to the assistant service binding `BRAIN` with `X-Ops-Hand-Shake` for mutual trust; returns JSON from the brain or structured gateway errors.

## Configuration

Set these environment variables when deploying:

| Variable | Purpose |
| --- | --- |
| `OPS_ASSET_IDS` (or `ASSET_ID`) | Comma-separated allow-list for `X-Ops-Asset-Id` values. Use the exact hash shipped in the web client. |
| `HAND_SHAKE` | Shared secret sent as `X-Ops-Hand-Shake` when calling the brain. |
| Service binding `BRAIN` | Must point to `ops-online-assistant` (production). |
| (Optional) Binding `MY_BRAIN` | Workers AI binding for `@cf/meta/llama-guard-3-8b` safety guard. |

## Assistant template (brain)

`assistant-template.js` contains a Cloudflare Workers AI starter for the `ops-online-assistant` brain:

* Chat completions use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
* Speech-to-text runs through `@cf/openai/whisper` on `POST /api/transcribe` (base64 audio input).
* The same handshake header (`X-Ops-Hand-Shake`) protects both chat and transcription endpoints.

## Smoke test

Once deployed, validate with:

```sh
curl -i -X POST "$GATEWAY/api/ops-online-chat" \
  -H "Content-Type: application/json" \
  -H "X-Ops-Asset-Id: <allowed-asset-id>" \
  -d '{"message":"hello","lang":"en","v":1}'
```

You should receive `200 OK` with `{ "reply": "<assistant text>" }`. Non-POST methods should return a clean JSON error and never bubble a 500 for misuse.
