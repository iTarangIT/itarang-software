"use client";

import React, { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ShoppingCart,
  Users,
  FileText,
  Calculator,
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
  TrendingUp,
  ListChecks,
  MapPinned,
  AlertTriangle,
  Upload,
  BarChart3,
  GitMerge,
  MessageSquare,
  UserMinus,
  History,
  X,
  Recycle,
  Coins,
  Truck,
  BookOpen,
  Handshake,
  FolderOpen,
  Wallet,
  Bell,
  ShieldAlert,
  Radar,
  ChevronDown,
  Gavel,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth/AuthProvider";
import { useUIStore } from "@/store/uiStore";
import { useBuybackNotificationSummary } from "@/hooks/useBuybackNotificationSummary";
import { useNavActivity } from "@/hooks/useNavActivity";
import {
  normalizeDealerType,
  type DealerTypeValue,
} from "@/lib/dealer/dealer-type";
import { capabilitiesFor } from "@/lib/dealer/dealer-capabilities";
import { readSnapshot, writeSnapshot } from "@/lib/session-snapshot";

/**
 * Session snapshot of the two flags that decide which dealer menu items exist.
 * Non-sensitive (a boolean and an enum), and cleared on sign-out by
 * clearSnapshots() so one user's menu gating can't leak into the next
 * user's session in the same tab.
 */
const DEALER_GATE_SNAPSHOT_KEY = "itarang:sidebar:dealer-gate:v1";

/** Loan entries, hidden when the dealer's finance enablement is off. */
const FINANCE_GATED_ITEM_IDS = new Set(["loans", "loan-mgmt"]);
/** Section headings gated by dealer type (E-202). */
const BUYBACK_SECTION = "BATTERY BUYBACK";
const NEW_BATTERY_SECTIONS = new Set(["SALES", "OPERATIONS"]);
/**
 * A scrap dealer's /dealer-portal IS the buyback dashboard, so the "Buyback
 * Dashboard" item would be a second link to the page "Dashboard" already
 * points at.
 */
const REDUNDANT_FOR_SCRAP_ITEM_IDS = new Set(["buyback"]);

/**
 * peakAmp Battery Buyback — the iTarang-staff side.
 *
 * Shown to exactly the roles that BUYBACK_ADMIN_ROLES allows
 * (src/lib/buyback/roles.ts: admin, ceo, business_head, sales_head). Kept as one
 * shared const rather than copy-pasted into the role arrays below, so the menu
 * cannot drift out of step with who the API actually lets in — a link a role can
 * see but not open is worse than no link.
 */
const BUYBACK_ADMIN_SECTION = {
  section: "BATTERY BUYBACK",
  items: [
    {
      id: "buyback-dashboard",
      label: "Buyback Dashboard",
      icon: LayoutDashboard,
      href: "/admin/buyback/dashboard",
    },
    {
      id: "buyback-notifications",
      label: "Notifications",
      icon: Bell,
      href: "/admin/buyback/notifications",
    },
    {
      id: "buyback-queue",
      label: "Buyback Requests",
      icon: Recycle,
      href: "/admin/buyback",
    },
    {
      id: "buyback-negotiations",
      label: "Negotiations",
      icon: Handshake,
      href: "/admin/buyback/negotiations",
    },
    {
      id: "buyback-vendors",
      label: "Scrap Vendors",
      icon: Truck,
      href: "/admin/buyback/vendors",
    },
    {
      id: "buyback-catalog",
      label: "Battery Catalogue",
      icon: BookOpen,
      href: "/admin/buyback/catalog",
    },
    {
      id: "buyback-documents",
      label: "Documents",
      icon: FolderOpen,
      href: "/admin/buyback/documents",
    },
    {
      id: "buyback-payments",
      label: "Payments & Settlement",
      icon: Wallet,
      href: "/admin/buyback/payments",
    },
    {
      id: "buyback-ledger",
      label: "Transaction History",
      icon: Coins,
      href: "/admin/buyback/ledger",
    },
    {
      id: "buyback-statements",
      label: "Bank Reconciliation",
      icon: Receipt,
      href: "/admin/buyback/statements",
    },
  ],
};

/**
 * E-224 — NeoDove, the external telecalling vendor the business runs its
 * calling in. Shown to exactly the roles NEODOVE_ADMIN_ROLES lets through
 * (src/lib/neodove/roles.ts: admin, sales_head, business_head, ceo,
 * sales_manager) — pushing the prospect pool to an outside vendor consumes
 * their plan quota, so it is not an individual-rep capability.
 *
 * One shared const rather than five copies, for the same reason
 * BUYBACK_ADMIN_SECTION is: a link a role can see but not open is worse than
 * no link, and five hand-maintained copies guarantee that drift eventually.
 *
 * Its own section rather than items inside LEAD MANAGEMENT because this
 * integration has a failure mode nothing else there has — NeoDove cannot be
 * queried, so a dropped webhook is silent and unrecoverable. Sync Activity and
 * Reconcile exist only to make that visible, and they are useless if you have
 * to go hunting for them.
 */
const NEODOVE_SECTION = {
  section: "NEODOVE",
  items: [
    {
      id: "neodove-campaigns",
      label: "Campaigns",
      icon: Megaphone,
      href: "/leads/neodove-campaigns",
      // Deliberately NOT `exact`. getActiveItemId is longest-match-wins, so
      // /activity and /reconcile already beat this item on their own pages
      // (their paths are longer), while campaign DETAIL routes —
      // /leads/neodove-campaigns/NDC-… — match only this one and correctly keep
      // Campaigns lit. Marking it exact would black the sidebar out on every
      // detail page, which is precisely the U5 bug documented further down.
    },
    {
      id: "neodove-activity",
      label: "Sync Activity",
      icon: History,
      href: "/leads/neodove-campaigns/activity",
    },
    {
      id: "neodove-reconcile",
      label: "Reconcile",
      icon: Upload,
      href: "/leads/neodove-campaigns/reconcile",
    },
  ],
};

// Items appended to every role's sidebar — universal actions any logged-in
// user can take (currently: submit a business expense → CEO approves).
const COMMON_ITEMS = [
  {
    section: "EXPENSES",
    items: [
      {
        id: "submit-expense",
        label: "Submit Expense",
        icon: Receipt,
        href: "/expenses/submit",
      },
    ],
  },
];

// Per-role sections pinned BELOW COMMON_ITEMS.
//
// COMMON_ITEMS is appended to every role at the end of the build (see
// `menuItems` below), so anything inside a role's own array can only ever
// render ABOVE "EXPENSES / Submit Expense". A role whose last item must
// genuinely BE last goes here instead.
//
// Only sales_head uses this today; every other role's rendered nav is unchanged.
// The item keeps the id `sh-settings` on purpose — getActiveItemId() is
// longest-href-wins so /admin/settings still beats /admin, and the badge mapping
// further down keys on item.id.
const ROLE_TRAILING_SECTIONS: Record<string, any[]> = {
  sales_head: [
    {
      section: "Settings",
      items: [
        {
          // id and href keep their old "settings" spelling on purpose — the id
          // backs `data-testid="nav-sh-settings"` and the route is unchanged.
          // Only the label the user reads was renamed.
          id: "sh-settings",
          label: "Notifications",
          icon: Bell,
          href: "/admin/settings",
        },
      ],
    },
  ],
};

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
      section: "PART 0 OVERSIGHT",
      items: [
        {
          id: "ceo-admin-dashboard",
          label: "Ops Dashboard",
          icon: LayoutDashboard,
          href: "/admin",
        },
        {
          id: "ceo-escalations",
          label: "Escalations",
          icon: AlertTriangle,
          href: "/admin/escalations",
        },
        {
          id: "ceo-reports",
          label: "Reports",
          icon: BarChart3,
          href: "/admin/reports",
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
        // E-230 — OEM Onboarding came off this slot and OEM Inventory Pricing
        // took its place, as asked on the 2026-08-06 call. The onboarding form
        // is not deleted: it still lives at /oem-onboarding and is still linked
        // from the sales_order_manager sidebar, which is who actually uses it.
        {
          id: "oem-pricing",
          label: "OEM Inventory Pricing",
          icon: Landmark,
          href: "/oem-pricing",
        },
        {
          id: "inventory-reports",
          label: "Inventory",
          icon: PieChart,
          href: "/inventory",
        },
        { id: "leads", label: "Leads", icon: Users, href: "/leads" },
        { id: "deals", label: "Deals", icon: FileCheck, href: "/deals" },
        {
          id: "sales-invoices",
          label: "Sales Invoices",
          icon: Receipt,
          href: "/ceo/invoices",
        },
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
          id: "financing-offer-approvals",
          label: "Financing Approvals",
          icon: ClipboardCheck,
          href: "/admin/nbfc/financing-offers/approvals",
        },
        {
          id: "nbfc-directory",
          label: "NBFC Directory",
          icon: Building,
          href: "/admin/nbfc",
        },
        {
          id: "loan-products",
          label: "Loan Products",
          icon: Package,
          href: "/admin/loan-products",
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
        {
          id: "expense-approvals",
          label: "Expense Approvals",
          icon: ClipboardCheck,
          href: "/ceo/expenses",
        },
        // E-230 — E-226's "OEM Price List" entry pointed at /ceo/oem-prices,
        // which now redirects to /oem-pricing under BUSINESS above. Two sidebar
        // entries onto one table is exactly the "multiple gates to reach one
        // single place" the same call objected to, so this one is gone rather
        // than repointed.
      ],
    },
    NEODOVE_SECTION,
    BUYBACK_ADMIN_SECTION,
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
      section: "LEAD MANAGEMENT",
      items: [
        {
          id: "sh-admin-dashboard",
          label: "Ops Dashboard",
          icon: LayoutDashboard,
          href: "/admin",
        },
        // "Leads Info" merged into /leads — one screen, one lead, one row.
        // sales_head was the only role carrying both entries.
        {
          id: "sh-leads",
          label: "Leads",
          icon: Users,
          href: "/leads",
        },
        {
          id: "sh-escalations",
          label: "Escalations",
          icon: AlertTriangle,
          href: "/admin/escalations",
        },
        {
          id: "sh-merge-requests",
          label: "Merge Requests",
          icon: GitMerge,
          href: "/admin/merge-requests",
        },
        {
          id: "sh-onboarding-dropouts",
          label: "Onboarding Dropouts",
          icon: UserMinus,
          href: "/admin/onboarding-dropouts",
        },
        {
          id: "sh-whatsapp-onboarding",
          label: "WhatsApp Onboarding",
          icon: MessageSquare,
          href: "/admin/whatsapp-onboarding",
        },
        {
          id: "sh-lead-upload",
          label: "Bulk Lead Upload",
          icon: Upload,
          href: "/admin/upload",
        },
        {
          id: "sh-reports",
          label: "Reports",
          icon: BarChart3,
          href: "/admin/reports",
        },
        // "Notifications" (formerly "Settings") used to sit here, buried in
        // LEAD MANAGEMENT. It now lives in ROLE_TRAILING_SECTIONS so it renders
        // last — see the note there.
      ],
    },
    {
      section: "SALES",
      items: [
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
          id: "loan-products",
          label: "Loan Products",
          icon: Package,
          href: "/admin/loan-products",
        },
        {
          id: "nbfc-risk-cards",
          label: "Risk Cards",
          icon: AlertTriangle,
          href: "/admin/nbfc/risk-cards",
        },
        // [E-234] The Auction Control Centre. Its eight endpoints have existed
        // since E-069/E-070 with no screen and no nav entry, so pause / extend /
        // reduce / reserve-price / approve-winner / cancel were reachable only
        // by hand-written curl. This is the first way in.
        {
          id: "nbfc-auction-control",
          label: "Auction Control",
          icon: Gavel,
          href: "/admin/nbfc/auction",
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
          id: "admin-product-master",
          label: "Product Master",
          icon: Package,
          href: "/admin/product-master",
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
        {
          id: "admin-inventory-ageing",
          label: "Ageing Report",
          icon: Package,
          href: "/admin/inventory/ageing-report",
        },
        {
          id: "admin-inventory-transfer",
          label: "Transfer",
          icon: ShoppingCart,
          href: "/admin/inventory/transfer",
        },
      ],
    },
    {
      section: "EXPENSES",
      items: [
        {
          id: "sh-ai-expense-tracker",
          label: "AI Expense Tracker",
          icon: Receipt,
          href: "/admin/expense-tracker",
        },
      ],
    },
    {
      section: "CALCULATOR",
      items: [
        {
          id: "sh-calculator",
          label: "Loan Calculator",
          icon: Calculator,
          href: "/admin/calculator",
        },
        {
          id: "sh-calculator-history",
          label: "Search History",
          icon: History,
          href: "/admin/calculator/search-history",
        },
      ],
    },
    NEODOVE_SECTION,
    BUYBACK_ADMIN_SECTION,
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
    NEODOVE_SECTION,
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
          id: "admin-product-master",
          label: "Product Master",
          icon: Package,
          href: "/admin/product-master",
        },
        {
          id: "admin-inventory-upload",
          label: "Bulk Upload",
          icon: ShoppingCart,
          href: "/admin/inventory/upload",
        },
        {
          id: "admin-inventory-ageing",
          label: "Ageing Report",
          icon: Package,
          href: "/admin/inventory/ageing-report",
        },
        {
          id: "admin-inventory-transfer",
          label: "Transfer",
          icon: ShoppingCart,
          href: "/admin/inventory/transfer",
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
      section: "LEAD MANAGEMENT",
      items: [
        // Repointed, not deleted: this was admin's ONLY route into leads —
        // the admin nav had no /leads entry — so removing it would have taken
        // admin off the merged screen entirely.
        {
          id: "admin-leads",
          label: "Leads",
          icon: Users,
          href: "/leads",
        },
        {
          id: "admin-escalations",
          label: "Escalations",
          icon: AlertTriangle,
          href: "/admin/escalations",
        },
        {
          id: "admin-merge-requests",
          label: "Merge Requests",
          icon: GitMerge,
          href: "/admin/merge-requests",
        },
        {
          id: "admin-onboarding-dropouts",
          label: "Onboarding Dropouts",
          icon: UserMinus,
          href: "/admin/onboarding-dropouts",
        },
        {
          id: "admin-whatsapp-onboarding",
          label: "WhatsApp Onboarding",
          icon: MessageSquare,
          href: "/admin/whatsapp-onboarding",
        },
        {
          id: "admin-lead-upload",
          label: "Bulk Lead Upload",
          icon: Upload,
          href: "/admin/upload",
        },
        {
          id: "admin-reports",
          label: "Reports",
          icon: BarChart3,
          href: "/admin/reports",
        },
        {
          id: "admin-settings",
          label: "Notifications",
          icon: Bell,
          href: "/admin/settings",
        },
      ],
    },
    NEODOVE_SECTION,
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
          id: "admin-product-master",
          label: "Product Master",
          icon: Package,
          href: "/admin/product-master",
        },
        // E-230 — the same screen the CEO reaches under BUSINESS. Admin is
        // authorised for it everywhere else (the API allows ceo + admin, the
        // middleware gate allows ceo + admin, and both price notifications go
        // to PRICE_KEEPERS = admin + ceo with href "/oem-pricing"), so without
        // this entry an admin could follow a notification INTO the screen and
        // then have no way back to it.
        //
        // Next to Product Master rather than with the stock movements below:
        // both are reference data about what we sell, and this screen prices
        // exactly the models that one defines. Deliberately NOT added to the
        // sales_head or inventory_manager copies of this section — the route
        // gate admits ceo and admin only, so a link there would just bounce.
        {
          id: "admin-oem-pricing",
          label: "OEM Inventory Pricing",
          icon: Landmark,
          href: "/oem-pricing",
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
        {
          id: "admin-inventory-ageing",
          label: "Ageing Report",
          icon: Package,
          href: "/admin/inventory/ageing-report",
        },
        {
          id: "admin-inventory-transfer",
          label: "Transfer",
          icon: ShoppingCart,
          href: "/admin/inventory/transfer",
        },
      ],
    },
    {
      section: "EXPENSES",
      items: [
        {
          id: "admin-ai-expense-tracker",
          label: "AI Expense Tracker",
          icon: Receipt,
          href: "/admin/expense-tracker",
        },
      ],
    },
    {
      section: "CALCULATOR",
      items: [
        {
          id: "admin-calculator",
          label: "Loan Calculator",
          icon: Calculator,
          href: "/admin/calculator",
        },
        {
          id: "admin-calculator-history",
          label: "Search History",
          icon: History,
          href: "/admin/calculator/search-history",
        },
      ],
    },
    BUYBACK_ADMIN_SECTION,
  ],

  /**
   * IT Dashboard — the security surface, split out of the admin and CEO navs so
   * the vulnerability detail (live exploit reproductions, unauthenticated PII
   * endpoints) sits behind its own login rather than every business one. The
   * `it` role has no other pages by design.
   */
  it: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "it-dashboard",
          label: "IT Dashboard",
          icon: LayoutDashboard,
          href: "/it",
        },
      ],
    },
    {
      section: "SECURITY",
      items: [
        {
          id: "it-security",
          label: "Security Risk",
          icon: ShieldAlert,
          href: "/it/security",
        },
        {
          id: "it-security-live",
          label: "Live Attacks",
          icon: Radar,
          href: "/it/security/live",
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
    NEODOVE_SECTION,
    BUYBACK_ADMIN_SECTION,
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

  sales_insight: [
    {
      section: "INSIGHTS",
      items: [
        {
          id: "converted-leads",
          label: "Converted Leads",
          icon: TrendingUp,
          href: "/sales-insight",
        },
      ],
    },
  ],

  inside_sales_rep: [
    {
      section: "INSIDE SALES",
      items: [
        {
          id: "my-queue",
          label: "My Queue",
          icon: ListChecks,
          href: "/inside-sales",
        },
        {
          id: "is-campaigns",
          label: "Campaigns",
          icon: Megaphone,
          href: "/inside-sales/campaigns",
          // NOT `exact`. getActiveItemId is longest-match-wins, so the campaign
          // DETAIL route keeps this item lit on its own; marking it exact is the
          // U5 bug documented on NEODOVE_SECTION — the sidebar goes dark as soon
          // as you open a campaign.
        },
      ],
    },
  ],

  asm: [
    {
      section: "FIELD WORK",
      items: [
        {
          id: "my-visits",
          label: "My Visits",
          icon: MapPinned,
          href: "/asm",
        },
        {
          id: "asm-campaigns",
          label: "Campaigns",
          icon: Megaphone,
          href: "/asm/campaigns",
          // Not `exact`, for the same reason as the inside-sales twin above.
        },
      ],
    },
  ],

  /**
   * peakAmp Battery Buyback — the scrap vendor's side (E-195).
   *
   * Small on purpose. A vendor's whole relationship with iTarang is: here are
   * the lots we've quoted you, answer them. They are not staff and not a
   * dealer — nothing else in this application is any of their business, and
   * anything added here is a new surface that has to be checked for dealer
   * identity before it ships (see toVendorThread in lib/buyback/serialize.ts).
   */
  scrap_vendor: [
    {
      section: "OVERVIEW",
      items: [
        {
          id: "vendor-dashboard",
          label: "Dashboard",
          icon: LayoutDashboard,
          href: "/vendor-portal",
          // exact: this is the prefix of every sibling below, so without it the
          // Dashboard item would stay lit on /vendor-portal/inbox etc.
          exact: true,
        },
        {
          id: "vendor-inbox",
          label: "Quotation Inbox",
          icon: FileText,
          href: "/vendor-portal/inbox",
        },
        {
          id: "vendor-bids",
          label: "My Bids",
          icon: Handshake,
          href: "/vendor-portal/bids",
        },
        {
          id: "vendor-orders",
          label: "Orders & Documents",
          icon: FolderOpen,
          href: "/vendor-portal/orders",
        },
        {
          id: "vendor-payments",
          label: "Payments",
          icon: Wallet,
          href: "/vendor-portal/payments",
        },
        {
          id: "vendor-notifications",
          label: "Notifications",
          icon: Bell,
          href: "/vendor-portal/notifications",
        },
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
          id: "calculator",
          label: "Calculator",
          icon: Calculator,
          href: "/dealer-portal/calculator",
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
    {
      // peakAmp — the dealer sells their end-of-life batteries back to iTarang.
      // Its own section rather than an item under OPERATIONS: this is the dealer
      // SELLING to iTarang, the opposite direction to everything above it, and
      // burying it in a list of buying tools is how it goes unnoticed.
      section: "BATTERY BUYBACK",
      items: [
        {
          id: "buyback",
          label: "Buyback Dashboard",
          icon: Recycle,
          href: "/dealer-portal/buyback",
          // Task 6: /dealer-portal/buyback now has children (requests, new,
          // [id]) as well as siblings that share its prefix. Without `exact`,
          // the default startsWith match (see isActive below) highlights this
          // tile on every one of them too — most visibly alongside "My
          // Requests" on /dealer-portal/buyback/requests.
          exact: true,
        },
        {
          id: "buyback-requests",
          label: "My Requests",
          icon: FileText,
          href: "/dealer-portal/buyback/requests",
        },
        {
          id: "buyback-new",
          label: "Sell Batteries",
          icon: Coins,
          href: "/dealer-portal/buyback/new",
        },
        {
          id: "buyback-pickups",
          label: "Pickups",
          icon: Truck,
          href: "/dealer-portal/buyback/pickups",
        },
        {
          id: "buyback-dealer-payments",
          label: "Payments",
          icon: Landmark,
          href: "/dealer-portal/buyback/payments",
        },
        {
          id: "buyback-notifications",
          label: "Notifications",
          icon: Bell,
          href: "/dealer-portal/buyback/notifications",
        },
      ],
    },
    {
      // [E-234] The dealer BUYS recovered stock from an NBFC partner here.
      //
      // Its own section for the same reason BUYBACK got one: direction. Buyback
      // is the dealer selling dead batteries to iTarang; this is the dealer
      // buying recovered ones at auction. Filing them together would put two
      // opposite money flows under one heading.
      section: "BATTERY AUCTIONS",
      items: [
        {
          id: "auctions",
          label: "Live Auctions",
          icon: Gavel,
          // Deliberately NOT `exact`. The detail route
          // /dealer-portal/auctions/[id] should highlight this item, and the
          // default startsWith match does that for free. `my-bids` sits below
          // and is longer, so getActiveItemId's longest-match rule picks it
          // correctly when the dealer is there.
        href: "/dealer-portal/auctions",
        },
        {
          id: "auction-my-bids",
          label: "My Bids",
          icon: Gavel,
          href: "/dealer-portal/auctions/my-bids",
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

/**
 * Which single nav item (by id) should render as active for the current
 * pathname.
 *
 * The old rule matched each item independently — exact match, or
 * `pathname.startsWith(itemPath + "/")` — so whenever one item's href was a
 * literal prefix of a sibling/child's, both matched and both lit up. That was
 * already patched once for the dealer buyback section via a per-item `exact`
 * flag (Task 6), but `exact` can't fix the admin buyback section: "Buyback
 * Requests" (/admin/buyback) must stay ACTIVE on `/admin/buyback/<id>` detail
 * pages (a real child route with no nav entry of its own), which rules out
 * marking it exact — yet it must NOT stay active on `/admin/buyback/dashboard`
 * now that that has its own nav entry.
 *
 * So instead of an independent boolean per item, every item that matches at
 * all is a candidate, and the longest (most specific) itemPath wins — the
 * `exact` flag still applies per-candidate (it just means "only ever a
 * candidate via exact match, never via prefix"). On /admin/buyback/dashboard,
 * both "/admin/buyback" and "/admin/buyback/dashboard" match by prefix/exact,
 * but the latter is longer and wins. On /admin/buyback/<id>, only
 * "/admin/buyback" matches at all, so it wins by default — unchanged from
 * before.
 */
interface NavItemForActive {
  id: string;
  href: string;
  exact?: boolean;
}
interface NavGroupForActive {
  items: NavItemForActive[];
}

// U5 — /dealer-portal/buyback/<id> detail routes have no nav entry of their
// own. "Buyback Dashboard" is `exact` (Task 6), so it never matches by
// prefix here, and no sibling item's href (new/requests/pickups/payments) is
// a prefix of a detail route either — so the longest-match loop below finds
// nothing and the sidebar goes dark on a page the dealer reached FROM this
// section. Folded into "My Requests" (buyback-requests), which is where a
// detail page is conceptually reached from.
const DEALER_BUYBACK_PREFIX = "/dealer-portal/buyback/";
const DEALER_BUYBACK_STATIC_SIBLINGS = new Set(["new", "requests", "pickups", "payments", "notifications"]);

function getActiveItemId(menuItems: NavGroupForActive[], pathname: string): string | null {
  let winnerId: string | null = null;
  let winnerLength = -1;
  for (const group of menuItems) {
    for (const item of group.items) {
      // active = exact match OR active for `/admin/nbfc?owner=me` style hrefs
      const itemPath = item.href.split("?")[0];
      const matches = item.exact
        ? pathname === itemPath
        : pathname === itemPath ||
          (itemPath !== "/" && pathname.startsWith(itemPath + "/"));
      if (!matches) continue;
      if (itemPath.length > winnerLength) {
        winnerId = item.id;
        winnerLength = itemPath.length;
      }
    }
  }

  // Fallback only — never overrides a real match above, so the admin
  // longest-match logic (and every other section) is untouched.
  if (winnerId === null && pathname.startsWith(DEALER_BUYBACK_PREFIX)) {
    const firstSegment = pathname.slice(DEALER_BUYBACK_PREFIX.length).split("/")[0];
    if (firstSegment && !DEALER_BUYBACK_STATIC_SIBLINGS.has(firstSegment)) {
      winnerId = "buyback-requests";
    }
  }

  return winnerId;
}

// Section names are display strings ("BATTERY BUYBACK"); this makes them safe
// for the aria-controls id linking a group header to its panel.
function slugifySection(section: string) {
  return section.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// Shared inner content rendered by BOTH the desktop sidebar and the mobile
// drawer. Receives the already-computed (role-aware, finance-gated, badged)
// menuItems so all that logic stays in Sidebar(). `onNavigate` lets the drawer
// close itself when a link is tapped.
function SidebarNav({
  menuItems,
  pathname,
  user,
  loading,
  inferredRole,
  onNavigate,
}: {
  menuItems: any[];
  pathname: string;
  user: ReturnType<typeof useAuth>["user"];
  loading: boolean;
  inferredRole: string;
  onNavigate?: () => void;
}) {
  // Computed once for the whole tree per pathname/menu change — see
  // getActiveItemId's doc comment for why this has to be a single
  // most-specific-match-wins pass rather than a per-item boolean.
  const activeItemId = useMemo(
    () => getActiveItemId(menuItems, pathname),
    [menuItems, pathname],
  );

  // The group holding the current route. Open by default, so landing on a page
  // always reveals where you are.
  const activeSection = useMemo(
    () =>
      menuItems.find((group) =>
        group.items.some((item: any) => item.id === activeItemId),
      )?.section ?? null,
    [menuItems, activeItemId],
  );

  // Explicit user toggles ONLY — a section absent from this map falls back to
  // `section === activeSection`. Storing the full open-set instead would need an
  // effect to re-open the active group after every navigation, and a setState in
  // an effect body is a cascading render (react-hooks/set-state-in-effect).
  // Deriving gets the same behaviour for free.
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());

  const isSectionOpen = (section: string) =>
    toggled.has(section) ? (toggled.get(section) as boolean) : section === activeSection;

  const toggleSection = (section: string) => {
    const next = !isSectionOpen(section);
    setToggled((prev) => new Map(prev).set(section, next));
  };

  // Desktop sidebar and mobile drawer both render this component at the same
  // time, so the aria-controls ids have to be per-instance.
  const navId = useId();

  return (
    <>
      {/* Logo lockup */}
      <div className="px-5 h-[68px] flex items-center border-b border-white/[0.07]">
        <img
          src="/itarang-logo-white.png"
          alt="iTarang"
          className="h-7 w-auto object-contain select-none"
          draggable={false}
        />
      </div>

      <div className="sidebar-scroll flex-1 overflow-y-auto py-2">
        {menuItems.map((group: any) => {
          const isOpen = isSectionOpen(group.section);
          const hasActive = group.items.some(
            (item: any) => item.id === activeItemId,
          );
          const panelId = `${navId}-${slugifySection(group.section)}`;
          return (
            <div key={group.section} className="sidebar-section">
              <button
                type="button"
                onClick={() => toggleSection(group.section)}
                aria-expanded={isOpen}
                aria-controls={panelId}
                data-has-active={hasActive ? "true" : undefined}
                className="sidebar-section-toggle"
              >
                <span className="truncate">{group.section}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "w-4 h-4 ml-auto shrink-0 opacity-70 transition-transform duration-200",
                    isOpen ? "rotate-180" : "rotate-0",
                  )}
                  strokeWidth={2}
                />
              </button>
              {/* 0fr → 1fr grid row is the only way to transition to an
                  auto height without measuring the panel. */}
              <div
                id={panelId}
                className={cn(
                  "grid transition-[grid-template-rows] duration-200 ease-out",
                  isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
              >
                {/* Items stay mounted so the collapse can animate; `inert`
                    keeps the hidden ones out of the tab order. */}
                <div className="min-h-0 overflow-hidden" inert={!isOpen}>
                  <div className="pb-2">
                    {group.items.map((item: any) => {
                      const isActive = item.id === activeItemId;
                      return (
                        <Link
                          key={item.id}
                          href={item.href}
                          onClick={onNavigate}
                          data-testid={`nav-${item.id}`}
                          className={cn(
                            isActive
                              ? "sidebar-nav-item-active"
                              : "sidebar-nav-item",
                          )}
                        >
                          <item.icon
                            className={cn(
                              "w-[18px] h-[18px] shrink-0",
                              isActive ? "text-white" : "text-white/55",
                            )}
                            strokeWidth={1.75}
                          />
                          <span className="truncate flex-1">{item.label}</span>
                          {item.badge ? (
                            <span
                              className="ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold"
                              style={{
                                background: "var(--color-brand-sky)",
                                color: "#fff",
                              }}
                            >
                              {item.badge}
                            </span>
                          ) : null}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
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
    </>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { user, loading } = useAuth();
  // Mobile drawer open/close (shared with the header hamburger). Only wired up
  // for the dealer portal — see the `isDealerPortal` gate in the render below.
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const closeSidebar = useUIStore((s) => s.closeSidebar);

  // Belt-and-suspenders: close the drawer on any route change (link taps already
  // call closeSidebar via onNavigate, but this also covers back/forward nav).
  useEffect(() => {
    closeSidebar();
  }, [pathname, closeSidebar]);

  // Derive role from the current pathname so the sidebar renders immediately
  // even before the auth context resolves. This eliminates the "blank sidebar
  // until refresh" SSR issue because we no longer gate on loading/user.
  const inferredRole = (() => {
    if (user?.role) return user.role.toLowerCase();
    if (pathname.startsWith("/dealer-portal")) return "dealer";
    if (pathname.startsWith("/vendor-portal")) return "scrap_vendor";
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
    if (pathname.startsWith("/sales-insight")) return "sales_insight";
    if (pathname.startsWith("/inside-sales")) return "inside_sales_rep";
    if (pathname.startsWith("/asm")) return "asm";
    if (pathname.startsWith("/it")) return "it";
    return "user";
  })();

  // For the dealer role, loan-related entries must hide when the dealer's
  // onboarding application has financeEnabled=false. Source the flag from
  // /api/dealer/stats (already the authoritative finance-enabled endpoint).
  // The SAME response carries dealerType (E-202), which gates whole sections
  // below — one request, two gates, so they can never disagree.
  const [dealerFinanceEnabled, setDealerFinanceEnabled] = useState<boolean | null>(null);
  const [dealerType, setDealerType] = useState<DealerTypeValue>("new");

  useEffect(() => {
    if (inferredRole !== "dealer") return;
    let cancelled = false;

    // These two flags gate WHICH menu items render, so until the fetch below
    // lands the dealer sees an incomplete menu — and this component remounts on
    // every hard navigation, so they see it every time. Seeding from the
    // session snapshot paints the last-known-good menu immediately while the
    // fetch revalidates behind it.
    //
    // Read here in the effect, NOT in a useState initialiser: this client
    // component is still server-rendered, where sessionStorage does not exist,
    // so seeding during render would make the client's first paint disagree
    // with the server HTML and trip a hydration mismatch. AuthProvider's
    // profile snapshot is read from an effect for exactly this reason.
    const snapshot = readSnapshot<{
      financeEnabled: boolean;
      dealerType: DealerTypeValue;
    }>(DEALER_GATE_SNAPSHOT_KEY);
    if (snapshot) {
      setDealerFinanceEnabled(snapshot.financeEnabled);
      setDealerType(snapshot.dealerType);
    }

    fetch("/api/dealer/stats", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const flag = json?.data?.dealer?.financeEnabled;
        const financeEnabled = typeof flag === "boolean" ? flag : false;
        // `dealer` is null when no onboarding application is found. Default to
        // 'new' — the safe direction: a dealer we can't classify keeps the
        // portal they have today rather than losing every menu.
        const resolvedType = normalizeDealerType(json?.data?.dealer?.dealerType) ?? "new";
        setDealerFinanceEnabled(financeEnabled);
        setDealerType(resolvedType);
        writeSnapshot(DEALER_GATE_SNAPSHOT_KEY, {
          financeEnabled,
          dealerType: resolvedType,
        });
      })
      .catch(() => {
        // Only fall back to the closed state if there was no snapshot to show.
        // A transient network blip must not blank out a menu we were already
        // rendering correctly from cache.
        if (!cancelled && !snapshot) setDealerFinanceEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inferredRole]);

  // E-202 / E-225 — which modules this dealer type has at all.
  //  · new   → no buyback (they don't sell old batteries back to us)
  //  · scrap → ONLY buyback (no leads, loans, assets, orders, inventory…)
  //  · both  → everything, i.e. exactly today's menu
  const dealerCaps = capabilitiesFor(dealerType);

  const filteredMenuItems = useMemo(() => {
    // Resolved inside the memo, not read from an outer `||` expression: that
    // would be a new array identity on every render and defeat the memo.
    const rawMenuItems = roleNavigation[inferredRole] || roleNavigation["user"] || [];
    if (inferredRole !== "dealer") return rawMenuItems;

    const caps = capabilitiesFor(dealerType);

    return rawMenuItems
      .filter((group: any) => {
        if (!caps.buyback && group.section === BUYBACK_SECTION) return false;
        if (!caps.newBattery && NEW_BATTERY_SECTIONS.has(group.section)) return false;
        return true;
      })
      .map((group: any) => ({
        ...group,
        items: group.items.filter((item: any) => {
          // Both filters apply together — a scrap dealer must not regain
          // "Loan Processing" just because the finance filter is the one that
          // would normally drop it.
          if (dealerFinanceEnabled === false && FINANCE_GATED_ITEM_IDS.has(item.id)) return false;
          if (!caps.newBattery && REDUNDANT_FOR_SCRAP_ITEM_IDS.has(item.id)) return false;
          return true;
        }),
      }))
      // A section whose every item was filtered out would otherwise render as a
      // bare heading with nothing under it.
      .filter((group: any) => group.items.length > 0);
  }, [inferredRole, dealerFinanceEnabled, dealerType]);

  // Universal nav items (e.g. Submit Expense) appended to every role except:
  //  · "user" — the unauthenticated path-inferred fallback view;
  //  · "scrap_vendor" — a vendor is a COUNTERPARTY, not staff. "Submit Expense"
  //    files a business expense for a CEO to approve; offering that to the firm
  //    we are selling scrap to is not a universal action, it is a wrong one.
  //  · "it" — the IT console is a single-purpose security surface (scanner
  //    findings + live attacks); expense filing is out of scope for it.
  const NO_COMMON_ITEMS = new Set(["user", "scrap_vendor", "it"]);
  let menuItems = [
    ...filteredMenuItems,
    ...(NO_COMMON_ITEMS.has(inferredRole) ? [] : COMMON_ITEMS),
    // Anything that must render below the shared EXPENSES group. Empty for
    // every role but sales_head, so this is a no-op elsewhere.
    ...(ROLE_TRAILING_SECTIONS[inferredRole] ?? []),
  ];

  // Merge duplicate EXPENSES groups so a role with its own EXPENSES section
  // gets the shared "Submit Expense" item inside it instead of rendering two
  // separate headings.
  menuItems = menuItems.reduce((acc: any[], group: any) => {
    if (group.section !== "EXPENSES") {
      acc.push(group);
      return acc;
    }

    const existingExpenses = acc.find((item) => item.section === "EXPENSES");
    if (!existingExpenses) {
      acc.push({
        section: "EXPENSES",
        items: [...group.items],
      });
      return acc;
    }

    existingExpenses.items.push(...group.items);
    return acc;
  }, []);

  // NBFC Onboarding Plan §15.1 — count badge on the CEO "Pending NBFC
  // Approvals" link, fetched once on mount. Polling is overkill for a queue
  // that turns over a handful of times per week.
  const [pendingNbfcCount, setPendingNbfcCount] = useState<number | null>(null);
  useEffect(() => {
    if (inferredRole !== "ceo") return;
    let cancelled = false;
    fetch("/api/admin/nbfc/approvals/count", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => {
        if (!cancelled) setPendingNbfcCount(Number(j.count ?? 0));
      })
      .catch(() => {
        /* silent — badge stays absent on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [inferredRole]);

  // Live-attack badge (E-216) — count of NEW security events, polled so the
  // "Live Attacks" link lights up in near-real-time when the detector fires.
  const [securityEventCount, setSecurityEventCount] = useState<number | null>(null);
  useEffect(() => {
    if (inferredRole !== "it") return;
    let cancelled = false;
    const load = () =>
      fetch("/api/it/security/events/count", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((j) => {
          if (!cancelled) setSecurityEventCount(Number(j.count ?? 0));
        })
        .catch(() => {
          /* silent — badge stays absent on failure */
        });
    load();
    const id = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [inferredRole]);

  // Vendor inbox badge — the count of quotations awaiting this vendor's
  // response (status SENT), mirroring the CEO approvals badge above. One fetch
  // on mount; a queue that turns over a handful of times a week needs no poll.
  const [vendorInboxCount, setVendorInboxCount] = useState<number | null>(null);
  useEffect(() => {
    if (inferredRole !== "scrap_vendor") return;
    let cancelled = false;
    fetch("/api/vendor/threads", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => {
        if (cancelled) return;
        const list = (j?.data?.threads ?? []) as Array<{ status?: string }>;
        setVendorInboxCount(list.filter((t) => t?.status === "SENT").length);
      })
      .catch(() => {
        /* silent — badge stays absent on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [inferredRole]);

  // Buyback notification badges. Shares the summary query with the header bell
  // (same query key → one request) and updates live, so a mark-read anywhere
  // decrements these. Gated to roles that actually have a buyback surface so a
  // finance/service login never fires the request.
  const isBuybackRole =
    [
      "dealer",
      "scrap_vendor",
      "admin",
      "ceo",
      "business_head",
      "sales_head",
    ].includes(inferredRole) &&
    // A NEW-battery dealer has no buyback surface at all (E-202), so polling
    // their unread counts is a request whose answer can only ever be zero.
    (inferredRole !== "dealer" || dealerCaps.buyback);
  const notifSummary = useBuybackNotificationSummary(isBuybackRole);
  const totalUnread = notifSummary.unread.total;
  const negotiationUnread = notifSummary.unread.byCategory.Negotiation ?? 0;

  // New arrivals in the admin work queues since this person last opened each
  // page — Dealer Validation, KYC Review, WhatsApp Onboarding. Clears on visit.
  const navActivity = useNavActivity(
    ["admin", "sales_head", "ceo", "business_head"].includes(inferredRole),
    pathname,
  );

  if (Object.keys(navActivity).length > 0) {
    menuItems = menuItems.map((group) => ({
      ...group,
      items: group.items.map((item: { id: string }) => {
        const n = navActivity[item.id];
        return n ? { ...item, badge: n > 99 ? "99+" : n } : item;
      }),
    }));
  }

  if (pendingNbfcCount && pendingNbfcCount > 0) {
    menuItems = menuItems.map((group: any) => ({
      ...group,
      items: group.items.map((item: any) =>
        item.id === "nbfc-approvals"
          ? { ...item, badge: pendingNbfcCount }
          : item,
      ),
    }));
  }

  if (vendorInboxCount && vendorInboxCount > 0) {
    menuItems = menuItems.map((group: any) => ({
      ...group,
      items: group.items.map((item: any) =>
        item.id === "vendor-inbox" ? { ...item, badge: vendorInboxCount } : item,
      ),
    }));
  }

  if (securityEventCount && securityEventCount > 0) {
    const badge = securityEventCount > 99 ? "99+" : securityEventCount;
    menuItems = menuItems.map((group) => ({
      ...group,
      items: group.items.map((item: { id: string }) =>
        item.id === "it-security-live" ? { ...item, badge } : item,
      ),
    }));
  }

  // Total unread on the "Notifications" link (dealer / admin / vendor), and
  // Negotiation-category unread on the admin "Negotiations" link.
  if (totalUnread > 0 || negotiationUnread > 0) {
    menuItems = menuItems.map((group: any) => ({
      ...group,
      items: group.items.map((item: any) => {
        if (
          (item.id === "buyback-notifications" || item.id === "vendor-notifications") &&
          totalUnread > 0
        ) {
          return { ...item, badge: totalUnread > 99 ? "99+" : totalUnread };
        }
        if (item.id === "buyback-negotiations" && negotiationUnread > 0) {
          return { ...item, badge: negotiationUnread > 99 ? "99+" : negotiationUnread };
        }
        return item;
      }),
    }));
  }

  // BRD §6.B sidebar — solid #02314e navy, 9px ALL CAPS section labels at
  // rgba(255,255,255,0.30), 13px DM Sans Medium nav items, 3px transparent
  // left border, active = `rgba(19,143,198,0.15)` bg + `#138fc6` left border
  // + white text. Width pinned at w-64 to keep LayoutWrapper margin (md:ml-64).
  return (
    <>
      {/* Desktop sidebar — fixed 256px, visible from md up. Unchanged output. */}
      <div className="sidebar-shell w-64 h-screen flex-col fixed left-0 top-0 z-10 hidden md:flex">
        <SidebarNav
          menuItems={menuItems}
          pathname={pathname}
          user={user}
          loading={loading}
          inferredRole={inferredRole}
        />
      </div>

      {/* Mobile drawer — phone-only (md:hidden), rendered on EVERY route this
          sidebar serves. It was previously gated to /dealer-portal, /expenses
          and /it, which meant the header hamburger had nothing to open anywhere
          else (sales-head, admin, ceo, …) — the desktop sidebar is `hidden
          md:flex`, so those roles had no navigation at all on a phone. The
          drawer is already role-aware (it renders the same computed menuItems),
          so no per-role work is needed. Mirrors the NbfcPortalSidebar pattern:
          backdrop + left slide-in panel, driven by the shared uiStore. */}
      <div
        className={`md:hidden fixed inset-0 z-50 ${
          sidebarOpen ? "" : "pointer-events-none"
        }`}
        aria-hidden={!sidebarOpen}
      >
        {/* Backdrop */}
        <div
          onClick={closeSidebar}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
            sidebarOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        {/* Panel */}
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="Main navigation"
          className={`sidebar-shell absolute left-0 top-0 h-full w-72 max-w-[85vw] flex flex-col transition-transform duration-200 ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <button
            type="button"
            onClick={closeSidebar}
            aria-label="Close navigation"
            className="absolute right-3 top-4 z-10 p-2 text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <SidebarNav
            menuItems={menuItems}
            pathname={pathname}
            user={user}
            loading={loading}
            inferredRole={inferredRole}
            onNavigate={closeSidebar}
          />
        </aside>
      </div>
    </>
  );
}
