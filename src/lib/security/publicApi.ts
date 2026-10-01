// The API routes that may be reached WITHOUT a signed-in session (tracker ID
// 118). Everything else under /api/* needs a login.
//
// Why a list. Middleware used to let every /api request through, so a route
// that forgot its own check was open to anyone with the URL — dealer names and
// phone numbers, AI calls to dealers, lead writes. Each handler now checks who
// is calling, and this list is the other half: the routes that are public ON
// PURPOSE, each with the reason. Two things read it:
//
//   - middleware (apiGate below): an /api request with no session that is not
//     on this list is refused, or — in report mode — logged;
//   - the contract test (__tests__/api-auth.contract.test.ts): every route file
//     must either check the caller itself or be on this list, so a new
//     unprotected route fails the build instead of shipping.
//
// "Public" here means "no SESSION". Most of these still authenticate the
// caller another way — a cron bearer, a provider signature, a device token, a
// single-use token in the path. The `why` says which. Provider webhooks go
// through src/lib/security/webhookAuth.ts; the contract test fails a webhook
// route that checks nothing.
//
// Pure and dependency-free: middleware imports it.

export type PublicApiRule = { pattern: RegExp; why: string };

export const PUBLIC_API_RULES: readonly PublicApiRule[] = [
  // ── sign-in / password flows: the caller has no session by definition
  { pattern: /^\/api\/auth\/(logout|forgot-password|reset-password)$/, why: "password reset and logout work without a session" },

  // ── scheduled jobs: Bearer CRON_SECRET (checkCronAuth)
  { pattern: /^\/api\/cron\//, why: "cron — Bearer CRON_SECRET" },
  { pattern: /^\/api\/(bolna|elevenlabs)\/call-scheduler$/, why: "cron — Bearer CRON_SECRET" },
  { pattern: /^\/api\/scraper\/cron$/, why: "cron — Bearer CRON_SECRET" },
  { pattern: /^\/api\/nbfc\/dpdpa\/retention\/cron$/, why: "cron — Bearer CRON_SECRET" },
  { pattern: /^\/api\/nbfc\/dual-approval\/cron\/expire$/, why: "cron — Bearer CRON_SECRET" },
  { pattern: /^\/api\/health\/redis$/, why: "Bearer CRON_SECRET" },

  // ── queue workers: Upstash QStash signature
  { pattern: /^\/api\/(bolna|elevenlabs)\/dispatch-call$/, why: "QStash signature" },
  { pattern: /^\/api\/scraper\/(chunk|finalize)$/, why: "QStash signature" },

  // ── provider webhooks and callbacks: the provider calls us
  { pattern: /^\/api\/webhooks\//, why: "provider webhook — Bolna: bearer BOLNA_WEBHOOK_SECRET; Digio: X-Digio-Checksum" },
  { pattern: /^\/api\/(bolna|elevenlabs|neodove|whatsapp)\/webhook$/, why: "provider webhook" },
  { pattern: /^\/api\/assistant\/wa\/webhook$/, why: "Meta WhatsApp webhook — signature / verify token" },
  { pattern: /^\/api\/ceo\/ai-dialer\/webhook\//, why: "Bolna webhook — bearer BOLNA_WEBHOOK_SECRET" },
  { pattern: /^\/api\/bolna\/tools\//, why: "tool calls made by the Bolna voice agent during a call — bearer BOLNA_TOOL_SECRET" },
  { pattern: /^\/api\/payments\/razorpay\/[a-z-]*webhook$/, why: "Razorpay webhook — signature" },
  { pattern: /^\/api\/digio\/webhook\//, why: "Digio webhook — X-Digio-Checksum (DIGIO_WEBHOOK_SECRET)" },
  { pattern: /^\/api\/esign\/[^/]+\/webhook$/, why: "e-sign provider webhook — the provider checksum, keyed with the NBFC account secret" },
  { pattern: /^\/api\/integrations\/ecofy\/events$/, why: "Ecofy → CRM events — HMAC signature" },
  { pattern: /^\/api\/nbfc\/(agreement|enach|vkyc)\/callback$/, why: "NBFC result callback — X-iTarang-Signature; the Decentro VKYC leg only flags, the result is fetched" },
  { pattern: /^\/api\/kyc\/decentro\/active-video-liveness\/(callback|return)$/, why: "Decentro has no signature here — the callback only flags the row; the result is fetched from Decentro" },
  { pattern: /^\/api\/kyc\/digilocker\/callback(\/|$)/, why: "DigiLocker browser redirect — cannot be signed; the Aadhaar data is fetched from Decentro" },
  { pattern: /^\/api\/leads\/digilocker\/callback\//, why: "DigiLocker browser redirect — cannot be signed; the Aadhaar data is fetched from Decentro" },

  // ── machines: their own key or token
  { pattern: /^\/api\/bot\//, why: "bot API — Bearer BOT_API_KEY (withBotAuth)" },
  { pattern: /^\/api\/iot\/ingest$/, why: "IoT ingestion — device token" },
  { pattern: /^\/api\/admin\/sales-invoices\/drive\/scan$/, why: "scanner — device token, or a signed-in role" },
  { pattern: /^\/api\/operations\/ingest\//, why: "host metrics ingestion — bearer" },
  { pattern: /^\/api\/internal\/security-events$/, why: "middleware → app, x-internal-secret" },
  { pattern: /^\/api\/internal\/log-client-error$/, why: "browser error log; a signed-out page can fail too" },
  { pattern: /^\/api\/admin\/nbfc\/[^/]+\/test-only\//, why: "test bypass header; refuses in production" },

  // ── links sent to people who have no login: the token in the path is the credential
  { pattern: /^\/api\/public\//, why: "public by design — auction window, quotation link, document-upload link" },
  { pattern: /^\/api\/coborrowerconsent\//, why: "co-borrower consent link — token" },
  { pattern: /^\/api\/nbfc\/fi\/field-form\//, why: "field-investigation agent form — token" },
  { pattern: /^\/api\/nbfc\/recovery\/agent-form\//, why: "recovery agent form — token" },
  { pattern: /^\/api\/nbfc\/vkyc\/capture\//, why: "customer video-KYC capture — token" },
  { pattern: /^\/api\/onboarding\/correct\//, why: "dealer correction link — token" },

  // ── dealer / vendor onboarding: a prospective dealer has no account yet
  { pattern: /^\/api\/vendor\/register$/, why: "scrap-vendor self-registration" },
  { pattern: /^\/api\/dealer\/onboarding\/(submit|status)$/, why: "pre-login dealer onboarding form" },
  { pattern: /^\/api\/uploads\/dealer-documents$/, why: "uploads from the pre-login onboarding form and the correction link" },
  { pattern: /^\/api\/files\/dealer-documents\//, why: "reads of what the pre-login onboarding form uploaded (random keys)" },

  // ── monitoring
  { pattern: /^\/api\/health$/, why: "uptime probe" },
];

/** True when this API path may be called with no session. */
export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_RULES.some((r) => r.pattern.test(pathname));
}

/**
 * What middleware does with an /api request that has no session and is not on
 * the list:
 *
 *   enforce  refuse it — 401, before any route code runs
 *   report   let it through and log it (the default)
 *   off      do nothing
 *
 * WHY THE DEFAULT IS "report". Every route now checks its own caller, so the
 * holes are closed with or without this gate; the gate is the safety net for
 * the NEXT route somebody forgets. But a wrong list entry in enforce mode
 * turns away a payment webhook or a customer's e-sign callback, and those
 * cannot be replayed. So it ships logging what it WOULD refuse; once the log
 * (`[api-gate] would refuse …`) has been quiet through a normal week, set
 * API_AUTH_GATE=enforce.
 */
export type ApiGateMode = "enforce" | "report" | "off";

export function apiGateMode(raw: string | undefined = process.env.API_AUTH_GATE): ApiGateMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "enforce" || v === "off" ? v : "report";
}

export type ApiGateVerdict = "allow" | "report" | "refuse";

/** The gate's decision for one request. Pure. */
export function apiGate(input: { pathname: string; hasSession: boolean; mode?: ApiGateMode }): ApiGateVerdict {
  const mode = input.mode ?? apiGateMode();
  if (mode === "off" || input.hasSession) return "allow";
  if (!input.pathname.startsWith("/api/")) return "allow";
  if (isPublicApiPath(input.pathname)) return "allow";
  return mode === "enforce" ? "refuse" : "report";
}
