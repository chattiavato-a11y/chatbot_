# CF Worker Enlace vs Repo Gap Analysis

## Scope checked
- Reference script supplied in the request.
- Repo implementation and integration files reviewed in this repository.

## Separation requested: Repo vs Cloudflare Worker

### A) Repo side (by file)

#### `index.html`
- Bootstraps the front-end runtime and loads `app.js`.

#### `app.js`
- Defines default Enlace endpoints (`workerEndpoint`, `assistantEndpoint`, `voiceEndpoint`, `ttsEndpoint`).
- Maps origin -> asset IDs and uses `window.EnlaceRepo` client helpers for chat/voice/tts calls.
- Loads endpoint/config data via `window.EnlaceRepo.init()` and `window.EnlaceRepo.getConfig()`.

#### `worker.config.json`
- Root communication config used by repo runtime references.
- Includes endpoint URLs, required headers, and allowed origin + asset-id arrays.

#### `worker_files/worker.config.json`
- Served/distribution config variant for the same communication contract.

#### `worker_files/worker.assets.json`
- Registry-style asset records for endpoint/origin identity mapping.

#### `worker_files/registry.worker.config.json`
- Registry document for worker config provenance, integrity, and serving policy.

#### `worker_files/registry.schema.json`
- JSON schema governing registry record structure/constraints.

#### `CF_WORKER_ENLACE_GAP_ANALYSIS.md`
- Human-readable audit report tying reference script expectations to in-repo implementation.

### B) Cloudflare Worker side (by file)

#### `worker_files/enlace.worker.js` (Enlace Worker)
- Implements `/api/chat`, `/api/voice`, `/api/tts`.
- Enforces CORS + origin/asset identity (`x-ops-asset-id`).
- Applies sanitizer + safety guard.
- Calls Brain binding (`env.brain.fetch`) and returns bridged SSE to clients.

#### `worker_files/gateway.worker.js` (Gateway Worker)
- Optional gateway/proxy layer.
- Validates origin and required headers.
- Forwards upstream requests to configured Enlace URL.

#### `worker_files/gateway.worker.toml` (Gateway deployment config)
- Declares runtime config like `ENLACE_URL` and gateway request constraints.

> If any Cloudflare Worker is not deployed in your environment, this section still reflects the repo-side implementation files currently present.

## Brain section (where Brain is wired)

### Brain invocation + hop header
- Implemented in `callBrain(env, payload)` inside `worker_files/enlace.worker.js`.
- Service-binding check: `env.brain.fetch` must exist.
- Hop header is forwarded with `[HOP_HDR]: HOP_VAL`.

### Brain headers pass-through to client
- Implemented via `forwardBrainHeaders(outHeaders, brainResp)`.
- Forwards: `x-chattia-lang-iso2`, `x-chattia-model`, `x-chattia-translated`, `x-chattia-embeddings`.

### Brain streaming bridge
- Implemented via `bridgeBrainToSSE(brainBody, allowAuthor)`.
- Handles both:
  - Brain SSE blocks (`data:` events), and
  - Raw concatenated JSON chunk streams.
- Converts both into UI-friendly SSE text deltas.

## What already matches the reference
- Origin -> Asset ID map and strict verification via `x-ops-asset-id` are present.
- Guard-at-edge flow is present for `/api/chat` and `/api/voice?mode=chat`.
- Brain service call (`env.brain.fetch`) with hop header is present.
- Brain headers are forwarded back to client.
- Streaming bridge converts Brain payloads (SSE or raw JSON chunks) to SSE deltas.
- Sanitization and malicious content screening run before Guard + Brain paths.
- Security headers include CSP, HSTS, XFO, XCTO, Referrer-Policy, and no-store cache behavior.

## Gaps vs the provided “FIXED + SPANISH RELIABILITY + COMPLIANCE NOTES” script

### 1) Missing CORP security header
The provided script explicitly sets:
- `Cross-Origin-Resource-Policy: cross-origin`

Current repo implementation does **not** set this header in `securityHeaders()`.

### 2) Missing multilingual model-selection upgrades
The provided script adds language model constants and priority flow:
- `MODEL_LANG_DETECT = @cf/google/gemma-3-12b-it`
- `MODEL_LANG_DETECT_FALLBACK = @cf/meta/llama-3.2-3b-instruct`
- `MODEL_CHAT_MULTILINGUAL = @cf/google/gemma-3-12b-it`
- Spanish-quality model preference logic

Current repo still uses a simpler classifier path (`MODEL_CHAT_FAST` plus one fallback constant) and does not implement the same explicit detect-model chain.

### 3) Missing forced output language detection for commands like “reply in Spanish”
Provided script includes explicit language forcing function (`detectForcedReplyLangIso2`) that overrides normal inference.

Current repo has language detection heuristics/model fallback, but no dedicated forced-output-language parser for “reply/respond in X language” prompts.

### 4) Missing embeddings intent guardrail
Provided script auto-disables embeddings unless user intent looks like search/RAG via `shouldUseEmbeddings()`.

Current repo passes through `want_embeddings` but does not include intent-based auto-disable logic.

### 5) Missing preferred Brain model auto-selection based on desired output language
Provided script uses `pickPreferredChatModel()` to set model preference when `meta.model` is absent (especially for Spanish quality routing).

Current repo does not include this model-picking function and therefore does not enforce that behavior.

### 6) Minor documentation delta in top comment block
The supplied script includes additional notes about:
- SRI placement in HTML tags
- SEO/Search Console scope for HTML vs APIs
- Explicit mention of new Spanish reliability behaviors

Repo header comment does not include those newer notes.

## Exact code locations requested
- **Brain service call (`env.brain.fetch`) with hop header**
  - `callBrain` function declaration and service-binding check: `worker_files/enlace.worker.js` lines 449-450.
  - Actual `env.brain.fetch("https://service/api/chat", ...)` invocation and hop header injection (`[HOP_HDR]: HOP_VAL`): lines 451-457.

- **Brain headers forwarded back to client**
  - `forwardBrainHeaders` helper that forwards `x-chattia-lang-iso2`, `x-chattia-model`, `x-chattia-translated`, `x-chattia-embeddings`: lines 462-467.
  - Applied on `/api/chat` path before SSE response: line 870.
  - Applied on `/api/voice?mode=chat` path before SSE response: line 998.

- **Streaming bridge converts Brain payloads (SSE/raw JSON) -> SSE deltas**
  - Main bridge function: `bridgeBrainToSSE(brainBody, allowAuthor)` at line 587.
  - SSE block parsing path (`extractSSEBlocks`, `parseSSEBlockToData`, JSON-or-text handling): lines 610-651.
  - Raw concatenated JSON extraction path (`extractJsonObjectsFromBuffer` usage): lines 656-666.
  - Final SSE responses using bridge output:
    - chat route: line 872.
    - voice chat route: line 999.

- **Sanitization + malicious-content screening before Guard + Brain**
  - Sanitization helpers: `sanitizeContent` line 201; `normalizeMessages` line 206.
  - Malicious detector: `looksMalicious` line 181.
  - Chat route order:
    - normalize/sanitize messages: line 837.
    - Guard call after normalization: line 853.
    - Brain call after Guard: line 861.
  - Voice route order:
    - sanitize transcript: line 954.
    - malicious block check: line 956.
    - Guard call after sanitized messages: line 982.
    - Brain call after Guard: line 990.

## Enlace ↔ Repo communication status

### Config-level evidence that communication is wired
- Endpoints for assistant/voice/tts are configured and point to Enlace worker URL in both root and `worker_files` config JSON.
- Gateway worker TOML includes `ENLACE_URL` and required header policy.

### Runtime-level caveat
- `enlace.worker.js` requires `env.brain` service binding for chat/voice chat to work.
- In this repo snapshot, there is no Enlace wrangler config shown that declares the `brain` service binding, so runtime wiring cannot be fully proven from repository files alone.

## Net assessment
- **Partially aligned** with your provided script.
- Core pipeline/security/streaming architecture matches.
- Missing the newest language reliability + embeddings/model-routing + CORP additions from your script.
- Communication appears configured at endpoint/gateway metadata level, but a deploy-time binding check is still needed to confirm `env.brain` is active in production.
