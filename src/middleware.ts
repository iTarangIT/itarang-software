import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { BUYBACK_ADMIN_ROLES } from "@/lib/buyback/roles";
import { detectThreat, detectBodyThreat, type ThreatSignal } from "@/lib/security/detect";
import { trackRequest, type RateSignal } from "@/lib/security/rate-watch";
import { postSecurityEvent } from "@/lib/security/report-event";

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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // ── Live-attack detection (E-216). OPT-IN (SECURITY_DETECTION_ENABLED=1) and
  // wrapped so it can never break routing. Runs before the /api early-return so
  // API attacks are seen too. Only flagged requests pay the cost; benign traffic
  // returns from detectThreat() in a few regex tests.
  if (process.env.SECURITY_DETECTION_ENABLED === "1") {
    try {
      const ip =
        (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
        request.headers.get("x-real-ip") ||
        null;

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
      if (
        !signal &&
        process.env.SECURITY_INSPECT_BODY === "1" &&
        (request.method === "POST" || request.method === "PUT" || request.method === "PATCH")
      ) {
        const ct = request.headers.get("content-type") || "";
        const len = Number(request.headers.get("content-length") || "0");
        if (/application\/json|x-www-form-urlencoded|text\//i.test(ct) && len > 0 && len <= 100_000) {
          try {
            signal = detectBodyThreat(await request.clone().text());
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
          evidence: signal.evidence,
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
    "/((?!_next/static|_next/image|favicon.ico|(?!api/).*\\.(?:svg|png|jpg|jpeg|gif|webp|pdf)$).*)",
  ],
};
