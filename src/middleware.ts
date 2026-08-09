import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { BUYBACK_ADMIN_ROLES } from "@/lib/buyback/roles";
import { detectThreat, detectBodyThreat, type ThreatSignal } from "@/lib/security/detect";
import { trackRequest, type RateSignal } from "@/lib/security/rate-watch";
import { postSecurityEvent, SECURITY_INGEST_PATH } from "@/lib/security/report-event";
import { clientIp } from "@/lib/security/client-ip";
import { fingerprintRequest } from "@/lib/security/fingerprint";
import { checkBlocked, recordStrike, shouldEmitBlockEvent } from "@/lib/security/blocklist";

// Prevents browsers from serving stale HTML across deploys. Applied to HTML
// responses only — _next/static assets are excluded by the matcher and keep
// their default long-lived, immutable caching (they're content-hashed).
function addNoStoreHeaders(response: NextResponse): NextResponse {
  response.headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  );
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

export async function middleware(request: NextRequest) {
  // Logout route clears cookies itself and must not pay for getUser() / DB
  // profile lookups — short-circuit before any Supabase calls.
  if (request.nextUrl.pathname === "/api/auth/logout") {
    return addNoStoreHeaders(
      NextResponse.next({ request: { headers: request.headers } }),
    );
  }

  // NBFC self-coding loop UI test bypass. Triple-guarded:
  //   1. NODE_ENV !== 'production'
  //   2. NBFC_TEST_BYPASS_SECRET set on the server
  //   3. Request carries header `x-nbfc-test-bypass` with that exact value
  //      (Playwright's page.setExtraHTTPHeaders attaches it on every request)
  // When all three match, skip auth and pass through. This lets E-001's AC4
  // load /admin/nbfc/[id]/review without a Supabase session, mirroring the
  // bypass already used by /api/admin/nbfc/** API tests.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.NBFC_TEST_BYPASS_SECRET &&
    request.headers.get("x-nbfc-test-bypass") ===
      process.env.NBFC_TEST_BYPASS_SECRET
  ) {
    return addNoStoreHeaders(
      NextResponse.next({ request: { headers: request.headers } }),
    );
  }

  // App Router prefetches/navigations fetch an RSC payload (marked by the
  // `RSC` header; prefetches also carry `Next-Router-Prefetch`). The no-store
  // header below is only meant for full HTML document loads (anti-stale across
  // deploys) — applying it to RSC responses tells the client router to treat
  // every prefetched <Link> as immediately stale, killing prefetch and making
  // navigations feel unresponsive (looks like the link needs multiple clicks).
  // For those requests we return the response without the no-store headers so
  // the router cache can keep the prefetch.
  const isRscRequest =
    request.headers.get("rsc") === "1" ||
    request.headers.has("next-router-prefetch");
  const finalize = (res: NextResponse): NextResponse =>
    isRscRequest ? res : addNoStoreHeaders(res);

  // ── Ban gate (E-216). An IP that has already proven hostile is refused HERE,
  // before the Supabase round-trip and before any route logic — the point of a
  // ban is that a banned attacker costs us nothing. The detector further down
  // only stops the ONE request whose payload matched a rule; this stops every
  // request from a sender that already earned a ban, however it is dressed up.
  // Only public source addresses are ever banned — see src/lib/security/blocklist.ts.
  if (
    process.env.SECURITY_DETECTION_ENABLED === "1" &&
    request.nextUrl.pathname !== SECURITY_INGEST_PATH
  ) {
    try {
      const bannedIp = clientIp(request.headers).ip;
      const ban = checkBlocked(bannedIp);
      if (ban) {
        // Record it, but at most once per IP per cooldown — an attacker
        // retrying 1000×/min must not write 1000 rows.
        if (bannedIp && shouldEmitBlockEvent(bannedIp)) {
          const fp = fingerprintRequest(request.headers, {
            method: request.method,
            path: request.nextUrl.pathname,
            host: request.nextUrl.host,
            search: request.nextUrl.search,
            authenticated: false,
          });
          await postSecurityEvent(request.nextUrl.origin, {
            event_type: "ip_blocked",
            severity: "high",
            action: "blocked",
            ip: bannedIp,
            actor_user_id: null,
            actor_role: null,
            method: request.method,
            path: request.nextUrl.pathname,
            query: request.nextUrl.search || null,
            user_agent: request.headers.get("user-agent"),
            matched_rule: "auto-block",
            reporter: "middleware",
            evidence: {
              ban: {
                reason: ban.reason,
                blocked_until: new Date(ban.until).toISOString(),
                strikes: ban.strikes,
                previous_bans: Math.max(0, ban.bans - 1),
                earned_by: ban.types,
              },
              net: fp.net,
              client: fp.client,
              geo: fp.geo,
              request: fp.request,
              flags: fp.flags,
              note: "This IP is under an active auto-ban. Every request from it is refused until the ban expires; further refusals within the cooldown are not logged individually.",
            },
          });
        }
        return finalize(
          new NextResponse(JSON.stringify({ error: "Request blocked by security policy." }), {
            status: 403,
            headers: {
              "content-type": "application/json",
              "retry-after": String(Math.max(1, Math.ceil((ban.until - Date.now()) / 1000))),
            },
          }),
        );
      }
    } catch {
      // The ban gate must never break the app.
    }
  }

  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );

          response = NextResponse.next({
            request,
          });

          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Identity for this request. `getUser()` used to be called here, and it is a
  // network round-trip to Supabase on EVERY request — including every /api/*
  // call, because the early-return for those sits below this point. A page that
  // fires five API calls on mount therefore paid the auth hop six times.
  //
  // `getClaims()` verifies the session JWT locally against the project's cached
  // JWKS when the token is signed with an ASYMMETRIC key, turning that hop into
  // an in-process WebCrypto signature check. It still goes through getSession()
  // internally, so the session-cookie refresh wired into the cookie adapter
  // above — which the matcher comment depends on for /api/files/* — still
  // happens.
  //
  // IMPORTANT: the speedup is conditional on the Supabase project actually
  // using asymmetric JWT signing keys. If the project still signs with the
  // legacy symmetric secret (HS*), the SDK detects that and falls back to a
  // getUser() round-trip *internally*, then returns the claims normally — so
  // this code takes the claims branch either way and behaviour is unchanged,
  // just not faster. That is why this is safe to ship ahead of a key rotation
  // rather than gated behind one; it is also why measuring TTFB is the only way
  // to confirm the win landed.
  //
  // Two deliberate properties of the explicit fallback below:
  //   * No session at all → getClaims() returns null data with a null error, so
  //     `user` stays null and we do NOT call getUser(). An unauthenticated
  //     request must not be made to pay an extra round-trip.
  //   * A real verification failure (bad signature, expired token the refresh
  //     couldn't save) surfaces as an error → fall back to the authoritative
  //     getUser() so the outcome matches the old code exactly.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;

  let user: {
    id: string;
    email?: string;
    app_metadata?: unknown;
    user_metadata?: unknown;
  } | null = null;

  if (claims?.sub) {
    user = {
      id: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      app_metadata: claims.app_metadata,
      user_metadata: claims.user_metadata,
    };
  } else if (claimsError) {
    const {
      data: { user: fetchedUser },
    } = await supabase.auth.getUser();
    user = fetchedUser;
  }

  const path = request.nextUrl.pathname;

  // ── Live-attack detection (E-216). OPT-IN (SECURITY_DETECTION_ENABLED=1) and
  // wrapped so it can never break routing. Runs before the /api early-return so
  // API attacks are seen too. Only flagged requests pay the cost; benign traffic
  // returns from detectThreat() in a few regex tests.
  //
  // The ingest route is exempt: its body carries the offending payload as
  // `evidence`, so with SECURITY_INSPECT_BODY=1 inspecting it would re-detect
  // the same attack, post another event, and recurse without bound. This never
  // fired before only because reporting was silently broken (see ingestOrigin()
  // in report-event.ts) — fixing that made the loop reachable.
  if (process.env.SECURITY_DETECTION_ENABLED === "1" && path !== SECURITY_INGEST_PATH) {
    try {
      // Who is sending this — real (proxy-written) IP, not the spoofable
      // leftmost X-Forwarded-For entry; plus the client software, geo, and the
      // behavioural tells that separate a script from a browser. All of it is
      // attached to the event so a responder never has to guess at the sender.
      const fp = fingerprintRequest(request.headers, {
        method: request.method,
        path,
        host: request.nextUrl.host,
        search: request.nextUrl.search,
        authenticated: !!user,
        userId: user?.id ?? null,
        role: (user?.app_metadata as { role?: string } | undefined)?.role ?? null,
      });
      const ip = fp.ip;

      // Volumetric/behavioural counters (floods, enumeration, auth hammering).
      // Called on EVERY request — benign traffic has to be counted for the rates
      // to mean anything — and it is O(1) per call. Returns a signal only when a
      // threshold trips AND the per-IP emit cooldown has elapsed.
      const rateSignal: RateSignal | null = trackRequest({ ip, path, method: request.method });

      let signal: ThreatSignal | RateSignal | null = detectThreat({
        method: request.method,
        path,
        search: request.nextUrl.search,
        userAgent: request.headers.get("user-agent") || "",
        hasSession: !!user,
        role: (user?.app_metadata as { role?: string } | undefined)?.role,
        host: request.nextUrl.host,
      });
      // Body inspection (opt-in via SECURITY_INSPECT_BODY). Clone the request so
      // the ORIGINAL body still reaches the route untouched. Bounded to text-ish
      // bodies under 100 KB so this never stalls the hot path.
      //
      // `bodySample` is kept only when the body is what tripped a rule: for a
      // POSTed payload the URL columns show nothing at all, so without it the
      // event would name an attack with no visible attack in it.
      let bodySample: string | null = null;
      if (
        !signal &&
        process.env.SECURITY_INSPECT_BODY === "1" &&
        (request.method === "POST" || request.method === "PUT" || request.method === "PATCH")
      ) {
        const ct = request.headers.get("content-type") || "";
        const len = Number(request.headers.get("content-length") || "0");
        if (/application\/json|x-www-form-urlencoded|text\//i.test(ct) && len > 0 && len <= 100_000) {
          try {
            const body = await request.clone().text();
            signal = detectBodyThreat(body);
            // Truncated hard: the body of an attack on a CRM can contain the
            // customer PII the attacker was reaching for, and this row is read
            // by IT staff. 1 KB is enough to see the payload in context.
            if (signal) bodySample = body.slice(0, 1000);
          } catch {
            /* unreadable body — skip */
          }
        }
      }
      // A payload signal is more specific and more actionable than a rate one,
      // so it wins when both fire on the same request; the rate signal's
      // cooldown is already spent, but the IP is identical in both events, so
      // nothing actionable is lost.
      if (!signal) signal = rateSignal;

      if (signal) {
        // A global safety valve: SECURITY_DETECTION_MODE=monitor downgrades
        // every block to a log without a code change.
        const action = process.env.SECURITY_DETECTION_MODE === "monitor" ? "logged" : signal.action;

        // Strike accounting. Only rules confident enough to block count — the
        // soft signals (unauthenticated sensitive hit, off-host redirect param,
        // a flood from a shared dealer NAT) fire on real traffic often enough
        // that banning on them would lock out legitimate users. Crossing the
        // threshold bans the IP, so its NEXT request is refused at the gate
        // above regardless of what it contains.
        const ban =
          signal.action === "blocked" && process.env.SECURITY_DETECTION_MODE !== "monitor"
            ? recordStrike(ip, signal.event_type, signal.severity)
            : null;

        await postSecurityEvent(request.nextUrl.origin, {
          event_type: signal.event_type,
          severity: signal.severity,
          action,
          ip,
          actor_user_id: user?.id ?? null,
          actor_role:
            (user?.app_metadata as { role?: string } | undefined)?.role ??
            (user?.user_metadata as { role?: string } | undefined)?.role ??
            null,
          method: request.method,
          path,
          query: request.nextUrl.search || null,
          user_agent: request.headers.get("user-agent"),
          matched_rule: signal.matched_rule,
          reporter: "middleware",
          // The rule's own evidence (the matched payload) plus everything the
          // columns can't carry: who sent it, from where, with what software,
          // and — when a ban was triggered — the ban that resulted.
          evidence: {
            ...signal.evidence,
            ...(bodySample ? { body_sample: bodySample } : {}),
            net: fp.net,
            client: fp.client,
            geo: fp.geo,
            request: fp.request,
            flags: fp.flags,
            ...(ban
              ? {
                  ban: {
                    reason: ban.reason,
                    blocked_until: new Date(ban.until).toISOString(),
                    strikes: ban.strikes,
                    previous_bans: Math.max(0, ban.bans - 1),
                    earned_by: ban.types,
                    note: "This event tripped the auto-block threshold. Every further request from this IP is refused until the ban expires.",
                  },
                }
              : {}),
          },
        });
        if (action === "blocked") {
          // A volumetric block is a rate limit, not a policy violation — 429 +
          // Retry-After so well-behaved clients back off instead of retrying.
          const isRate = signal.event_type === "rate_flood";
          return finalize(
            new NextResponse(
              JSON.stringify({
                error: isRate ? "Too many requests." : "Request blocked by security policy.",
              }),
              {
                status: isRate ? 429 : 403,
                headers: isRate
                  ? { "content-type": "application/json", "retry-after": "60" }
                  : { "content-type": "application/json" },
              },
            ),
          );
        }
      }
    } catch {
      // Detection must never break the app.
    }
  }

  // API and asset requests only need the session-cookie refresh that
  // getUser() above already performed (see the matcher comment on why
  // /api/files/* must keep it). Role resolution below is page-navigation
  // logic — skipping it saves up to two Supabase `users` queries on every
  // API call. Outcome is identical: these paths were public (unauthenticated)
  // and fell through to finalize() (authenticated) before this early exit.
  if (path.startsWith("/api") || path.startsWith("/_next") || path === "/favicon.ico") {
    return finalize(response);
  }

  const roleDashboards: Record<string, string> = {
    ceo: "/ceo",
    business_head: "/business-head",
    sales_head: "/sales-head",
    sales_manager: "/sales-manager",
    sales_executive: "/sales-executive",
    sales_insight: "/sales-insight",
    inside_sales_rep: "/inside-sales",
    asm: "/asm",
    finance_controller: "/finance-controller",
    inventory_manager: "/inventory-manager",
    service_engineer: "/service-engineer",
    sales_order_manager: "/sales-order-manager",
    dealer: "/dealer-portal",
    admin: "/admin",
    // IT Dashboard — the security surface (scanner findings + live attacks),
    // deliberately its own role/login rather than a section of /admin or /ceo.
    it: "/it",
    nbfc_partner: "/nbfc",
    // E-195 — the scrap vendor's own portal. Adding it here also protects the
    // path: isProtectedRoute is derived from these values.
    scrap_vendor: "/vendor-portal",
  };

  // E-212 — /reset-password is reached from an emailed token link by a user who
  // by definition has no session. It sits under no roleDashboards prefix, so it
  // already falls through un-redirected today, but that is accidental rather
  // than intentional: listing it means a future isProtectedRoute widening can't
  // silently lock the only way back into a locked-out account.
  const isPublicRoute =
    path === "/login" || path === "/logout" || path === "/reset-password";

  const isProtectedRoute =
    Object.values(roleDashboards).some((dashboardPath) =>
      path.startsWith(dashboardPath),
    ) ||
    path.startsWith("/risk-head") ||
    path.startsWith("/inventory") ||
    path.startsWith("/product-catalog") ||
    path.startsWith("/oem-onboarding") ||
    // E-230 — the OEM price register. Role is re-asserted by the API (ceo,
    // admin); listing it here is the "you must be signed in" half.
    path.startsWith("/oem-pricing") ||
    path.startsWith("/deals") ||
    path.startsWith("/leads") ||
    path.startsWith("/approvals") ||
    path.startsWith("/orders") ||
    path.startsWith("/provisions") ||
    path.startsWith("/disputes") ||
    path.startsWith("/expenses") ||
    // /profile is every role's own account page. It is deliberately NOT in
    // roleDashboards — those values also drive the "wrong role → bounce to your
    // own dashboard" check below, so a /profile entry keyed to one role would
    // bounce every OTHER role off their own profile. Listing it here only means
    // "you must be signed in", which is what was missing: before this, an
    // unauthenticated visitor rendered the page instead of being sent to /login.
    path === "/profile" ||
    path === "/" ||
    path === "/dashboard";

  if (!user) {
    if (isPublicRoute) return finalize(response);

    if (isProtectedRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      return finalize(NextResponse.redirect(url));
    }

    return finalize(response);
  }

  // Role lives on AWS RDS, not Supabase — read it from app_metadata (synced by
  // /api/user/profile on each login). Fallbacks: user_metadata, Supabase users
  // table (legacy), default "user".
  const appMetadataRole = (user.app_metadata as { role?: string } | undefined)?.role;
  const userMetadataRole = (user.user_metadata as { role?: string } | undefined)?.role;

  let legacyRole: string | undefined;
  if (!appMetadataRole && !userMetadataRole) {
    const { data: profileById } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    legacyRole = profileById?.role ?? undefined;

    if (!legacyRole && user.email) {
      const { data: profileByEmail } = await supabase
        .from("users")
        .select("role")
        .eq("email", user.email)
        .maybeSingle();
      legacyRole = profileByEmail?.role ?? undefined;
    }
  }

  const rawRole = appMetadataRole || userMetadataRole || legacyRole || "user";
  const role = rawRole.toLowerCase();
  const myDashboard = roleDashboards[role] || "/";

  // Per-navigation logging is hot-path cost in prod — opt in when debugging.
  if (process.env.MIDDLEWARE_DEBUG === "1") {
    console.log("[MIDDLEWARE] Auth user:", {
      authUserId: user.id,
      authEmail: user.email,
      resolvedRole: role,
      dashboard: myDashboard,
      path,
    });
  }

  // First-login forced password reset for NBFC partners. Activation route sets
  // users.must_change_password=true; /api/auth/change-password clears it.
  if (
    role === "nbfc_partner" &&
    (path.startsWith("/nbfc") || path.startsWith("/risk-head")) &&
    path !== "/change-password"
  ) {
    const { data: mustChange } = await supabase
      .from("users")
      .select("must_change_password")
      .eq("id", user.id)
      .maybeSingle();
    if (mustChange?.must_change_password) {
      return finalize(
        NextResponse.redirect(new URL("/change-password", request.url)),
      );
    }
  }

  if (path === "/login" || path === "/" || path === "/dashboard") {
    if (myDashboard !== "/") {
      return finalize(
        NextResponse.redirect(new URL(myDashboard, request.url)),
      );
    }
    return finalize(response);
  }

  // E-230 — the OEM price register moved off /ceo onto the OEM tab, so that
  // Admin can reach it as the requirement asks. It therefore lost the gate it
  // used to inherit: /ceo IS a roleDashboards prefix, and /oem-pricing is not,
  // so without this it would fall through to the permissive default at the
  // bottom of this function and render for any signed-in user. The API 403s
  // either way — this stops the page from rendering at all.
  if (path.startsWith("/oem-pricing") && role !== "ceo" && role !== "admin") {
    return finalize(NextResponse.redirect(new URL(myDashboard, request.url)));
  }

  // Shared access routes
  const sharedRouteAccess: Record<string, string[]> = {
    // NBFC Risk Head dashboard — the second-approver surface of the
    // battery-immobilisation gate. All NBFC users sign in as `nbfc_partner`;
    // the layout does the fine-grained nbfc_users.role === 'nbfc_risk_head'
    // gate. admin/ceo retain support access.
    "/risk-head": ["nbfc_partner", "admin", "ceo"],
    "/admin/dealer-verification": ["sales_head"],
    "/admin/kyc-review": ["admin", "sales_head", "business_head", "ceo"],
    // NBFC onboarding (BRD §6.0): sales_head submits, CEO approves. Admin and
    // business_head also need read access for support and oversight. The
    // /api/admin/nbfc/* routes still gate writes per role; this just allows
    // the dashboard pages to render.
    "/admin/nbfc": ["admin", "ceo", "business_head", "sales_head"],
    // Global NBFC loan-product catalogue (view/search/edit). Same audience as
    // the NBFC directory; writes are still admin-gated by the API.
    "/admin/loan-products": ["admin", "ceo", "business_head", "sales_head"],
    "/admin/product-review": ["admin", "sales_head", "business_head", "ceo"],
    "/admin/inventory": [
      "admin",
      "ops_manager",
      "super_admin",
      "inventory_manager",
      "ceo",
      "sales_head",
    ],
    "/admin/product-master": [
      "admin",
      "ops_manager",
      "super_admin",
      "inventory_manager",
      "ceo",
      "sales_head",
    ],
    // Battery-buyback admin pages (M06). Must be above the bare "/admin"
    // entry below — it admits business_head to buyback only, and the bare
    // "/admin" entry (without business_head) would otherwise match first.
    "/admin/buyback": [...BUYBACK_ADMIN_ROLES],
    // Part 0 Module 3 — the admin / ops workspace. The Ops-Manager persona is
    // held by the sales_head account, so sales_head gets full access (admin +
    // CEO too). This bare "/admin" prefix is LAST so the specific entries
    // above are matched first by the prefix find().
    "/admin": ["admin", "sales_head", "ceo"],
  };

  const allowedSharedRoles = Object.entries(sharedRouteAccess).find(
    ([routePrefix]) => path.startsWith(routePrefix),
  )?.[1];

  if (allowedSharedRoles && allowedSharedRoles.includes(role)) {
    return finalize(response);
  }

  const matchedRole = Object.entries(roleDashboards).find(([, dashboardPath]) =>
    path.startsWith(dashboardPath),
  )?.[0];

  // CEO can see all dashboards (existing behavior).
  // Admin can also see /nbfc/* for support/troubleshooting (Phase C addition).
  const isAdminViewingNbfc = role === "admin" && path.startsWith("/nbfc");
  if (matchedRole && matchedRole !== role && role !== "ceo" && !isAdminViewingNbfc) {
    return finalize(
      NextResponse.redirect(new URL(myDashboard, request.url)),
    );
  }

  return finalize(response);
}

export const config = {
  matcher: [
    // Skip Next internals, favicon, image assets, and uploaded PDFs served
    // statically (e.g. /nbfc-uploads/*.pdf). Without `.pdf` in this list, PDF
    // iframes hit the auth middleware and get redirected to the user's role
    // dashboard instead of returning the file.
    //
    // The `(?!api/)` guard keeps the extension-skip from also swallowing the
    // AUTHENTICATED file proxy at /api/files/<bucket>/<key>.<ext>. Those URLs
    // MUST run through middleware so the Supabase session cookie gets refreshed
    // — otherwise, once the short-lived access token expires, every image/PDF
    // document view 401s ("Unauthorized") even for a logged-in user, while the
    // rest of the app (which is refreshed on each request) keeps working.
    // Middleware passes /api/* through without a redirect (isPublicRoute), so
    // this only adds the refresh, never a dashboard bounce.
    // `fonts/` is excluded outright. The brand fonts used to be served by
    // fonts.gstatic.com, so they never touched this middleware at all; once
    // they moved into public/fonts/ (to get a third-party render-blocking
    // request off the critical path) they became same-origin requests, and
    // every woff2 would otherwise pay a full auth check on the critical path
    // of the first paint. They are public static files with no session
    // semantics — nothing here has anything to say about them. Note this
    // could NOT be handled by adding woff2 to the extension list below: that
    // branch is guarded by `(?!api/)`, and its purpose is the authenticated
    // file proxy, which is a different concern.
    "/((?!_next/static|_next/image|favicon.ico|fonts/|(?!api/).*\\.(?:svg|png|jpg|jpeg|gif|webp|pdf)$).*)",
  ],
};
