import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

export async function middleware(request: NextRequest) {
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
    if (isPublicRoute) return response;

    if (isProtectedRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      return NextResponse.redirect(url);
    }

    return response;
  }

  let profile: { role?: string | null } | null = null;

  const { data: profileById } = await supabase
    .from("users")
    .select("role,email,id")
    .eq("id", user.id)
    .maybeSingle();

  if (profileById) {
    profile = profileById;
  } else if (user.email) {
    const { data: profileByEmail } = await supabase
      .from("users")
      .select("role,email,id")
      .eq("email", user.email)
      .maybeSingle();

    if (profileByEmail) {
      profile = profileByEmail;
    }
  }

  const rawRole = profile?.role || "user";
  const role = rawRole.toLowerCase();
  const myDashboard = roleDashboards[role] || "/";

  console.log("[MIDDLEWARE] Auth user:", {
    authUserId: user.id,
    authEmail: user.email,
    resolvedRole: role,
    dashboard: myDashboard,
    path,
  });

  if (path === "/login" || path === "/" || path === "/dashboard") {
    if (myDashboard !== "/") {
      return NextResponse.redirect(new URL(myDashboard, request.url));
    }
    return response;
  }

  // Shared access routes
  const sharedRouteAccess: Record<string, string[]> = {
    "/admin/dealer-verification": [
      "admin",
      "sales_head",
      "business_head",
      "ceo",
    ],
    "/admin/kyc-review": ["admin", "sales_head", "business_head", "ceo"],
  };

  const allowedSharedRoles = Object.entries(sharedRouteAccess).find(
    ([routePrefix]) => path.startsWith(routePrefix),
  )?.[1];

  if (allowedSharedRoles && allowedSharedRoles.includes(role)) {
    return response;
  }

  const matchedRole = Object.entries(roleDashboards).find(([, dashboardPath]) =>
    path.startsWith(dashboardPath),
  )?.[0];

  if (matchedRole && matchedRole !== role && role !== "ceo") {
    return NextResponse.redirect(new URL(myDashboard, request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
