"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/it/security", label: "Findings" },
  { href: "/it/security/history", label: "History" },
  { href: "/it/security/live", label: "Live Attacks" },
];

/**
 * Tab strip shared by the scanner (Findings), the resolution audit trail
 * (History) and the detection (Live Attacks) pages.
 */
export default function SecurityNavTabs() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              active
                ? "border-slate-900 dark:border-slate-100 text-slate-900 dark:text-slate-100"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
