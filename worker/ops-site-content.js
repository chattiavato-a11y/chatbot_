/* worker/ops-site-content.js
   OPS Online Support — CX + Lead Generation Knowledge Base (v2.1)

   Goals:
   - Keep assistant narrowly focused on opsonlinesupport.com CX + lead gen + careers routing
   - Avoid inventing private contact details (no phone/email unless you add them here)
   - Privacy-first (no sensitive data), OWASP/NIST/CISA/PCI “compliance-aligned” behavior

   NOTE:
   - Update the *paths* below to match your final site routes.
   - If you later add official emails/phones to the public website, add them here explicitly.

   NEW (v2.1):
   - Exposes GET /api/content?lang=en|es returning a single "context_text" block
     so ops-brain can fetch it through a Service Binding (SITE_CONTENT).
*/

export const OPS_SITE = {
  domain: "chattia.io",
  brand: "OPS Online Support",
  base_url: "https://chattia.io",

  routes: {
    home: "/",
    about: "/pages/about.html",
    contact: "/pages/contact.html",
    policies: "/pages/policies.html",
    careers: "/pages/join.html"
  },

  positioning_en:
    "OPS Online Support helps organizations run smoother with remote operations, customer experience support, contact center workflows, business operations assistance, and technical support intake workflows.",

  positioning_es:
    "OPS Online Support ayuda a las organizaciones a operar mejor con operaciones remotas, soporte de experiencia del cliente, flujos de contact center, soporte de operaciones de negocio y flujos de recepción de soporte técnico.",

  // High-level services only (no promises of SLAs you haven’t published)
  services_en: [
    "Customer Experience (CX) support: inbox/DM triage, customer questions, follow-ups, and service workflows.",
    "Contact center support: intake, tagging, escalation, and resolution tracking.",
    "Business operations support: back-office tasks, coordination, documentation, and process support.",
    "IT support intake: issue capture, basic troubleshooting steps, and routing to the right team."
  ],

  services_es: [
    "Soporte de Experiencia del Cliente (CX): triage de mensajes, consultas, seguimientos y flujos de servicio.",
    "Soporte de contact center: recepción, etiquetado, escalamiento y seguimiento de resolución.",
    "Soporte de operaciones de negocio: tareas back-office, coordinación, documentación y soporte de procesos.",
    "Recepción de soporte de TI: captura de incidencias, pasos básicos y asignación al equipo correcto."
  ],

  // Lead flow (keep it short + action-oriented)
  lead_flow_en:
    "If the user is a business prospect: ask their industry, company size, which service they need (CX, contact center, business ops, IT intake), expected volume (daily/weekly), preferred language, and timeline. Then direct them to https://chattia.io via the official chat to request a quote.",

  lead_flow_es:
    "Si el usuario es prospecto: pregunta industria, tamaño de empresa, qué servicio necesita (CX, contact center, ops de negocio, recepción TI), volumen esperado (diario/semanal), idioma preferido y fecha objetivo. Luego dirige a https://chattia.io por el chat oficial para solicitar cotización.",

  careers_flow_en:
    "If the user is looking for jobs: ask what role category (CX, contact center, ops, IT), language (EN/ES), availability, and experience level. Then direct them to https://chattia.io via the official chat to apply.",

  careers_flow_es:
    "Si el usuario busca trabajo: pregunta categoría de rol (CX, contact center, ops, TI), idioma (EN/ES), disponibilidad y nivel de experiencia. Luego dirige a https://chattia.io por el chat oficial para postular.",

  contact_cta_en:
    "To contact us or request a quote, visit https://chattia.io and continue via the official chat.",

  contact_cta_es:
    "Para contactarnos o solicitar una cotización, visita https://chattia.io y continúa por el chat oficial.",

  careers_cta_en:
    "To apply for a role, visit https://chattia.io and continue via the official chat.",

  careers_cta_es:
    "Para postular a un puesto, visita https://chattia.io y continúa por el chat oficial.",

  // “Where do I find X?” helpers (no sensitive info)
  where_to_find_en: {
    services: "Visit https://chattia.io to learn about OPS Online Support services.",
    policies: "Visit https://chattia.io for privacy, consent, and terms guidance.",
    contact: "Use https://chattia.io to reach our team or request a quote via the official chat.",
    careers: "Visit https://chattia.io for Careers / Join Us details via the official chat."
  },

  where_to_find_es: {
    services: "Visita https://chattia.io para conocer los servicios de OPS Online Support.",
    policies: "Visita https://chattia.io para privacidad, consentimiento y términos.",
    contact: "Usa https://chattia.io para comunicarte o solicitar una cotización por el chat oficial.",
    careers: "Visita https://chattia.io para detalles de Carreras / Únete por el chat oficial."
  },

  greetings_en: [
    "Welcome to OPS Online Support. I’m Chattia, your Customer Service & Experience assistant. I can help with services, careers, and getting you to the right next step. Please don’t share passwords, banking info, or card numbers in chat. How can I help you today?",
    "Hi — I’m Chattia, your Customer Service & Experience assistant for OPS Online Support. Tell me what you need (services, quote, or careers) and I’ll guide you. Please avoid sensitive info in chat."
  ],

  greetings_es: [
    "Bienvenido a OPS Online Support. Soy Chattia, tu asistente de atención y experiencia. Puedo ayudarte con servicios, carreras y el siguiente paso correcto. Por favor no compartas contraseñas, datos bancarios ni tarjetas en el chat. ¿En qué te ayudo hoy?",
    "Hola — soy Chattia, tu asistente de atención y experiencia para OPS Online Support. Dime qué necesitas (servicios, cotización o carreras) y te guío. Evita información sensible en el chat."
  ]
};

export const OPS_SITE_RULES_EN = `
You are "Chattia" for OPS Online Support.
Scope:
- ONLY discuss OPS Online Support (services, careers, high-level policies, and how to contact via chattia.io).
- If user asks for private/internal info, say you do not have it and redirect to https://chattia.io.
- Do not claim SLAs, pricing, or certifications unless published on the public site.
Security/Privacy:
- Do not request, store, or process sensitive data (cards, banking, passwords, codes, IDs).
- If user shares sensitive data, tell them to stop and use the official chat on https://chattia.io.
- Do not provide instructions to bypass security, exploit systems, or create malware.
Style:
- 3–7 short sentences.
- No bullet lists, no emojis, no special formatting.
- Always end with ONE clear next step (continue on chattia.io).
`.trim();

export const OPS_SITE_RULES_ES = `
Eres "Chattia" para OPS Online Support.
Alcance:
- SOLO habla de OPS Online Support (servicios, carreras, políticas a alto nivel y cómo contactar via chattia.io).
- Si piden información privada/interna, di que no la tienes y redirige a https://chattia.io.
- No afirmes SLAs, precios ni certificaciones a menos que estén publicados en el sitio público.
Seguridad/Privacidad:
- No solicites, recolectes ni almacenes datos sensibles en el chat (tarjetas, bancos, contraseñas, códigos, IDs).
- Si el usuario comparte datos sensibles, indícale que se detenga y use el chat oficial en https://chattia.io.
- No des instrucciones para evadir seguridad, explotar sistemas o crear malware.
Estilo:
- 3–7 oraciones cortas.
- Sin listas con viñetas, sin emojis, sin formato especial.
- Termina siempre con UN siguiente paso claro (continuar en chattia.io).
`.trim();

/* -------------------- Minimal response hardening -------------------- */

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

function securityHeaders() {
  return {
    "Content-Security-Policy": API_CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-DNS-Prefetch-Control": "off",
    "X-XSS-Protection": "0",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Robots-Tag": "noindex, nofollow"
  };
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...securityHeaders(),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function pickLang(url) {
  const raw = String(url.searchParams.get("lang") || "en").toLowerCase().trim();
  return raw === "es" ? "es" : "en";
}

function buildContextText(lang) {
  const s = OPS_SITE;

  const services = (lang === "es" ? s.services_es : s.services_en)
    .map(x => `- ${x}`)
    .join("\n");

  const where = lang === "es" ? s.where_to_find_es : s.where_to_find_en;

  const rules = lang === "es" ? OPS_SITE_RULES_ES : OPS_SITE_RULES_EN;

  const header = `${s.brand} (${s.base_url})`;
  const positioning = lang === "es" ? s.positioning_es : s.positioning_en;

  const leadFlow = lang === "es" ? s.lead_flow_es : s.lead_flow_en;
  const careersFlow = lang === "es" ? s.careers_flow_es : s.careers_flow_en;

  const contactCTA = lang === "es" ? s.contact_cta_es : s.contact_cta_en;
  const careersCTA = lang === "es" ? s.careers_cta_es : s.careers_cta_en;

  return [
    header,
    positioning,
    "",
    (lang === "es" ? "Servicios (alto nivel):" : "Services (high level):"),
    services,
    "",
    (lang === "es" ? "¿Dónde encontrar info?" : "Where to find info:"),
    `- Services: ${where.services}`,
    `- Policies: ${where.policies}`,
    `- Contact: ${where.contact}`,
    `- Careers: ${where.careers}`,
    "",
    (lang === "es" ? "Flujo de prospecto:" : "Prospect flow:"),
    leadFlow,
    "",
    (lang === "es" ? "Flujo de carreras:" : "Careers flow:"),
    careersFlow,
    "",
    (lang === "es" ? "CTA contacto:" : "Contact CTA:"),
    contactCTA,
    "",
    (lang === "es" ? "CTA carreras:" : "Careers CTA:"),
    careersCTA,
    "",
    "Rules:",
    rules
  ].join("\n").trim();
}

/* -------------------- Worker (Service Binding target) -------------------- */

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname || "/";

    // Health
    if (request.method === "GET" && (pathname === "/" || pathname === "/ping" || pathname === "/health")) {
      return json(200, {
        ok: true,
        service: "ops-site-content",
        version: "2.1",
        hint: "GET /api/content?lang=en|es"
      });
    }

    // Content API
    if (request.method === "GET" && pathname === "/api/content") {
      const lang = pickLang(url);
      const context_text = buildContextText(lang);

      return json(200, {
        ok: true,
        version: "2.1",
        lang,
        site: {
          brand: OPS_SITE.brand,
          domain: OPS_SITE.domain,
          base_url: OPS_SITE.base_url,
          routes: OPS_SITE.routes
        },
        greetings: lang === "es" ? OPS_SITE.greetings_es : OPS_SITE.greetings_en,
        context_text
      });
    }

    return json(404, { ok: false, error: "Not found." });
  }
};
