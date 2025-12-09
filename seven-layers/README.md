# Seven-Layer Ops CySec Core & Governance Plan

This repository currently ships a single static `index.html` chat interface with inline scripts/styles and a Cloudflare Worker backend URL. The steps below provide a concrete implementation plan to stand up all seven layers of the Ops CySec Core & Governance framework **without altering the existing app in-place**; work can proceed inside this `seven-layers/` directory and then be incrementally merged.

## Layer 1: Identify
- Create an asset inventory and software bill of materials (SBOM) covering the static assets and any Cloudflare Worker packages (e.g., using `npm list --json` once a Worker project is initialized).
- Add dependency manifests for both the front end (e.g., a minimal `package.json` for linting/testing tooling) and the Worker backend.
- Document data flows and third-party services (FontAwesome CDN, Worker endpoint) in `seven-layers/docs/data-flow.md`.

## Layer 2: Protect
- Externalize inline scripts/styles into dedicated files and enforce a strict Content Security Policy (drop `unsafe-inline`, pin SRI for any CDN assets).
- Enable transport security: enforce HTTPS via HSTS, set `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, and `X-Content-Type-Options` headers.
- Add backend protections in the Worker: JWT or token-based authentication, per-IP/user rate limiting, input validation, and request size limits.
- Implement secrets management (e.g., Cloudflare KV or environment bindings) and define data-at-rest encryption requirements.

## Layer 3: Detect
- Instrument structured logging on both client (minimal event breadcrumbs) and Worker (request/response metrics, error traces).
- Export telemetry to a SIEM-friendly format; define dashboards for latency, error rate, and rate-limit triggers.
- Add automated scans (Snyk/Trivy or `npm audit`) and lint checks in CI.

## Layer 4: Respond
- Write an incident response playbook covering triage, containment, and communication.
- Add a client-side status banner pattern to surface incident states from a status endpoint.
- Provide hooks for disabling the chat endpoint or serving a maintenance page from the Worker.

## Layer 5: Recover
- Define backup/restore procedures for any stored chat transcripts (if added later) and Worker configuration.
- Establish MTTR/MTTD targets with post-incident review steps and a changelog for remedial actions.
- Add automated health checks and graceful degradation (retry with backoff, offline notice).

## Layer 6: Govern/Comply
- Draft privacy notice, cookie consent, and data-retention statements aligned with GDPR/CCPA, stored in `seven-layers/policies/`.
- Document DPIA/LSA triggers and record-keeping requirements.
- Align PCI DSS requirements 3–11 where applicable (logging, access control, vulnerability management) and map to NIST CSF/CISA Cyber Essentials.

## Layer 7: Assure/Validate
- Add unit tests (language toggle, input validation) and integration tests (Worker endpoint contract) runnable via CI.
- Include CSP regression tests (e.g., check for inline scripts) and lighthouse audits for Core Web Vitals and accessibility.
- Require code review with security gates and signed commits for releases.
- Keep tests hermetic: run against fixtures or mocked endpoints so they **do not change or slow down** the live chatbot experience during development or production.

## Suggested directory structure within `seven-layers/`
- `policies/` — privacy, cookie, and retention policies.
- `docs/` — data-flow diagrams, IR playbooks, recovery runbooks.
- `ci/` — example GitHub Actions for linting, tests, and dependency scanning.
- `worker/` — hardened Cloudflare Worker scaffold with auth, rate limits, and logging.

### Example tree when populated
```
seven-layers/
├── README.md
├── ci/
│   ├── security-scan.yml
│   └── tests.yml
├── docs/
│   ├── data-flow.md
│   ├── incident-response-playbook.md
│   └── recovery-runbook.md
├── policies/
│   ├── cookie-policy.md
│   ├── data-retention.md
│   └── privacy-notice.md
├── worker/
│   ├── src/
│   │   ├── auth.ts
│   │   ├── logging.ts
│   │   ├── rate-limit.ts
│   │   └── router.ts
│   ├── tests/
│   │   ├── csp-regression.spec.ts
│   │   └── endpoint-contract.spec.ts
│   ├── wrangler.toml
│   └── package.json
└── ui-tests/
    ├── language-toggle.spec.js
    └── accessibility.spec.js
```

Start by populating the docs and policies, then iteratively harden the client (move inline code to files, tighten CSP) and build out the Worker protections. Each completed artifact should be referenced from a living security README in this folder.

## FAQ and design clarifications
- **What is `worker/src/logging.ts` for?** It centralizes structured logging, redaction, and correlation ID handling for the Worker so telemetry and audits are consistent and privacy-preserving. The logging utilities can also emit metrics-friendly events for SIEM/observability pipelines without duplicating logic across handlers.
- **Will the seven layers sanitize and protect user-to-chatbot interactions?** Yes. The Protect/Detect/Respond layers explicitly add validation, rate limiting, CSP hardening, and abuse/threat monitoring, while the Worker router and tests ensure requests are sanitized before processing. Front-end guidance includes removing inline scripts, enforcing strict headers, and keeping client-side telemetry minimal and consent-aware.
- **Do the layers stay separate from the existing chatbot?** Yes. All planning, scaffolds, and tests live under `seven-layers/` and are designed to be hermetic. They do not alter the current `index.html` behavior; integration can be staged later with feature flags and mockable endpoints to avoid performance impact on the live chatbot.
