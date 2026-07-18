import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { BUYBACK_ADMIN_ROLES } from "@/lib/buyback/roles";

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
    nbfc_partner: "/nbfc",
    // E-195 — the scrap vendor's own portal. Adding it here also protects the
    // path: isProtectedRoute is derived from these values.
    scrap_vendor: "/vendor-portal",
  };

  const isPublicRoute = path === "/login" || path === "/logout";

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
