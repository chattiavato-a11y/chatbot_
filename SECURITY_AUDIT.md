# Security Deep-Dive Findings

Date: 2026-02-13
Scope: `index.html`, `app.js`, `_headers`, `worker_files/*.js`, `worker_files/*.json`, `csp.config.json`, `SECURITY.md`.

## High-impact findings

1. **CSP/runtime mismatch in frontend (fixed)**
   - `index.html` had an inline Firebase `<script type="module">` that conflicts with the site CSP (`script-src 'self'`) and also imported from `gstatic`, which is not allowed by the configured CSP.
   - This created a policy/code mismatch and unnecessary client-side attack surface.
   - Status: removed inline Firebase block from `index.html`.

2. **Gateway origin trust gap (fixed)**
   - The gateway validated CORS headers but did not strictly deny non-allowed origins for non-preflight requests.
   - A direct server-to-server request could bypass browser CORS protections and still reach the upstream if required headers were spoofed.
   - Status: explicit origin allowlist enforcement now returns `403 Origin not allowed`.

3. **Sanitizer reliability bug due to global regex state (fixed)**
   - The gateway sanitizer reused global regexes (`/g`) with `.test()`. In JavaScript, global regexes keep `lastIndex`, which can cause skipped matches across calls.
   - This made malicious pattern detection inconsistent.
   - Status: reset `pattern.lastIndex = 0` before both `.test()` and `.replace()`.

## Additional risks and weaknesses

4. **Over-reliance on regex sanitization**
   - `worker_files/enlace.worker.js` and `worker_files/gateway.worker.js` both sanitize payloads via regex. This helps, but regex-only sanitization is bypass-prone for complex payloads and encoding tricks.

5. **Potential sensitive metadata forwarding**
   - Gateway enriches metadata with IP (`CF-Connecting-IP`) and user-agent and forwards upstream. This is operationally useful but may increase privacy/compliance obligations.

6. **Security policy documentation is placeholder-level**
   - `SECURITY.md` is mostly template text and lacks concrete vulnerability reporting channels/SLA details.

7. **Static header policy drift risk**
   - Security headers are declared in `_headers`, while additional security behavior exists in worker code. Divergence between these layers can cause silent breakage or weakened controls over time.

## What was checked for malicious code patterns

- Dangerous DOM/code execution patterns (`eval`, `new Function`, `innerHTML`, `document.write`).
- Script injection markers (`<script`, inline handlers, `javascript:` protocol, data-URL HTML payloads).
- Command/SQL-style chaining markers and template-injection markers in gateway sanitization.
- Open proxy/upstream forwarding behavior and origin enforcement logic.
- Secrets-in-repo scan for common token/key signatures.

## Recommended next steps

1. Add unit tests for sanitizer behavior and origin enforcement in gateway worker.
2. Add signed config integrity verification in the client (asset + config signature validation).
3. Replace template `SECURITY.md` with real intake/contact/SLA and disclosure workflow.
4. Introduce structured allowlist validation for all forwarded fields (schema-level checks).
5. Add CI security checks (Semgrep + secret scanning + dependency auditing).

## Tiny-ML integrity guard (new)

A lightweight repository-level guard was added at `security/tiny-ml-guard.mjs` with a baseline file at `security/integrity.baseline.json`.

- It computes SHA-256 hashes for repo files and compares against baseline integrity state.
- It applies a tiny weighted heuristic model ("Tiny ML") over changed files to detect high-risk patterns such as dynamic eval, string-based timers, script injection markers, and redirect payloads (`location=`, meta refresh, `top.location`).
- It **blocks** with a non-zero exit code when the risk score crosses threshold, enabling CI/CD to reject malicious or unauthorized redirect-introducing changes.
- Optional strict mode (`--strict-integrity`) fails on any integrity drift (added/removed/changed files).

Usage:

```bash
node security/tiny-ml-guard.mjs --write-baseline
node security/tiny-ml-guard.mjs
node security/tiny-ml-guard.mjs --strict-integrity
```

