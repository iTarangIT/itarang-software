import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

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

  const roleDashboards: Record<string, string> = {
    ceo: "/ceo",
    business_head: "/business-head",
    sales_head: "/sales-head",
    sales_manager: "/sales-manager",
    sales_executive: "/sales-executive",
    finance_controller: "/finance-controller",
    inventory_manager: "/inventory-manager",
    service_engineer: "/service-engineer",
    sales_order_manager: "/sales-order-manager",
    dealer: "/dealer-portal",
    admin: "/admin",
    nbfc_partner: "/nbfc",
  };

  const isPublicRoute =
    path === "/login" ||
    path === "/logout" ||
    path.startsWith("/api") ||
    path.startsWith("/_next") ||
    path === "/favicon.ico";

  const isProtectedRoute =
    Object.values(roleDashboards).some((dashboardPath) =>
      path.startsWith(dashboardPath),
    ) ||
    path.startsWith("/inventory") ||
    path.startsWith("/product-catalog") ||
    path.startsWith("/oem-onboarding") ||
    path.startsWith("/deals") ||
    path.startsWith("/leads") ||
    path.startsWith("/approvals") ||
    path.startsWith("/orders") ||
    path.startsWith("/provisions") ||
    path.startsWith("/disputes") ||
    path === "/" ||
    path === "/dashboard";

  if (!user) {
    if (isPublicRoute) return addNoStoreHeaders(response);

    if (isProtectedRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      return addNoStoreHeaders(NextResponse.redirect(url));
    }

    return addNoStoreHeaders(response);
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

  console.log("[MIDDLEWARE] Auth user:", {
    authUserId: user.id,
    authEmail: user.email,
    resolvedRole: role,
    dashboard: myDashboard,
    path,
  });

  // First-login forced password reset for NBFC partners. Activation route sets
  // users.must_change_password=true; /api/auth/change-password clears it.
  if (
    role === "nbfc_partner" &&
    path.startsWith("/nbfc") &&
    path !== "/change-password"
  ) {
    const { data: mustChange } = await supabase
      .from("users")
      .select("must_change_password")
      .eq("id", user.id)
      .maybeSingle();
    if (mustChange?.must_change_password) {
      return addNoStoreHeaders(
        NextResponse.redirect(new URL("/change-password", request.url)),
      );
    }
  }

  if (path === "/login" || path === "/" || path === "/dashboard") {
    if (myDashboard !== "/") {
      return addNoStoreHeaders(
        NextResponse.redirect(new URL(myDashboard, request.url)),
      );
    }
    return addNoStoreHeaders(response);
  }

  // Shared access routes
  const sharedRouteAccess: Record<string, string[]> = {
    "/admin/dealer-verification": ["sales_head"],
    "/admin/kyc-review": ["admin", "sales_head", "business_head", "ceo"],
    // NBFC onboarding (BRD §6.0): sales_head submits, CEO approves. Admin and
    // business_head also need read access for support and oversight. The
    // /api/admin/nbfc/* routes still gate writes per role; this just allows
    // the dashboard pages to render.
    "/admin/nbfc": ["admin", "ceo", "business_head", "sales_head"],
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
  };

  const allowedSharedRoles = Object.entries(sharedRouteAccess).find(
    ([routePrefix]) => path.startsWith(routePrefix),
  )?.[1];

  if (allowedSharedRoles && allowedSharedRoles.includes(role)) {
    return addNoStoreHeaders(response);
  }

  const matchedRole = Object.entries(roleDashboards).find(([, dashboardPath]) =>
    path.startsWith(dashboardPath),
  )?.[0];

  // CEO can see all dashboards (existing behavior).
  // Admin can also see /nbfc/* for support/troubleshooting (Phase C addition).
  const isAdminViewingNbfc = role === "admin" && path.startsWith("/nbfc");
  if (matchedRole && matchedRole !== role && role !== "ceo" && !isAdminViewingNbfc) {
    return addNoStoreHeaders(
      NextResponse.redirect(new URL(myDashboard, request.url)),
    );
  }

  return addNoStoreHeaders(response);
}

export const config = {
  matcher: [
    // Skip Next internals, favicon, image assets, and uploaded PDFs served
    // from public/nbfc-uploads/. Without `.pdf` in this list, PDF iframes
    // hit the auth middleware and get redirected to the user's role
    // dashboard instead of returning the file.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|pdf)$).*)",
  ],
};
