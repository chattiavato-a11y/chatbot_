# Security and privacy quickstart

- **Scope**: OPS Online Support (Chattia) frontend assets. Apply these practices to `/assets`, `/pages`, and the chat UI in `index.html`.
- **Threat model**: Script injection, origin spoofing, automated abuse, and unauthorized data collection.

## Frontend hardening
- Content Security Policy is defined in `index.html` and should be mirrored at the edge (e.g., Cloudflare) for enforcement.
- Turnstile verification is required before chat submission; keep widget IDs and callbacks in sync with the gateway.
- Inputs are normalized and checked for obvious HTML/script payloads before network calls.
- Keep the origin/path allowlist in `assets/chattia-ui.js` aligned with the deployed hostnames.
- Never introduce third-party scripts without updating CSP and reviewing privacy impact.

## Data handling
- The assistant is designed to avoid intentional PII collection. Remind users not to paste sensitive data.
- Consent gates preference storage. Theme/language persistence only occurs after consent is accepted.
- Chat transcripts are stored only in-session on the client for user convenience; clearing chat purges the transcript list.

## Reporting
- For security incidents or suspected vulnerabilities, file an issue with minimal reproduction steps and no sensitive data.
- For privacy requests (deletion, data access), direct users to the Contact section in `content.md` and include timestamps.
