# Codex Operating Profile (Project-Specific)

This repository uses a hybrid operating profile for AI-assisted delivery across:

- Cloud-native DevSecOps automation
- Human-centered UX/HCI optimization
- Security and compliance governance
- AI/ML orchestration and observability

## Execution Principles

1. **Security-first defaults**
   - Favor strict Content Security Policy controls.
   - Avoid `eval()`, `new Function()`, and `unsafe-eval` dependencies.
   - Keep scripts external and origin-scoped where possible.
2. **Compliance-by-design**
   - Map implementation decisions to NIST CSF/CISA Cyber Essentials/PCI DSS controls where relevant.
3. **HCI and accessibility**
   - Prioritize Core Web Vitals and WCAG 2.1 AA alignment.
4. **Observability and continuous improvement**
   - Instrument performance and reliability signals and use them to guide iterative hardening.

## CSP Baseline Expectations

- Keep `script-src` strict (`'self'` and explicit trusted origins only).
- Do not include `'unsafe-eval'` in `script-src`.
- Prefer external JavaScript over inline scripts; if inline is unavoidable, use per-response nonces or hashes.
- Restrict object/embed execution with `object-src 'none'`.
- Keep framing protections (`frame-ancestors 'none'` and `X-Frame-Options: DENY`).

## Delivery Outcome

The target state is a resilient, compliant, performance-aware, and user-centered e-commerce-ready architecture that can evolve safely through AI-assisted workflows.
