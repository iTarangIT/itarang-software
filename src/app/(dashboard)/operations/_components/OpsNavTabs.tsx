"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * Sub-navigation for the Ops Console.
 *
 * The sidebar already lists these, but the console is meant to be worked
 * across — you land on the one-slide board, see one tile red, and move to the
 * module behind it. A horizontal strip makes that one click and keeps the
 * mobile drawer closed.
 *
 * Kept in step with the `operations:` block in components/layout/sidebar.tsx.
 */
const TABS: Array<{ href: string; label: string }> = [
  { href: "/operations", label: "Board" },
  { href: "/operations/infrastructure", label: "Infrastructure" },
  { href: "/operations/database", label: "Database" },
  { href: "/operations/logs", label: "Logs" },
  { href: "/operations/system", label: "System" },
  { href: "/operations/spend", label: "Spend" },
  { href: "/operations/business", label: "Business" },
  { href: "/operations/team", label: "Team" },
  { href: "/operations/usage", label: "Usage" },
  { href: "/operations/alerts", label: "Alerts" },
  { href: "/operations/jobs", label: "Collectors" },
  { href: "/operations/elevenlabs", label: "ElevenLabs" },
];

export function OpsNavTabs() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Ops Console sections"
      className="-mx-1 flex gap-1 overflow-x-auto pb-1"
    >
      {TABS.map((tab) => {
        // "/operations" is a prefix of every other tab, so it only wins on an
        // exact match — otherwise the board would stay lit on every sub-page.
        const active =
          tab.href === "/operations"
            ? pathname === "/operations"
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
              active
                ? "bg-brand-navy text-white"
                : "text-ink-muted hover:bg-brand-50 hover:text-brand-700",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
