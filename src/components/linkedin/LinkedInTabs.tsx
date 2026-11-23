"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const LI_BASE = "/sales-head/linkedin";

const TABS = [
  { href: `${LI_BASE}/search`, label: "Search" },
  { href: `${LI_BASE}/prospects`, label: "Prospects" },
  { href: `${LI_BASE}/campaigns`, label: "Campaigns" },
  { href: `${LI_BASE}/inbox`, label: "Inbox" },
  { href: `${LI_BASE}/accounts`, label: "Accounts" },
];

export function LinkedInTabs() {
  const path = usePathname() ?? "";
  return (
    <nav className="flex gap-1 border-b border-gray-200" aria-label="LinkedIn outreach">
      {TABS.map((t) => {
        const active = path === t.href || path.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              active ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
