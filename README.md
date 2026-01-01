# OPS Online Support — Security & Compliance Notes

## Gateway (Cloudflare Worker)
- **Forced HTTPS:** HTTP requests are redirected to HTTPS (308) before any processing.
- **CSP (gateway responses):**
  - `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; frame-src https://challenges.cloudflare.com; script-src 'self' https://challenges.cloudflare.com 'nonce-ops-inline-asset'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://ops-gateway.grabem-holdem-nuts-right.workers.dev https://challenges.cloudflare.com; worker-src 'self'; manifest-src 'self'; media-src 'self'; report-uri https://ops-gateway.grabem-holdem-nuts-right.workers.dev/reports/csp`
  - Reporting endpoints are exposed via `/reports/csp` and `/reports/telemetry` with sampling and size limits.
- **Other headers:** `Strict-Transport-Security: max-age=15552000; includeSubDomains; preload`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy: accelerometer=(), camera=(), display-capture=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), bluetooth=()`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`.
- **CORS:** Scoped to `https://chattiavato-a11y.github.io` for API and reporting endpoints with `Access-Control-Allow-Headers: Content-Type, X-Ops-Asset-Id`.
- **Rate limiting:** Durable Object limiter keeps bursts to 5/10s and sustained to 60/5m.
- **Input safety:** 4KB max body, honeypots, Turnstile verification, content-type checks, data URI/base64 rejection, pattern-based sanitization, optional AI guard, and structured logging to KV (if bound).

## Frontend (GitHub Pages)
- **CSP (meta):** Mirrors the worker allowlists, adds `frame-ancestors 'none'`, and reports to `https://ops-gateway.grabem-holdem-nuts-right.workers.dev/reports/csp`.
- **HTTP-equivalent headers (meta):** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=15552000; includeSubDomains; preload`, `Referrer-Policy: strict-origin-when-cross-origin` (also set via `<meta name=\"referrer\">`), `Permissions-Policy: accelerometer=(), camera=(), display-capture=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), bluetooth=()`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`.
- **Assets with SRI:**  
  - `assets/styles.css` — `sha384-Kuw+CpXG3kB2wy3CGC3Z+lpHtDAhAiEPN/roIeIFlyD/BNIC5EM/9lYE7y/5EMsy`  
  - `https://challenges.cloudflare.com/turnstile/v0/api.js` — `sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb`
- **Inline script:** Uses nonce `ops-inline-asset` to comply with `script-src`.
- **Privacy & consent:** Banner explains localStorage use; preferences persist only after acceptance. Decline keeps preferences in-memory only.
- **Accessibility:** Focus-visible outlines, transcript panel with copy, voice transcript logging, reduced-motion toggle honoring `prefers-reduced-motion`, ARIA labels for controls.

## Local validation
- Inspect headers (replace host if using a tunnel):  
  - `curl -I https://ops-gateway.grabem-holdem-nuts-right.workers.dev/`  
  - `curl -I -X OPTIONS -H "Origin: https://chattiavato-a11y.github.io" https://ops-gateway.grabem-holdem-nuts-right.workers.dev/api/ops-online-chat`
- Check CSP/headers from the built page (served by a static host or `python -m http.server`):  
  - `curl -I http://localhost:8000/index.html`
- Verify SRI matches current assets:  
  - `openssl dgst -sha384 -binary assets/styles.css | openssl base64 -A`

## Re-run Observatory / reporting
- After deployment, re-scan the site with [Mozilla Observatory](https://observatory.mozilla.org/) against the GitHub Pages URL.
- CSP/Reporting endpoints post to the gateway at `/reports/csp` and `/reports/telemetry`; inspect KV/console logs for violation samples. Adjust sampling in `index.html` (`telemetrySampleRate`) and durable storage retention in `worker/ops-gateway.js` as needed.
