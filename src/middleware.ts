import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { normalizeRole } from "@/lib/roles";
import {
  findLatestDealerOnboardingRecord,
  findSupabaseUserProfile,
} from "@/lib/supabase/identity";

type UserProfile = {
  role?: string | null;
  email?: string | null;
  id?: string | null;
  dealer_id?: string | null;
};

type DealerOnboardingProfile = {
  onboarding_status?: string | null;
  dealer_account_status?: string | null;
};

function getAuthMetadataRole(user: {
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
}) {
  const userRole = user.user_metadata?.role;
  if (typeof userRole === "string" && userRole.trim()) {
    return userRole;
  }

  const appRole = user.app_metadata?.role;
  if (typeof appRole === "string" && appRole.trim()) {
    return appRole;
  }

  return "user";
}

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
            request.cookies.set(name, value)
          );

          response = NextResponse.next({
            request,
          });

          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
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
    Object.values(roleDashboards).some(
      (dashboardPath) =>
        path === dashboardPath || path.startsWith(`${dashboardPath}/`)
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

  const profile = await findSupabaseUserProfile<UserProfile>(
    supabase,
    user,
    "role,email,id,dealer_id"
  );

  const rawRole = profile?.role || getAuthMetadataRole(user);
  const role = normalizeRole(rawRole);
  const myDashboard = roleDashboards[role] || "/";

  console.log("[MIDDLEWARE] Auth user:", {
    authUserId: user.id,
    authEmail: user.email,
    resolvedRole: role,
    dashboard: myDashboard,
    path,
  });

  if (path === "/login") {
    return response;
  }

  if (path === "/" || path === "/dashboard") {
    if (myDashboard !== "/") {
      return NextResponse.redirect(new URL(myDashboard, request.url));
    }
    return response;
  }

  // Explicit shared access for dealer verification pages
  if (path === "/admin/dealer-verification" || path.startsWith("/admin/dealer-verification/")) {
    if (["admin", "sales_head", "business_head", "ceo"].includes(role)) {
      return response;
    }
    return NextResponse.redirect(new URL(myDashboard, request.url));
  }

  const matchedRole = Object.entries(roleDashboards).find(
    ([, dashboardPath]) =>
      path === dashboardPath || path.startsWith(`${dashboardPath}/`)
  )?.[0];

  if (matchedRole && matchedRole !== role && role !== "ceo") {
    return NextResponse.redirect(new URL(myDashboard, request.url));
  }

  // Dealer-specific gating
  if (role === "dealer") {
    // If dealer already has a dealer_id, they are fully approved — skip onboarding checks
    if (profile?.dealer_id) {
      return response;
    }

    const dealerProfile =
      await findLatestDealerOnboardingRecord<DealerOnboardingProfile>(
        supabase,
        user,
        {
          profileUserId: profile?.id || null,
          selectClause: "onboarding_status,dealer_account_status",
        }
      );

    // If onboarding lookup returned null (e.g. RLS blocking), check if user
    // already has a dealer_id in the users table — that means they were approved.
    let onboardingStatus = (
      dealerProfile?.onboarding_status || "draft"
    ).toLowerCase();

    let dealerAccountStatus = (
      dealerProfile?.dealer_account_status || ""
    ).toLowerCase();

    if (!dealerProfile) {
      // Fallback: check if the users table has dealer_id set (set during approval)
      const { data: fullProfile } = await supabase
        .from("users")
        .select("dealer_id")
        .eq("id", user.id)
        .maybeSingle();

      if (!fullProfile) {
        // Also try by email
        const { data: emailProfile } = await supabase
          .from("users")
          .select("dealer_id")
          .eq("email", user.email)
          .maybeSingle();

        if (emailProfile?.dealer_id) {
          onboardingStatus = "approved";
          dealerAccountStatus = "active";
        }
      } else if (fullProfile?.dealer_id) {
        onboardingStatus = "approved";
        dealerAccountStatus = "active";
      }
    }

    const isDealerPortalRoute = path.startsWith("/dealer-portal");
    const isDealerOnboardingRoute =
      path.startsWith("/dealer-onboarding") ||
      path.startsWith("/dealer-portal/onboarding-status");

    // Allow onboarding routes through BEFORE dealer portal gating
    // to prevent infinite redirect loop on /dealer-portal/onboarding-status
    if (isDealerOnboardingRoute) {
      return response;
    }

    if (isDealerPortalRoute) {
      const isApprovedAndActive =
        onboardingStatus === "approved" && dealerAccountStatus === "active";

      if (isApprovedAndActive) {
        return response;
      }

      const url = request.nextUrl.clone();

      if (
        onboardingStatus === "draft" ||
        onboardingStatus === "in_progress" ||
        onboardingStatus === ""
      ) {
        url.pathname = "/dealer-onboarding";
        return NextResponse.redirect(url);
      }

      if (
        onboardingStatus === "submitted" ||
        onboardingStatus === "pending_sales_head" ||
        onboardingStatus === "under_review" ||
        onboardingStatus === "agreement_in_progress" ||
        onboardingStatus === "agreement_completed" ||
        onboardingStatus === "correction_requested" ||
        onboardingStatus === "action_needed" ||
        onboardingStatus === "rejected"
      ) {
        url.pathname = "/dealer-portal/onboarding-status";
        return NextResponse.redirect(url);
      }

      url.pathname = "/dealer-onboarding";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
