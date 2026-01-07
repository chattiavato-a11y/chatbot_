/* worker/assistant-template.js
   OPS ONLINE ASSISTANT — BRAIN (v3.2.2)
   Called ONLY by ops-gateway via Service Binding (env.BRAIN.fetch)

   Enhancements:
   - OWASP-style API security headers aligned with Gateway (CSP, Permissions-Policy, CORP, etc.)
   - Blocks data:...;base64 payloads (upload attempts)
   - Strong HMAC verification (ts + nonce + method + path + bodySha)
   - Optional nonce replay cache (KV: OPS_NONCE preferred; OPS_RL fallback)
   - Request-ID passthrough (X-Ops-Request-Id)

   REQUIRED:
   - Secret: HAND_SHAKE (same value as Gateway)
   - Workers AI binding on Brain: AI (optional but recommended)

   OPTIONAL:
   - KV namespace: OPS_NONCE (preferred) OR OPS_RL (fallback) for replay cache
*/

import { OPS_SITE, OPS_SITE_RULES_EN, OPS_SITE_RULES_ES } from "./ops-site-content.js";

const CHAT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_BODY_BYTES = 16_384;
const MAX_MSG_CHARS = 256;
const MAX_HISTORY_ITEMS = 12;

// anti-replay window
const SIG_MAX_SKEW_MS = 5 * 60 * 1000;

// tokens cut ~50%
const MAX_OUTPUT_TOKENS = 774;

// KV constraints: Cloudflare KV expirationTtl must be >= 60 seconds
const NONCE_TTL_SECONDS = 600;

/* ------------ “Compliance-aligned” security headers (OWASP-friendly) ------------ */

const API_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'none'"
].join("; ");

const PERMISSIONS_POLICY = [
  "accelerometer=()","autoplay=()","camera=()","display-capture=()","encrypted-media=()","fullscreen=()",
  "geolocation=()","gyroscope=()","magnetometer=()","microphone=()","midi=()","payment=()",
  "picture-in-picture=()","publickey-credentials-get=()","screen-wake-lock=()","usb=()","bluetooth=()",
  "clipboard-read=()","clipboard-write=()","gamepad=()","hid=()","idle-detection=()","serial=()",
  "web-share=()","xr-spatial-tracking=()"
].join(", ");

function systemPrompt(lang) {
  const rules = (lang === "es") ? OPS_SITE_RULES_ES : OPS_SITE_RULES_EN;

  const positioning = (lang === "es") ? OPS_SITE.positioning_es : OPS_SITE.positioning_en;
  const services = (lang === "es") ? OPS_SITE.services_es : OPS_SITE.services_en;
 
::contentReference[oaicite:0]{index=0}
