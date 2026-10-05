/**
 * RELEASE-BLOCKING (tracker ID 118).
 *
 * Middleware does not protect /api/* by itself, so a route handler that forgets
 * to check who is calling is open to anyone with the URL. That is how dealer
 * names and phone numbers, AI calls to dealers and lead writes were reachable
 * with no login. This test is the thing that notices the next one.
 *
 * Every route file under src/app/api must be ONE of:
 *
 *   1. checked    it calls a session helper (requireRole, guardApi,
 *                 requireLeadAccess, auth.getUser, …);
 *   2. public     its path is on the public list (src/lib/security/publicApi.ts),
 *                 with the reason written next to it;
 *   3. delegated  it only forwards to another route's handlers, which check;
 *   4. inert      it answers a fixed 4xx / 5xx and touches nothing.
 *
 * If you are here because this failed: add the login check to the route. Only
 * put a path on the public list when someone with NO login is meant to call it
 * — and say how that caller is authenticated instead.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLIC_API_RULES, apiGate, apiGateMode, isPublicApiPath } from "../publicApi";

const API_DIR = join(process.cwd(), "src", "app", "api");

/** A call that establishes WHO is calling from the session. */
const SESSION_CHECK = new RegExp(
  [
    String.raw`\brequire[A-Z]\w*\s*\(`, // requireRole, requireAuth, requireLeadAccess, requireNbfcAccess, …
    String.raw`\bguardApi\s*\(`,
    String.raw`\bgetSessionUser\s*\(`,
    String.raw`\bresolve\w*Actor\s*\(`,
    String.raw`\bgetAuthenticatedAppUser\s*\(`,
    String.raw`\bgetEcofyLeadForViewer\s*\(`,
    String.raw`auth\.getUser\s*\(`,
    String.raw`auth\.getClaims\s*\(`,
  ].join("|"),
);

/** Routes that only re-export / forward to another route's (checked) handlers. */
const DELEGATED: Record<string, string> = {
  "/api/ai-dialer/campaigns/[id]/leads/[leadId]/intent-feedback":
    "forwards to /api/dealer-leads/[id]/intent-feedback, which enforces INTENT_REVIEW_ROLES",
};

/** Retired or unimplemented routes: a fixed error and nothing else. */
const INERT: Record<string, string> = {
  "/api/dealer-onboarding/upload-document": "501 Not implemented",
  "/api/lead/[id]/close-offer": "410 — offer negotiation retired",
  "/api/lead/[id]/negotiate-offer": "410 — offer negotiation retired",
  "/api/nbfc/auction/lots/[id]/bid": "403 — NBFC bidding withdrawn",
  "/api/nbfc/offer/[leadId]/fix": "410 — fixing an offer retired",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

/** Comments stripped: a route may EXPLAIN that it needs requireRole without calling it. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const urlOf = (file: string) =>
  "/api/" + relative(API_DIR, file).split(sep).slice(0, -1).join("/");

/** A concrete path for the pattern match: [id] → x, [...path] → x/y. */
const sample = (url: string) => url.replace(/\[\.\.\.[^\]]+\]/g, "x/y").replace(/\[[^\]]+\]/g, "x");

const routes = walk(API_DIR).map((file) => ({ file, url: urlOf(file), src: code(file) }));

/** The route file a concrete path lands on: [id] is one segment, [...path] is the rest. */
const routePattern = (url: string) =>
  new RegExp(
    "^" +
      url
        .split("/")
        .map((seg) => (seg.startsWith("[...") ? ".+" : seg.startsWith("[") ? "[^/]+" : seg.replace(/[^\w-]/g, "\\$&")))
        .join("/") +
      "$",
  );

/**
 * A public rule that names a VALUE of a dynamic segment cannot be matched by
 * the generic sample ("/api/files/x/x/y"), so it gives a real path instead.
 */
const RULE_EXAMPLES: Record<string, string> = {
  [String(/^\/api\/files\/dealer-documents\//)]: "/api/files/dealer-documents/onboarding/a.pdf",
};

/**
 * Handlers that are fine without a session check of their own, one method of a
 * route whose other method does check.
 */
const HANDLER_EXEMPT: Record<string, string> = {
  "POST /api/admin/lead/[id]/reject-loan": "retired — fixed 410",
  "POST /api/admin/lead/[id]/sanction-loan": "retired — fixed 410 (POST_DEPRECATED)",
  "GET /api/admin/nbfc-requests/[id]/act":
    "the emailed act-token (sha256 + expiry) is the credential for the read; the POST also needs an admin session",
};

const HANDLER = /^export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/gm;
const LOCAL_FN = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|^const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm;

/** The exported handlers of a route that neither check the caller nor call a local helper that does. */
function uncheckedHandlers(src: string): string[] {
  const handlers = [...src.matchAll(HANDLER)];
  const fns = [...src.matchAll(LOCAL_FN)];
  const starts = [...handlers, ...fns].map((m) => m.index!).sort((a, b) => a - b);
  const body = (from: number) => src.slice(from, starts.find((x) => x > from) ?? src.length);

  const checkingHelpers = fns.filter((m) => SESSION_CHECK.test(body(m.index!))).map((m) => m[1] ?? m[2]);

  return handlers
    .filter((m) => {
      const text = body(m.index!);
      if (SESSION_CHECK.test(text)) return false;
      // Calls a checking helper, or IS one: `export const GET = handle;`.
      return !checkingHelpers.some((h) => new RegExp(String.raw`\b${h}\s*\(|=\s*${h}\s*;`).test(text));
    })
    .map((m) => m[1]);
}

describe("every API route says who may call it", () => {
  it("finds the routes — a moved folder would make this vacuously pass", () => {
    expect(routes.length).toBeGreaterThan(900);
  });

  it("no route is left with neither a login check nor a place on the public list", () => {
    const unprotected = routes
      .filter((r) => !SESSION_CHECK.test(r.src))
      .filter((r) => !isPublicApiPath(sample(r.url)))
      .filter((r) => !(r.url in DELEGATED) && !(r.url in INERT))
      .map((r) => r.url)
      .sort();

    expect(
      unprotected,
      "these API routes can be called by anyone with the URL — add requireRole / guardApi / " +
        "requireLeadAccess, or (only if a caller with no login is intended) list the path in " +
        "src/lib/security/publicApi.ts with the reason",
    ).toEqual([]);
  });

  it("a route that checks one method checks them all — a guarded POST beside an open GET is still open", () => {
    const open = routes
      .filter((r) => SESSION_CHECK.test(r.src))
      .filter((r) => !isPublicApiPath(sample(r.url)))
      .flatMap((r) => uncheckedHandlers(r.src).map((method) => `${method} ${r.url}`))
      .filter((key) => !(key in HANDLER_EXEMPT))
      .sort();

    expect(
      open,
      "these handlers sit in a route file that checks the caller, but do not check it themselves",
    ).toEqual([]);
  });

  it("an inert route really is inert: no database, no outbound call", () => {
    for (const url of Object.keys(INERT)) {
      const r = routes.find((x) => x.url === url);
      expect(r, `${url} is listed as inert but the file is gone — remove it from INERT`).toBeDefined();
      expect(/\bdb\.|\bfetch\(|@\/lib\/db/.test(r!.src), `${url} is listed as inert but does real work`).toBe(false);
    }
  });

  it("a delegated route still exists and still forwards", () => {
    for (const url of Object.keys(DELEGATED)) {
      const r = routes.find((x) => x.url === url);
      expect(r, `${url} is listed as delegated but the file is gone`).toBeDefined();
      expect(r!.src).toMatch(/from\s+["']@\/app\/api\//);
    }
  });

  it("every cron route checks the cron secret — being on the public list is not a check", () => {
    const open = routes
      .filter((r) => /^\/api\/cron\//.test(r.url) || /\/cron(\/|$)/.test(r.url))
      .filter((r) => !/CRON_SECRET|checkCronAuth\s*\(/.test(r.src))
      .map((r) => r.url);
    expect(open, "a cron route with no CRON_SECRET check runs for anyone who calls it").toEqual([]);
  });

  it("no route trusts a bare x-vercel-cron header — off Vercel anyone can send one", () => {
    // The sandbox and production run on a VPS, where the header is not
    // stripped. fromVercelCron (security/cronAuth.ts) trusts it on Vercel only.
    const forgeable = routes
      .filter((r) => /headers\.get\(\s*["']x-vercel-cron["']\s*\)/.test(r.src))
      .map((r) => r.url);
    expect(forgeable, "read the header through fromVercelCron(req), never directly").toEqual([]);
  });

  it("every public rule still matches a real route — a stale rule is an open door for the next route at that path", () => {
    const stale = PUBLIC_API_RULES.filter((rule) => {
      const example = RULE_EXAMPLES[String(rule.pattern)];
      if (example) return !(rule.pattern.test(example) && routes.some((r) => routePattern(r.url).test(example)));
      return !routes.some((r) => rule.pattern.test(sample(r.url)));
    }).map((rule) => String(rule.pattern));
    expect(stale).toEqual([]);
  });

  it("the three routes nothing called are gone", () => {
    for (const url of ["/api/bolna-test", "/api/ai-dialer/run", "/api/leads/assign"]) {
      expect(routes.some((r) => r.url === url), url).toBe(false);
    }
  });
});

/**
 * "No session" is not "no check". A route on the public list still has to prove
 * its caller — a cron bearer, a provider signature, a token from the link — or
 * be named below with the reason nobody can be asked for proof.
 */
const CALLER_PROOF = new RegExp(
  [
    // provider webhooks and NBFC callbacks (src/lib/security/webhookAuth.ts)
    String.raw`\bguard(Webhook|DigioWebhook|BolnaCall)\s*\(`,
    String.raw`\bcheckWebhook\s*\(`,
    String.raw`\binboundCallbackAllowed\s*\(`,
    String.raw`\bverify\w+\s*\(`, // verifySignature, verifyWebhookSignature, verifyBolnaWebhook, verifyInbound, …
    String.raw`\bnew Receiver\s*\(`, // QStash
    // crons and machines
    String.raw`\bcheckCronAuth\s*\(`,
    String.raw`CRON_SECRET`,
    String.raw`\bwithBotAuth\s*\(`,
    String.raw`\b[A-Z][A-Z_]*_SECRET\b`,
    String.raw`\bcreateHmac\s*\(`,
    // links: the token in the path or body is looked up
    String.raw`\b\w*Token\w*\s*\(`,
    String.raw`\b(consent|upload)_token\b`,
  ].join("|"),
);

const OPEN_BY_DESIGN: Record<string, string> = {
  "/api/auth/logout": "ends the caller's own session; nothing to protect",
  "/api/health": "uptime probe; returns no data",
  "/api/public/auctions": "the public auction window — published lots only",
  "/api/vendor/register": "scrap-vendor self-registration; creates a pending vendor for admin review",
  "/api/uploads/dealer-documents": "pre-login dealer onboarding and the correction link upload here",
  "/api/dealer-onboarding/salespeople": "salesperson dropdown on the pre-login onboarding form; names and roles only (ID 66)",
  "/api/internal/log-client-error": "browser error log; a signed-out page can fail too",
  // No provider signature exists. These only FLAG a row or record consent; the
  // result itself is fetched from Decentro with our credentials, so a forged
  // call cannot plant data.
  "/api/kyc/decentro/active-video-liveness/callback": "Decentro: no signature; flags the row, result is fetched",
  "/api/kyc/decentro/active-video-liveness/return": "customer landing page; no writes",
  "/api/kyc/digilocker/callback": "DigiLocker browser redirect; consent flag only",
  "/api/kyc/digilocker/callback/[transactionId]": "DigiLocker browser redirect; e-Aadhaar is fetched from Decentro",
  "/api/kyc/digilocker/callback/coborrower/[leadId]": "DigiLocker browser redirect; consent flag only",
  "/api/leads/digilocker/callback/[transactionId]": "DigiLocker browser redirect; e-Aadhaar is fetched from Decentro",
};

describe("a public route still proves its caller", () => {
  const publicRoutes = routes.filter(
    (r) => isPublicApiPath(sample(r.url)) || Object.values(RULE_EXAMPLES).some((ex) => routePattern(r.url).test(ex)),
  );

  it("finds them", () => {
    expect(publicRoutes.length).toBeGreaterThan(80);
  });

  it("every public route checks a secret, a signature or a token — or is listed as open by design", () => {
    const unproven = publicRoutes
      .filter((r) => !CALLER_PROOF.test(r.src) && !SESSION_CHECK.test(r.src))
      .filter((r) => !(r.url in OPEN_BY_DESIGN))
      .map((r) => r.url)
      .sort();

    expect(
      unproven,
      "these routes take calls with no login and no proof of who is calling — verify the provider " +
        "(src/lib/security/webhookAuth.ts) or add the route to OPEN_BY_DESIGN with the reason",
    ).toEqual([]);
  });

  it("the open-by-design list has no dead or already-checked entries", () => {
    for (const url of Object.keys(OPEN_BY_DESIGN)) {
      const r = routes.find((x) => x.url === url);
      expect(r, `${url} is listed as open by design but the file is gone`).toBeDefined();
      expect(CALLER_PROOF.test(r!.src), `${url} now checks its caller — remove it from OPEN_BY_DESIGN`).toBe(false);
    }
  });

  it("the webhooks that were unsigned now go through the verifier", () => {
    const mustVerify: Record<string, RegExp> = {
      "/api/webhooks/digio": /guardDigioWebhook\(/,
      "/api/digio/webhook/loan-agreement": /guardDigioWebhook\(/,
      "/api/digio/webhook/nbfc": /guardDigioWebhook\(/,
      "/api/esign/[provider]/webhook": /checkWebhook\(/,
      "/api/webhooks/bolna": /guardBolnaCall\(/,
      "/api/ceo/ai-dialer/webhook/bolna": /guardBolnaCall\(/,
      "/api/bolna/tools/price-lookup": /guardBolnaCall\(/,
      "/api/nbfc/enach/callback": /inboundCallbackAllowed\(/,
      "/api/nbfc/vkyc/callback": /inboundCallbackAllowed\(/,
      "/api/nbfc/agreement/callback": /inboundCallbackAllowed\(/,
    };
    for (const [url, marker] of Object.entries(mustVerify)) {
      const r = routes.find((x) => x.url === url);
      expect(r, url).toBeDefined();
      expect(r!.src, url).toMatch(marker);
    }
  });

  it("an unsigned KYC callback never takes its result from the request", () => {
    // These are open by design BECAUSE they only flag a row; the result is
    // fetched from Decentro. A handler that reads the body, or writes a
    // verification, would let a forged call plant a KYC result.
    for (const url of [
      "/api/kyc/digilocker/callback",
      "/api/kyc/digilocker/callback/[transactionId]",
      "/api/kyc/digilocker/callback/coborrower/[leadId]",
      "/api/leads/digilocker/callback/[transactionId]",
    ]) {
      const r = routes.find((x) => x.url === url);
      expect(r, url).toBeDefined();
      expect(r!.src, `${url} reads a request body`).not.toMatch(/\.json\(\)|\.formData\(\)|\.text\(\)/);
    }
    const digi = routes.find((x) => x.url === "/api/kyc/digilocker/callback/[transactionId]")!.src;
    expect(digi, "the DigiLocker callback must not write a verification result").not.toMatch(/kycVerifications/);
  });

  it("a verifier runs before the route reads or writes anything", () => {
    // The guard call must come before the first database touch in the handler.
    for (const url of ["/api/webhooks/digio", "/api/digio/webhook/loan-agreement", "/api/digio/webhook/nbfc", "/api/webhooks/bolna", "/api/ceo/ai-dialer/webhook/bolna", "/api/bolna/tools/price-lookup"]) {
      const src = routes.find((x) => x.url === url)!.src;
      const handler = src.slice(src.search(/export (async function|const) POST/));
      const guardAt = handler.search(/guard(DigioWebhook|BolnaCall)\(/);
      const dbAt = handler.search(/\bdb\.|applyAgreementWebhookEvent\(|handleBolnaWebhook\(|findProduct\(/);
      expect(guardAt, `${url}: no guard in the POST handler`).toBeGreaterThan(-1);
      expect(dbAt === -1 || guardAt < dbAt, `${url}: the guard must run before any work`).toBe(true);
    }
  });
});

describe("the public list", () => {
  it("admits what must work without a login", () => {
    for (const p of [
      "/api/auth/forgot-password",
      "/api/cron/dealer-agreement-refresh",
      "/api/webhooks/digio",
      "/api/payments/razorpay/webhook",
      "/api/payments/razorpay/emi-webhook",
      "/api/whatsapp/webhook",
      "/api/neodove/webhook",
      "/api/public/quotations/abc.def",
      "/api/nbfc/recovery/agent-form/tok/visit",
      "/api/onboarding/correct/tok",
      "/api/kyc/digilocker/callback/DIGI-1",
      "/api/kyc/digilocker/callback",
      "/api/files/dealer-documents/agreements/1/a.pdf",
      "/api/bot/campaigns/1/start",
      "/api/health",
    ]) {
      expect(isPublicApiPath(p), p).toBe(true);
    }
  });

  it("does not admit the routes that were open", () => {
    for (const p of [
      "/api/ai-dialer/campaigns",
      "/api/ai-dialer/campaigns/7/leads",
      "/api/ai-dialer",
      "/api/leads/L-1/summary",
      "/api/kyc/L-1/upload-document",
      "/api/coborrower/L-1/documents",
      "/api/region-groups",
      "/api/files/documents/kyc/L-1/pan.jpg",
      "/api/files/call-recordings/a.mp3",
      "/api/dealer-leads",
      "/api/admin/leads/bulk",
      "/api/integrations/digio/create-agreement",
      // look-alikes of public paths
      "/api/public",
      "/api/healthz",
      "/api/auth/change-password",
      "/api/webhooksx/digio",
    ]) {
      expect(isPublicApiPath(p), p).toBe(false);
    }
  });
});

describe("the middleware gate", () => {
  it("defaults to report; only the two explicit values change it", () => {
    expect(apiGateMode(undefined)).toBe("report");
    expect(apiGateMode("")).toBe("report");
    expect(apiGateMode("anything")).toBe("report");
    expect(apiGateMode(" Enforce ")).toBe("enforce");
    expect(apiGateMode("off")).toBe("off");
  });

  it("a signed-in request and a public path always pass", () => {
    for (const mode of ["enforce", "report"] as const) {
      expect(apiGate({ pathname: "/api/dealer-leads", hasSession: true, mode })).toBe("allow");
      expect(apiGate({ pathname: "/api/webhooks/digio", hasSession: false, mode })).toBe("allow");
      expect(apiGate({ pathname: "/_next/data/x.json", hasSession: false, mode })).toBe("allow");
    }
  });

  it("an anonymous call to a private route is refused in enforce, only logged in report, ignored when off", () => {
    const anon = { pathname: "/api/ai-dialer/campaigns/7/leads", hasSession: false };
    expect(apiGate({ ...anon, mode: "enforce" })).toBe("refuse");
    expect(apiGate({ ...anon, mode: "report" })).toBe("report");
    expect(apiGate({ ...anon, mode: "off" })).toBe("allow");
  });
});
