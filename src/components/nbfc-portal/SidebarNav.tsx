"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * NBFC Portal sidebar navigation.
 *
 * Renders the seven items mandated by BRD §6.1.2 in fixed order:
 *   Portfolio Overview, Lead Intelligence, Battery Monitoring,
 *   Risk Alerts, Recovery & Auction, Audit Log, Settings.
 *
 * Active state is computed by pathname-prefix match against `match`.
 * Below the md breakpoint the sidebar collapses into a hamburger drawer.
 */

export type NbfcNavItem = {
  /** Stable identifier used by tests (data-nav-id). */
  id: string;
  /** Visible label including the BRD-mandated emoji prefix. */
  label: string;
  /** Anchor href. */
  href: string;
  /** Pathname prefix that marks this item active. */
  match: string;
};

export const NBFC_NAV_ITEMS: readonly NbfcNavItem[] = [
  {
    id: "portfolio",
    label: "📊 Portfolio Overview",
    href: "/nbfc/portfolio",
    match: "/nbfc/portfolio",
  },
  {
    id: "leads",
    label: "🔍 Lead Intelligence",
    href: "/nbfc/leads",
    match: "/nbfc/leads",
  },
  {
    id: "batteries",
    label: "🔋 Battery Monitoring",
    href: "/nbfc/batteries",
    match: "/nbfc/batteries",
  },
  {
    id: "risk",
    label: "⚠️ Risk Alerts",
    href: "/nbfc/risk",
    match: "/nbfc/risk",
  },
  {
    id: "recovery",
    label: "🔄 Recovery & Auction",
    href: "/nbfc/recovery",
    match: "/nbfc/recovery",
  },
  {
    id: "audit",
    label: "📋 Audit Log",
    href: "/nbfc/audit",
    match: "/nbfc/audit",
  },
  {
    id: "settings",
    label: "⚙️ Settings",
    href: "/nbfc/settings",
    match: "/nbfc/settings",
  },
] as const;

function isActive(pathname: string | null, match: string): boolean {
  if (!pathname) return false;
  return pathname === match || pathname.startsWith(`${match}/`);
}

export default function SidebarNav() {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile hamburger drawer (collapsed below md). The <details>
          element gives us a no-JS-required disclosure that Playwright
          can interact with deterministically. */}
      <details className="md:hidden border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <summary
          aria-label="Open NBFC navigation"
          className="px-4 py-3 cursor-pointer select-none text-sm font-medium"
        >
          ☰ Menu
        </summary>
        <ul className="px-2 pb-2">
          {NBFC_NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.match);
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  data-nav-id={item.id}
                  data-active={active ? "true" : "false"}
                  aria-current={active ? "page" : undefined}
                  className={
                    "block px-3 py-2 rounded text-sm " +
                    (active
                      ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                      : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800")
                  }
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </details>

      {/* Desktop sidebar (md and up). */}
      <aside
        aria-label="NBFC portal navigation"
        className="hidden md:flex md:flex-col md:w-64 md:shrink-0 md:border-r md:border-slate-200 dark:md:border-slate-800 md:bg-white dark:md:bg-slate-900"
      >
        <nav className="p-3">
          <ul className="space-y-1">
            {NBFC_NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.match);
              return (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    data-nav-id={item.id}
                    data-active={active ? "true" : "false"}
                    aria-current={active ? "page" : undefined}
                    className={
                      "flex items-center px-3 py-2 rounded text-sm font-medium transition-colors " +
                      (active
                        ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                        : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800")
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </>
  );
}
