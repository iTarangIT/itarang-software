/**
 * What src/middleware.ts decides for a page request, pinned by calling it.
 *
 * The decision tables (roleDashboards, isProtectedRoute, sharedRouteAccess)
 * are locals inside middleware(), so there is nothing to import and assert on.
 * This suite instead mocks the one thing that needs a network — the Supabase
 * client — and runs the real function against a NextRequest. No env, no DB.
 *
 * Three kinds of test live here:
 *
 *   1. what must hold     signed-out visitors are sent to /login, a role is
 *                         bounced off another role's dashboard, the API gate;
 *   2. tripwires          the dashboard directories on disk are checked against
 *                         the protected list, so a new top-level page that
 *                         nobody listed fails here instead of shipping public;
 *   3. KNOWN GAPS         behaviour the Oct 2026 auth audit flagged as wrong
 *                         and that is NOT fixed yet. They assert what the code
 *                         does today so the gap cannot widen unnoticed. When
 *                         you fix one, its test fails — flip the expectation.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the mocked Supabase client reports for the current test. */
const session = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  /** The row `supabase.from("users")…maybeSingle()` resolves to. */
  row: null as { role?: string; must_change_password?: boolean } | null,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getClaims: async () => ({
        data: session.claims ? { claims: session.claims } : null,
        error: null,
      }),
      getUser: async () => ({ data: { user: null } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: session.row }) }),
      }),
    }),
  }),
}));

import {
  DEALS_PAGE_ROLES,
  ORDERS_PAGE_ROLES,
  PROVISIONS_PAGE_ROLES,
  staffPageRolesFor,
} from "@/lib/auth/staffPageRoles";

import { config, middleware } from "../middleware";

type Who = { app?: string; meta?: string } | null;

/**
 * Where a request ends up: "pass" (rendered), a redirect target's pathname, or
 * the status code of a refusal.
 */
async function visit(path: string, who: Who = null): Promise<string> {
  session.claims = who
    ? {
        sub: "00000000-0000-4000-8000-000000000001",
        email: "someone@example.com",
        app_metadata: { role: who.app },
        user_metadata: { role: who.meta },
      }
    : null;

  const res = await middleware(new NextRequest(`http://localhost${path}`));
  const location = res.headers.get("location");
  if (location) return new URL(location).pathname;
  return res.headers.get("x-middleware-next") ? "pass" : String(res.status);
}

const as = (role: string): Who => ({ app: role });

/** Roles held by people outside iTarang. */
const EXTERNAL_ROLES = ["dealer", "scrap_vendor", "refurbisher", "nbfc_partner"];

/** Staff dashboards — no external role belongs on any of them. */
const STAFF_DASHBOARDS = [
  "/ceo",
  "/business-head",
  "/sales-head",
  "/sales-manager",
  "/sales-executive",
  "/sales-insight",
  "/inside-sales",
  "/asm",
  "/finance-controller",
  "/inventory-manager",
  "/service-engineer",
  "/sales-order-manager",
  "/admin",
  "/it",
  "/operations",
  "/partner",
  "/monitor",
  "/feature-requests",
];

const HOME: Record<string, string> = {
  dealer: "/dealer-portal",
  scrap_vendor: "/vendor-portal",
  refurbisher: "/refurbisher-portal",
  nbfc_partner: "/nbfc",
};

beforeEach(() => {
  session.claims = null;
  session.row = null;
  // Detection posts events over fetch; the test bypass skips auth entirely.
  vi.stubEnv("SECURITY_DETECTION_ENABLED", undefined);
  vi.stubEnv("NBFC_TEST_BYPASS_SECRET", undefined);
  vi.stubEnv("API_AUTH_GATE", undefined);
  vi.stubEnv("MIDDLEWARE_DEBUG", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a signed-out visitor", () => {
  it("is sent to /login from every role dashboard and shared staff page", async () => {
    const paths = [
      ...STAFF_DASHBOARDS,
      ...Object.values(HOME),
      "/admin/kyc-review",
      "/risk-head",
      "/oem-pricing",
      "/orders",
      "/provisions",
      "/deals",
      "/leads",
      "/inventory",
      "/profile",
      "/settings/whatsapp-link",
      "/",
      "/dashboard",
    ];
    const reached: string[] = [];
    for (const p of paths) if ((await visit(p)) !== "/login") reached.push(p);
    expect(reached).toEqual([]);
  });

  it("reaches the pages that are public on purpose", async () => {
    for (const p of ["/login", "/logout", "/reset-password", "/auctions", "/recovery-agent/some-token"]) {
      expect(await visit(p), p).toBe("pass");
    }
  });

  it("never has a dashboard directory on disk that the protected list forgot", async () => {
    // An unlisted path falls through to `return finalize(response)` for a
    // signed-out visitor — it fails OPEN. So a new top-level folder under
    // (dashboard) is public until someone adds it to isProtectedRoute, and
    // this is the check that notices.
    const dashboardDir = fileURLToPath(new URL("../app/(dashboard)", import.meta.url));
    expect(existsSync(dashboardDir)).toBe(true);

    const dirs = readdirSync(dashboardDir).filter((name) =>
      statSync(`${dashboardDir}/${name}`).isDirectory(),
    );
    expect(dirs.length).toBeGreaterThan(30);

    const open: string[] = [];
    for (const dir of dirs) if ((await visit(`/${dir}`)) !== "/login") open.push(dir);

    // KNOWN GAP — /hr and /procurement render signed-out (static placeholder
    // pages today). Add them to isProtectedRoute, then empty this list.
    expect(open.sort()).toEqual(["hr", "procurement"]);
  });
});

describe("a signed-in user on someone else's dashboard", () => {
  it("bounces every external role off every staff dashboard, to its own portal", async () => {
    const reached: string[] = [];
    for (const role of EXTERNAL_ROLES) {
      for (const p of STAFF_DASHBOARDS) {
        const got = await visit(`${p}/anything`, as(role));
        if (got !== HOME[role]) reached.push(`${role} ${p} → ${got}`);
      }
    }
    expect(reached).toEqual([]);
  });

  it("bounces external roles off each other's portals", async () => {
    expect(await visit("/nbfc/portfolio", as("dealer"))).toBe("/dealer-portal");
    expect(await visit("/dealer-portal/leads", as("nbfc_partner"))).toBe("/nbfc");
    expect(await visit("/vendor-portal", as("refurbisher"))).toBe("/refurbisher-portal");
    expect(await visit("/refurbisher-portal", as("scrap_vendor"))).toBe("/vendor-portal");
  });

  it("lets a role onto its own dashboard", async () => {
    for (const role of EXTERNAL_ROLES) {
      expect(await visit(`${HOME[role]}/x`, as(role)), role).toBe("pass");
    }
    expect(await visit("/admin/users", as("admin"))).toBe("pass");
  });

  it("lets the CEO see every dashboard, and admin see /nbfc — and nothing wider", async () => {
    for (const p of [...STAFF_DASHBOARDS, ...Object.values(HOME)]) {
      expect(await visit(p, as("ceo")), p).toBe("pass");
    }
    expect(await visit("/nbfc/portfolio", as("admin"))).toBe("pass");
    expect(await visit("/ceo", as("admin"))).toBe("/admin");
    expect(await visit("/it", as("admin"))).toBe("/admin");
  });

  it("sends a signed-in user from /, /dashboard and /login to their own dashboard", async () => {
    for (const p of ["/", "/dashboard", "/login"]) {
      expect(await visit(p, as("dealer")), p).toBe("/dealer-portal");
    }
  });
});

describe("the shared /admin rows", () => {
  it("admit exactly the roles listed for the sub-page, not the bare /admin audience", async () => {
    // business_head: buyback and reports, not the rest of /admin.
    expect(await visit("/admin/buyback/leads", as("business_head"))).toBe("pass");
    expect(await visit("/admin/reports", as("business_head"))).toBe("pass");
    expect(await visit("/admin/users", as("business_head"))).toBe("/business-head");
    expect(await visit("/admin/reports/needs-attention", as("business_head"))).toBe("/business-head");

    // finance_controller: the Reports page only.
    expect(await visit("/admin/reports", as("finance_controller"))).toBe("pass");
    expect(await visit("/admin/reports/sales-dashboard", as("finance_controller"))).toBe("/finance-controller");
    expect(await visit("/admin", as("finance_controller"))).toBe("/finance-controller");

    // partner: the lead-management pages it mirrors from sales_head.
    expect(await visit("/admin/upload", as("partner"))).toBe("pass");
    expect(await visit("/admin/targets", as("partner"))).toBe("/partner");

    expect(await visit("/admin/users", as("sales_head"))).toBe("pass");
  });

  it("never admit an external role to any /admin page", async () => {
    const pages = [
      "/admin",
      "/admin/kyc-review",
      "/admin/nbfc",
      "/admin/loan-products",
      "/admin/inventory",
      "/admin/buyback",
      "/admin/reports",
      "/admin/notifications",
      "/admin/dealer-verification",
    ];
    const reached: string[] = [];
    for (const role of EXTERNAL_ROLES) {
      for (const p of pages) if ((await visit(p, as(role))) === "pass") reached.push(`${role} ${p}`);
    }
    expect(reached).toEqual([]);
  });

  it("keeps the OEM price register to ceo and admin", async () => {
    expect(await visit("/oem-pricing", as("ceo"))).toBe("pass");
    expect(await visit("/oem-pricing", as("admin"))).toBe("pass");
    expect(await visit("/oem-pricing", as("sales_head"))).toBe("/sales-head");
    expect(await visit("/oem-pricing", as("dealer"))).toBe("/dealer-portal");
  });
});

describe("the procurement and deal pages", () => {
  // /orders, /provisions and /deals sit under no role dashboard, so the
  // wrong-role bounce never ran for them and every signed-in role got in.
  // src/lib/auth/staffPageRoles.ts now names who may.
  const pages = [
    "/orders",
    "/orders/1",
    "/provisions",
    "/provisions/new",
    "/provisions/1/create-order",
    "/deals",
    "/deals/1",
    "/deals/new",
  ];

  it("turn away every external role and the placeholder role", async () => {
    const reached: string[] = [];
    for (const role of [...EXTERNAL_ROLES, "user"]) {
      for (const p of pages) {
        const got = await visit(p, as(role));
        if (got !== (HOME[role] ?? "/")) reached.push(`${role} ${p} → ${got}`);
      }
    }
    expect(reached).toEqual([]);
  });

  it("admit the roles their APIs and dashboards already serve", async () => {
    for (const role of ORDERS_PAGE_ROLES) expect(await visit("/orders/1", as(role)), role).toBe("pass");
    for (const role of PROVISIONS_PAGE_ROLES) expect(await visit("/provisions/new", as(role)), role).toBe("pass");
    for (const role of DEALS_PAGE_ROLES) expect(await visit("/deals/1", as(role)), role).toBe("pass");
  });

  it("keep each list to its own page", async () => {
    // sales_manager works deals, not procurement; inventory_manager the reverse.
    expect(await visit("/orders", as("sales_manager"))).toBe("/sales-manager");
    expect(await visit("/deals", as("inventory_manager"))).toBe("/inventory-manager");
    expect(await visit("/deals", as("sales_order_manager"))).toBe("/sales-order-manager");
  });

  it("match on a whole segment, so /deals does not claim /dealer-portal", async () => {
    expect(staffPageRolesFor("/dealer-portal")).toBeUndefined();
    expect(staffPageRolesFor("/orders-archive")).toBeUndefined();
    expect(staffPageRolesFor("/deals")).toBe(DEALS_PAGE_ROLES);
    expect(staffPageRolesFor("/deals/1")).toBe(DEALS_PAGE_ROLES);
    expect(await visit("/dealer-portal/leads", as("dealer"))).toBe("pass");
  });

  it("are re-checked by the pages themselves, with the same lists", () => {
    // Middleware can be skipped (see the matcher gap below: /orders/x.pdf never
    // reaches it), so the server pages that read the database must not rely
    // on it. Read as source — the pages import the database.
    // join(), not a URL: a URL would percent-encode the "[id]" folder name.
    const dashboardDir = fileURLToPath(new URL("../app/(dashboard)", import.meta.url));
    const page = (...parts: string[]) => readFileSync(join(dashboardDir, ...parts), "utf8");

    expect(page("orders", "page.tsx")).toMatch(/requireRole\(\[\.\.\.ORDERS_PAGE_ROLES\]\)/);
    expect(page("orders", "[id]", "page.tsx")).toMatch(/requireRole\(\[\.\.\.ORDERS_PAGE_ROLES\]\)/);
    expect(page("provisions", "page.tsx")).toMatch(/requireRole\(\[\.\.\.PROVISIONS_PAGE_ROLES\]\)/);
    expect(page("deals", "page.tsx")).toMatch(/requireRole\(\[\.\.\.DEALS_PAGE_ROLES\]\)/);
    expect(page("deals", "[id]", "page.tsx")).toMatch(/requireRole\(\[\.\.\.DEALS_PAGE_ROLES\]\)/);
  });

  it("the APIs those pages call use the same lists, not just a login (ID 143)", () => {
    const apiDir = fileURLToPath(new URL("../app/api", import.meta.url));
    const route = (...parts: string[]) => readFileSync(join(apiDir, ...parts, "route.ts"), "utf8");

    expect(route("orders")).toMatch(/requireRole\(\[\.\.\.ORDERS_PAGE_ROLES\]\)/);
    expect(route("orders", "[id]", "upload-pi")).toMatch(/requireRole\(\[\.\.\.ORDERS_PAGE_ROLES\]\)/);
    expect(route("provisions")).toMatch(/requireRole\(\[\.\.\.PROVISIONS_PAGE_ROLES\]\)/);
    expect(route("provisions", "inventory")).toMatch(/requireRole\(\[\.\.\.PROVISIONS_PAGE_ROLES\]\)/);
    for (const r of [route("orders", "[id]", "upload-pi"), route("provisions", "inventory")]) {
      expect(r).not.toMatch(/requireAuth\(/);
    }
  });
});

describe("which role middleware believes", () => {
  it("prefers app_metadata over user_metadata", async () => {
    // app_metadata is written by the server; user_metadata by the user.
    expect(await visit("/ceo", { app: "dealer", meta: "ceo" })).toBe("/dealer-portal");
  });

  it("treats a literal 'user' as a placeholder and reads the next slot", async () => {
    expect(await visit("/nbfc/portfolio", { app: "user", meta: "nbfc_partner" })).toBe("pass");
    expect(await visit("/nbfc/portfolio", { app: "USER", meta: "nbfc_partner" })).toBe("pass");
  });

  it("falls back to the legacy users lookup only when both slots are empty", async () => {
    session.row = { role: "admin" };
    expect(await visit("/admin/users", {})).toBe("pass");
    // A real metadata role is not overridden by that row.
    expect(await visit("/admin/users", as("dealer"))).toBe("/dealer-portal");
  });

  it("lower-cases the role before comparing", async () => {
    expect(await visit("/admin/users", as("ADMIN"))).toBe("pass");
  });

  it("gives a role it has never heard of no dashboard at all", async () => {
    // No role anywhere resolves to "user"; so do typos and unlisted roles.
    // They are bounced to "/", which renders for them without a redirect loop.
    for (const who of [{}, as("user"), as("ops_manager"), as("sales-head")]) {
      expect(await visit("/admin/users", who)).toBe("/");
      expect(await visit("/ceo", who)).toBe("/");
      expect(await visit("/", who)).toBe("pass");
    }
  });
});

describe("NBFC first-login password change", () => {
  it("holds an nbfc_partner on /change-password until it is done", async () => {
    session.row = { must_change_password: true };
    expect(await visit("/nbfc/portfolio", as("nbfc_partner"))).toBe("/change-password");
    expect(await visit("/risk-head/approvals", as("nbfc_partner"))).toBe("/change-password");
  });

  it("does not hold anyone whose flag is clear", async () => {
    session.row = { must_change_password: false };
    expect(await visit("/nbfc/portfolio", as("nbfc_partner"))).toBe("pass");
  });

  it("KNOWN GAP: a failed or empty lookup lets the partner straight in", async () => {
    // The flag is read through the Supabase client, and Supabase has no
    // public.users table — the row lives on RDS. So in practice this lookup
    // returns nothing and the gate never fires; only the login action
    // enforces it. Should fail closed, or read the flag from where it lives.
    session.row = null;
    expect(await visit("/nbfc/portfolio", as("nbfc_partner"))).toBe("pass");
  });
});

describe("the API login gate, as wired into middleware", () => {
  it("refuses an anonymous call to a private route in enforce mode", async () => {
    vi.stubEnv("API_AUTH_GATE", "enforce");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await visit("/api/leads/create")).toBe("401");
  });

  it("only logs it in the default report mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await visit("/api/dealer/profile")).toBe("pass");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("would refuse unauthenticated GET /api/dealer/profile"));
  });

  it("lets public paths and signed-in callers through in enforce mode", async () => {
    vi.stubEnv("API_AUTH_GATE", "enforce");
    expect(await visit("/api/health")).toBe("pass");
    expect(await visit("/api/auth/logout")).toBe("pass");
    expect(await visit("/api/bot/campaigns")).toBe("pass");
    expect(await visit("/api/leads/create", as("dealer"))).toBe("pass");
  });

  it("never role-bounces an API call — routes answer for themselves", async () => {
    expect(await visit("/api/admin/users", as("dealer"))).toBe("pass");
  });
});

describe("the test bypass header", () => {
  it("skips auth outside production when the secret matches", async () => {
    vi.stubEnv("NBFC_TEST_BYPASS_SECRET", "s3cret");
    const res = await middleware(
      new NextRequest("http://localhost/admin/nbfc/1/review", { headers: { "x-nbfc-test-bypass": "s3cret" } }),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("does nothing in production, with a wrong value, or with no secret set", async () => {
    const request = (value: string) =>
      new NextRequest("http://localhost/admin/nbfc/1/review", { headers: { "x-nbfc-test-bypass": value } });
    const target = async (value: string) =>
      new URL((await middleware(request(value))).headers.get("location") ?? "http://localhost/pass").pathname;

    // No secret configured: an empty header must not equal an unset secret.
    expect(await target("")).toBe("/login");

    vi.stubEnv("NBFC_TEST_BYPASS_SECRET", "s3cret");
    expect(await target("wrong")).toBe("/login");

    vi.stubEnv("NODE_ENV", "production");
    expect(await target("s3cret")).toBe("/login");
  });
});

describe("the matcher", () => {
  // Next anchors the source itself; this mirrors that.
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  const runs = (path: string) => matcher.test(path);

  it("runs on pages and on every /api path, including file-proxy URLs with an extension", () => {
    for (const p of ["/", "/admin", "/dealer-portal/leads/1", "/api/leads", "/api/files/bucket/key.png", "/api/files/b/doc.pdf"]) {
      expect(runs(p), p).toBe(true);
    }
  });

  it("skips Next internals, the favicon, fonts and static images", () => {
    for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/fonts/brand.woff2", "/logo.png", "/hero.webp"]) {
      expect(runs(p), p).toBe(false);
    }
  });

  it("KNOWN GAP: a page path that merely ends in an image or PDF extension skips middleware", () => {
    // The extension skip is not limited to real static files, so a dynamic
    // segment can be made to look like one: /admin/inventory/[itemId] with
    // itemId "abc.png" reaches the page with no login check and no role
    // bounce. Only the page's own guard is left. Lower-case only.
    for (const p of ["/admin/inventory/abc.png", "/orders/x.pdf", "/dealer-portal/leads/1.jpg", "/ceo/anything.svg"]) {
      expect(runs(p), p).toBe(false);
    }
    expect(runs("/admin/inventory/abc.PNG")).toBe(true);
  });

  it("KNOWN GAP: uploaded NBFC images and PDFs under /nbfc-uploads are never seen by middleware", () => {
    // Files committed under public/nbfc-uploads are served statically, before
    // the session-checked /api/nbfc-uploads rewrite can fire.
    expect(runs("/nbfc-uploads/100/pan_card.jpeg")).toBe(false);
    expect(runs("/nbfc-uploads/100/agreement.pdf")).toBe(false);
  });
});

describe("KNOWN GAPS in the role check", () => {
  it("pages that are 'protected' but tied to no role render for every signed-in role", async () => {
    // isProtectedRoute lists these, so a signed-out visitor is turned away —
    // but none is a roleDashboards prefix, so the only role check never runs.
    // A dealer, a scrap vendor, an NBFC partner and an auth user with no
    // users row all get through. These are client pages that lean on their
    // APIs. (/orders, /provisions and /deals were here too — see
    // "the procurement and deal pages" above.)
    const pages = [
      "/inventory",
      "/product-catalog",
      "/oem-onboarding",
      "/leads",
      "/approvals",
      "/disputes",
      "/expenses/submit",
    ];
    for (const role of [...EXTERNAL_ROLES, "user"]) {
      for (const p of pages) {
        expect(await visit(p, as(role)), `${role} ${p}`).toBe("pass");
      }
    }
  });

  it("/risk-head has an allow-list row that turns nobody away", async () => {
    // sharedRouteAccess can only ADMIT; the deny needs a roleDashboards
    // prefix, and /risk-head is not one. The layout is what stops a dealer.
    expect(await visit("/risk-head/approvals", as("dealer"))).toBe("pass");
  });

  it("user_metadata.role is believed when app_metadata has no role", async () => {
    // A signed-in user can write their own user_metadata through the Supabase
    // client. With app_metadata.role unset — or the 'user' placeholder — that
    // self-asserted value becomes the role, and 'ceo' passes every bounce.
    expect(await visit("/ceo", { meta: "ceo" })).toBe("pass");
    expect(await visit("/admin/users", { app: "user", meta: "ceo" })).toBe("pass");
  });

  it("prefixes match without a segment boundary", async () => {
    // startsWith("/admin") also claims /administrator; "/it" claims /items.
    // Harmless while no such route exists — it fails closed — but the same
    // looseness makes /nbfc swallow /nbfc-uploads, bouncing sales_head off the
    // VKYC videos its own /admin/nbfc pages link to.
    expect(await visit("/administrator", as("dealer"))).toBe("/dealer-portal");
    expect(await visit("/items", as("dealer"))).toBe("/dealer-portal");
    expect(await visit("/nbfc-uploads/100/vkyc.webm", as("sales_head"))).toBe("/sales-head");
  });
});
