# Chattia UI

Static chat interface for the Chattia assistant, tuned for security-first deployments.

## Quick start

Open `index.html` in a local server (for example `python3 -m http.server`) and navigate to the page.

## Security headers

The `_headers` file provides recommended HTTP response headers for static hosts that support it
(Netlify, Cloudflare Pages, etc.). Ensure your hosting platform applies these headers in production.

## Worker configuration

`worker.config.json` defines the worker endpoint, allowed origins, and required headers. The UI
loads this file at runtime to validate origin access and enforce required headers.
