# Worker Config Consolidation & Verification

## Purpose
Keep the UI, registry metadata, and Cloudflare Worker aligned so client requests
work from approved origins and integrity checks stay trustworthy.

## Single Source of Truth
- **Runtime config**: `worker.config.json`
- **UI consumer**: `app.js` loads `worker.config.json` at startup and uses the
  `workerEndpoint` + `allowedOrigins` values for requests.
- **Registry metadata**: `registry.worker.config.json` mirrors the config and
  stores a SHA-512 digest for integrity verification.

## Update Workflow (when changing allowlist or endpoint)
1. **Edit** `worker.config.json`.
2. **Recompute** the SHA-512 digest:
   ```bash
   sha512sum worker.config.json
   ```
3. **Update** `registry.worker.config.json`:
   - `integrity.sha512`
   - `policy.allowed_origins`
4. **Validate** the UI default fallback in `app.js` matches the config.

## Verification Checklist
- **Health endpoint**
  ```bash
  curl -i https://<workerEndpoint>/health
  ```
- **CORS allowlist**
  - From each allowed origin, issue a POST to `/api/chat` and confirm no
    `Origin not allowed` response.
- **Config registry integrity**
  - Confirm `registry.worker.config.json` SHA-512 equals `worker.config.json`.

## Operational Notes
- The Worker script enforces the allowlist; the UI should not add origins
  not present in the Worker `ALLOWED_ORIGINS` set.
- For troubleshooting, open `/api/chat`, `/api/voice`, or `/api/tts` with GET
  to confirm the Worker is reachable and returns usage JSON.
