# OPS Online Assistant Repo Audit

## Overview
Single-page chatbot UI served from `index.html` with inline styles and vanilla JavaScript. Provides bilingual (EN/ES) toggle, dark/light theme toggle, speech synthesis output, local chat history cache, and remote API call to a Cloudflare Worker endpoint.

## What works well
- **Bilingual EN/ES UI + speech**: `langCtrl` flips `document.documentElement.lang`, swaps all `data-en`/`data-es` text (skip link, controls, notices), updates placeholders, and speech synthesis picks EN/ES voices (lines 193-254, 286-336).
- **Theme toggle**: `themeCtrl` flips `body.dark` with accessible focus states on buttons (lines 256-261 and 36-104).
- **Speech preparation**: `cleanForSpeech` strips code fences, inline code, bullets, emphasis, and redundant whitespace before speaking responses (lines 316-353).
- **Guarded chat persistence**: history is trimmed to 40 turns and stored with a 30-day TTL only when the user opts in via the privacy toggle; opt-out clears storage (lines 371-437).
- **Resilient send flow**: client-side rate limiting (5/min + 1.2s gap), offline guard, abortable fetch timeout (12s), and localized errors prevent UI hangs; send button re-enables reliably (lines 502-618).
- **Accessibility upgrades**: skip-link, ARIA labels, focusable new bot messages, and screen-reader-only status updates improve navigation (lines 110-173, 371-402, 563-610).
- **Security headers**: inline CSP and Referrer-Policy metadata constrain asset loading to self/CDN and remove referrers (lines 5-12).

## Gaps and risks to address
- **CSP still allows inline script/style**: meta CSP permits `'unsafe-inline'` to support current inline assets; consider hashing or externalizing assets for stricter enforcement alongside HSTS when deployed via a server.
- **Testing/observability**: no automated tests or telemetry hooks; helpers (language toggle, speech cleanup, rate limiter, storage TTL) remain unverified.
- **Worker-side abuse controls**: UI throttles submits but backend should still enforce auth/rate limits, input size, and anti-automation controls.

## Suggested next steps
- Move inline script/styles into hashed files and serve with HSTS + SRI to tighten CSP.
- Add unit tests for `cleanForSpeech`, language toggling, storage TTL/opt-in, and rate limiting; wire a CI job to run them.
- Instrument client and Worker with basic logging/metrics (latency, errors, throttling hits) and consider synthetic uptime checks.
