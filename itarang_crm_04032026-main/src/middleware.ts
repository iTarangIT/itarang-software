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
                    cookiesToSet.forEach(({ name, value, options }) =>
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

    // Mapping for role-specific dashboard paths
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
    };

    // 1. If not logged in
    if (!user) {
        // Allow /login, /logout and /api routes
        if (path === "/login" || path === "/logout" || path.startsWith("/api")) {
            return response;
        }

        // Check if path is protected OR root '/'
        const isProtectedRoute =
            Object.values(roleDashboards).some((d) => path.startsWith(d)) ||
            path.startsWith("/inventory") ||
            path.startsWith("/product-catalog") ||
            path.startsWith("/oem-onboarding") ||
            path.startsWith("/deals") ||
            path.startsWith("/leads") ||
            path.startsWith("/approvals") ||
            path.startsWith("/orders") ||
            path.startsWith("/provisions") ||
            path.startsWith("/disputes");

        if (isProtectedRoute || path === "/") {
            const url = request.nextUrl.clone();
            url.pathname = "/login";
            return NextResponse.redirect(url);
        }

        return response;
    }

    // 2. If logged in
    const { data: profile } = await supabase
        .from("users")
        .select("role")
        .eq("id", user.id)
        .single();

    const rawRole = profile?.role || "user";
    const role = rawRole.toLowerCase();
    const myDashboard = roleDashboards[role] || "/";

    // Redirection from /login or / or /dashboard
    if (path === "/" || path === "/login" || path === "/dashboard") {
        // If logged in, never stay on /login
        if (path === "/login") {
            return NextResponse.redirect(new URL(myDashboard, request.url));
        }

        // Optional: redirect / and /dashboard to role dashboard when role is known
        if (path === "/" || path === "/dashboard") {
            if (myDashboard !== "/") {
                return NextResponse.redirect(new URL(myDashboard, request.url));
            }
        }

        return response; // allow '/' for 'user'
    }

    // Role-based path protection
    const roles = Object.keys(roleDashboards);
    const matchedRole = roles.find((r) => path.startsWith(roleDashboards[r]));

    // If accessing another role's path and not CEO
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