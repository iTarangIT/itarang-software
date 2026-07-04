"use client";

/**
 * RiskHeadSidebar — sidebar for the NBFC Risk Head dashboard (/risk-head).
 *
 * Mirrors `NbfcPortalSidebar`'s visual language (navy shell, sky accent) but
 * carries a focused nav: the battery-immobilisation Approvals inbox and the
 * Battery Monitoring view the Risk Head reviews before deciding. The Risk Head
 * is the second approver in the two-person immobilisation gate (RBI Digital
 * Lending Directions 2025); they do not initiate, so origination/recovery
 * surfaces are intentionally absent.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck, Layers, X } from "lucide-react";

const NAV_ITEMS: Array<{
  id: string;
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    id: "approvals",
    href: "/risk-head/approvals",
    label: "Immobilisation Approvals",
    icon: ShieldCheck,
  },
  {
    id: "batteries",
    href: "/risk-head/batteries",
    label: "Battery Monitoring",
    icon: Layers,
  },
];

/** Shared inner content rendered by both the desktop sidebar and mobile drawer. */
function SidebarBody({
  tenantName,
  pathname,
  pendingCount,
  onNavigate,
}: {
  tenantName: string;
  pathname: string;
  pendingCount: number;
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
          Risk Head
        </p>
        <p className="text-[14px] font-semibold text-white mt-1 truncate">
          {tenantName}
        </p>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-white/50">
          <span>Battery immobilisation sign-off</span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-6">
        <h3 className="sidebar-section-label px-5 mb-2">Approvals</h3>
        <div>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.id}
                href={item.href}
                onClick={onNavigate}
                data-testid={`risk-head-nav-${item.id}`}
                className={
                  isActive ? "sidebar-nav-item-active" : "sidebar-nav-item"
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
                {item.id === "approvals" && pendingCount > 0 && (
                  <span
                    aria-label={`${pendingCount} pending approvals`}
                    className="ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-[color:var(--color-brand-sky)] text-white text-[11px] font-bold tabular-nums"
                  >
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="px-5 py-4 border-t border-white/[0.07] text-[11px] text-white/40 leading-relaxed">
        RBI Digital Lending Directions 2025 — every approval you make here is
        written to the immutable audit log.
      </div>
    </>
  );
}

export default function RiskHeadSidebar({
  tenantName,
  pendingCount,
  mobileOpen = false,
  onClose,
}: {
  tenantName: string;
  pendingCount: number;
  mobileOpen?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname() ?? "";

  return (
    <>
      {/* Desktop sidebar — fixed, always visible from md up. */}
      <aside className="sidebar-shell w-64 h-screen flex-col fixed left-0 top-0 z-10 hidden md:flex">
        <SidebarBody
          tenantName={tenantName}
          pathname={pathname}
          pendingCount={pendingCount}
        />
      </aside>

      {/* Mobile drawer — slide-in overlay below md. */}
      <div
        className={`md:hidden fixed inset-0 z-50 ${
          mobileOpen ? "" : "pointer-events-none"
        }`}
        aria-hidden={!mobileOpen}
      >
        <div
          onClick={onClose}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
            mobileOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="Risk Head navigation"
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
            pathname={pathname}
            pendingCount={pendingCount}
            onNavigate={onClose}
          />
        </aside>
      </div>
    </>
  );
}
