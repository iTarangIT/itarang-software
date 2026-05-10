"use client";

/**
 * NbfcPortalSidebar — BRD §6.1.2 sidebar for the NBFC partner portal.
 *
 * Visual language mirrors `src/components/layout/sidebar.tsx` so the NBFC
 * surface reads as the same product as the admin surface. The navy
 * background, sky accent, ALL CAPS section labels, and 13px nav typography
 * all carry over via the shared `.sidebar-shell` and friends.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartLine,
  ClipboardList,
  Cog,
  FileText,
  Layers,
  Search,
  Siren,
} from "lucide-react";

const NAV_ITEMS: Array<{
  id: string;
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
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

export default function NbfcPortalSidebar({
  tenantName,
  activeLoans,
  aumInr,
}: {
  tenantName: string;
  activeLoans: number;
  aumInr: number | null;
}) {
  const pathname = usePathname() ?? "";

  return (
    <div className="sidebar-shell w-64 h-screen flex-col fixed left-0 top-0 z-10 hidden md:flex">
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
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.id}
                href={item.href}
                data-testid={`nbfc-portal-nav-${item.id}`}
                className={
                  isActive ? "sidebar-nav-item-active" : "sidebar-nav-item"
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="px-5 py-4 border-t border-white/[0.07] text-[11px] text-white/40 leading-relaxed">
        RBI Digital Lending Directions 2025 — every action you take here is
        written to the immutable audit log.
      </div>
    </div>
  );
}
