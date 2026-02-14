# Security Deep-Dive Findings

Date: 2026-02-14  
Scope: `index.html`, `app.js`, `_headers`, `worker_files/*.js`, `worker_files/*.json`, `worker.config.json`, `security/*`.

## Confirmed hardening improvements (validated in-repo)

1. **No Cloudflare dashboard placeholder URL remains in code or config**
   - Verified that `https://dash.cloudflare.com` is absent from tracked files.
   - This removes accidental deployment/config confusion caused by placeholder dashboard references.

2. **No repo-level multilingual model-selection chain logic is present**
   - The edge worker still defines fixed model constants for guard/STT/TTS execution, but no dynamic multilingual model-router or model-selection chain logic is implemented in this repo.
   - This aligns with keeping model selection in the Brain/Cloudflare runtime boundary.

3. **Removed features are not present in repository code paths**
   - No implementation for:
     - forced output language detection,
     - embeddings intent guardrail,
     - preferred Brain model auto-selection.
   - Verified by targeted string scans across frontend and worker code.

## Current high-risk and medium-risk gaps (deep dive)

1. **ENLACE origin/asset trust can be spoofed outside browser CORS context (high)**
   - ENLACE trusts `Origin` + `x-ops-asset-id` matching for admission.
   - These headers are application-level values and can be forged by non-browser clients.
   - Recommendation:
     - Add gateway→ENLACE request signing (HMAC with timestamp + nonce) and replay window checks.
     - Enforce signature verification in ENLACE before processing chat/voice routes.

2. **Gateway→ENLACE hop is not cryptographically authenticated (high)**
   - A hop header exists (`x-chattia-hop`), but comments already note it is not a secret.
   - Without signed service-to-service auth, ENLACE cannot strongly distinguish trusted gateway traffic from crafted direct calls.
   - Recommendation:
     - Add mTLS-equivalent trust at edge where possible, or signed bearer assertions scoped to gateway service identity.

3. **PII over-collection in ENLACE communication metadata (medium/high compliance risk)**
   - Gateway enriches forwarded payload with `CF-Connecting-IP`, `User-Agent`, `Accept-Language`, and geo fields.
   - This may exceed data minimization needs for basic chat fulfillment and increases GDPR/CCPA/PCI audit exposure.
   - Recommendation:
     - Minimize by default (hash/truncate IP, remove city/region unless justified).
     - Add explicit retention + purpose documentation and configurable telemetry levels.

4. **Language fingerprinting leakage from client to ENLACE (medium)**
   - Frontend sends `language_list` and custom language headers (`x-chattia-lang-list`) derived from `navigator.languages`.
   - Full language vectors can be highly identifying when combined with UA/IP.
   - Recommendation:
     - Send only a single normalized language hint when strictly needed.
     - Gate extended language metadata behind explicit user consent.

5. **Regex-only sanitization as primary control (medium)**
   - Both gateway and ENLACE rely heavily on regex mutation/redaction.
   - This remains bypass-prone against obfuscation/encoding and does not provide schema-level semantic safety.
   - Recommendation:
     - Add strict JSON schema validation per endpoint.
     - Allowlist accepted fields/types/lengths; reject unknown keys for privileged metadata blocks.

6. **No explicit rate limiting / abuse throttling visible at repo layer (medium)**
   - Message length and payload caps exist, but no per-IP/per-origin quotas are implemented in code.
   - Recommendation:
     - Add rate limiting with burst + sustained quotas and anomaly counters on `/api/chat` and `/api/voice`.

7. **Security policy process documentation still missing in this repo (medium)**
   - There is no concrete vulnerability intake/SLA/PGP disclosure process file in current tracked scope.
   - Recommendation:
     - Add operational `SECURITY.md` with contacts, triage timelines, severity rubric, and coordinated disclosure workflow.

## ENLACE communication hardening backlog (actionable)

1. **Authenticate every gateway→ENLACE call**
   - Required headers: `x-chattia-sig`, `x-chattia-ts`, `x-chattia-nonce`, `x-chattia-key-id`.
   - Signature input: method + path + canonical query + body hash + timestamp + nonce.
   - Reject stale timestamps and replayed nonces.

2. **Constrain ENLACE ingress path**
   - Ensure ENLACE only accepts direct traffic from the gateway service identity, not generic internet clients.
   - If direct public exposure is required, split public endpoints from privileged internal endpoints.

3. **Minimize and classify forwarded metadata**
   - Classify each field as: required / optional / prohibited.
   - Remove default forwarding of raw IP + rich geo where not mandatory.

4. **Harden request contract validation**
   - Adopt per-route schema validation (chat, voice STT, TTS).
   - Deny unknown meta keys under `meta.gateway` and reject malformed nested objects.

5. **Add auditable controls**
   - Log signature verification result, replay detection, and rate-limit actions with request IDs.
   - Define retention periods and redaction policy for security telemetry.

## Verification commands executed

```bash
rg -n "https://dash.cloudflare.com|dash.cloudflare.com" .
rg -n "multilingual model-selection chain|forced output language detection|embeddings intent guardrail|preferred Brain model auto-selection" .
rg -n "language_hint|language_list|x-chattia-lang-list|CF-Connecting-IP|Accept-Language|x-chattia-hop" app.js worker_files/gateway.worker.js worker_files/enlace.worker.js
```
