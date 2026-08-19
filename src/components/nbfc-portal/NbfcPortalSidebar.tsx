"use client";

/**
 * NbfcPortalSidebar — BRD §6.1.2 sidebar for the NBFC partner portal.
 *
 * Visual language mirrors `src/components/layout/sidebar.tsx` so the NBFC
 * surface reads as the same product as the admin surface. The navy
 * background, sky accent, ALL CAPS section labels, and 13px nav typography
 * all carry over via the shared `.sidebar-shell` and friends.
 *
 * Renders twice:
 *  - Desktop (≥ md): a fixed 256px sidebar.
 *  - Mobile (< md): a slide-in drawer with backdrop, driven by `mobileOpen`.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BatteryCharging,
  Briefcase,
  CalendarClock,
  ChartLine,
  ClipboardList,
  Cog,
  FilePlus2,
  FileText,
  Gavel,
  Layers,
  Search,
  Siren,
  Wrench,
  X,
} from "lucide-react";
import { useNbfcWorkQueue } from "@/hooks/useNbfcWorkQueue";

const NAV_ITEMS: Array<{
  id: string;
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  // Addendum V0.1 §7.1 — Acquire is the pre-disbursal origination workspace.
  // Sits above Monitor (Portfolio Overview) since it is the primary surface
  // for an NBFC user under the addendum's competing-NBFC routing model.
  {
    id: "acquire",
    href: "/nbfc/acquire",
    label: "Acquire",
    icon: Briefcase,
  },
  {
    id: "portfolio",
    href: "/nbfc/portfolio",
    label: "Portfolio Overview",
    icon: ChartLine,
  },
  {
    id: "leads",
    href: "/nbfc/leads",
    label: "Lead Intelligence",
    icon: Search,
  },
  {
    id: "emi-tracker",
    href: "/nbfc/emi-tracker",
    label: "EMI Tracker",
    icon: CalendarClock,
  },
  {
    id: "batteries",
    href: "/nbfc/batteries",
    label: "Battery Monitoring",
    icon: Layers,
  },
  {
    id: "risk",
    href: "/nbfc/risk",
    label: "Risk Alerts",
    icon: Siren,
  },
  {
    id: "recovery",
    href: "/nbfc/recovery",
    label: "Recovery & Auction",
    icon: ClipboardList,
  },
  // [BRD §3, §5] The battery master and the workshop console. Both had APIs
  // and no screen, so recovered stock could only be registered — and repairs
  // only raised — with curl.
  {
    id: "recovery-batteries",
    href: "/nbfc/recovery/batteries",
    label: "Recovered Batteries",
    icon: BatteryCharging,
  },
  {
    id: "recovery-refurbishment",
    href: "/nbfc/recovery/refurbishment",
    label: "Refurbishment",
    icon: Wrench,
  },
  // [E-234] `/nbfc/auction` shipped with E-038 and was never linked from
  // anywhere — an orphan page reachable only by typing the URL. Recovery is the
  // pipeline that feeds it, so they are siblings rather than merged.
  //
  // It was labelled "Auction Marketplace" while it still offered NBFCs a bid
  // button. It does not: bidders are dealers, and an NBFC is the seller here.
  // The label now says whose lots these are.
  {
    id: "auction",
    href: "/nbfc/auction",
    label: "Auction Lots",
    icon: Gavel,
  },
  {
    id: "auction-drafts",
    href: "/nbfc/auction/drafts",
    label: "Draft Lots",
    icon: FilePlus2,
  },
  {
    id: "audit",
    href: "/nbfc/audit",
    label: "Audit Log",
    icon: FileText,
  },
  {
    id: "settings",
    href: "/nbfc/settings",
    label: "Settings",
    icon: Cog,
  },
];

const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);

/** Shared inner content rendered by both the desktop sidebar and mobile drawer. */
function SidebarBody({
  tenantName,
  activeLoans,
  aumInr,
  pathname,
  acquirePending,
  onNavigate,
}: {
  tenantName: string;
  activeLoans: number;
  aumInr: number | null;
  pathname: string;
  acquirePending: number;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="px-5 h-[68px] flex items-center border-b border-white/[0.07]">
        <img
          src="/itarang-logo-white.png"
          alt="iTarang"
          className="h-7 w-auto object-contain select-none"
          draggable={false}
        />
      </div>

      <div className="px-5 py-4 border-b border-white/[0.07]">
        <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">
          NBFC Partner
        </p>
        <p className="text-[14px] font-semibold text-white mt-1 truncate">
          {tenantName}
        </p>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-white/50">
          <span>{activeLoans.toLocaleString("en-IN")} active</span>
          {aumInr ? (
            <>
              <span aria-hidden>·</span>
              <span>AUM ₹{inr(aumInr)}</span>
            </>
          ) : null}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-6">
        <h3 className="sidebar-section-label px-5 mb-2">Portal</h3>
        <div>
          {/* Longest matching href wins.
              The old test — `pathname === href || pathname.startsWith(href + "/")`
              — lit up EVERY ancestor, so /nbfc/auction/drafts highlighted both
              "Auction Lots" and "Draft Lots" at once. Matching the deepest
              entry is the same rule the main app sidebar uses. */}
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const matches = (href: string) =>
              pathname === href || pathname.startsWith(`${href}/`);
            const isActive =
              matches(item.href) &&
              !NAV_ITEMS.some(
                (other) =>
                  other.id !== item.id &&
                  other.href.length > item.href.length &&
                  matches(other.href),
              );
            return (
              <Link
                key={item.id}
                href={item.href}
                onClick={onNavigate}
                data-testid={`nbfc-portal-nav-${item.id}`}
                className={
                  isActive ? "sidebar-nav-item-active" : "sidebar-nav-item"
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
                {item.id === "acquire" && acquirePending > 0 && (
                  <span
                    aria-label={`${acquirePending} pending applications`}
                    className="ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-[color:var(--color-brand-sky)] text-white text-[11px] font-bold tabular-nums"
                  >
                    {acquirePending > 99 ? "99+" : acquirePending}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="px-5 py-4 border-t border-white/[0.07] text-[11px] text-white/40 leading-relaxed">
        RBI Digital Lending Directions 2025 — every action you take here is
        written to the immutable audit log.
      </div>
    </>
  );
}

export default function NbfcPortalSidebar({
  tenantName,
  activeLoans,
  aumInr,
  mobileOpen = false,
  onClose,
}: {
  tenantName: string;
  activeLoans: number;
  aumInr: number | null;
  mobileOpen?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname() ?? "";
  const { acquire_pending } = useNbfcWorkQueue();

  return (
    <>
      {/* Desktop sidebar — fixed, always visible from md up. */}
      <aside className="sidebar-shell w-64 h-screen flex-col fixed left-0 top-0 z-10 hidden md:flex">
        <SidebarBody
          tenantName={tenantName}
          activeLoans={activeLoans}
          aumInr={aumInr}
          pathname={pathname}
          acquirePending={acquire_pending}
        />
      </aside>

      {/* Mobile drawer — slide-in overlay below md. */}
      <div
        className={`md:hidden fixed inset-0 z-50 ${
          mobileOpen ? "" : "pointer-events-none"
        }`}
        aria-hidden={!mobileOpen}
      >
        {/* Backdrop */}
        <div
          onClick={onClose}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
            mobileOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        {/* Panel */}
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="NBFC portal navigation"
          className={`sidebar-shell absolute left-0 top-0 h-full w-72 max-w-[85vw] flex flex-col transition-transform duration-200 ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="absolute right-3 top-4 z-10 p-2 text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <SidebarBody
            tenantName={tenantName}
            activeLoans={activeLoans}
            aumInr={aumInr}
            pathname={pathname}
            acquirePending={acquire_pending}
            onNavigate={onClose}
          />
        </aside>
      </div>
    </>
  );
}
