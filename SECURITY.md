# Security Policy

## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 5.1.x   | :white_check_mark: |
| 5.0.x   | :x:                |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

Use this section to tell people how to report a vulnerability.

Tell them where to go, how often they can expect to get an update on a
reported vulnerability, what to expect if the vulnerability is accepted or
declined, etc.

## Content Security Policy (CSP) Guardrails

This project follows a strict CSP posture designed to reduce XSS risk:

- Keep `script-src` limited to trusted origins and never add `unsafe-eval`.
- Avoid JavaScript patterns that require dynamic code execution (`eval`, `new Function`, string-based timers).
- Prefer external scripts and styles; if inline code is required, use nonces or hashes that rotate per response.
- Keep `object-src 'none'`, `frame-ancestors 'none'`, and related hardening headers enabled.

When introducing third-party libraries, verify they do not require `unsafe-eval` before approval.
