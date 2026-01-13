/* worker/ops-site-content.js
   OPS SITE CONTENT (v3.2)
   - Single source of truth for “site facts” used by ops-brain.js
   - Keep this plain data + simple rules (no secrets, no KV, no bindings)
*/

export const OPS_SITE = {
  brand: "OPS Online Support",
  base_url: "https://opsonlinesupport.com",

  routes: {
    home: "/",
    about: "/pages/about.html",
    contact: "/pages/contact.html",
    policies: "/pages/policies.html",
    careers: "/pages/join.html"
  },

  positioning_en:
    "OPS Online Support provides remote operations support, contact center services, IT support, and professionals on-demand, designed for quality CX/UX and lead generation.",
  positioning_es:
    "OPS Online Support ofrece soporte remoto de operaciones, contact center, soporte IT y profesionales bajo demanda, enfocado en CX/UX de alta calidad y generación de leads.",

  services_en: [
    "Business Operations support (admin, back office, process support).",
    "Contact Center support (customer support, inbound/outbound, CX metrics).",
    "IT Support (helpdesk, troubleshooting, basic systems support).",
    "Professionals On Demand (specialized support by request)."
  ],
  services_es: [
    "Soporte de Operaciones de Negocio (administración, back office, procesos).",
    "Contact Center (soporte al cliente, inbound/outbound, métricas CX).",
    "Soporte IT (helpdesk, troubleshooting, soporte básico).",
    "Profesionales Bajo Demanda (soporte especializado bajo solicitud)."
  ],

  contact_cta_en:
    "If you want pricing, onboarding, or a tailored recommendation, use the Contact page.",
  contact_cta_es:
    "Si deseas precios, onboarding o una recomendación a tu medida, usa la página de Contacto.",

  careers_cta_en:
    "If you want to join the team, use the Join/Careers page.",
  car
