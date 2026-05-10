"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ShoppingCart,
  Users,
  FileText,
  Phone,
  PieChart,
  Package,
  FileCheck,
  Landmark,
  Briefcase,
  Building,
  Receipt,
  ClipboardCheck,
  Car,
  Battery,
  Wrench,
  CreditCard,
  Megaphone,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth/AuthProvider";

const roleNavigation: Record<string, any[]> = {
  ceo: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/ceo",
        },
      ],
    },
    {
      section: "BUSINESS",
      items: [
        {
          id: "product-catalog",
          label: "Product Catalog",
          icon: Package,
          href: "/product-catalog",
        },
        { id: "oems", label: "OEMs", icon: Landmark, href: "/oem-onboarding" },
        {
          id: "inventory-reports",
          label: "Inventory",
          icon: PieChart,
          href: "/inventory",
        },
        { id: "leads", label: "Leads", icon: Users, href: "/leads" },
        { id: "deals", label: "Deals", icon: FileCheck, href: "/deals" },
      ],
    },
    {
      section: "INTELLIGENCE",
      items: [
        {
          id: "intellicar",
          label: "Intellicar Dashboard",
          icon: Battery,
          href: "/ceo/intellicar",
        },
        {
          id: "ai-dialer",
          label: "AI Dialer (Bolna)",
          icon: Phone,
          href: "/ceo/ai-dialer",
        },
      ],
    },
    {
      section: "NBFC APPROVALS",
      items: [
        {
          id: "nbfc-approvals",
          label: "Pending NBFC Approvals",
          icon: ClipboardCheck,
          href: "/admin/nbfc/approvals",
        },
        {
          id: "nbfc-directory",
          label: "NBFC Directory",
          icon: Building,
          href: "/admin/nbfc",
        },
        {
          id: "nbfc-ecosystem",
          label: "Ecosystem Overview",
          icon: PieChart,
          href: "/admin/nbfc/ecosystem-overview",
        },
      ],
    },
    {
      section: "ADMIN",
      items: [
        {
          id: "kyc-review",
          label: "KYC Review",
          icon: Shield,
          href: "/admin/kyc-review",
        },
        {
          id: "product-review",
          label: "Product Review",
          icon: Package,
          href: "/admin/product-review",
        },
      ],
    },
  ],

  sales_head: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/sales-head",
        },
      ],
    },
    {
      section: "SALES",
      items: [
        { id: "leads", label: "Leads", icon: Users, href: "/leads" },
        { id: "deals", label: "Deals", icon: FileCheck, href: "/deals" },
        {
          id: "approvals",
          label: "Approvals",
          icon: FileText,
          href: "/sales-head/approvals",
        },
      ],
    },
    {
      section: "NBFC",
      items: [
        {
          id: "nbfc-onboard",
          label: "Onboard NBFC",
          icon: Building,
          href: "/admin/nbfc/new",
        },
        {
          id: "nbfc-directory",
          label: "NBFC Directory",
          icon: Landmark,
          href: "/admin/nbfc",
        },
        {
          id: "nbfc-my-drafts",
          label: "My Submitted Drafts",
          icon: FileText,
          href: "/admin/nbfc?owner=me",
        },
      ],
    },
    // Dealer Scraper removed — now lives inside /leads as a tab
    {
      section: "ADMIN",
      items: [
        {
          id: "kyc-review",
          label: "KYC Review",
          icon: Shield,
          href: "/admin/kyc-review",
        },
        {
          id: "product-review",
          label: "Product Review",
          icon: Package,
          href: "/admin/product-review",
        },
        {
          id: "dealer-validation",
          label: "Dealer Validation",
          icon: ClipboardCheck,
          href: "/admin/dealer-verification",
        },
      ],
    },
  ],

  sales_manager: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/sales-manager",
        },
      ],
    },
    {
      section: "SALES",
      items: [
        { id: "leads", label: "My Leads", icon: Users, href: "/leads" },
        { id: "deals", label: "My Deals", icon: FileCheck, href: "/deals" },
        {
          id: "ai-calls",
          label: "AI Calls",
          icon: Phone,
          href: "/sales-manager/ai-calls",
        },
      ],
    },
    // Dealer Prospecting section removed — scraped leads now live inside /leads as a tab
  ],

  inventory_manager: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/inventory-manager",
        },
      ],
    },
    {
      section: "INVENTORY",
      items: [
        {
          id: "product-catalog",
          label: "Product Catalog",
          icon: Package,
          href: "/product-catalog",
        },
        {
          id: "admin-inventory",
          label: "Inventory",
          icon: PieChart,
          href: "/admin/inventory",
        },
        {
          id: "admin-inventory-upload",
          label: "Bulk Upload",
          icon: ShoppingCart,
          href: "/admin/inventory/upload",
        },
      ],
    },
  ],

  admin: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/admin",
        },
      ],
    },
    {
      section: "REVIEW",
      items: [
        {
          id: "kyc-review",
          label: "KYC Review",
          icon: Shield,
          href: "/admin/kyc-review",
        },
        {
          id: "product-review",
          label: "Product Review",
          icon: Package,
          href: "/admin/product-review",
        },
      ],
    },
    {
      section: "INVENTORY",
      items: [
        {
          id: "admin-inventory",
          label: "Inventory",
          icon: PieChart,
          href: "/admin/inventory",
        },
        {
          id: "admin-inventory-upload",
          label: "Bulk Upload",
          icon: ShoppingCart,
          href: "/admin/inventory/upload",
        },
        {
          id: "admin-inventory-add",
          label: "Add Item",
          icon: Package,
          href: "/admin/inventory/add",
        },
      ],
    },
  ],

  service_engineer: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/service-engineer",
        },
      ],
    },
    {
      section: "PDI",
      items: [
        {
          id: "pdi-queue",
          label: "PDI Queue",
          icon: FileCheck,
          href: "/service-engineer/pdi-queue",
        },
      ],
    },
  ],

  business_head: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/business-head",
        },
      ],
    },
    {
      section: "MANAGEMENT",
      items: [
        {
          id: "approvals",
          label: "Approvals",
          icon: FileCheck,
          href: "/business-head/approvals",
        },
        {
          id: "credits",
          label: "Credit Management",
          icon: Landmark,
          href: "/business-head/credits",
        },
      ],
    },
    {
      section: "ADMIN",
      items: [
        {
          id: "kyc-review",
          label: "KYC Review",
          icon: Shield,
          href: "/admin/kyc-review",
        },
        {
          id: "product-review",
          label: "Product Review",
          icon: Package,
          href: "/admin/product-review",
        },
      ],
    },
  ],

  finance_controller: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/finance-controller",
        },
      ],
    },
    {
      section: "FINANCE",
      items: [
        {
          id: "invoices",
          label: "Invoices",
          icon: FileText,
          href: "/finance-controller/invoices",
        },
        {
          id: "payments",
          label: "Payments",
          icon: Landmark,
          href: "/finance-controller/payments",
        },
        {
          id: "credits",
          label: "Credits",
          icon: Briefcase,
          href: "/finance-controller/credits",
        },
      ],
    },
  ],

  sales_order_manager: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/sales-order-manager",
        },
      ],
    },
    {
      section: "OPERATIONS",
      items: [
        {
          id: "oem-onboarding",
          label: "OEM Onboarding",
          icon: Building,
          href: "/sales-order-manager/oem-onboarding",
        },
        {
          id: "provisions",
          label: "Provisions",
          icon: FileText,
          href: "/sales-order-manager/provisions",
        },
        {
          id: "orders",
          label: "Orders",
          icon: ShoppingCart,
          href: "/sales-order-manager/orders",
        },
        {
          id: "pi-invoices",
          label: "PI & Invoices",
          icon: Receipt,
          href: "/sales-order-manager/pi-invoices",
        },
      ],
    },
  ],

  sales_executive: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/sales-executive",
        },
      ],
    },
    {
      section: "SALES",
      items: [
        { id: "leads", label: "My Leads", icon: Users, href: "/leads" },
        { id: "deals", label: "My Deals", icon: FileCheck, href: "/deals" },
      ],
    },
  ],

  dealer: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/dealer-portal",
        },
      ],
    },
    {
      section: "SALES",
      items: [
        {
          id: "leads",
          label: "Lead Management",
          icon: Users,
          href: "/dealer-portal/leads",
        },
        {
          id: "drafts",
          label: "My Drafts",
          icon: FileText,
          href: "/dealer-portal/leads/drafts",
        },
        {
          id: "loans",
          label: "Loan Processing",
          icon: Landmark,
          href: "/dealer-portal/loans",
        },
        {
          id: "loan-mgmt",
          label: "Loan Management",
          icon: CreditCard,
          href: "/dealer-portal/loans/management",
        },
        {
          id: "assets",
          label: "Asset Management",
          icon: Car,
          href: "/dealer-portal/assets",
        },
        {
          id: "batteries",
          label: "Battery Management",
          icon: Battery,
          href: "/dealer-portal/batteries",
        },
      ],
    },
    {
      section: "OPERATIONS",
      items: [
        {
          id: "orders",
          label: "Orders from OEM",
          icon: ShoppingCart,
          href: "/dealer-portal/orders",
        },
        {
          id: "inventory",
          label: "Inventory",
          icon: Package,
          href: "/dealer-portal/inventory",
        },
        {
          id: "service",
          label: "Service Management",
          icon: Wrench,
          href: "/dealer-portal/service",
        },
        {
          id: "campaigns",
          label: "Campaigns",
          icon: Megaphone,
          href: "/dealer-portal/campaigns/new",
        },
      ],
    },
  ],

  user: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/",
        },
      ],
    },
  ],
};

export function Sidebar() {
  const pathname = usePathname();
  const { user, loading } = useAuth();

  // Derive role from the current pathname so the sidebar renders immediately
  // even before the auth context resolves. This eliminates the "blank sidebar
  // until refresh" SSR issue because we no longer gate on loading/user.
  const inferredRole = (() => {
    if (user?.role) return user.role.toLowerCase();
    if (pathname.startsWith("/dealer-portal")) return "dealer";
    if (pathname.startsWith("/admin")) return "admin";
    if (pathname.startsWith("/ceo")) return "ceo";
    if (pathname.startsWith("/sales-head")) return "sales_head";
    if (pathname.startsWith("/business-head")) return "business_head";
    if (pathname.startsWith("/finance-controller")) return "finance_controller";
    if (pathname.startsWith("/sales-order-manager")) return "sales_order_manager";
    if (pathname.startsWith("/inventory-manager")) return "inventory_manager";
    if (pathname.startsWith("/service-engineer")) return "service_engineer";
    if (pathname.startsWith("/sales-manager")) return "sales_manager";
    if (pathname.startsWith("/sales-executive")) return "sales_executive";
    return "user";
  })();

  const rawMenuItems = roleNavigation[inferredRole] || roleNavigation["user"] || [];

  // For the dealer role, loan-related entries must hide when the dealer's
  // onboarding application has financeEnabled=false. Source the flag from
  // /api/dealer/stats (already the authoritative finance-enabled endpoint).
  const [dealerFinanceEnabled, setDealerFinanceEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (inferredRole !== "dealer") return;
    let cancelled = false;
    fetch("/api/dealer/stats", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const flag = json?.data?.dealer?.financeEnabled;
        setDealerFinanceEnabled(typeof flag === "boolean" ? flag : false);
      })
      .catch(() => {
        if (!cancelled) setDealerFinanceEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inferredRole]);

  const financeGatedItemIds = new Set(["loans", "loan-mgmt"]);
  const menuItems =
    inferredRole === "dealer" && dealerFinanceEnabled === false
      ? rawMenuItems.map((group: any) => ({
          ...group,
          items: group.items.filter((item: any) => !financeGatedItemIds.has(item.id)),
        }))
      : rawMenuItems;

  // BRD §6.B sidebar — solid #02314e navy, 9px ALL CAPS section labels at
  // rgba(255,255,255,0.30), 13px DM Sans Medium nav items, 3px transparent
  // left border, active = `rgba(19,143,198,0.15)` bg + `#138fc6` left border
  // + white text. Width pinned at w-64 to keep LayoutWrapper margin (md:ml-64).
  return (
    <div className="sidebar-shell w-64 h-screen flex-col fixed left-0 top-0 z-10 hidden md:flex">
      {/* Logo lockup */}
      <div className="px-5 h-[68px] flex items-center border-b border-white/[0.07]">
        <img
          src="/itarang-logo-white.png"
          alt="iTarang"
          className="h-7 w-auto object-contain select-none"
          draggable={false}
        />
      </div>

      <div className="flex-1 overflow-y-auto py-6 space-y-7">
        {menuItems.map((group: any) => (
          <div key={group.section}>
            <h3 className="sidebar-section-label px-5 mb-2">
              {group.section}
            </h3>
            <div>
              {group.items.map((item: any) => {
                // active = exact match OR active for `/admin/nbfc?owner=me` style hrefs
                const itemPath = item.href.split("?")[0];
                const isActive =
                  pathname === itemPath ||
                  (itemPath !== "/" && pathname.startsWith(itemPath + "/"));
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    className={cn(
                      isActive ? "sidebar-nav-item-active" : "sidebar-nav-item",
                    )}
                  >
                    <item.icon
                      className={cn(
                        "w-[18px] h-[18px] shrink-0",
                        isActive ? "text-white" : "text-white/55",
                      )}
                      strokeWidth={1.75}
                    />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Profile mini-card — NOTE: `displayRole` is sourced from users.role
          via /api/user/profile. The known "dealer for sales_head" data
          glitch is upstream of the UI; see docs/nbfc/NOTES.md. */}
      <div className="px-4 py-4 border-t border-white/[0.07]">
        <div className="flex items-center gap-3">
          {loading && !user ? (
            <>
              <div className="w-9 h-9 bg-white/10 rounded-full animate-pulse" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="h-3.5 w-24 bg-white/10 rounded animate-pulse" />
                <div className="h-3 w-16 bg-white/10 rounded animate-pulse" />
              </div>
            </>
          ) : (
            <>
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm shadow-sm"
                style={{ background: "var(--gradient-primary)" }}
              >
                {(user?.name?.[0] || user?.email?.[0] || "U").toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-white truncate">
                  {user?.name || "User"}
                </p>
                <span
                  className="inline-block mt-1 px-2 py-0.5 rounded text-[9px] font-bold tracking-[0.14em] uppercase"
                  style={{
                    background: "rgba(19,143,198,0.18)",
                    color: "#9fcfe8",
                  }}
                >
                  {user?.role || inferredRole}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
